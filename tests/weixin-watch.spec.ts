/** weixin-watch: the listen set it pushes to the backend each round, and what it reports back about it. */
import { describe, expect, it } from 'vitest'
import type { BridgeClient, BridgeInboundOptions, BridgeListenResult } from '../src/sources/chat/weixin/bridge.ts'
import { pollChat, reconcileListen } from '../src/sources/weixin-watch.ts'
import type { SourceContext } from '../src/sources/host.ts'

/** A bridge stub that records every `/listen` call, so a test can prove the call was made or skipped. */
function stub(result: BridgeListenResult = { listening: [], added: [], removed: [], failed: [] }, calls: string[][] = [],
  options: (BridgeInboundOptions | undefined)[] = []): BridgeClient {
  return {
    async health() { return { ok: true, available: true } },
    async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
    async rooms() { return [] },
    async members() { return [] },
    async messages() { return { events: [], next: '' } },
    async send() { return { msgId: 'srv-1', deduped: false } },
    async listen(rooms, inbound) { calls.push([...rooms]); options.push(inbound); return result },
  }
}

const rooms = [{ id: 'wxname_aa', name: '研发-交付群' }, { id: 'wxname_bb', name: '运维群' }]

describe('reconcileListen', () => {
  it('sends the configured ids and reports what the backend confirmed it watches', async () => {
    const calls: string[][] = []
    const bridge = stub({ listening: rooms, added: ['研发-交付群'], removed: [], failed: [] }, calls)
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 2, unresolved: [] })
    // The id is what the configuration holds; the sidecar is what resolves it to a display name.
    expect(calls).toEqual([['wxname_aa', 'wxname_bb']])
  })

  it('carries the inbound switches with the chat set, so a changed switch reaches the sidecar', async () => {
    const calls: string[][] = []
    const options: (BridgeInboundOptions | undefined)[] = []
    await reconcileListen(stub(undefined, calls, options), rooms, { voice: false, images: true })
    expect(calls).toEqual([['wxname_aa', 'wxname_bb']])
    expect(options).toEqual([{ voice: false, images: true }])
  })

  it('sends no options for a caller that names none, which the backend reads as its defaults', async () => {
    const options: (BridgeInboundOptions | undefined)[] = []
    await reconcileListen(stub(undefined, [], options), rooms)
    expect(options).toEqual([undefined])
  })

  it('names the chats the backend could not resolve, instead of counting them as watched', async () => {
    const bridge = stub({ listening: [rooms[0]!], added: [], removed: [], failed: [{ room: 'wxname_bb', detail: 'no such chat' }] })
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 1, unresolved: ['wxname_bb'] })
  })

  it('does nothing when no chat is configured, so a sidecar someone configured on its own is left alone', async () => {
    const calls: string[][] = []
    await expect(reconcileListen(stub(undefined, calls), [])).resolves.toEqual({ watching: 0, unresolved: [] })
    expect(calls).toEqual([])
  })

  it('does nothing for a backend that cannot change its listen set at runtime', async () => {
    const bridge: BridgeClient = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events: [], next: '' } },
      async send() { return { msgId: 'srv-1', deduped: false } },
    }
    await expect(reconcileListen(bridge, rooms)).resolves.toEqual({ watching: 0, unresolved: [] })
  })
})

describe('pollChat canned replies', () => {
  const event = (nativeId: string, text: string) => ({
    nativeId, chatId: 'wxname_group', sender: { id: 'wxname_person', name: '阿黎' }, text, at: '2026-11-08T00:00:00Z',
    ats: [], ownMessage: false, mentionsAgent: false,
  })

  function harness(events: ReturnType<typeof event>[]) {
    const sent: unknown[] = []
    const received: unknown[] = []
    const bridge = {
      async health() { return { ok: true, available: true } },
      async status() { return { loggedIn: true, wxid: 'wxid_self', name: '助手' } },
      async rooms() { return [] },
      async members() { return [] },
      async messages() { return { events, next: '9' } },
      async send(message: unknown) { sent.push(message); return { msgId: 'srv-1', deduped: false } },
    } as unknown as BridgeClient
    const ctx = {
      state: { get: () => '0', set: () => {} },
      receive: async (trigger: unknown) => { received.push(trigger) },
    } as unknown as SourceContext
    return { bridge, ctx, sent, received }
  }

  it('sends the configured text on a keyword hit, and still hands the message to the agent', async () => {
    const { bridge, ctx, sent, received } = harness([event('m1', '请查订单 12345')])
    const rules = [{ any: '订单', reply: '已收到，正在查询。' }]
    await expect(pollChat(ctx, bridge, 'weixin', 'wxname_group', rules)).resolves.toBe(1)
    expect(sent).toEqual([{ room: 'wxname_group', wxid: 'wxname_person', text: '已收到，正在查询。',
      idempotencyKey: 'auto:weixin:m1' }])
    // The template is not a reason to drop what the person said.
    expect(received).toHaveLength(1)
  })

  it('sends nothing without a hit, and nothing for the agent\'s own echo', async () => {
    const miss = harness([event('m2', '今天天气不错')])
    await pollChat(miss.ctx, miss.bridge, 'weixin', 'wxname_group', [{ any: '订单', reply: 'x' }])
    expect(miss.sent).toEqual([])
    expect(miss.received).toHaveLength(1)

    const own = harness([{ ...event('m3', '订单'), ownMessage: true }])
    await pollChat(own.ctx, own.bridge, 'weixin', 'wxname_group', [{ any: '订单', reply: 'x' }])
    expect(own.sent).toEqual([])
    expect(own.received).toEqual([])
  })
})
