/** DingTalk Source kind: the shared chat factory plus DingTalk's structured-`@` reception and at-least-once replies. */
import { z } from 'zod'
import type { FieldSpec, SourceKind } from '../../kind.ts'
import type { ChatAdapter } from '../port.ts'
import { chatKind, type ChatKindMeta } from '../kind.ts'
import { sendMessage } from './adapter.ts'

/** Stable kind ID. */
export const SOURCE = 'dingtalk'

export const DingTalkConfigSchema = z.object({
  /** Client ID (AppKey) of the DingTalk app whose robot receives the stream. */
  clientId: z.string().trim().min(1),
  /** Client Secret of that app; preferred from the environment or a file rather than the settings store. */
  clientSecret: z.string().trim().min(1),
  /** Optional path of a file holding the secret, for deployments that inject it outside settings. */
  tokenFile: z.string().trim().min(1).optional(),
  /** The robot's code, used as the bot's identity when the runtime has not learned its staffId. */
  robotCode: z.string().trim().min(1).optional(),
  /** Receive only messages that mention the bot; off leaves admission to the Policy. */
  atOnly: z.boolean().default(true),
  /** How often a polling transport would ask for missed messages, in seconds (the stream does not need it). */
  pollSeconds: z.number().int().min(5).max(3600).default(5),
}).strict()
export type DingTalkKindConfig = z.infer<typeof DingTalkConfigSchema>

const Fields: FieldSpec[] = [
  { key: 'clientId', type: 'text', label: { zh: 'Client ID（AppKey）', en: 'Client ID (AppKey)' },
    hint: { zh: '钉钉开放平台应用的 AppKey；机器人的 Stream 长连接以它鉴权。', en: 'AppKey of the DingTalk app; the robot\'s Stream connection authenticates with it.' } },
  { key: 'clientSecret', type: 'text', label: { zh: 'Client Secret', en: 'Client Secret' },
    hint: { zh: '优先从环境变量或仅本机可读的文件注入；写在这里的值会进入设置库，请不要提交到仓库。', en: 'Prefer injecting this from an environment variable or a file only this account can read; a value saved here lives in the settings store, so never commit it.' } },
  { key: 'tokenFile', type: 'text', label: { zh: 'Secret 文件', en: 'Secret file' },
    hint: { zh: '保存的是文件路径；适配器读取并强制 0600，优先级高于内联值。', en: 'Holds a file path; the adapter reads it and enforces mode 0600, and it takes precedence over the inline value.' } },
  { key: 'robotCode', type: 'text', label: { zh: '机器人 robotCode', en: 'Robot code' },
    hint: { zh: '机器人的 robotCode，用作自身身份；群 @ 判定以运行时学到的 staffId 优先，拿不到时用它。', en: 'The robot\'s code, used as the bot identity; group @-detection prefers the staffId the runtime learned and falls back to it.' } },
  { key: 'atOnly', type: 'switch', label: { zh: '仅接收 @ 的消息', en: 'Receive only @s' },
    hint: { zh: '开启时只接收获 @ 的群消息；关闭时也接收其余群消息，交评估按规则推断。', en: 'On receives only messages that mention the bot; off also receives the rest, from which Eval may infer work under the rules.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' },
    hint: { zh: '仅轮询传输使用；Stream 长连接不需要它。', en: 'Used by polling transports only; the Stream connection does not need it.' } },
]

/** The real DingTalk adapter: the stream transport parses callbacks with `parseStreamEvent` and replies through `sendMessage`. */
export const dingTalkAdapter: ChatAdapter<DingTalkKindConfig> = {
  host: SOURCE,
  transports: ['stream'],
  // DingTalk has no server-side idempotency key and its sessionWebhook cannot dedupe a retry: declare at-least-once delivery.
  capabilities: { idempotency: 'none', maxChars: 5000, markdown: true, proactive: false },
  async probe(config) {
    // There is no cheap DingTalk health probe: the stream connection reports health, and credentials are exercised on first send.
    if (!config.clientId || !config.clientSecret) throw new Error('DingTalk requires a Client ID and a Client Secret')
  },
  // No history read in this build; a ThreadContext over the stream's buffer is a later item.
  async readThread() { return { events: [] } },
  send: (config, address, text, id) => sendMessage(config, {
    conversationId: address.conversationId ?? address.room ?? '',
    ...(address.sessionWebhook ? { sessionWebhook: address.sessionWebhook } : {}),
    ...(address.sessionWebhookExpiredTime ? { sessionWebhookExpiredTime: Number(address.sessionWebhookExpiredTime) } : {}),
  }, text, id),
  // DingTalk exposes no deep link from a callback; the panel names the source instead.
  link: () => ({ url: '', label: { zh: '钉钉', en: 'DingTalk' } }),
}

const Meta: ChatKindMeta<DingTalkKindConfig> = {
  host: SOURCE,
  title: { zh: '钉钉', en: 'DingTalk' },
  description: { zh: '通过钉钉 Stream 长连接接收群里 @ 机器人的消息，并把回复发回会话。', en: 'Receives messages that mention the bot in DingTalk groups over the Stream long connection, and replies in the conversation.' },
  schema: DingTalkConfigSchema,
  fields: Fields,
  // DingTalk message IDs look like `msg…`; they are what a search query would name.
  idPattern: 'msg[A-Za-z0-9_-]+',
}

/** Dependency seam of the kind: the bot's own staffId, known only once the runtime sees the account. */
export interface DingTalkKindHooks {
  selfId?(): string | undefined
}

let rememberedSelfId: string | undefined
/** Records the bot's own staffId the stream layer learned, for the kinds built from the default hooks. */
export function rememberDingTalkSelfId(value: string | undefined): void { rememberedSelfId = value }

/** Reception result of the kind: an unmentioned group message is filtered but observed, so it can still be Thread context. */
type DingTalkScopeResult =
  | { listened: true; observed: boolean; row?: string }
  | { listened: false; reason: string; observed?: boolean; row?: string }

/**
 * Builds the DingTalk SourceKind from the shared chat factory (identity, health, Policy `allowed` list, channel wiring, find,
 * repliesTo), overriding the reception rule: DingTalk robots are only reachable when mentioned, so a group message is judged
 * on the structured `ats` list against the bot's own staffId (runtime `selfId`, else the configured `robotCode`), falling back
 * to the callback's own `mentionsAgent` when neither is known. Direct messages are always received.
 */
export function createDingTalkKind(adapter: ChatAdapter<DingTalkKindConfig>, hooks: DingTalkKindHooks = {}): SourceKind<DingTalkKindConfig> {
  return {
    ...chatKind(adapter, Meta),
    // Delivery is at-least-once: the body marker is only written, never read back, so a retried message can arrive twice.
    facts: () => ({
      delivery: { zh: '出站为至少一次投递：无服务端幂等键，重试可能重复发送。', en: 'Outbound delivery is at-least-once: there is no server-side idempotency key, so a retry may send the same message twice.' },
    }),
    scope({ meta }, config): DingTalkScopeResult {
      if (meta.direct === true) return { listened: true, observed: false, row: 'directMessages' }
      const ats = Array.isArray(meta.ats) ? meta.ats.filter((id): id is string => typeof id === 'string') : []
      const self = (hooks.selfId ? hooks.selfId() : rememberedSelfId) ?? config.robotCode
      const addressed = self !== undefined ? ats.includes(self) : meta.mentionsAgent === true
      return addressed
        ? { listened: true, observed: true, row: 'groupAddressed' }
        : { listened: false, reason: 'group_ambient', observed: true, row: 'groupAmbient' }
    },
  }
}

/** The DingTalk Source kind as installed, on the real adapter. */
export const dingtalkKind = createDingTalkKind(dingTalkAdapter)