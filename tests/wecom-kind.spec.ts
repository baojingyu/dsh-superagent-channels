/** The WeCom SourceKind: its identity and schema, its two-branch reception rule, and its honest at-least-once channel. */
import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { ChannelHost } from '../src/sources/kind.ts'
import type { ChatAdapter } from '../src/sources/chat/port.ts'
import { createWecomKind, wecomAdapter, wecomKind, WecomConfigSchema, type WecomConfigValue } from '../src/sources/chat/wecom/kind.ts'

const CONFIG: WecomConfigValue = WecomConfigSchema.parse({ corpId: 'ww123', corpSecret: 'secret', agentId: '100001' })
const host = (config: WecomConfigValue, instance = 'wecom-ops'): ChannelHost =>
  ({ commands: {} as ChannelHost['commands'], deployment: {} as ChannelHost['deployment'], config, instance })
const message = (address: Record<string, string>): OutboundMessage =>
  ({ id: 'm1', channel: { source: 'wecom', thread: 'wecom:1', address }, text: 'hi', kind: 'reply' })

/** A fake backend that records what it was asked to send, so no test reaches the network. */
function fakeAdapter() {
  const sent: { config: unknown; address: Record<string, string>; text: string; id: string }[] = []
  const adapter: ChatAdapter<WecomConfigValue> = {
    host: 'wecom',
    transports: ['webhook'],
    capabilities: { idempotency: 'none', maxChars: 2048, markdown: false, proactive: true },
    probe: async () => {},
    readThread: async () => ({ events: [] }),
    send: async (config, address, text, id) => { sent.push({ config, address, text, id }); return 'sent' },
    link: () => ({ url: '', label: { zh: '企业微信', en: 'WeCom' } }),
  }
  return { adapter, sent }
}

describe('WeCom kind', () => {
  it('is the wecom kind with only the health entry it reports', () => {
    expect(wecomKind.kind).toBe('wecom')
    expect(wecomKind.health).toEqual(['wecom'])
    expect(wecomKind.title.en).toBe('WeCom')
    expect(wecomKind.description.zh).toContain('公网入口')
    expect(wecomAdapter.transports).toEqual(['webhook'])
  })

  it('builds from the chat factory and its schema fills the defaults and rejects an incomplete or unknown config', () => {
    const defaults = WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: 's', agentId: '1' })
    expect(defaults).toMatchObject({ atOnly: true, pollSeconds: 60 })
    expect(defaults.tokenFile).toBeUndefined()
    expect(defaults.encodingAesKeyFile).toBeUndefined()
    expect(WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: 's', agentId: '1', tokenFile: '/run/secret', encodingAesKeyFile: '/run/aes', atOnly: false, pollSeconds: 5 }))
      .toMatchObject({ tokenFile: '/run/secret', encodingAesKeyFile: '/run/aes', atOnly: false, pollSeconds: 5 })
    expect(() => WecomConfigSchema.parse({ corpSecret: 's', agentId: '1' })).toThrow()
    expect(() => WecomConfigSchema.parse({ corpId: ' ', corpSecret: 's', agentId: '1' })).toThrow()
    expect(() => WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: '', agentId: '1' })).toThrow()
    expect(() => WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: 's', agentId: '' })).toThrow()
    expect(() => WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: 's', agentId: '1', pollSeconds: 4 })).toThrow()
    expect(() => WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: 's', agentId: '1', extra: true })).toThrow()
  })

  it('lists one field per schema key', () => {
    expect(wecomKind.fields.map(field => field.key).sort())
      .toEqual(['agentId', 'atOnly', 'corpId', 'corpSecret', 'encodingAesKeyFile', 'pollSeconds', 'tokenFile'])
  })

  it('listens to a message that mentions the application and only observes one that does not', () => {
    const scope = (meta: Record<string, unknown>, config: WecomConfigValue = CONFIG) => wecomKind.scope!({ meta } as never, config)
    expect(scope({ chatId: 'wr1', mentionsAgent: true })).toEqual({ listened: true, observed: true, row: 'groupAddressed' })
    expect(scope({ chatId: 'wr1', mentionsAgent: false })).toEqual({ listened: false, reason: 'group_ambient', observed: true, row: 'groupAmbient' })
    // With `atOnly` off an unaddressed chat message is listened too, still marked observed as ambient.
    expect(scope({ chatId: 'wr1' }, { ...CONFIG, atOnly: false })).toEqual({ listened: true, observed: true, row: 'groupAmbient' })
    // An application has no direct flag: a message with no chat is a one-to-one conversation.
    expect(scope({})).toEqual({ listened: true, observed: false, row: 'directMessages' })
  })

  it('declares the honest at-least-once capabilities and facts', () => {
    expect(wecomKind.channel!.capabilities).toEqual({ idempotency: 'none', maxChars: 2048, markdown: false, proactive: true })
    const facts = wecomKind.facts!(undefined)
    expect(JSON.stringify(facts)).toContain('重试可能重复')
    expect(JSON.stringify(facts)).toContain('公网入口')
  })

  it('sends through the injected adapter without inventing an idempotency key', async () => {
    const { adapter, sent } = fakeAdapter()
    const kind = createWecomKind(adapter)
    expect(await kind.channel!.send(host(CONFIG), message({ touser: 'zhangsan' }))).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ address: { touser: 'zhangsan' }, text: 'hi', id: 'm1' })
    // The adapter SPI carries the message ID, but the WeCom send ignores it: the platform has no idempotency key.
    expect(wecomKind.channel!.capabilities?.idempotency).toBe('none')
  })

  it('keeps the chat factory\'s allowed policy table keyed by WeCom user IDs', () => {
    expect(wecomKind.policy!.schema.parse({ allowed: [{ id: 'zhangsan', name: '张三' }] }))
      .toEqual({ allowed: [{ id: 'zhangsan', name: '张三' }] })
    expect(() => wecomKind.policy!.schema.parse({ allowed: [{ id: 'zhangsan' }, { id: 'zhangsan' }] })).toThrow()
  })
})
