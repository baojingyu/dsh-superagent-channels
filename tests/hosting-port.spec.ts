/** The code-hosting port and its kind factory: the shared settings, the receiving scope of each Trigger, and the note channel's markers. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { OutboundMessage } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { ChannelHost, FieldSpec, SourceKind } from '../src/sources/kind.ts'
import { hostingKind, hostingMarker, type HostingConfig } from '../src/sources/hosting/kind.ts'
import type { ChangeRequest, HostAdapter } from '../src/sources/hosting/port.ts'
import { testDeployment } from './fixtures/deployment.ts'

const META = { host: 'gitlab', title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '内部 GitLab 的合并请求。', en: 'Merge requests on an internal GitLab.' } }
const config: HostingConfig = { project: 'team/app', tokenFile: '/home/agent/gitlab-token', pollSeconds: 60 }

const change = (number: number): ChangeRequest => ({ number, title: `MR ${number}`, body: 'body', author: 'dev', authorIsBot: false,
  url: `https://gitlab.example.com/team/app/-/merge_requests/${number}`, state: 'open', merged: false,
  head: { ref: 'feature', sha: 'abc1234' }, base: { ref: 'main' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })

/** A stand-in host: URLs, change reads, and note posting work, while the reads no host provider implements yet fail loudly. */
function stub(record: { text?: string; marker?: string } = {}): HostAdapter<HostingConfig> {
  const unimplemented = () => { throw new Error('provider not configured') }
  return {
    host: 'gitlab',
    page: (project, number) => `https://gitlab.example.com/${project}/-/merge_requests/${number}`,
    listChanges: async () => unimplemented(),
    readChange: async (_commands, _project, number) => change(number),
    readNotes: async () => unimplemented(),
    postNote: async (_commands, _change, text, marker) => { record.text = text; record.marker = marker; return 'sent' },
  }
}

const host: ChannelHost = { commands: {} as unknown as Commands, deployment: testDeployment(), config, instance: 'gitlab' }
const message = (address: Record<string, string>): OutboundMessage =>
  ({ id: 'r42', channel: { source: 'gitlab', thread: 'gitlab:7', address }, text: '修好了', kind: 'reply' })

describe('hostingKind', () => {
  it('returns a complete SourceKind whose schema merges the shared settings with the host\'s extra fields', () => {
    const extraField: FieldSpec = { key: 'observeCi', type: 'switch', label: { zh: '接收 CI', en: 'Receive CI' } }
    const kind: SourceKind<HostingConfig> = hostingKind(stub(), { ...META, extraSchema: { observeCi: z.boolean().default(false) },
      extraFields: [extraField] })
    expect(kind.kind).toBe('gitlab')
    expect(kind.title).toEqual({ zh: 'GitLab', en: 'GitLab' })
    expect(kind.health).toEqual(['gitlab'])
    expect(kind.fields.map(field => field.key)).toEqual(['project', 'tokenFile', 'pollSeconds', 'observeCi'])
    expect(kind.fields.find(field => field.key === 'pollSeconds')).toMatchObject({ type: 'number', advanced: true, min: 30, max: 3600 })
    // The extra key arrives after the shared ones, and the shared defaults still fill.
    expect(kind.schema.parse({ project: 'team/app', tokenFile: '/token' }))
      .toEqual({ project: 'team/app', tokenFile: '/token', pollSeconds: 60, observeCi: false })
  })

  it('fails to parse a configuration without a project, without a token file, or with an unknown key', () => {
    const kind = hostingKind(stub(), META)
    expect(kind.schema.safeParse({ tokenFile: '/token' }).success).toBe(false)
    expect(kind.schema.safeParse({ project: '', tokenFile: '/token' }).success).toBe(false)
    expect(kind.schema.safeParse({ project: 'team/app' }).success).toBe(false)
    expect(kind.schema.safeParse({ project: 'team/app', tokenFile: '/token', pollSeconds: 10 }).success).toBe(false)
    expect(kind.schema.safeParse({ project: 'team/app', tokenFile: '/token', extra: true }).success).toBe(false)
    expect(kind.schema.safeParse({ project: 'team/app', tokenFile: '/token' }).success).toBe(true)
  })

  it('derives the receiving row from a Trigger\'s kind and CI metadata, and observes every row it knows', () => {
    const kind = hostingKind(stub(), META)
    const scope = (meta: Record<string, unknown>) => {
      const result = kind.scope!({ meta }, config)
      if (!result.listened) throw new Error('a hosting Trigger is always listened to')
      return result
    }
    expect(scope({ kind: 'issue', number: 7 }).row).toBe('issues')
    expect(scope({ kind: 'pull', number: 7 }).row).toBe('pulls')
    expect(scope({ kind: 'inline', number: 7 }).row).toBe('comments')
    expect(scope({ kind: 'conversation', number: 7 }).row).toBe('comments')
    expect(scope({ kind: 'review', number: 7 }).row).toBe('comments')
    expect(scope({ ci: true, branch: 'main' }).row).toBe('ci')
    expect(scope({ kind: 'pull' }).observed).toBe(true)
    expect(scope({ kind: 'push' }).row).toBeUndefined()
    expect(scope({ kind: 'push' }).observed).toBe(false)
  })

  it('declares a Markdown channel that deduplicates retries by marker', () => {
    const kind = hostingKind(stub(), META)
    expect(kind.channel?.capabilities).toEqual({ idempotency: 'marker', markdown: true })
  })

  it('links a change through the adapter, using the address\'s project or the instance configuration', () => {
    const kind = hostingKind(stub(), META)
    const url = 'https://gitlab.example.com/team/app/-/merge_requests/7'
    expect(kind.channel!.link({ project: 'team/app', number: '7' }, {})).toEqual({ url, label: { zh: 'GitLab #7', en: 'GitLab #7' } })
    expect(kind.channel!.link({ number: '7' }, {}, config).url).toBe(url)
    expect(kind.channel!.link({ number: '7' }, {}).url).toBe('')
    expect(kind.channel!.link({ project: 'team/app' }, {}).url).toBe('')
  })

  it('posts a note with the marker of the message ID, and refuses an address without a change number', async () => {
    const record: { text?: string; marker?: string } = {}
    const kind = hostingKind(stub(record), META)
    expect(await kind.channel!.send(host, message({ project: 'team/app', number: '7' }))).toBe('sent')
    expect(record.text).toBe('修好了')
    expect(record.marker).toBe('<!-- dsh-superagent:r42 -->')
    expect(record.marker).toBe(hostingMarker('r42'))
    await expect(kind.channel!.send(host, message({ project: 'team/app' }))).rejects.toThrow('Missing hosting reply target')
  })
})