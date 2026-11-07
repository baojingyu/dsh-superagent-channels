/** Several instances of one Source kind: each with its own configuration, its own outbound host, and its own health. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import type { ChannelHost, SourceKind } from '../src/sources/kind.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { githubKind } from '../src/sources/github.ts'
import { policyOf } from '../src/app/views/settings.ts'
import { sourcesStatus } from '../src/app/views/sources.ts'
import { Store } from '../src/app/store.ts'
import type { ChannelRef } from '../src/core/index.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A minimal kind whose Channel records the host it receives and whose link reads the instance's configuration. */
function wecomKind(sent: ChannelHost[]): SourceKind<{ room: string }> {
  return {
    kind: 'wecom', title: { zh: '企微', en: 'WeCom' }, description: { zh: '', en: '' }, health: ['wecom'],
    schema: z.object({ room: z.string().default('') }).strict(),
    fields: [],
    channel: {
      send: async host => { sent.push(host); return 'sent' },
      link: (_address, _links, config) => ({ url: `https://wecom/${config?.room ?? ''}`, label: { zh: '企微', en: 'WeCom' } }),
    },
  }
}
/** Two instances of one kind, each with its own settings key. */
const twoInstances = () => SettingsSchema.parse({ sources: {
  'wecom-ops': { kind: 'wecom', enabled: true, config: { room: 'ops' } },
  'wecom-hr': { kind: 'wecom', enabled: true, config: { room: 'hr' } },
} })
const reply = (source: string): OutboundMessage => ({ id: 'r1', channel: { source, thread: `${source}:1`, address: { room: 'r' } }, text: 'hi', kind: 'reply' })

describe('Source instances', () => {
  it('resolves every instance of one kind to its own configuration, and lists them all', () => {
    const sources = new SourceRegistry(twoInstances)
    sources.register(wecomKind([]))
    expect(sources.instance('wecom-ops')).toEqual({ id: 'wecom-ops', kind: 'wecom', enabled: true, config: { room: 'ops' } })
    expect(sources.instance('wecom-hr')).toEqual({ id: 'wecom-hr', kind: 'wecom', enabled: true, config: { room: 'hr' } })
    expect(sources.instances()).toEqual([
      { id: 'wecom-hr', kind: 'wecom', enabled: true, config: { room: 'hr' }, installed: true },
      { id: 'wecom-ops', kind: 'wecom', enabled: true, config: { room: 'ops' }, installed: true },
    ])
  })
  it('keeps a stored instance without a kind as its kind\'s default instance, and adds the default of a registered kind with no settings', () => {
    const legacy = new SourceRegistry(() => SettingsSchema.parse({ sources: { github: { enabled: true, config: {} } } }))
    legacy.register(githubKind)
    expect(legacy.instances()).toMatchObject([{ id: 'github', kind: 'github', enabled: true, installed: true }])
    expect(legacy.instance('github')).toMatchObject({ id: 'github', kind: 'github', enabled: true, config: { repository: '' } })
    const bare = new SourceRegistry(() => SettingsSchema.parse({}))
    bare.register(githubKind)
    expect(bare.instances()).toMatchObject([{ id: 'github', kind: 'github', enabled: true, installed: true }])
    expect(bare.instance('github')).toMatchObject({ id: 'github', kind: 'github', config: { repository: '' } })
  })
  it('reports each instance\'s health entries under its own key, without throwing', () => {
    const board = new HealthBoard()
    const sources = new SourceRegistry(twoInstances, board)
    sources.register(wecomKind([]))
    const context = (id: string) => sourceContextOf({ sources } as unknown as SourceContextDeps, { id, kind: 'wecom', health: ['wecom'] })
    expect(() => context('wecom-ops').report('wecom', { state: 'ready', detail: 'ops is listening' })).not.toThrow()
    context('wecom-hr').report('wecom', { state: 'error', detail: 'hr is down' })
    expect(board.all['wecom-ops:wecom']).toMatchObject({ state: 'ready', detail: 'ops is listening' })
    expect(board.all['wecom-hr:wecom']).toMatchObject({ state: 'error', detail: 'hr is down' })
    expect(board.all['wecom-ops:wecom']).not.toEqual(board.all['wecom-hr:wecom'])
    // A report is still restricted to the entries the kind declares.
    expect(() => context('wecom-ops').report('history', { state: 'ready', detail: '' })).toThrow('has no health entry history')
  })
  it('gives the Channel the configuration and ID of the instance that sends, and the same config to its link', async () => {
    const sent: ChannelHost[] = []
    const sources = new SourceRegistry(twoInstances)
    sources.register(wecomKind(sent))
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
    expect(await sources.send(reply('wecom-hr'), commands)).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]!.instance).toBe('wecom-hr')
    expect(sent[0]!.config).toEqual({ room: 'hr' })
    expect(sent[0]!.commands).toBe(commands)
    expect(sent[0]!.deployment.repository).toBe('acme/widgets')
    expect(sources.link({ source: 'wecom-ops', thread: 'wecom-ops:1', address: { room: 'r' } }, {})).toMatchObject({ url: 'https://wecom/ops' })
  })
})

describe('Policy blocks per instance', () => {
  it('keeps a named instance\'s policy block, reading its own stored part first and its kind\'s part otherwise', () => {
    const settings = SettingsSchema.parse({ sources: { 'feishu-hr': { kind: 'feishu', enabled: true, config: {} } },
      policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' } } } })
    const sources = new SourceRegistry(() => settings)
    sources.register(feishuKind)
    // Without a part of its own, a named instance reads the part its kind stores (`sync.ready` follows `syncChat`).
    expect(policyOf(settings, sources, 'feishu-hr', {})).toMatchObject({ policy: {
      explicit: feishuKind.policy!.explicit, fields: feishuKind.policy!.fields, sync: { ready: true } } })
    // Its own stored part wins over the kind's.
    const own = SettingsSchema.parse({ sources: { 'feishu-hr': { kind: 'feishu', enabled: true, config: {} } },
      policy: { sources: { 'feishu-hr': { allowed: [], syncChat: '' }, feishu: { allowed: [{ id: 'ou_alice' }], syncChat: 'oc_team' } } } })
    const ownSources = new SourceRegistry(() => own)
    ownSources.register(feishuKind)
    expect(policyOf(own, ownSources, 'feishu-hr', {})).toMatchObject({ policy: { sync: { ready: false } } })
    // A default instance still reads the part under its own name, which is its kind.
    const legacy = SettingsSchema.parse({ sources: { feishu: { enabled: true, config: {} } },
      policy: { sources: { feishu: { allowed: [{ id: 'ou_alice', name: 'Alice' }], syncChat: 'oc_team' } } } })
    const legacySources = new SourceRegistry(() => legacy)
    legacySources.register(feishuKind)
    expect(policyOf(legacy, legacySources, 'feishu', {})).toEqual(policyOf(settings, sources, 'feishu-hr', {}))
  })
})

/** A kind whose schema requires a field, so `schema.parse({})` cannot fill a default. */
const requiredKind: SourceKind<{ key: string }> = {
  kind: 'strict', title: { zh: '必填', en: 'Strict' }, description: { zh: '', en: '' }, health: ['strict'],
  schema: z.object({ key: z.string().min(1) }).strict(), fields: [],
}

describe('Unconfigured required kinds', () => {
  it('returns a disabled default instance instead of throwing when a defaulted-free schema needs a field', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(requiredKind)
    expect(() => sources.instances()).not.toThrow()
    expect(sources.instances()).toEqual([{ id: 'strict', kind: 'strict', enabled: false, config: {}, installed: true }])
    expect(sources.instance('strict')).toEqual({ id: 'strict', kind: 'strict', enabled: false, config: {} })
    // A kind whose schema fills its defaults keeps the old behaviour: a default instance that stays enabled.
    const defaults = new SourceRegistry(() => SettingsSchema.parse({}))
    defaults.register(githubKind)
    expect(defaults.instances()).toMatchObject([{ id: 'github', kind: 'github', enabled: true, installed: true }])
  })

  it('shows the unconfigured kind as an off row in the panel instead of throwing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-registry-instances-'))
    const store = new Store(join(directory, 'orchestrator.sqlite'))
    try {
      store.saveSettings(SettingsSchema.parse({}))
      const sources = new SourceRegistry(() => store.settings())
      sources.register(requiredKind)
      const links = (channel: ChannelRef) => ({ url: '', label: { zh: channel.source, en: channel.source } })
      const rows = sourcesStatus({ store, sources, links }, {}, {})
      expect(rows.map(row => [row.id, row.enabled, row.state])).toEqual([['strict', false, 'off']])
    } finally {
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
