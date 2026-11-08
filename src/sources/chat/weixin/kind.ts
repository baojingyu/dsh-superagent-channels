/** Weixin Source kind: group messages judged by structured `@`, echo-idempotent replies through the sidecar bridge, and its environment. */
import { z } from 'zod'
import type { OutboundMessage } from '../../../core/index.ts'
import { KV } from '../../../kv.ts'
import type { ChannelHost, FieldSpec, Localized, SourceChannel, SourceKind, SourcePolicyPart } from '../../kind.ts'
import type { BridgeCapabilities, BridgeClient, BridgeStatus, MentionCapability } from './bridge.ts'
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
  /**
   * How long one bridge request may take, in seconds. The default is generous because some endpoints
   * drive the client's own UI: listing chats enumerates the contact pages, which costs ~10 s on a busy
   * account. Too small a value looks like "the bridge did not answer" while it is still working.
   */
  timeoutSeconds: z.number().int().min(5).max(300).default(30),
  /** Phrases that admit a group message without an `@`. Matched case-insensitively inside the text. */
  keywords: z.array(z.object({ any: z.string().trim().min(1).max(50) }).strict()).default([]),
  /** Fixed replies sent from the polling loop when a message names one; the agent still sees the message. */
  autoReplies: z.array(z.object({
    any: z.string().trim().min(1).max(50),
    reply: z.string().trim().min(1).max(2000),
  }).strict()).default([]),
  /** Whether a group reply mentions the person who addressed the bot. A direct message has no mention to make. */
  mentionBack: z.boolean().default(true),
  /** Whether a voice message is transcribed before Eval sees it. Transcription drives the client UI. */
  voice: z.boolean().default(true),
  /** Whether images are fetched as attachments; off keeps the `[图片]` placeholder and downloads nothing. */
  images: z.boolean().default(true),
}).strict()
export type WeixinConfig = z.infer<typeof WeixinConfigSchema>

/** The first configured keyword the text names, case-insensitively; `undefined` when none does. */
function keywordHit(text: string | undefined, keywords: readonly { any: string }[]): string | undefined {
  if (!text || keywords.length === 0) return undefined
  const haystack = text.toLowerCase()
  return keywords.find(item => item.any !== '' && haystack.includes(item.any.toLowerCase()))?.any
}

const Fields: FieldSpec[] = [
  { key: 'baseUrl', type: 'text', label: { zh: '桥地址', en: 'Bridge URL' },
    hint: { zh: 'wxauto-bridge 的 loopback 地址，例如 http://127.0.0.1:8787；只允许本机，不要填公网地址。', en: 'Loopback address of wxauto-bridge, such as http://127.0.0.1:8787; localhost only, never a public address.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '桥 token 文件', en: 'Bridge token file' },
    hint: { zh: '保存 sidecar bearer token 的文件路径；文件权限必须是 0600，否则客户端拒绝读取。', en: 'Path of the file holding the sidecar bearer token; it must have mode 0600 or the client refuses to read it.' } },
  { key: 'selfWxid', type: 'text', pattern: '^[A-Za-z0-9_\\-]+$', label: { zh: '本账号 wxid', en: 'This account wxid' },
    hint: { zh: '群 @ 判定和自消息识别都以它为准，昵称改了也不会失效。', en: 'Group @-detection and own-message detection are judged against it, so a renamed account still works.' } },
  { key: 'rooms', type: 'rows', label: { zh: '接收的群与私聊', en: 'Chats and direct messages' },
    hint: { zh: '只接收这些会话里发给机器人的消息。选**群**＝群聊（按 @ 判定），选**一个人**＝私聊（私聊不需要 @，收到就当作找机器人）。ID 必须是桥给出的稳定标识（形如 wxname_…），不能填昵称；点「刷新会话列表」从桥能看到的会话里挑，再保存。第二列的「名字」只是给人看的标签，选中后会自动填，留空也可以。', en: 'Receives only the messages to the bot in these chats; the chat ID must be the stable ID the bridge reports (a backend without stable IDs names them wxname_…), never a nickname. Press "Refresh chats" to pick from what the bridge can see, then save.' },
    columns: [
      { key: 'id', type: 'text', label: { zh: '群 ID', en: 'Chat ID' }, pattern: '^[A-Za-z0-9_\-]+$',
        choose: { zh: '选择桥能看到的会话', en: 'Choose a chat the bridge can see' },
        refresh: { zh: '刷新会话列表', en: 'Refresh chats' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
    ] },
  { key: 'atOnly', type: 'switch', label: { zh: '仅接收 @ 的消息', en: 'Receive only @s' },
    hint: { zh: '开启时只接收 @ 机器人的群消息；关闭时也接收其余消息，交评估按规则推断。后端完全无法判定群 @ 时（能力为 none），开启会让群消息全部被过滤，此时应关闭并靠规则与名单准入。', en: 'On receives only messages that mention the bot; off also receives the rest, from which Eval may infer work under the rules. A backend that cannot detect mentions at all (capability `none`) filters every group message while this is on, so turn it off and rely on the rules and the sender list.' } },
  { key: 'keywords', type: 'rows', label: { zh: '关键词（不 @ 也算找机器人）', en: 'Keywords (admitted without an @)' },
    hint: { zh: '群消息正文里出现任一个关键词，就当作在找机器人，不需要 @；是否成为可接的工作仍由准入模型判断。大小写不敏感。', en: 'A group message whose text names any of these is treated as addressed to the bot without an @; whether it becomes work is still the admission model\'s decision. Case-insensitive.' },
    columns: [
      { key: 'any', type: 'text', label: { zh: '关键词', en: 'Keyword' } },
    ] },
  { key: 'autoReplies', type: 'rows', label: { zh: '关键词自动回复', en: 'Canned keyword replies' },
    hint: { zh: '命中即由轮询循环直接回固定文字，不经过模型。**这条消息仍会交给模型**——用模板顶掉一个人说的话，剩下的内容就丢了。', en: 'On a match the polling loop sends this fixed text itself, without the model. The message is still handed to the model: answering a person with a template and dropping the rest of what they said loses it.' },
    columns: [
      { key: 'any', type: 'text', label: { zh: '关键词', en: 'Keyword' } },
      { key: 'reply', type: 'text', label: { zh: '回复内容', en: 'Reply' } },
    ] },
  { key: 'mentionBack', type: 'switch', label: { zh: '回复时 @ 发言人', en: 'Mention the sender in a reply' },
    hint: { zh: '仅对群聊生效：回复群里找机器人的那个人时带上 @，让对方确实收到提醒。私聊没有 @ 这一说，开了也不会带。', en: 'Groups only: a reply to the person who addressed the bot carries an @, so they are actually notified. A direct message has no mention to make, so this does nothing there.' } },
  { key: 'voice', type: 'switch', label: { zh: '转写语音消息', en: 'Transcribe voice messages' },
    hint: { zh: '开启时语音会转成文字再交给评估；转写要驱动客户端界面，每条最多占用 8 秒，因此可以在不需要时关掉（关掉后文字是「[语音消息]」占位）。', en: 'On transcribes voice into text before Eval sees it; transcription drives the client UI and may hold it for up to eight seconds per message, so it can be turned off - the text then stays a `[语音消息]` placeholder.' } },
  { key: 'images', type: 'switch', label: { zh: '接收图片', en: 'Receive images' },
    hint: { zh: '开启时图片会作为附件交给模型；关闭时只在文字里留「[图片]」占位，不下载任何字节。', en: 'On hands images to the model as attachments; off leaves a `[图片]` placeholder in the text and downloads nothing.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' },
    hint: { zh: '轮询传输向桥询问新消息的间隔。', en: 'How often the polling transport asks the bridge for new messages.' } },
  { key: 'timeoutSeconds', type: 'number', advanced: true, min: 5, max: 300, label: { zh: '桥请求超时 / 秒', en: 'Bridge request timeout / s' },
    hint: { zh: '单个桥请求最多等多久。有些端点要驱动客户端界面（例如列会话会翻联系人群组，忙时约 10 秒），这个值太小会被误报成「桥没有响应」。', en: 'How long one bridge request may take. Some endpoints drive the client UI - listing chats walks the contact pages and takes about 10 s on a busy account - so too small a value is reported as "the bridge did not answer".' } },
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
  /**
   * Reads what the backend reported it can do, for `scope` and `facts`, which cannot await. A backend that cannot report
   * structured mentions cannot prove a group message addresses the agent, and saying "ambient" would claim we looked.
   */
  capabilities?(): BridgeCapabilities | undefined
  /** Builds the bridge client used by `channel.send`; tests inject a fake so nothing reaches the network. */
  client?(config: WeixinConfig): BridgeClient
}

/** What the last bridge read reported: the account status and, when the sidecar said, its capability report. */
let remembered: { status: BridgeStatus; capabilities?: BridgeCapabilities } | undefined
/**
 * Records what a bridge read just returned, so the next `facts` render shows the account it belongs to. `capabilities` is
 * optional because a sidecar older than the capability report is read as capable on every count.
 */
export function rememberWeixinStatus(status: BridgeStatus, capabilities?: BridgeCapabilities): void {
  remembered = { status, ...(capabilities ? { capabilities } : {}) }
}

/** Reception result of the weixin kind: ambient group messages stay observable for Thread context even when not listened. */
type WeixinScopeResult =
  | { listened: true; observed: boolean; row?: string }
  | { listened: false; reason: string; observed?: boolean; row?: string }

/**
 * How the panel describes the strength of this backend's mention proof. `markup` is the honest middle: it reads the
 * separator the client itself inserts after a name picked from the mention list, so a person typing `@name` does not
 * produce it, but a pasted separator can, and a renamed account no longer matches its own name.
 */
const MENTION_FACTS: Record<MentionCapability, Localized> = {
  structured: { zh: '群 @ 按结构化列表判定', en: 'Group @s are judged on the structured list' },
  markup: { zh: '群 @ 按客户端标记判定：改本账号昵称即失效，粘贴分隔符可伪造', en: "Group @s are judged on the client's own mention markup: renaming this account breaks it, and a pasted separator can forge it" },
  none: { zh: '该后端无法判定群 @：群消息只按规则推断，不按 @ 判定', en: 'This backend cannot detect group @s: group messages are judged by the rules, never by mentions' },
}

/** Builds the weixin SourceKind; the default `weixinKind` uses the sidecar client and the last recorded status. */
export function createWeixinKind(hooks: WeixinKindHooks = {}): SourceKind<WeixinConfig> {
  const bridgeFor = (config: WeixinConfig): BridgeClient =>
    hooks.client?.(config)
      ?? createBridgeClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile, timeoutMs: config.timeoutSeconds * 1000 })
  /** What the backend last reported it can do; `undefined` while nothing has been read, which reads as capable. */
  const capabilitiesOf = (): BridgeCapabilities | undefined => hooks.capabilities ? hooks.capabilities() : remembered?.capabilities
  const policy: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }> = {
    unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
    schema: WeixinPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' },
        hint: { zh: '这里是**授权**：名单里的人 @ 机器人或私聊机器人，才算明确请求。它与「接收的群与私聊」是两件事——那个列表决定消息**收不收得到**，这个名单决定收到后能不能**变成可接的工作**，所以想接某人私聊时两处都要加他。两个列表的候选都只含桥真见过的对象：先让他在微信里发一条消息（或你打开一次他的会话），再点「刷新会话列表」。', en: 'This list is **authorization**: someone on it who mentions the bot or messages it directly makes an explicit request. It is a different setting from "Chats and direct messages", which decides whether a message is received at all, so a person whose direct messages you want both received and acted on has to be in both. Both pickers only hold what the bridge has actually seen: have them send one message (or open their chat once), then refresh.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '^[A-Za-z0-9_\-]+$',
            choose: { zh: '选择桥见过的发送人', en: 'Choose a sender the bridge has seen' } },
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
    // A reply goes only to a chat the Source still receives. A direct message carries no room - the direct
    // stream is one conversation per person - so the person's id is what the configuration names.
    allowed: (address, config) => config.rooms.some(room => room.id === (address.room || address.wxid)),
    send: async (host: ChannelHost, message: OutboundMessage): Promise<'sent' | 'gone'> => {
      const { room = '', wxid = '', quoteId } = message.channel.address
      const config = host.config as WeixinConfig
      // A mention only exists in a group, and it names the sender by id: the sidecar knows the display name it observed
      // for that id, so a rewritten nickname cannot make the reply mention the wrong person.
      const at = config.mentionBack && room && wxid ? { at: [wxid] } : {}
      const result = await bridgeFor(config).send({
        room, wxid, text: message.text, ...(quoteId ? { quoteId } : {}), ...at, idempotencyKey: message.id,
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
    // A backend that reports it cannot produce `ats` at all can never prove a group message addresses the agent. Recording
    // `group_ambient` there would claim we looked and found no `@`; the honest reason is that we cannot look, which also
    // tells an operator that the Policy's mention row is unavailable rather than simply unmatched. `markup` backends do
    // produce `ats`, so they take the same path as `structured` ones; only `facts` distinguishes how strong the proof is.
    scope(input, config): WeixinScopeResult {
      const { meta } = input
      const room = typeof meta.room === 'string' ? meta.room : ''
      if (!room) return { listened: true, observed: false, row: 'directMessages' }
      // A keyword admits the message the way an `@` does: it says the group was talking about something this Source cares
      // about. It does not claim a mention, so the row still says ambient and the admission model still decides the rest.
      const keyword = keywordHit(input.text, config.keywords)
      if (capabilitiesOf()?.mentions === 'none') {
        return config.atOnly && !keyword
          ? { listened: false, reason: 'mentions_unsupported', observed: true, row: 'groupAmbient' }
          : { listened: true, observed: true, row: 'groupAmbient' }
      }
      const ats = Array.isArray(meta.ats) ? meta.ats.filter((id): id is string => typeof id === 'string') : []
      const addressed = ats.includes(config.selfWxid)
      const row = addressed ? 'groupAddressed' : 'groupAmbient'
      return addressed || !config.atOnly || keyword
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
    // The second fact states how strong the mention proof is rather than hiding it: a `markup` backend reads the client's
    // own mention markup, which survives neither a renamed account nor a pasted separator, and an operator should know that
    // before treating a group `@` as authorization.
    facts: () => {
      const status = hooks.status ? hooks.status() : remembered?.status
      const account = status?.loggedIn ? { zh: `已登录：${status.name || status.wxid}`, en: `Signed in as ${status.name || status.wxid}` } : { zh: '未连接', en: 'Not connected' }
      const mentions = MENTION_FACTS[capabilitiesOf()?.mentions ?? 'structured']
      return { account, mentions }
    },
    // A backend without stable chat IDs names its chats and people `wxname_<hash>`, which keeps the id patterns strict at
    // the cost of being unreadable. This resolves them to display names for the panel's row keys, exactly as the Feishu
    // kind resolves its chat ids; a failed read leaves the stored labels alone rather than clearing them.
    async refreshLabels(host) {
      const ctx = host.context({ kind: SOURCE, health: ['weixin'] })
      const config = ctx.config<WeixinConfig>(SOURCE)
      if (!config) return {}
      // Refreshing the picker is a person pressing a button and waiting, so it may wait far longer than
      // a poll: the first listing can walk the contact pages, and giving up early leaves them with nothing.
      const bridge = hooks.client?.(config)
        ?? createBridgeClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile, timeoutMs: Math.max(config.timeoutSeconds, 60) * 1000 })
      const labels: Record<string, string> = {}
      for (const room of await bridge.rooms()) {
        if (room.name) labels[room.id] = room.name
        for (const person of await bridge.members(room.id)) if (person.name) labels[person.id] = person.name
      }
      ctx.state.set(KV.sources.labels(SOURCE), labels)
      return labels
    },
  }
}

/** The weixin Source kind as installed: sidecar client over HTTP and the last status the polling loop recorded. */
export const weixinKind = createWeixinKind()
