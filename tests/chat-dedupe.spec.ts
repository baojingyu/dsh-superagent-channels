/** Transport-level dedupe ring and the chat kind factory: bounded TTL dedupe per instance, and a SourceKind with equal Thread scope across backends. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { key } from '../src/core/index.ts'
import type { OutboundMessage } from '../src/core/index.ts'
import { DeliveredRing } from '../src/sources/chat/dedupe.ts'
import { chatKind } from '../src/sources/chat/kind.ts'
import type { ChatAdapter } from '../src/sources/chat/port.ts'
import type { ChannelHost, ChannelLinks } from '../src/sources/kind.ts'

describe('DeliveredRing', () => {
  it('treats the same instance and native ID as delivered within the TTL, and another instance as a different message', () => {
    const ring = new DeliveredRing(2000, 600_000, () => 1_000)
    expect(ring.check('weixin-ops', 'm1')).toBe(false)
    expect(ring.check('weixin-ops', 'm1')).toBe(true)
    expect(ring.check('weixin-hr', 'm1')).toBe(false)
    expect(ring.check('weixin-hr', 'm1')).toBe(true)
    expect(ring.check('weixin-ops', 'm2')).toBe(false)
    expect(ring.check('weixin-ops', 'm1')).toBe(true)
  })

  it('delivers again once the TTL elapsed, and keeps redelivery from extending the TTL of the first delivery', () => {
    let now = 1_000
    const ring = new DeliveredRing(2000, 600_000, () => now)
    expect(ring.check('weixin-ops', 'm1')).toBe(false)
    now += 599_999
    expect(ring.check('weixin-ops', 'm1')).toBe(true)
    now += 1
    expect(ring.check('weixin-ops', 'm1')).toBe(false)
    now += 599_999
    expect(ring.check('weixin-ops', 'm1')).toBe(true)
  })

  it('evicts the oldest entry once its capacity is exceeded, while the newest stays a duplicate', () => {
    const ring = new DeliveredRing(2, 600_000, () => 1_000)
    expect([ring.check('weixin-ops', 'm1'), ring.check('weixin-ops', 'm2')]).toEqual([false, false])
    expect(ring.check('weixin-ops', 'm3')).toBe(false)
    expect(ring.check('weixin-ops', 'm1')).toBe(false)
    expect(ring.check('weixin-ops', 'm3')).toBe(true)
    expect(ring.check('weixin-ops', 'm2')).toBe(false)
  })

  it('defaults to a 2000-entry, ten-minute ring and the wall clock', () => {
    const ring = new DeliveredRing()
    expect(ring.check('weixin-ops', 'm1')).toBe(false)
    expect(ring.check('weixin-ops', 'm1')).toBe(true)
  })
})

const ChatConfigSchema = z.object({
  chats: z.array(z.object({ chatId: z.string(), name: z.string().optional(), listen: z.enum(['mentions', 'all']) }).strict()).default([]),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
}).strict()
type ChatConfig = z.infer<typeof ChatConfigSchema>
const config: ChatConfig = ChatConfigSchema.parse({ chats: [{ chatId: 'room-1', name: 'Ops', listen: 'all' }], otherChats: 'mentions' })

/** Records what the factory hands the backend, so the channel wiring is observable instead of inferred. */
const calls: { send: unknown[]; link: unknown[] } = { send: [], link: [] }
const adapter: ChatAdapter<ChatConfig> = {
  host: 'chat-demo',
  transports: ['poll', 'webhook'],
  capabilities: { maxChars: 2000, markdown: false, idempotency: 'echo' },
  async probe() {},
  async readThread() { return { events: [] } },
  async send(...args) { calls.send.push(args); return 'sent' },
  link(config, address) { calls.link.push([config, address]); return { url: `https://chat.test/${address.room ?? ''}`, label: { zh: '群', en: 'Chat' } } },
}
const meta = { host: 'chat-demo', title: { zh: '聊天', en: 'Chat' }, description: { zh: '测试后端', en: 'Test backend' },
  schema: ChatConfigSchema, fields: [], idPattern: 'cm_[a-z0-9]+' }
const kind = chatKind(adapter, meta)
const host = { config, instance: 'chat-demo' } as unknown as ChannelHost
const message: OutboundMessage = { id: 'out-1', channel: { source: 'chat-demo', thread: 'chat-demo:room-1', address: { room: 'room-1', messageId: 'cm_1' } },
  text: 'hi', kind: 'reply' }

describe('chatKind', () => {
  it('declares only the health entry it reports, under the kind ID', () => {
    expect(kind.kind).toBe('chat-demo')
    expect(kind.health).toEqual(['chat-demo'])
    // A shared `history` entry belongs to the one kind that reports a backfill; another kind naming it is refused.
    expect(kind.health).not.toContain('history')
    expect(kind.schema.parse({})).toEqual({ chats: [], otherChats: 'none', directMessages: true })
  })

  it('reads reception from the configured chat lists, naming the scope row the Policy admits', () => {
    const scope = kind.scope!
    expect(scope({ meta: { chatId: 'room-1' } }, config)).toEqual({ listened: true, observed: true, row: 'room-1' })
    expect(scope({ meta: { chatId: 'room-1' } }, ChatConfigSchema.parse({ chats: [{ chatId: 'room-1', listen: 'mentions' }], otherChats: 'mentions' })))
      .toEqual({ listened: true, observed: false, row: 'room-1' })
    expect(scope({ meta: { chatId: 'room-2' } }, config)).toEqual({ listened: true, observed: false, row: 'otherChats' })
    expect(scope({ meta: { chatId: 'room-2' } }, ChatConfigSchema.parse({ chats: [], otherChats: 'none' })))
      .toEqual({ listened: false, reason: 'chat_not_allowed' })
    expect(scope({ meta: { direct: true } }, config)).toEqual({ listened: true, observed: false, row: 'directMessages' })
    expect(scope({ meta: { direct: true } }, ChatConfigSchema.parse({ chats: [], directMessages: false })))
      .toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
  })

  it('puts allowed first in the Policy part and rejects duplicate or empty IDs', () => {
    expect(kind.policy!.fields[0]!.key).toBe('allowed')
    expect(kind.policy!.schema.parse({})).toEqual({ allowed: [] })
    expect(kind.policy!.schema.safeParse({ allowed: [{ id: 'wxid_a' }, { id: 'wxid_a' }] }).success).toBe(false)
    expect(kind.policy!.schema.safeParse({ allowed: [{ id: '   ' }] }).success).toBe(false)
    expect(kind.policy!.schema.safeParse({ allowed: [{ id: 'wxid_a', extra: 1 }] }).success).toBe(false)
  })

  it('derives the answered Trigger from the parent message the event reports', () => {
    expect(kind.repliesTo!({ meta: { parentId: 'cm_2' } } as never)).toBe(key('chat-demo', 'cm_2'))
    expect(kind.repliesTo!({ meta: {} } as never)).toBeUndefined()
    expect(kind.repliesTo!({ meta: { parentId: 2 } } as never)).toBeUndefined()
  })

  it('picks this backend native IDs out of a search query as Trigger search terms', () => {
    expect(kind.find!('look at cm_42 and cm_42, not room-1')).toEqual({ threads: [], terms: ['cm_42'] })
  })

  it('sends through the adapter with the instance config, the channel address, the text, and the message ID', async () => {
    await expect(kind.channel!.send(host, message)).resolves.toBe('sent')
    expect(calls.send).toEqual([[config, { room: 'room-1', messageId: 'cm_1' }, 'hi', 'out-1']])
    expect(kind.channel!.capabilities).toEqual({ maxChars: 2000, markdown: false, idempotency: 'echo' })
  })

  it('links through the adapter with the instance config, falling back to an empty config when the caller has none', () => {
    const links: ChannelLinks = {}
    expect(kind.channel!.link({ room: 'room-1' }, links, config)).toEqual({ url: 'https://chat.test/room-1', label: { zh: '群', en: 'Chat' } })
    expect(calls.link.at(-1)).toEqual([config, { room: 'room-1' }])
    kind.channel!.link({ room: 'room-2' }, links, undefined)
    expect(calls.link.at(-1)).toEqual([{}, { room: 'room-2' }])
  })
})