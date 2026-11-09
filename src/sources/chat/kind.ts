/** Factory for chat Source kinds: one backend adapter supplies transport and delivery, while Thread scope, Policy, and links stay the same across backends. */
import { z } from 'zod'
import { key, type OutboundMessage, type ScopeResult, type Trigger } from '../../core/index.ts'
import type { ChannelHost, ChannelLink, ChannelLinks, FieldSpec, Localized, SourceKind, SourcePolicyPart } from '../kind.ts'
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
      if (chat) return { listened: true, observed: chat.listen === 'all', row: 'chats' }
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