/** dingtalkKind: identity, schema, structured-`@` reception, capability declaration, and channel wiring over an injected adapter. */
import { beforeEach, describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { ChannelHost } from '../src/sources/kind.ts'
import type { ChatAdapter } from '../src/sources/chat/port.ts'
import { DingTalkConfigSchema, createDingTalkKind, dingtalkKind, rememberDingTalkSelfId } from '../src/sources/chat/dingtalk/kind.ts'
import type { DingTalkKindConfig } from '../src/sources/chat/dingtalk/kind.ts'

const config: DingTalkKindConfig = DingTalkConfigSchema.parse({ clientId: 'app-key', clientSecret: 's3cret', robotCode: 'robot-1' })
const bare: DingTalkKindConfig = DingTalkConfigSchema.parse({ clientId: 'app-key', clientSecret: 's3cret' })
const calls: unknown[] = []
/** A fake adapter: records what the channel hands it, so no test needs a network or the real oapi. */
const adapter: ChatAdapter<DingTalkKindConfig> = {
  host: 'dingtalk',
  transports: ['stream'],
  capabilities: { idempotency: 'none', maxChars: 5000, markdown: true, proactive: false },
  async probe() {},
  async readThread() { return { events: [] } },
  async send(...args) { calls.push(args); return 'sent' },
  link: () => ({ url: '', label: { zh: '钉钉', en: 'DingTalk' } }),
}
beforeEach(() => { rememberDingTalkSelfId(undefined); calls.length = 0 })

describe('dingtalkKind identity and schema', () => {
  it('is the dingtalk kind with its own and the history health entries', () => {
    expect(dingtalkKind.kind).toBe('dingtalk')
    expect(dingtalkKind.health).toEqual(['dingtalk', 'history'])
  })

  it('validates clientId/clientSecret/tokenFile/robotCode/atOnly/pollSeconds, and lists the same keys as fields', () => {
    expect(dingtalkKind.schema.parse({ clientId: 'app-key', clientSecret: 's3cret' }))
      .toEqual({ clientId: 'app-key', clientSecret: 's3cret', atOnly: true, pollSeconds: 5 })
    expect(dingtalkKind.fields.map(field => field.key)).toEqual(['clientId', 'clientSecret', 'tokenFile', 'robotCode', 'atOnly', 'pollSeconds'])
    expect(dingtalkKind.schema.safeParse({ clientId: '', clientSecret: 's3cret' }).success).toBe(false)
    expect(dingtalkKind.schema.safeParse({ clientId: 'app-key', clientSecret: '' }).success).toBe(false)
    expect(dingtalkKind.schema.safeParse({ clientId: 'app-key', clientSecret: 's3cret', pollSeconds: 4 }).success).toBe(false)
    expect(dingtalkKind.schema.safeParse({ clientId: 'app-key', clientSecret: 's3cret', pollSeconds: 3601 }).success).toBe(false)
    expect(dingtalkKind.schema.safeParse({ clientId: 'app-key', clientSecret: 's3cret', atOnly: 'yes' }).success).toBe(false)
    expect(dingtalkKind.schema.safeParse({ clientId: 'app-key', clientSecret: 's3cret', extra: 1 }).success).toBe(false)
  })

  it('puts allowed first in the Policy part and accepts senderStaffIds', () => {
    expect(dingtalkKind.policy!.fields[0]!.key).toBe('allowed')
    expect(dingtalkKind.policy!.schema.parse({})).toEqual({ allowed: [] })
    expect(dingtalkKind.policy!.schema.safeParse({ allowed: [{ id: 'staff-alice' }, { id: 'staff-bob', name: '阿黎' }] }).success).toBe(true)
    expect(dingtalkKind.policy!.schema.safeParse({ allowed: [{ id: 'staff-alice' }, { id: 'staff-alice' }] }).success).toBe(false)
  })
})

describe('dingtalkKind capability declaration', () => {
  it('declares at-least-once delivery (no server-side key), a 5000-character limit, markdown, and no proactive push', () => {
    expect(dingtalkKind.channel!.capabilities).toEqual({ idempotency: 'none', maxChars: 5000, markdown: true, proactive: false })
  })

  it('says in its facts that a retry may send the same message twice', () => {
    const facts = dingtalkKind.facts!(undefined)
    expect(facts.delivery).toEqual({ zh: '出站为至少一次投递：无服务端幂等键，重试可能重复发送。',
      en: 'Outbound delivery is at-least-once: there is no server-side idempotency key, so a retry may send the same message twice.' })
    const rendered = JSON.stringify(facts)
    expect(rendered).toContain('重试可能重复')
    expect(rendered).toContain('may send the same message twice')
  })
})

describe('dingtalkKind scope', () => {
  const kind = createDingTalkKind(adapter)
  it('addresses a group message only when the structured ats list names the bot', () => {
    expect(kind.scope!({ meta: { direct: false, ats: ['staff-alice', 'robot-1'] } }, config))
      .toEqual({ listened: true, observed: true, row: 'groupAddressed' })
  })

  it('filters an unmentioned group message but keeps it observed', () => {
    const result = kind.scope!({ meta: { direct: false, ats: ['staff-alice'] } }, config)
    expect(result).toMatchObject({ listened: false, observed: true, row: 'groupAmbient' })
    expect(result.listened).toBe(false)
  })

  it('always receives a direct message without requiring a mention', () => {
    expect(kind.scope!({ meta: { direct: true } }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
  })

  it("prefers the bot's own staffId learned at runtime over the configured robotCode", () => {
    const hooked = createDingTalkKind(adapter, { selfId: () => 'staff-self' })
    expect(hooked.scope!({ meta: { direct: false, ats: ['staff-self'] } }, bare)).toMatchObject({ listened: true, row: 'groupAddressed' })
    expect(hooked.scope!({ meta: { direct: false, ats: ['robot-1'] } }, config)).toMatchObject({ listened: false, row: 'groupAmbient' })
  })

  it("falls back to the callback's own mentionsAgent when no bot identity is known at all", () => {
    expect(kind.scope!({ meta: { direct: false, ats: [], mentionsAgent: true } }, bare)).toMatchObject({ listened: true, row: 'groupAddressed' })
    expect(kind.scope!({ meta: { direct: false, ats: [], mentionsAgent: false } }, bare)).toMatchObject({ listened: false, row: 'groupAmbient' })
    expect(kind.scope!({ meta: { direct: false, ats: [] } }, bare)).toMatchObject({ listened: false, row: 'groupAmbient' })
  })
})

describe('dingtalkKind channel', () => {
  const host = { config, instance: 'dingtalk' } as unknown as ChannelHost
  const message: OutboundMessage = { id: 'out-1', kind: 'reply', text: '已修复，见 MR !37',
    channel: { source: 'dingtalk', thread: 'dingtalk:cid-1', address: { conversationId: 'cid-1', sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?s=1' } } }

  it('sends through the adapter with the instance config, the address, the text, and the message ID', async () => {
    const kind = createDingTalkKind(adapter)
    await expect(kind.channel!.send(host, message)).resolves.toBe('sent')
    expect(calls).toEqual([[config, { conversationId: 'cid-1', sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?s=1' }, '已修复，见 MR !37', 'out-1']])
  })

  it('links with an empty URL and the DingTalk label', () => {
    expect(dingtalkKind.channel!.link({ conversationId: 'cid-1' }, {})).toEqual({ url: '', label: { zh: '钉钉', en: 'DingTalk' } })
  })
})