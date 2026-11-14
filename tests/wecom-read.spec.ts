/** WeCom reads and Thread context: the callback message as a resource, the Trigger it becomes, and the honest parts. */
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { createWecomKind, wecomTriggerOf, WecomConfigSchema } from '../src/sources/chat/wecom/kind.ts'
import { readWecom, wecomRef, wecomReferences, wecomResource } from '../src/sources/chat/wecom/read.ts'
import type { ChatEvent } from '../src/sources/chat/port.ts'

const CONFIG = WecomConfigSchema.parse({ corpId: 'ww1', corpSecret: 's', agentId: '1' })

const trigger = (meta: Record<string, unknown> = {}): Trigger => ({
  id: key('wecom', '42'), source: 'wecom', threads: [{ source: 'wecom', id: 'wr1' }],
  actor: { source: 'wecom', id: 'zhangsan' }, human: true, at: '2026-11-14T01:00:00.000Z', text: '请看一下这个报错',
  meta: { chatId: 'wr1', direct: false, senderId: 'zhangsan', mentionsAgent: true, nativeId: '42', ...meta } } as Trigger)

describe('WeCom references', () => {
  it('resolves a WeCom Trigger and refuses another chat kind\'s Trigger', () => {
    expect(wecomRef(trigger())).toEqual({ triggerId: key('wecom', '42'), messageId: '42' })
    // A WeChat Trigger has `room` and no boolean `mentionsAgent`; it must not resolve as WeCom.
    expect(wecomRef({ ...trigger(), meta: { room: 'r', senderId: 's', nativeId: '42' } } as Trigger)).toBeUndefined()
  })
  it('names the one resource and validates it', () => {
    expect(wecomReferences(wecomRef(trigger())!)).toEqual({ skill: 'dsh-superagent-wecom', message: `wecom/${key('wecom', '42')}/message` })
    expect(wecomResource('wecom/t1/message')).toEqual({ triggerId: 't1' })
    expect(() => wecomResource('wecom/t1/thread')).toThrow(/no history/)
  })
})

describe('readWecom', () => {
  it('reads the callback message, naming an image inline and marking an application echo', () => {
    const read = readWecom(trigger({ media: ['MEDIA-1'] }), `wecom/${key('wecom', '42')}/message`)
    expect(read).toMatchObject({ status: 'ok', next_resource: null,
      message: { id: '42', from: 'zhangsan', text: '请看一下这个报错 [image:MEDIA-1]', images: ['MEDIA-1'] } })
    expect(readWecom({ ...trigger(), human: false } as Trigger, `wecom/${key('wecom', '42')}/message`).message.bot).toBe(true)
  })
})

describe('wecomTriggerOf', () => {
  const event = (overrides: Partial<ChatEvent> = {}): ChatEvent => ({ nativeId: '42', chatId: 'wr1', direct: false, threadRoot: 'wr1',
    sender: { id: 'zhangsan', bot: false }, text: 'hi', at: '2026-11-14T01:00:00.000Z', mentionsAgent: true, ...overrides })
  it('names a group reply by chatid and a direct reply by touser', () => {
    const group = wecomTriggerOf(event(), 'wecom')
    expect(group).toMatchObject({ id: key('wecom', '42'), source: 'wecom', channel: { address: { chatid: 'wr1' } },
      meta: { chatId: 'wr1', direct: false, senderId: 'zhangsan', mentionsAgent: true, nativeId: '42' } })
    const direct = wecomTriggerOf(event({ chatId: 'zhangsan', direct: true }), 'wecom')
    expect(direct.channel!.address).toEqual({ touser: 'zhangsan' })
  })
})

describe('WeCom ThreadContext', () => {
  const context = createWecomKind(undefined as never, async () => ({ bytes: new Uint8Array(), mime: 'image/png' })).threadContext!
  it('answers no_root and no_parent, because a callback carries neither topic nor quote', async () => {
    expect(await context.read({} as never, trigger(), 'root', undefined, CONFIG)).toMatchObject({ messages: [], status: 'no_root' })
    expect(await context.read({} as never, trigger(), 'parent', undefined, CONFIG)).toMatchObject({ messages: [], status: 'no_parent' })
  })
  it('reads the callback\'s own message, with its image marker, and no history', async () => {
    const read = await context.read({} as never, trigger({ media: ['MEDIA-1'] }), 'thread', undefined, CONFIG)
    expect(read.status).toBe('ok')
    expect(read.body).toMatchObject({ history: false })
    expect(read.messages).toEqual([expect.objectContaining({ id: '42', from: 'zhangsan', text: '请看一下这个报错 [image:MEDIA-1]' })])
    expect(context.images!('x [image:MEDIA-1]')).toEqual(['MEDIA-1'])
  })
})
