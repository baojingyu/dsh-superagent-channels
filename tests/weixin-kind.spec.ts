/** weixinKind: structured-`@` reception, keyed-idempotent replies through the bridge, the allowed list, environment, and facts. */
import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { ChannelHost } from '../src/sources/kind.ts'
import type { BridgeClient } from '../src/sources/chat/weixin/bridge.ts'
import { WeixinConfigSchema, createWeixinKind, rememberWeixinStatus, weixinKind } from '../src/sources/chat/weixin/kind.ts'
import type { WeixinConfig } from '../src/sources/chat/weixin/kind.ts'

const config: WeixinConfig = WeixinConfigSchema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self', rooms: [{ id: 'room-1', name: 'Ops' }] })

/** A bridge stub: records sends and answers status, so no test reaches the network. */
function fakeBridge(sent: unknown[], result: 'sent' | 'gone' = 'sent'): BridgeClient {
  return {
    async health() { return { ok: true, available: true } },
    async status() { return { loggedIn: true, wxid: 'wxid_self', name: '智能助手' } },
    async rooms() { return [] },
    async members() { return [] },
    async messages() { return { events: [], next: '' } },
    async send(message) { sent.push(message); return result === 'gone' ? 'gone' : { msgId: 'srv-1', deduped: false } },
  }
}

describe('weixinKind schema and fields', () => {
  it('validates baseUrl/tokenFile/selfWxid/rooms/atOnly/pollSeconds and lists the same keys as fields', () => {
    expect(weixinKind.schema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self' }))
      .toEqual({ baseUrl: 'http://127.0.0.1:8787', tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self', rooms: [], atOnly: true, pollSeconds: 5 })
    expect(weixinKind.fields.map(field => field.key)).toEqual(['baseUrl', 'tokenFile', 'selfWxid', 'rooms', 'atOnly', 'pollSeconds'])
    expect(weixinKind.kind).toBe('weixin')
    expect(weixinKind.health).toEqual(['weixin'])
  })

  it('rejects empty credentials, malformed IDs, out-of-range poll intervals, and unknown keys', () => {
    expect(weixinKind.schema.safeParse({ tokenFile: '', selfWxid: 'wxid_self' }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'bad wxid' }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', pollSeconds: 4 }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', pollSeconds: 3601 }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', atOnly: 'yes' }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', extra: 1 }).success).toBe(false)
  })
})

describe('weixinKind scope', () => {
  const scope = weixinKind.scope!
  it('addresses a group message only when the structured ats list names this account', () => {
    expect(scope({ meta: { room: 'room-1', ats: ['wxid_b', 'wxid_self'] } }, config))
      .toEqual({ listened: true, observed: true, row: 'groupAddressed' })
  })
  it('leaves an unmentioned group message ambient, and unlistened while atOnly is on', () => {
    // `reason` is what Intake records for the filter; the plan's observed/row fields say it stays Thread-context material.
    expect(scope({ meta: { room: 'room-1', ats: ['wxid_b'] } }, config))
      .toEqual({ listened: false, reason: 'group_ambient', observed: true, row: 'groupAmbient' })
    expect(scope({ meta: { room: 'room-1' } }, config))
      .toEqual({ listened: false, reason: 'group_ambient', observed: true, row: 'groupAmbient' })
  })
  it('receives ambient group messages when atOnly is off', () => {
    expect(scope({ meta: { room: 'room-1', ats: ['wxid_b'] } }, { ...config, atOnly: false }))
      .toEqual({ listened: true, observed: true, row: 'groupAmbient' })
  })
  it('always receives a direct message', () => {
    expect(scope({ meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
    expect(scope({ meta: { room: '', ats: ['wxid_b'] } }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
  })

  it('records that a backend without structured mentions cannot judge group @s, not that none were found', () => {
    // `group_ambient` would claim the agent looked and saw no `@`; `mentions_unsupported` says it could not look at all,
    // which is the difference between "nobody mentioned you" and "this backend cannot tell".
    const limited = createWeixinKind({ capabilities: () => ({ mentions: false, members: false, media: true }) }).scope!
    expect(limited({ meta: { room: 'room-1', ats: ['wxid_self'] } }, config))
      .toEqual({ listened: false, reason: 'mentions_unsupported', observed: true, row: 'groupAmbient' })
  })

  it('receives group messages from such a backend once atOnly is off, leaving admission to the rules', () => {
    const limited = createWeixinKind({ capabilities: () => ({ mentions: false, members: false, media: true }) }).scope!
    expect(limited({ meta: { room: 'room-1' } }, { ...config, atOnly: false }))
      .toEqual({ listened: true, observed: true, row: 'groupAmbient' })
    // A direct message is unaffected: it needs no mention to be addressed to the agent.
    expect(limited({ meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
  })
})

describe('weixinKind channel', () => {
  const host = { config, instance: 'weixin' } as unknown as ChannelHost
  const message: OutboundMessage = { id: 'out-9', kind: 'reply', text: '已修复，见 MR !37',
    channel: { source: 'weixin', thread: 'weixin:room-1', address: { room: 'room-1', wxid: 'wxid_alice', quoteId: 'm1' } } }

  it('declares keyed idempotency and the 2000-character limit', () => {
    expect(weixinKind.channel!.capabilities).toEqual({ idempotency: 'keyed', maxChars: 2000, markdown: false, proactive: true })
  })

  it('allows a reply only to a chat the Source receives', () => {
    expect(weixinKind.channel!.allowed!({ room: 'room-1' }, config)).toBe(true)
    expect(weixinKind.channel!.allowed!({ room: 'room-2' }, config)).toBe(false)
  })

  it('sends through the bridge, passing the message ID as the Idempotency-Key', async () => {
    const sent: unknown[] = []
    const kind = createWeixinKind({ client: () => fakeBridge(sent) })
    await expect(kind.channel!.send(host, message)).resolves.toBe('sent')
    expect(sent).toEqual([{ room: 'room-1', wxid: 'wxid_alice', text: '已修复，见 MR !37', quoteId: 'm1', idempotencyKey: 'out-9' }])
  })

  it("maps a bridge 'gone' to the channel's gone result", async () => {
    const sent: unknown[] = []
    const kind = createWeixinKind({ client: () => fakeBridge(sent, 'gone') })
    await expect(kind.channel!.send(host, message)).resolves.toBe('gone')
    expect(sent).toHaveLength(1)
  })
})

describe('weixinKind policy', () => {
  it('puts allowed first and accepts wxid lists while refusing duplicates and malformed IDs', () => {
    expect(weixinKind.policy!.fields[0]!.key).toBe('allowed')
    expect(weixinKind.policy!.schema.parse({})).toEqual({ allowed: [] })
    expect(weixinKind.policy!.schema.safeParse({ allowed: [{ id: 'wxid_a' }, { id: 'wxid_b', name: '阿黎' }] }).success).toBe(true)
    expect(weixinKind.policy!.schema.safeParse({ allowed: [{ id: 'bad wxid' }] }).success).toBe(false)
    expect(weixinKind.policy!.schema.safeParse({ allowed: [{ id: 'wxid_a' }, { id: 'wxid_a' }] }).success).toBe(false)
  })
})

describe('weixinKind environment and facts', () => {
  it('exposes the trigger chat and sender only for weixin triggers', () => {
    const environment = weixinKind.environment!
    const values = (input: unknown): Record<string, string> => environment.values(input as never)
    expect(environment.variables.map(variable => variable.key)).toEqual(['DSH_SUPERAGENT_WEIXIN_ROOM', 'DSH_SUPERAGENT_WEIXIN_SENDER'])
    expect(values({ deployment: undefined, config, trigger: { source: 'weixin', meta: { room: 'room-1', senderId: 'wxid_alice' }, actor: { source: 'weixin', id: 'wxid_alice' } } }))
      .toEqual({ DSH_SUPERAGENT_WEIXIN_ROOM: 'room-1', DSH_SUPERAGENT_WEIXIN_SENDER: 'wxid_alice' })
    expect(values({ deployment: undefined, config, trigger: { source: 'github', meta: {}, actor: { source: 'github', id: 'octocat' } } }))
      .toEqual({ DSH_SUPERAGENT_WEIXIN_ROOM: '', DSH_SUPERAGENT_WEIXIN_SENDER: '' })
  })

  it('reports the account facts from the bridge status, and Not connected when there is none', () => {
    const capable = { zh: '群 @ 按结构化列表判定', en: 'Group @s are judged on the structured list' }
    const connected = createWeixinKind({ status: () => ({ loggedIn: true, wxid: 'wxid_self', name: '智能助手' }) })
    expect(connected.facts!(undefined)).toEqual({ account: { zh: '已登录：智能助手', en: 'Signed in as 智能助手' }, mentions: capable })
    const silent = createWeixinKind({ status: () => undefined })
    expect(silent.facts!(undefined)).toEqual({ account: { zh: '未连接', en: 'Not connected' }, mentions: capable })

    rememberWeixinStatus({ loggedIn: true, wxid: 'wxid_self', name: '助手' })
    expect(weixinKind.facts!(undefined)).toEqual({ account: { zh: '已登录：助手', en: 'Signed in as 助手' }, mentions: capable })
    rememberWeixinStatus({ loggedIn: false, wxid: 'wxid_self', name: '助手' })
    expect(weixinKind.facts!(undefined)).toEqual({ account: { zh: '未连接', en: 'Not connected' }, mentions: capable })
  })

  it('states the mention limitation a backend reported, instead of claiming group @s were checked', () => {
    // pc-uia on WeChat 4.x: the message bubble is a flat accessibility leaf, so no backend can produce `ats` there.
    const limited = createWeixinKind({
      status: () => ({ loggedIn: true, wxid: 'wxid_self', name: '智能助手' }),
      capabilities: () => ({ mentions: false, members: false, media: true }),
    })
    expect(limited.facts!(undefined)).toEqual({
      account: { zh: '已登录：智能助手', en: 'Signed in as 智能助手' },
      mentions: { zh: '该后端无法判定群 @：群消息只按规则推断，不按 @ 判定', en: 'This backend cannot detect group @s: group messages are judged by the rules, never by mentions' },
    })
  })

  it('carries the capabilities a status read recorded, and drops them when a later read omits them', () => {
    rememberWeixinStatus({ loggedIn: true, wxid: 'wxid_self', name: '助手' }, { mentions: false, members: false, media: true })
    expect(weixinKind.facts!(undefined).mentions).toMatchObject({ zh: '该后端无法判定群 @：群消息只按规则推断，不按 @ 判定' })
    // A sidecar that stops reporting capabilities is read as capable again: "did not say" is not "said it cannot".
    rememberWeixinStatus({ loggedIn: true, wxid: 'wxid_self', name: '助手' })
    expect(weixinKind.facts!(undefined).mentions).toMatchObject({ zh: '群 @ 按结构化列表判定' })
  })
})