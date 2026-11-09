/**
 * A refusal notice goes to a conversation, never to somebody's work item.
 *
 * Reported: sixteen comments reading "这条我没有接：你的账号不在允许名单里。" landed on other people's requirements, tasks and bugs.
 * The notice was written for a chat; a work item is a public record, and a comment there is noise that also broadcasts the
 * Source's configuration. The channel now declares whether it takes notices, and the registry refuses them for a Source that
 * does not - one chokepoint, before any kind code runs.
 */
import { describe, expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { projexKind } from '../src/sources/work/projex/kind.ts'
import { weixinKind } from '../src/sources/chat/weixin/kind.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'

const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)

/** A kind whose channel records what it was asked to send, standing in for any chat host. */
function recording(sent: OutboundMessage[], acceptsNotice: boolean): SourceKind<Record<string, unknown>> {
  return {
    kind: 'chatrec', title: { zh: '聊天', en: 'Chat' }, description: { zh: '', en: '' },
    schema: SettingsSchema.pick({}).passthrough() as never, fields: [], health: ['chatrec'],
    channel: {
      ...(acceptsNotice ? { acceptsNotice: true } : {}),
      capabilities: { idempotency: 'keyed' },
      send: async (_host, message) => { sent.push(message); return 'sent' },
      link: () => ({ url: '', label: { zh: '', en: '' } }),
    },
  }
}

const message = (source: string, kind: 'notice' | 'reply'): OutboundMessage => ({
  id: `${source}:${kind}`, kind, channel: { source, thread: `${source}:t`, address: {} }, text: '这条我没有接：你的账号不在允许名单里。',
})

const settingsWith = (sources: Record<string, unknown>) => SettingsSchema.parse({ sources })

describe('refusal notices only reach a conversation', () => {
  it('never sends one to a work item, so no requirement or bug is commented on', async () => {
    const settings = settingsWith({ projex: { enabled: true,
      config: { project: 'proj-1', tokenFile: '/tmp/projex.token', organizationId: 'org-1' } } })
    const registry = new SourceRegistry(() => settings)
    registry.register(projexKind)
    // Refused before the kind's own channel code runs: `'gone'` settles the receipt, nothing reaches Yunxiao.
    await expect(registry.send(message('projex', 'notice'), commands())).resolves.toBe('gone')
  })

  it('sends one to a chat, which is where a person wrote to the agent', async () => {
    const settings = settingsWith({ chatrec: { enabled: true, config: {} } })
    const sent: OutboundMessage[] = []
    const registry = new SourceRegistry(() => settings)
    registry.register(recording(sent, true))
    await expect(registry.send(message('chatrec', 'notice'), commands())).resolves.toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('still refuses a notice for a channel that never said it takes them', async () => {
    const settings = settingsWith({ chatrec: { enabled: true, config: {} } })
    const sent: OutboundMessage[] = []
    const registry = new SourceRegistry(() => settings)
    registry.register(recording(sent, false))
    await expect(registry.send(message('chatrec', 'notice'), commands())).resolves.toBe('gone')
    expect(sent).toHaveLength(0)
    // A real reply is untouched: only notices are gated.
    await expect(registry.send(message('chatrec', 'reply'), commands())).resolves.toBe('sent')
    expect(sent).toHaveLength(1)
  })

  it('answers the Engine up front, so an ignored backlog does not queue rows that can only be dropped', () => {
    const settings = settingsWith({
      projex: { enabled: true, config: { project: 'proj-1', tokenFile: '/tmp/projex.token', organizationId: 'org-1' } },
      chatrec: { enabled: true, config: {} },
    })
    const registry = new SourceRegistry(() => settings)
    registry.register(projexKind)
    registry.register(recording([], true))
    expect(registry.acceptsNotice('projex')).toBe(false)
    expect(registry.acceptsNotice('chatrec')).toBe(true)
    // An unknown source takes none.
    expect(registry.acceptsNotice('nope')).toBe(false)
  })

  it('declares the flag where it belongs: chats opt in, work items do not', () => {
    expect(weixinKind.channel?.acceptsNotice).toBe(true)
    // `workKind` builds the work channels; none of them takes a notice.
    expect(projexKind.channel?.acceptsNotice).toBeUndefined()
  })
})
