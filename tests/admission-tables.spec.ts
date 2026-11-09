/**
 * Every Source's admission table reads the same way: rows are reception ranges with a short annotation, and only the cells that
 * apply are offered. The chat ones name one row per conversation; the hosting one offers Issue, merge request, comment and CI.
 */
import { describe, expect, it } from 'vitest'
import { SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { chatKind } from '../src/sources/chat/kind.ts'
import type { ChatAdapter } from '../src/sources/chat/port.ts'
import { weixinKind, WeixinConfigSchema } from '../src/sources/chat/weixin/kind.ts'
import { gitlabKind } from '../src/sources/hosting/gitlab/kind.ts'
import { z } from 'zod'

const ChatSchema = z.object({
  chats: z.array(z.object({ chatId: z.string(), name: z.string().optional(), listen: z.enum(['mentions', 'all']) })).default([]),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  directMessages: z.boolean().default(true),
}).strict()

const adapter = {} as unknown as ChatAdapter<Record<string, unknown>>
const demo = chatKind(adapter, {
  host: 'chat-demo', title: { zh: '演示', en: 'Demo' }, description: { zh: '', en: '' },
  schema: ChatSchema, fields: [], idPattern: '[a-z]+',
})

describe('a chat kind names one row per conversation', () => {
  const config = ChatSchema.parse({
    chats: [{ chatId: 'room-1', name: '研发群', listen: 'all' }, { chatId: 'room-2', listen: 'mentions' }],
    otherChats: 'mentions', directMessages: false,
  })

  it('offers each configured chat, other chats, and direct messages', () => {
    const rows = demo.policy!.rows!(config)
    expect(rows.map(row => row.id)).toEqual(['room-1', 'room-2', 'otherChats', 'directMessages'])
    // A chat that receives everything can admit ambient messages; one that is "@ only" cannot.
    expect(rows[0]).toMatchObject({ label: '研发群', note: { zh: '全部消息' }, cells: { listedUnaddressed: true, unlistedAddressed: true } })
    expect(rows[1]).toMatchObject({ label: 'room-2', note: { zh: '仅 @' }, cells: { listedUnaddressed: false, unlistedAddressed: true } })
    expect(rows[2]).toMatchObject({ note: { zh: '仅 @' }, cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })
    expect(rows[3]).toMatchObject({ note: { zh: '不接收' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } })
  })

  it('uses the same row ids its scope reports, so a configuration lands where it is read', () => {
    const scope = demo.scope!
    expect(scope({ meta: { chatId: 'room-1' } }, config)).toMatchObject({ row: 'room-1' })
    expect(scope({ meta: { chatId: 'room-2' } }, config)).toMatchObject({ row: 'room-2' })
    expect(scope({ meta: { chatId: 'elsewhere' } }, config)).toMatchObject({ row: 'otherChats' })
    // Refused while the switch is off, and its own row once it is on.
    expect(scope({ meta: { direct: true } }, config)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    expect(scope({ meta: { direct: true } }, { ...config, directMessages: true })).toMatchObject({ row: 'directMessages' })
  })
})

describe('the WeChat kind', () => {
  const config = WeixinConfigSchema.parse({ tokenFile: '/tmp/weixin.token', selfWxid: 'wxid_self',
    rooms: [{ id: 'wxname_a', name: '运营群' }], atOnly: true, directMessages: true })

  it('offers one row per subscribed group plus direct messages', () => {
    const rows = weixinKind.policy!.rows!(config)
    expect(rows.map(row => row.id)).toEqual(['wxname_a', 'directMessages'])
    expect(rows[0]).toMatchObject({ label: '运营群', note: { zh: '仅 @' }, cells: { listedUnaddressed: false, unlistedAddressed: true } })
    expect(rows[1]).toMatchObject({ note: { zh: '接收' }, cells: { listedUnaddressed: false, unlistedAddressed: true } })
    // Nothing is offered for a row a person has not configured.
    expect(weixinKind.policy!.rows!({ ...config, rooms: [] }).map(row => row.id)).toEqual(['directMessages'])
  })
})

describe('GitLab now has a Policy at all', () => {
  it('declares the accounts and the four reception ranges', () => {
    const policy = gitlabKind.policy!
    expect(policy).toBeDefined()
    expect(policy.rows!({}).map(row => row.id)).toEqual(['issues', 'pulls', 'comments', 'ci'])
    const ci = policy.rows!({}).find(row => row.id === 'ci')!
    // CI has no sender: only its unaddressed cell applies.
    expect(ci.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: true })
    expect(policy.warnings!({}, { allowed: [] })).toHaveLength(1)
    expect(policy.warnings!({}, { allowed: [{ id: 'alice' }] })).toHaveLength(0)
  })

  it('accepts the part the panel sends, and the registry can hand it back', () => {
    expect(gitlabKind.policy!.schema.safeParse({ allowed: [{ id: 'alice', name: 'Alice' }] }).success).toBe(true)
    const settings = SettingsSchema.parse({})
    const registry = new SourceRegistry(() => settings)
    registry.register(gitlabKind)
    expect(registry.policyPart('gitlab')).toBeDefined()
  })
})
