/** WeChat worker-facing reads and Thread context: references, the resource grammar, and each read shape. */
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { weixinKind } from '../src/sources/chat/weixin/kind.ts'
import { readWeixin, weixinRef, weixinReferences, weixinResource } from '../src/sources/chat/weixin/read.ts'
import { weixinThreadContext } from '../src/sources/chat/weixin/thread.ts'
import type { BridgeClient } from '../src/sources/chat/weixin/bridge.ts'
import type { ChatEvent } from '../src/sources/chat/port.ts'

const event = (overrides: Partial<ChatEvent> & { nativeId: string }): ChatEvent => ({
  chatId: 'room1', direct: false, threadRoot: 'room1',
  sender: { id: 'wxid_b', name: 'Bob', bot: false }, text: `text ${overrides.nativeId}`, at: '2026-11-14T01:00:00.000Z', ...overrides })
const trigger = (meta: Record<string, unknown> = {}): Trigger => ({
  id: 'weixin:m1', source: 'weixin', threads: [{ source: 'weixin', id: 'room1' }],
  actor: { source: 'weixin', id: 'wxid_a' }, human: true, at: '2026-11-14T01:00:00.000Z', text: '能给我个临时链接吗',
  meta: { room: 'room1', senderId: 'wxid_a', nativeId: 'm1', ats: [], ...meta } } as Trigger)
/** A bridge whose `/messages` answers from pages keyed by cursor (`''` is the first page). */
function fakeBridge(pages: Record<string, { events: ChatEvent[]; next: string }>): BridgeClient {
  return { messages: async (_room: string, cursor: string | undefined) => pages[cursor ?? ''] ?? { events: [], next: '' },
    health: async () => ({ ok: true, available: true }), status: async () => ({ loggedIn: true, wxid: 'wxid_a', name: 'Me' }),
    rooms: async () => [], members: async () => [], send: async () => ({ msgId: 'x', deduped: false }) } as unknown as BridgeClient
}

describe('WeChat references', () => {
  it('resolves a WeChat Trigger and refuses one of another chat kind', () => {
    expect(weixinRef(trigger())).toMatchObject({ triggerId: 'weixin:m1', room: 'room1', messageId: 'm1' })
    // A Trigger without the WeChat-specific senderId is not ours, even when it carries a room-like meta.
    expect(weixinRef({ ...trigger(), meta: { room: 'room1', nativeId: 'm1' } } as Trigger)).toBeUndefined()
    // Nor is one without `room`, the field the WeChat watch always sets (DingTalk and WeCom use `chatId` instead).
    expect(weixinRef({ ...trigger(), meta: { senderId: 'wxid_a', nativeId: 'm1' } } as Trigger)).toBeUndefined()
  })
  it('names the resources anchored to a Trigger and validates them', () => {
    expect(weixinReferences(weixinRef(trigger())!)).toEqual({ skill: 'dsh-superagent-weixin',
      message: 'weixin/weixin:m1/message', thread: 'weixin/weixin:m1/thread', around: 'weixin/weixin:m1/around' })
    expect(weixinResource('weixin/t1/thread/c2')).toEqual({ triggerId: 't1', section: 'thread', cursor: 'c2' })
    expect(weixinResource('weixin/t1/message')).toEqual({ triggerId: 't1', section: 'message', cursor: undefined })
    expect(() => weixinResource('weixin/t1/message/x')).toThrow(/message/)
    expect(() => weixinResource('weixin/t1/root')).toThrow(/thread or \/around/)
  })
})

describe('readWeixin', () => {
  it('reads the Trigger\'s own message with its image markers, and marks an agent echo', async () => {
    const read = await readWeixin(fakeBridge({}), trigger({ media: ['img-1'] }), 'weixin/weixin:m1/message')
    expect(read).toMatchObject({ status: 'ok', message: { id: 'm1', from: 'wxid_a', text: '能给我个临时链接吗 [image:img-1]',
      images: ['img-1'] } })
    const echo = await readWeixin(fakeBridge({}), { ...trigger(), human: false } as Trigger, 'weixin/weixin:m1/message')
    expect(echo.message?.bot).toBe(true)
  })
  it('pages the conversation and hands back the resource for the next page', async () => {
    const bridge = fakeBridge({ '': { events: [event({ nativeId: 'm1' }), event({ nativeId: 'm2', ownMessage: true })], next: 'c2' },
      c2: { events: [event({ nativeId: 'm3' })], next: '' } })
    const first = await readWeixin(bridge, trigger(), 'weixin/weixin:m1/thread', 2)
    expect(first.messages?.map(message => message.id)).toEqual(['m1', 'm2'])
    expect(first.messages?.[1]?.bot).toBe(true)
    expect(first.next_resource).toBe('weixin/weixin:m1/thread/c2')
    const second = await readWeixin(bridge, trigger(), 'weixin/weixin:m1/thread/c2', 2)
    expect(second.messages?.map(message => message.id)).toEqual(['m3'])
    expect(second.next_resource).toBeNull()
  })
  it('finds the page that holds the Trigger for /around, and says so when it cannot', async () => {
    const bridge = fakeBridge({ '': { events: [event({ nativeId: 'm2' })], next: 'c2' },
      c2: { events: [event({ nativeId: 'm1' })], next: 'c3' } })
    const found = await readWeixin(bridge, trigger(), 'weixin/weixin:m1/around', 1)
    expect(found.status).toBe('ok')
    expect(found.messages?.map(message => message.id)).toEqual(['m1'])
    expect(found.next_resource).toBe('weixin/weixin:m1/around/c3')
    const missing = await readWeixin(fakeBridge({ '': { events: [event({ nativeId: 'zzz' })], next: '' } }), trigger(),
      'weixin/weixin:m1/around', 1)
    expect(missing).toEqual({ status: 'not_found', messages: [], next_resource: null })
  })
  it('reads a direct conversation through its thread id, and reports no room only when it has neither', async () => {
    const direct = await readWeixin(fakeBridge({ '': { events: [event({ nativeId: 'm1', chatId: '', direct: true })], next: '' } }),
      trigger({ room: '' }), 'weixin/weixin:m1/thread')
    expect(direct.status).toBe('ok')
    expect(direct.messages?.map(message => message.id)).toEqual(['m1'])
    const orphan = await readWeixin(fakeBridge({}), { ...trigger({ room: '' }), threads: [] } as Trigger, 'weixin/weixin:m1/thread')
    expect(orphan).toEqual({ status: 'no_room', messages: [], next_resource: null })
  })
})

describe('weixinThreadContext parts', () => {
  const context = weixinThreadContext(fakeBridge({ '': { events: [event({ nativeId: 'm1' }), event({ nativeId: 'm2', parentId: 'm1' })], next: '' } }))
  it('answers no_root, because a WeChat conversation has no topic above the message', async () => {
    expect(await context.read({} as never, trigger(), 'root', undefined, {})).toMatchObject({ messages: [], status: 'no_root' })
  })
  it('answers no_parent when the backend reported none, and finds the parent when it did', async () => {
    expect(await context.read({} as never, trigger(), 'parent', undefined, {})).toMatchObject({ messages: [], status: 'no_parent' })
    const withParent = fakeBridge({ '': { events: [event({ nativeId: 'm1' })], next: '' } })
    const read = await weixinThreadContext(withParent).read({} as never, trigger({ parentId: 'm1' }), 'parent', undefined, {})
    expect(read).toMatchObject({ status: 'ok' })
    expect(read.messages.map(message => message.id)).toEqual(['m1'])
  })
  it('reads the conversation page, marking the agent\'s own echo', async () => {
    const read = await context.read({} as never, trigger(), 'thread', undefined, { readPageSize: 2 })
    expect(read.messages.map(message => message.id)).toEqual(['m1', 'm2'])
    expect(read.status).toBe('ok')
  })
})

describe('weixinKind search and reply mapping', () => {
  it('turns a platform message ID into a search term', () => {
    expect(weixinKind.find!('abc12345')).toEqual({ threads: [], terms: ['abc12345'] })
    expect(weixinKind.find!('看这个')).toEqual({ threads: [], terms: [] })
  })
  it('names the Trigger a message answers, so the thread shows the exchange', () => {
    expect(weixinKind.repliesTo!({ ...trigger(), meta: { ...trigger().meta, parentId: 'm0' } } as Trigger)).toBe(key('weixin', 'm0'))
    expect(weixinKind.repliesTo!(trigger())).toBeUndefined()
  })
})
