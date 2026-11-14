/** DingTalk worker reads and Thread context: one stream callback, and the parts that say there is no history. */
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { DingTalkConfigSchema, dingtalkKind } from '../src/sources/chat/dingtalk/kind.ts'
import { dingtalkRef, dingtalkReferences, dingtalkResource, readDingtalk } from '../src/sources/chat/dingtalk/read.ts'

const CONFIG = DingTalkConfigSchema.parse({ clientId: 'x', clientSecret: 'y' })

const trigger = (meta: Record<string, unknown> = {}): Trigger => ({
  id: key('dingtalk', 'm1'), source: 'dingtalk', threads: [{ source: 'dingtalk', id: 'cid' }],
  actor: { source: 'dingtalk', id: 'staff-1' }, human: true, at: '2026-11-14T01:00:00.000Z', text: '看下这个报错',
  meta: { conversationId: 'cid', direct: false, senderId: 'staff-1', ats: [], nativeId: 'm1', ...meta } } as Trigger)

describe('DingTalk references', () => {
  it('resolves a DingTalk Trigger and refuses another chat kind', () => {
    expect(dingtalkRef(trigger())).toEqual({ triggerId: key('dingtalk', 'm1'), messageId: 'm1' })
    // A WeCom Trigger names `chatId`, not `conversationId`.
    expect(dingtalkRef({ ...trigger(), meta: { chatId: 'c', senderId: 's', nativeId: 'm1' } } as Trigger)).toBeUndefined()
    expect(dingtalkReferences(dingtalkRef(trigger())!)).toEqual({ skill: 'dsh-superagent-dingtalk',
      message: `dingtalk/${key('dingtalk', 'm1')}/message` })
    expect(() => dingtalkResource('dingtalk/t1/thread')).toThrow(/no history/)
  })
})

describe('readDingtalk', () => {
  it('reads the callback message and marks an agent echo', () => {
    expect(readDingtalk(trigger(), `dingtalk/${key('dingtalk', 'm1')}/message`)).toMatchObject({ status: 'ok', next_resource: null,
      message: { id: 'm1', from: 'staff-1', text: '看下这个报错' } })
    expect(readDingtalk({ ...trigger(), human: false } as Trigger, `dingtalk/${key('dingtalk', 'm1')}/message`).message.bot).toBe(true)
  })
})

describe('DingTalk ThreadContext', () => {
  const context = dingtalkKind.threadContext!
  it('answers no_root and no_parent, and reads the one message as the thread', async () => {
    expect(await context.read({} as never, trigger(), 'root', undefined, CONFIG)).toMatchObject({ messages: [], status: 'no_root' })
    expect(await context.read({} as never, trigger(), 'parent', undefined, CONFIG)).toMatchObject({ messages: [], status: 'no_parent' })
    const read = await context.read({} as never, trigger(), 'thread', undefined, CONFIG)
    expect(read).toMatchObject({ status: 'ok', body: { history: false },
      messages: [expect.objectContaining({ id: 'm1', from: 'staff-1', text: '看下这个报错' })] })
  })
})
