/** Weixin Source kind: group messages judged by structured `@`, echo-idempotent replies through the sidecar bridge, and its environment. */
import { z } from 'zod'
import type { OutboundMessage } from '../../../core/index.ts'
import type { ChannelHost, FieldSpec, SourceChannel, SourceKind, SourcePolicyPart } from '../../kind.ts'
import type { BridgeClient, BridgeStatus } from './bridge.ts'
import { createBridgeClient } from './bridge.ts'
import { weixinThreadContext } from './thread.ts'

/** Stable kind ID; one kind, several interchangeable backends behind the sidecar. */
export const SOURCE = 'weixin'
const WXID_PATTERN = /^[A-Za-z0-9_-]+$/

/** Chats the Source receives; `id` is the stable chatroom ID, never the display name. */
const RoomsSchema = z.array(z.object({
  id: z.string().trim().regex(WXID_PATTERN, 'Invalid chatroom ID'),
  name: z.string().trim().max(60).optional(),
}).strict()).default([])
export const WeixinConfigSchema = z.object({
  /** Loopback address of the wxauto-bridge sidecar; the bridge never listens beyond 127.0.0.1. */
  baseUrl: z.url().default('http://127.0.0.1:8787'),
  /** Path of the file holding the sidecar's bearer token; it must be readable only by this account (mode 0600). */
  tokenFile: z.string().trim().min(1),
  /** The agent's own wxid: what group `@`s and own messages are judged against. */
  selfWxid: z.string().trim().regex(WXID_PATTERN, 'Invalid wxid'),
  rooms: RoomsSchema,
  /** Receive only messages that mention the agent; off receives everything and leaves admission to the Policy. */
  atOnly: z.boolean().default(true),
  /** How often the polling transport asks the bridge for new messages, in seconds. */
  pollSeconds: z.number().int().min(5).max(3600).default(5),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>

const Fields: FieldSpec[] = [
  { key: 'baseUrl', type: 'text', label: { zh: '桥地址', en: 'Bridge URL' },
    hint: { zh: 'wxauto-bridge 的 loopback 地址，例如 http://127.0.0.1:8787；只允许本机，不要填公网地址。', en: 'Loopback address of wxauto-bridge, such as http://127.0.0.1:8787; localhost only, never a public address.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '桥 token 文件', en: 'Bridge token file' },
    hint: { zh: '保存 sidecar bearer token 的文件路径；文件权限必须是 0600，否则客户端拒绝读取。', en: 'Path of the file holding the sidecar bearer token; it must have mode 0600 or the client refuses to read it.' } },
  { key: 'selfWxid', type: 'text', pattern: '^[A-Za-z0-9_-]+$', label: { zh: '本账号 wxid', en: 'This account wxid' },
    hint: { zh: '群 @ 判定和自消息识别都以它为准，昵称改了也不会失效。', en: 'Group @-detection and own-message detection are judged against it, so a renamed account still works.' } },
  { key: 'rooms', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
    hint: { zh: '只接收这些群里发给机器人的消息；群 ID 必须稳定（真实 chatroomId），不能填昵称。', en: 'Receives only the messages to the bot in these chats; the chat ID must be the stable chatroomId, never the display name.' },
    columns: [
      { key: 'id', type: 'text', label: { zh: '群 ID', en: 'Chat ID' }, pattern: '^[A-Za-z0-9_-]+$' },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] },
  { key: 'atOnly', type: 'switch', label: { zh: '仅接收 @ 的消息', en: 'Receive only @s' },
    hint: { zh: '开启时只接收 @ 机器人的群消息；关闭时也接收其余消息，交评估按规则推断。', en: 'On receives only messages that mention the bot; off also receives the rest, from which Eval may infer work under the rules.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' },
    hint: { zh: '轮询传输向桥询问新消息的间隔。', en: 'How often the polling transport asks the bridge for new messages.' } },
]

const WeixinPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().regex(WXID_PATTERN, 'Invalid wxid'), name: z.string().trim().max(100).optional() }).strict())
    .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate wxids')
    .default([]),
}).strict()

/** Dependency seams of the kind: the bridge client (fake in tests) and the synchronous status behind `facts`. */
export interface WeixinKindHooks {
  /** Reads the bridge status for `facts`, which cannot await; the polling loop records what it last saw. */
  status?(): BridgeStatus | undefined
  /** Builds the bridge client used by `channel.send`; tests inject a fake so nothing reaches the network. */
  client?(config: WeixinConfig): BridgeClient
}

/** Last status a bridge read reported, kept module-wide because `SourceKind.facts` must answer synchronously. */
let rememberedStatus: BridgeStatus | undefined
/** Records the status a bridge read just returned, so the next `facts` render shows the account it belongs to. */
export function rememberWeixinStatus(status: BridgeStatus): void { rememberedStatus = status }

/** Reception result of the weixin kind: ambient group messages stay observable for Thread context even when not listened. */
type WeixinScopeResult =
  | { listened: true; observed: boolean; row?: string }
  | { listened: false; reason: string; observed?: boolean; row?: string }

/** Builds the weixin SourceKind; the default `weixinKind` uses the sidecar client and the last recorded status. */
export function createWeixinKind(hooks: WeixinKindHooks = {}): SourceKind<WeixinConfig> {
  const bridgeFor = (config: WeixinConfig): BridgeClient =>
    hooks.client?.(config) ?? createBridgeClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile })
  const policy: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }> = {
    unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
    schema: WeixinPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'wxid', en: 'wxid' }, pattern: '^[A-Za-z0-9_-]+$' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
  }
  const channel: SourceChannel<WeixinConfig> = {
    // Declarative transport metadata: message length limit, no Markdown, and whether a send may start a conversation.
    // Nothing reads it yet; the sidecar enforces these, and it reports what it can carry.
    // A retried send carries the OutboundMessage ID as the sidecar's Idempotency-Key and the sidecar answers `deduped`, so a
    // conversation is keyed: a retry returns the message already sent instead of posting a second one (not echo-matched).
    capabilities: { idempotency: 'keyed', maxChars: 2000, markdown: false, proactive: true },
    // A reply goes only to a chat the Source still receives.
    allowed: (address, config) => config.rooms.some(room => room.id === address.room),
    send: async (host: ChannelHost, message: OutboundMessage): Promise<'sent' | 'gone'> => {
      const { room = '', wxid = '', quoteId } = message.channel.address
      const result = await bridgeFor(host.config as WeixinConfig).send({
        room, wxid, text: message.text, ...(quoteId ? { quoteId } : {}), idempotencyKey: message.id,
      })
      return result === 'gone' ? 'gone' : 'sent'
    },
    // The sidecar exposes no deep link; the panel names the source instead.
    link: () => ({ url: '', label: { zh: '微信', en: 'WeChat' } }),
  }
  return {
    kind: SOURCE,
    title: { zh: '微信', en: 'WeChat' },
    description: { zh: '接收下列微信群中发给机器人的消息，按结构化的 @ 判定，并把回复发回群里。', en: 'Receives messages to the bot in these WeChat groups, judged by structured @s, and replies in the group.' },
    schema: WeixinConfigSchema,
    fields: Fields,
    health: ['weixin'],
    // Reception is decided on the structured `ats` list, never by matching `@nickname` in the text. An ambient group message
    // is filtered but still observed, so it remains Thread-context material; `reason` is what Intake records for the filter.
    scope({ meta }, config): WeixinScopeResult {
      const room = typeof meta.room === 'string' ? meta.room : ''
      if (!room) return { listened: true, observed: false, row: 'directMessages' }
      const ats = Array.isArray(meta.ats) ? meta.ats.filter((id): id is string => typeof id === 'string') : []
      const addressed = ats.includes(config.selfWxid)
      const row = addressed ? 'groupAddressed' : 'groupAmbient'
      return addressed || !config.atOnly
        ? { listened: true, observed: true, row }
        : { listened: false, reason: 'group_ambient', observed: true, row }
    },
    channel,
    policy,
    // Images of a message are downloaded through the sidecar when an assessment asks for one; mounting the reader changes
    // nothing for a Source whose chats never carry images, and a client that lacks /media reports that on the read instead.
    threadContext: weixinThreadContext((raw) => bridgeFor(raw as WeixinConfig)),
    environment: {
      variables: [
        { key: 'DSH_SUPERAGENT_WEIXIN_ROOM', description: { zh: '接下工单的微信群 chatroomId；工单不是从微信来的时为空', en: 'chatroomId of the WeChat group that started the ticket; empty when the ticket did not start on WeChat' } },
        { key: 'DSH_SUPERAGENT_WEIXIN_SENDER', description: { zh: '发起工单的微信用户 wxid；工单不是从微信来的时为空', en: 'wxid of the WeChat user who started the ticket; empty when the ticket did not start on WeChat' } },
      ],
      values: ({ trigger }) => ({
        DSH_SUPERAGENT_WEIXIN_ROOM: trigger?.source === SOURCE ? String(trigger.meta.room ?? '') : '',
        DSH_SUPERAGENT_WEIXIN_SENDER: trigger?.source === SOURCE ? String(trigger.meta.senderId ?? trigger.actor.id) : '',
      }),
    },
    // `facts` is synchronous: it reports the status the polling loop last recorded, and "Not connected" until there is one.
    facts: () => {
      const status = hooks.status ? hooks.status() : rememberedStatus
      const account = status?.loggedIn ? { zh: `已登录：${status.name || status.wxid}`, en: `Signed in as ${status.name || status.wxid}` } : { zh: '未连接', en: 'Not connected' }
      return { account }
    },
  }
}

/** The weixin Source kind as installed: sidecar client over HTTP and the last status the polling loop recorded. */
export const weixinKind = createWeixinKind()
