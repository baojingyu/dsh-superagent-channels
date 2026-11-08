/**
 * The WeCom (enterprise WeChat) Source kind: a self-built application's callback transport wrapped as a chat kind. Its
 * outbound has no server-side idempotency key, so it declares `idempotency: 'none'` — a retried send may repeat — and its
 * facts say so plainly instead of pretending otherwise.
 */
import { z } from 'zod'
import type { ChatAdapter } from '../port.ts'
import type { ChatKindMeta } from '../kind.ts'
import type { SourceKind } from '../../kind.ts'
import { chatKind } from '../kind.ts'
import type { WecomAddress } from './adapter.ts'
import { createWecomSender } from './adapter.ts'

/** Stable kind ID; one kind over any number of enterprise applications (instances). */
export const SOURCE = 'wecom'

export const WecomConfigSchema = z.object({
  /** Corporation ID of the enterprise application. */
  corpId: z.string().trim().min(1),
  /** Application secret; prefer injecting it from `tokenFile` in production and keeping it out of the stored settings. */
  corpSecret: z.string().trim().min(1),
  /** The self-built application's AgentID. */
  agentId: z.string().trim().min(1),
  /** Optional file holding the application secret; when set it takes precedence over the inline `corpSecret`. */
  tokenFile: z.string().trim().min(1).optional(),
  /** Optional file holding the callback EncodingAESKey (43 characters); prefer it over storing the key inline. */
  encodingAesKeyFile: z.string().trim().min(1).optional(),
  /** Receive only messages that mention the application; off receives everything and leaves admission to the Policy. */
  atOnly: z.boolean().default(true),
  /** How often a polling transport reads the application's history, in seconds. */
  pollSeconds: z.number().int().min(5).max(3600).default(60),
}).strict()
export type WecomConfigValue = z.infer<typeof WecomConfigSchema>

const Fields: ChatKindMeta<WecomConfigValue>['fields'] = [
  { key: 'corpId', type: 'text', label: { zh: '企业 CorpID', en: 'Corp ID' },
    hint: { zh: '企业微信管理后台的 CorpID，回调与出站都以它为准。', en: 'The CorpID from the WeCom admin console; callbacks and outbound both use it.' } },
  { key: 'corpSecret', type: 'text', label: { zh: '应用 Secret', en: 'App secret' },
    hint: { zh: '应用 Secret；生产建议改用 tokenFile 从文件注入，避免密钥写入设置。', en: 'Application secret; in production prefer injecting it from tokenFile so the secret is never stored in settings.' } },
  { key: 'agentId', type: 'text', label: { zh: '应用 AgentID', en: 'Agent ID' },
    hint: { zh: '自建应用的 AgentID，出站消息以它作为发送方。', en: 'The self-built application\'s AgentID; outbound messages are sent as it.' } },
  { key: 'tokenFile', type: 'text', label: { zh: 'Secret 文件', en: 'Secret file' },
    hint: { zh: '保存的是文件路径；适配器读取并强制 0600，优先级高于内联值。', en: 'Holds a file path; the adapter reads it and enforces mode 0600, and it takes precedence over the inline value.' } },
  { key: 'encodingAesKeyFile', type: 'text', label: { zh: '回调密钥文件', en: 'Callback key file' },
    hint: { zh: '保存的是文件路径；适配器读取并强制 0600，优先级高于内联值（回调解密用它）。', en: 'Holds a file path; the adapter reads it and enforces mode 0600, it takes precedence over the inline value, and callback decryption uses it.' } },
  { key: 'atOnly', type: 'switch', label: { zh: '仅接收 @ 的消息', en: 'Receive only @s' },
    hint: { zh: '开启时只接收 @ 应用的消息；关闭时也接收其余消息，交评估按规则推断。', en: 'On receives only messages that mention the application; off also receives the rest, from which Eval may infer work.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' },
    hint: { zh: '轮询传输读取应用历史消息的间隔。', en: 'How often a polling transport reads the application\'s message history.' } },
]

/**
 * The backend seam of the WeCom kind. Callbacks arrive through the runtime's route (see `webhook.ts`), so the transport is
 * `webhook`; the outbound API has no idempotency key, hence `idempotency: 'none'` and a `send` that passes no key.
 */
export const wecomAdapter: ChatAdapter<WecomConfigValue> = {
  host: SOURCE,
  transports: ['webhook'],
  capabilities: { idempotency: 'none', maxChars: 2048, markdown: false, proactive: true },
  // Verifies the credentials the panel reads (the message API needs a token even before any send).
  async probe(config) { await createWecomSender().accessToken(config) },
  // A callback transport has no history read, so this kind reports one entry and declares one; a backfill added later
// names its own entry rather than taking a name another kind already claims.
  async readThread() { return { events: [] } },
  send: (config, address: Record<string, string>, text: string) =>
    createWecomSender().sendMessage(config, address as WecomAddress, text),
  // The callback API exposes no deep link; the panel names the source instead.
  link: () => ({ url: '', label: { zh: '企业微信', en: 'WeCom' } }),
}

const META: ChatKindMeta<WecomConfigValue> = {
  host: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: { zh: '接收企业微信自建应用的回调消息（需公网入口由运维反代到本服务），并把回复发回应用。',
    en: 'Receives callbacks of a WeCom self-built application (the public entry point is reverse-proxied to this service by ops) and replies through the application.' },
  schema: WecomConfigSchema,
  fields: Fields,
  // WeCom message IDs are decimal; a query naming one becomes a Trigger search term.
  idPattern: '[0-9]{6,}',
}

/** Reception result of the WeCom kind: ambient group messages stay observable for Thread context even when not listened. */
type WecomScopeResult =
  | { listened: true; observed: boolean; row?: string }
  | { listened: false; reason: string; observed?: boolean; row?: string }

/**
 * Builds the WeCom SourceKind from `chatKind` and overrides only the reception rule: a WeCom application has no explicit
 * "direct message" flag, so a message without `meta.chatId` is a one-to-one conversation; a message in a chat is judged by
 * `meta.mentionsAgent` (structured, never `@nickname` in the text) — addressed is listened, and an unaddressed one is only
 * observed unless `atOnly` is off.
 */
export function createWecomKind(adapter: ChatAdapter<WecomConfigValue> = wecomAdapter): SourceKind<WecomConfigValue> {
  const base = chatKind(adapter, META)
  return {
    ...base,
    scope({ meta }, config): WecomScopeResult {
      const chatId = typeof meta.chatId === 'string' && meta.chatId ? meta.chatId : undefined
      if (!chatId) return { listened: true, observed: false, row: 'directMessages' }
      const addressed = meta.mentionsAgent === true
      const row = addressed ? 'groupAddressed' : 'groupAmbient'
      return addressed || !config.atOnly
        ? { listened: true, observed: true, row }
        : { listened: false, reason: 'group_ambient', observed: true, row }
    },
    // `facts` is synchronous and must tell the truth about the transport: a callback needs a public entry point, and an
    // outbound retry can repeat because WeCom's message API has no idempotency key.
    facts: () => ({
      inbound: { zh: '回调需公网入口（运维反代到本服务）', en: 'Callbacks need a public entry point (ops reverse-proxies it here)' },
      outbound: { zh: '出站至少一次：无服务端幂等键，重试可能重复', en: 'Outbound is at-least-once: no server-side idempotency key, so a retry may repeat' },
    }),
  }
}

/** The WeCom Source kind as installed: the real adapter and the honest at-least-once facts. */
export const wecomKind = createWecomKind()
