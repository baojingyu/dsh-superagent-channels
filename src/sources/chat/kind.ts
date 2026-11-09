/** Factory for chat Source kinds: one backend adapter supplies transport and delivery, while Thread scope, Policy, and links stay the same across backends. */
import { z } from 'zod'
import { key, type OutboundMessage, type ScopeResult, type Trigger } from '../../core/index.ts'
import type { AdmissionRowView, ChannelHost, ChannelLink, ChannelLinks, FieldSpec, Localized, SourceKind, SourcePolicyPart } from '../kind.ts'
import type { ChatAdapter } from './port.ts'

/** Configuration fields the factory reads itself, on top of whatever the kind's own schema adds. */
interface ChatScopeConfig {
  /** Chats the Source receives, with the chat's own reception rule. */
  chats?: readonly { chatId: string; name?: string; listen: 'mentions' | 'all' }[]
  /** Chats the bot joined but the configuration does not list: `none` or `@ only`. */
  otherChats?: 'none' | 'mentions'
  /** Whether direct messages to the bot are received. */
  directMessages?: boolean
}
/** What a chat kind needs from its backend and its own presentation, beyond the fields the caller lists. */
export interface ChatKindMeta<C extends Record<string, unknown>> {
  /** Source kind ID; names the kind and its `host` health entry. */
  host: string
  title: Localized
  description: Localized
  schema: z.ZodType<C>
  fields: FieldSpec[]
  /** Native ID pattern of this kind's messages, used to pick Trigger search terms out of a query. */
  idPattern: string
}

const scopeConfig = (config: unknown): ChatScopeConfig => config as ChatScopeConfig

/**
 * The admission rows of a chat backend that has no per-chat list of its own (DingTalk, WeCom): a message that mentions the bot,
 * a group message that does not, and a direct message. The row IDs are the ones those kinds' `scope` reports, which is what makes
 * the table configurable at all - a row no `scope` names can never be read.
 */
export function mentionRows(atOnly: boolean): AdmissionRowView[] {
  const received = { zh: '接收', en: 'Received' }
  const filtered = { zh: '不接收', en: 'Not received' }
  return [
    { id: 'groupAddressed', label: { zh: '群里 @ 机器人', en: 'Group messages that mention the bot' }, note: received,
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
    { id: 'groupAmbient', label: { zh: '群里未 @ 机器人', en: 'Group messages without a mention' },
      note: atOnly ? filtered : received,
      cells: { listedUnaddressed: !atOnly, unlistedAddressed: false, unlistedUnaddressed: !atOnly } },
    { id: 'directMessages', label: { zh: '私聊', en: 'Direct messages' }, note: received,
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } },
  ]
}
const ChatPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1).max(100), name: z.string().trim().max(100).optional() }).strict())
    .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate IDs')
    .default([]),
}).strict()

/**
 * Builds the SourceKind of a chat backend: the same Thread semantics (`threadRoot`), reception scope, `allowed` Policy table,
 * and outbound shape for every backend, so switching backends never reconfigures the Policy. `health` declares the backend's
 * own entry and history backfill; `scope` decides reception from `meta.chatId`/`meta.direct` and the configured chat lists.
 */
export function chatKind<C extends Record<string, unknown>>(adapter: ChatAdapter<C>, meta: ChatKindMeta<C>): SourceKind<C> {
  const policy: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }> = {
    unnamed: { person: { zh: '聊天用户', en: 'Chat user' }, bot: { zh: '聊天机器人', en: 'Chat bot' } },
    schema: ChatPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的用户', en: 'Users who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    // 行＝接收范围：每个已配置的会话（注解「仅 @」或「全部消息」）、其他群、私聊。只有该范围真实可用的格子才可编辑。
    rows(stored) {
      const settings = scopeConfig(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      const everything = { zh: '全部消息', en: 'All' }
      return [
        ...(settings.chats ?? []).map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId,
          note: chat.listen === 'all' ? everything : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'otherChats', label: { zh: '其他群', en: 'Other chats' },
          note: settings.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: settings.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'directMessages', label: { zh: '私聊', en: 'Direct messages' },
          note: settings.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: !!settings.directMessages, unlistedUnaddressed: false } },
      ]
    },
  }
  return {
    kind: meta.host,
    title: meta.title,
    description: meta.description,
    schema: meta.schema,
    fields: meta.fields,
    // Only the entries this kind reports. `history` belongs to a kind that runs a history backfill - Feishu does,
    // a callback or listener transport does not - because a default instance claims its entries by bare name and a
    // second kind naming the same one is refused at registration, which stops the whole plugin from starting.
    health: [meta.host],
    scope({ meta: inbound }: { meta: Record<string, unknown> }, config): ScopeResult {
      const settings = scopeConfig(config)
      if (inbound.direct === true) {
        return settings.directMessages === false
          ? { listened: false, reason: 'direct_messages_not_allowed' }
          : { listened: true, observed: false, row: 'directMessages' }
      }
      const chatId = typeof inbound.chatId === 'string' ? inbound.chatId : undefined
      const chat = settings.chats?.find(item => item.chatId === chatId)
      // The configured chat names its own row, so the admission table can carry one line per conversation.
      if (chat) return { listened: true, observed: chat.listen === 'all', row: chatId }
      return settings.otherChats === 'mentions'
        ? { listened: true, observed: false, row: 'otherChats' }
        : { listened: false, reason: 'chat_not_allowed' }
    },
    channel: {
    // A chat message is a person writing to the agent, so a refusal owes them one line.
    acceptsNotice: true,
      capabilities: adapter.capabilities,
      send: (host: ChannelHost, message: OutboundMessage) => adapter.send(host.config as C, message.channel.address, message.text, message.id),
      link: (address: Record<string, string>, _links: ChannelLinks, config?: C): ChannelLink => adapter.link((config ?? {}) as C, address),
    },
    // Only the backend knows the platform's ID syntax, so the query's native IDs become Trigger search terms.
    find(query) {
      const nativeId = new RegExp(`^(?:${meta.idPattern})$`)
      return { threads: [], terms: [...new Set(query.split(/\s+/).filter(word => nativeId.test(word)))] }
    },
    // A message's Trigger is named after the message, so the one it answers is named after its parent.
    repliesTo: (trigger: Trigger): string | undefined =>
      typeof trigger.meta.parentId === 'string' ? key(meta.host, trigger.meta.parentId) : undefined,
    policy,
  }
}