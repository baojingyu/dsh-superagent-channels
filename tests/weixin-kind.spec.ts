/** weixinKind: structured-`@` reception, keyed-idempotent replies through the bridge, the allowed list, environment, and facts. */
import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { ChannelHost } from '../src/sources/kind.ts'
import type { SourceHost } from '../src/sources/host.ts'
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
  it('validates every field and lists the same keys as fields', () => {
    expect(weixinKind.schema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self' }))
      .toEqual({ baseUrl: 'http://127.0.0.1:8787', tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self', rooms: [], atOnly: true, pollSeconds: 5,
        timeoutSeconds: 30, keywords: [], autoReplies: [], acknowledge: true, ackText: '收到，正在处理，请稍等。',
        progressAfterSeconds: 180, sendFiles: false, mentionBack: true, voice: true, images: true })
    // The default is deliberately generous: listing chats walks the client's contact pages (~10 s here), so a tight
    // timeout would be reported as "the bridge did not answer" while it is still working.
    expect(weixinKind.fields.map(field => field.key))
      .toEqual(['baseUrl', 'tokenFile', 'selfWxid', 'rooms', 'atOnly', 'keywords', 'autoReplies', 'sendFiles', 'acknowledge',
        'ackText', 'progressAfterSeconds', 'mentionBack', 'voice', 'images', 'pollSeconds', 'timeoutSeconds'])
    expect(weixinKind.kind).toBe('weixin')
    expect(weixinKind.health).toEqual(['weixin'])
  })

  it('rejects empty credentials, malformed IDs, out-of-range poll intervals, and unknown keys', () => {
    expect(weixinKind.schema.safeParse({ tokenFile: '', selfWxid: 'wxid_self' }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'bad wxid' }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', pollSeconds: 4 }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', pollSeconds: 3601 }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', atOnly: 'yes' }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', timeoutSeconds: 4 }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', timeoutSeconds: 301 }).success).toBe(false)
    expect(weixinKind.schema.safeParse({ tokenFile: '/tmp/t', selfWxid: 'wxid_self', extra: 1 }).success).toBe(false)
  })
  it('offers the chats and senders as a picker, because a wxname id cannot be typed by a person', () => {
    // A backend without stable IDs names chats and people `wxname_<hash>`. Those ids keep the patterns strict but nobody can
    // type them, so the rows must be choosable from what `refreshLabels` loaded, and the chat list must be refreshable.
    const rooms = weixinKind.fields.find(field => field.key === 'rooms')
    if (rooms?.type !== 'rows') throw new Error('the rooms field must be a rows field')
    expect(rooms.columns[0]).toMatchObject({
      key: 'id', choose: { zh: '选择桥能看到的会话', en: 'Choose a chat the bridge can see' },
      refresh: { zh: '刷新会话列表', en: 'Refresh chats' },
    })
    const allowed = weixinKind.policy!.fields.find(field => field.key === 'allowed')
    if (allowed?.type !== 'rows') throw new Error('the allowed field must be a rows field')
    expect(allowed.columns[0]).toMatchObject({ key: 'id', choose: { zh: '选择桥见过的发送人', en: 'Choose a sender the bridge has seen' } })
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
  it('admits an un-@ed group message when its text names a configured keyword', () => {
    const withKeywords = { ...config, keywords: [{ any: '订单' }] }
    // The keyword says the group was talking about something this Source cares about, so the message is listened to; it is
    // still an ambient row, because no one mentioned the agent.
    expect(scope({ meta: { room: 'room-1', ats: [] }, text: '帮我查一下订单状态' }, withKeywords))
      .toEqual({ listened: true, observed: true, row: 'groupAmbient' })
    // Case-insensitive, and a miss still filters.
    expect(scope({ meta: { room: 'room-1', ats: [] }, text: 'ORDER 已发货' }, { ...config, keywords: [{ any: 'order' }] }))
      .toEqual({ listened: true, observed: true, row: 'groupAmbient' })
    expect(scope({ meta: { room: 'room-1', ats: [] }, text: '今天天气不错' }, withKeywords))
      .toEqual({ listened: false, reason: 'group_ambient', observed: true, row: 'groupAmbient' })
    // A keyword does not fabricate a mention: an addressed message keeps its stronger row.
    expect(scope({ meta: { room: 'room-1', ats: ['wxid_self'] }, text: '订单' }, withKeywords))
      .toEqual({ listened: true, observed: true, row: 'groupAddressed' })
  })

  it('always receives a direct message', () => {
    expect(scope({ meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
    expect(scope({ meta: { room: '', ats: ['wxid_b'] } }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
  })

  it('records that a backend without structured mentions cannot judge group @s, not that none were found', () => {
    // `group_ambient` would claim the agent looked and saw no `@`; `mentions_unsupported` says it could not look at all,
    // which is the difference between "nobody mentioned you" and "this backend cannot tell".
    const limited = createWeixinKind({ capabilities: () => ({ mentions: 'none', members: 'none', media: true }) }).scope!
    expect(limited({ meta: { room: 'room-1', ats: ['wxid_self'] } }, config))
      .toEqual({ listened: false, reason: 'mentions_unsupported', observed: true, row: 'groupAmbient' })
  })

  it('receives group messages from such a backend once atOnly is off, leaving admission to the rules', () => {
    const limited = createWeixinKind({ capabilities: () => ({ mentions: 'none', members: 'none', media: true }) }).scope!
    expect(limited({ meta: { room: 'room-1' } }, { ...config, atOnly: false }))
      .toEqual({ listened: true, observed: true, row: 'groupAmbient' })
    // A direct message is unaffected: it needs no mention to be addressed to the agent.
    expect(limited({ meta: {} }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
  })

  it('judges a markup backend on its ats list exactly as a structured one, and says so in the facts', () => {
    // `markup` backends do produce `ats`, so reception is identical; only the strength of the proof differs, and that is a
    // fact for a person, not a branch in the scope rule.
    const marked = createWeixinKind({ capabilities: () => ({ mentions: 'markup', members: 'observed', media: true }) })
    expect(marked.scope!({ meta: { room: 'room-1', ats: ['wxid_self'] } }, config))
      .toEqual({ listened: true, observed: true, row: 'groupAddressed' })
    expect(marked.scope!({ meta: { room: 'room-1', ats: [] } }, config))
      .toEqual({ listened: false, reason: 'group_ambient', observed: true, row: 'groupAmbient' })
  })
})

describe('weixinKind channel', () => {
  const host = { config, instance: 'weixin' } as unknown as ChannelHost
  const message: OutboundMessage = { id: 'out-9', kind: 'reply', text: '已修复，见 MR !37',
    channel: { source: 'weixin', thread: 'weixin:room-1', address: { room: 'room-1', wxid: 'wxid_alice', quoteId: 'm1' } } }

  it('declares keyed idempotency and the 2000-character limit', () => {
    expect(weixinKind.channel!.capabilities).toEqual({ idempotency: 'keyed', maxChars: 2000, markdown: false, proactive: true,
    files: { maxBytes: 20 * 1024 * 1024 } })
  })

  it('allows a reply only to a chat the Source receives', () => {
    expect(weixinKind.channel!.allowed!({ room: 'room-1' }, config)).toBe(true)
    expect(weixinKind.channel!.allowed!({ room: 'room-2' }, config)).toBe(false)
  })

  it('allows a reply to a direct message by the person, because a direct chat carries no room', () => {
    // A direct message is one conversation per person and its events have `room: ''`, so the address falls back to the
    // sender. The configuration names that person, which is what the row in the panel holds.
    const withPerson = { ...config, rooms: [{ id: 'wxname_person', name: '<成员>' }] }
    expect(weixinKind.channel!.allowed!({ room: '', wxid: 'wxname_person' }, withPerson)).toBe(true)
    expect(weixinKind.channel!.allowed!({ room: '', wxid: 'wxname_stranger' }, withPerson)).toBe(false)
    // A group reply is still judged on the room alone.
    expect(weixinKind.channel!.allowed!({ room: 'room-1', wxid: 'wxname_person' }, config)).toBe(true)
    expect(weixinKind.channel!.allowed!({ room: 'room-2', wxid: 'wxname_person' }, config)).toBe(false)
  })

  it('sends through the bridge, passing the message ID as the Idempotency-Key', async () => {
    const sent: unknown[] = []
    const kind = createWeixinKind({ client: () => fakeBridge(sent) })
    await expect(kind.channel!.send(host, message)).resolves.toBe('sent')
    // A group reply mentions the sender by id: the sidecar resolves the display name it observed for that id.
    expect(sent).toEqual([{ room: 'room-1', wxid: 'wxid_alice', text: '已修复，见 MR !37', quoteId: 'm1',
      at: ['wxid_alice'], idempotencyKey: 'out-9' }])
  })

  it('mentions the sender only in a group, and only while the switch is on', async () => {
    const group: unknown[] = []
    await createWeixinKind({ client: () => fakeBridge(group) }).channel!.send(host, message)
    expect(group).toMatchObject([{ at: ['wxid_alice'] }])

    // A direct message has no audience to mention: `room` is empty, so nothing is asked for.
    const direct: unknown[] = []
    await createWeixinKind({ client: () => fakeBridge(direct) }).channel!.send(host, {
      ...message, channel: { ...message.channel, address: { wxid: 'wxname_person' } },
    })
    expect(direct).not.toMatchObject([{ at: expect.anything() }])

    // Switched off in the panel: the reply is the text alone.
    const quiet: unknown[] = []
    const off = { ...host, config: { ...(host.config as Record<string, unknown>), mentionBack: false } }
    await createWeixinKind({ client: () => fakeBridge(quiet) }).channel!.send(off, message)
    expect(quiet).not.toMatchObject([{ at: expect.anything() }])
  })

  it('sends a file only when the operator allowed it, the rest after the first', async () => {
    const file = { name: 'chart.png', data: 'iVBORw0KGgo=' }
    const on = { ...host, config: { ...config, sendFiles: true } }
    const withFile: OutboundMessage = { ...message, files: [file, { name: 'second.png', data: 'AAAA' }] }

    const sent: unknown[] = []
    await createWeixinKind({ client: () => fakeBridge(sent) }).channel!.send(on, withFile)
    expect(sent).toMatchObject([{ file }, { text: '', file: { name: 'second.png' } }])
    expect(sent).toHaveLength(2)

    // Off (the default): the text goes, the files do not.
    const off: unknown[] = []
    await createWeixinKind({ client: () => fakeBridge(off) }).channel!.send(host, withFile)
    expect(off).toHaveLength(1)
    expect(off).not.toMatchObject([{ file: expect.anything() }])
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

  it('states how strong the mention proof is, per capability state', () => {
    const factsOf = (mentions: 'structured' | 'markup' | 'none') => createWeixinKind({
      status: () => ({ loggedIn: true, wxid: 'wxid_self', name: '智能助手' }),
      capabilities: () => ({ mentions, members: 'none', media: true }),
    }).facts!(undefined).mentions
    expect(factsOf('structured')).toEqual({ zh: '群 @ 按结构化列表判定', en: 'Group @s are judged on the structured list' })
    // The middle state has to name its own weakness: a person reading "group @s are detected" would treat a forgeable
    // signal as authorization.
    expect(factsOf('markup')).toEqual({
      zh: '群 @ 按客户端标记判定：改本账号昵称即失效，粘贴分隔符可伪造',
      en: "Group @s are judged on the client's own mention markup: renaming this account breaks it, and a pasted separator can forge it",
    })
    expect(factsOf('none')).toEqual({
      zh: '该后端无法判定群 @：群消息只按规则推断，不按 @ 判定',
      en: 'This backend cannot detect group @s: group messages are judged by the rules, never by mentions',
    })
  })

  it('carries the capabilities a status read recorded, and drops them when a later read omits them', () => {
    rememberWeixinStatus({ loggedIn: true, wxid: 'wxid_self', name: '助手' }, { mentions: 'none', members: 'none', media: true })
    expect(weixinKind.facts!(undefined).mentions).toMatchObject({ zh: '该后端无法判定群 @：群消息只按规则推断，不按 @ 判定' })
    // A sidecar that stops reporting capabilities is read as capable again: "did not say" is not "said it cannot".
    rememberWeixinStatus({ loggedIn: true, wxid: 'wxid_self', name: '助手' })
    expect(weixinKind.facts!(undefined).mentions).toMatchObject({ zh: '群 @ 按结构化列表判定' })
  })
})

describe('weixinKind labels', () => {
  it('resolves the wxname ids a backend without chat IDs emits into display names, and stores them', async () => {
    // A backend that has no chatroomId names its chats and people `wxname_<hash>` so the id patterns stay strict; without
    // this the panel would show hashes where a person expects a group name.
    const stored: Array<[string, unknown]> = []
    const bridge: BridgeClient = {
      ...fakeBridge([]),
      async rooms() { return [{ id: 'wxname_aa', name: '<群名>' }] },
      async members() { return [{ id: 'wxname_bb', name: '老婆' }] },
    }
    const host = {
      context: () => ({ config: () => config, state: { set: (key: string, value: unknown) => { stored.push([key, value]) } } }),
    } as unknown as SourceHost
    const labels = await createWeixinKind({ client: () => bridge }).refreshLabels!(host)
    expect(labels).toEqual({ wxname_aa: '<群名>', wxname_bb: '老婆' })
    expect(stored).toHaveLength(1)
    expect(stored[0]![1]).toEqual({ wxname_aa: '<群名>', wxname_bb: '老婆' })
  })

  it('answers nothing when the Source is off, so the stored labels are left alone', async () => {
    const host = {
      context: () => ({ config: () => undefined, state: { set: () => { throw new Error('must not write') } } }),
    } as unknown as SourceHost
    await expect(createWeixinKind({ client: () => fakeBridge([]) }).refreshLabels!(host)).resolves.toEqual({})
  })
})