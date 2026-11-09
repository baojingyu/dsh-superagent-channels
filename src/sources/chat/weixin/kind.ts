/** Weixin Source kind: group messages judged by structured `@`, echo-idempotent replies through the sidecar bridge, and its environment. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { OutboundMessage } from '../../../core/index.ts'
import { KV } from '../../../kv.ts'
import type { SourceHost } from '../../host.ts'
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
  /**
   * What this group hands over: only messages that mention the agent, or every message in it. This is reception, not authorization -
   * whether a received message becomes work is the Policy's admission table, so there is no "may originate work" switch here.
   * Absent falls back to `atOnly` so a configuration written before this setting existed keeps its behaviour.
   */
  listen: z.enum(['mentions', 'all']).optional(),
}).strict()).default([])
export const WeixinConfigSchema = z.object({
  /** Loopback address of the wxauto-bridge sidecar; the bridge never listens beyond 127.0.0.1. */
  baseUrl: z.url().default('http://127.0.0.1:8787'),
  /** Path of the file holding the sidecar's bearer token; it must be readable only by this account (mode 0600). */
  tokenFile: z.string().trim().min(1),
  /** The agent's own wxid: what group `@`s and own messages are judged against. */
  selfWxid: z.string().trim().regex(WXID_PATTERN, 'Invalid wxid'),
  rooms: RoomsSchema,
  /**
   * Whether direct messages are read at all. Off keeps the Source to groups. On (the default) does not authorize anyone:
   * every direct message is read as one stream, and the Policy's list of people decides who may originate work, so a person
   * is configured once.
   */
  directMessages: z.boolean().default(true),
  /** Receive only messages that mention the agent; off receives everything and leaves admission to the Policy. */
  atOnly: z.boolean().default(true),
  /** How often the polling transport asks the bridge for new messages, in seconds. */
  pollSeconds: z.number().int().min(5).max(3600).default(5),
  /**
   * The Windows scheduled task that runs the sidecar. The plugin never starts the bridge itself - it must live in the logged-in
   * desktop session, survive a DSH restart, and keep its own local shim out of the repository - so a panel button asks this task to
   * start or stop it. Validated to a task name so a button can never become a command.
   */
  bridgeTask: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9 _.\-\\]+$/, 'Invalid task name').default('DSH-WeChat-Bridge'),
  /**
   * Absolute path of this machine's bridge launcher (a .cmd or .bat). The plugin starts it detached so the bridge outlives a DSH
   * restart, and never needs to know what is inside: the client library and its local shim stay on the machine, out of the repository.
   * Filled in the panel, so starting the bridge needs no command line.
   */
  bridgeLauncher: z.string().trim().max(400).default(''),
  /**
   * How long one bridge request may take, in seconds. The default is generous because some endpoints
   * drive the client's own UI: listing chats enumerates the contact pages, which costs ~10 s on a busy
   * account. Too small a value looks like "the bridge did not answer" while it is still working.
   */
  timeoutSeconds: z.number().int().min(5).max(300).default(30),
  /** Phrases that admit a group message without an `@`. Matched case-insensitively inside the text. */
  keywords: z.array(z.object({ any: z.string().trim().min(1).max(50) }).strict()).default([]),
  /** Whether a ticket's model may send a file from its working directory to this conversation. */
  sendFiles: z.boolean().default(false),
  /**
   * Send a receipt the moment a message addresses the bot, *before* the model is asked. Off by default: a message can be
   * ignored after that receipt, and "on it" followed by silence reads exactly like work in progress. With it off, a refused
   * message gets one line explaining that it was not taken, and an accepted one gets the acceptance's own reply.
   */
  acknowledge: z.boolean().default(false),
  /** What that receipt says. Kept short: it goes out before anything has been understood. */
  ackText: z.string().trim().min(1).max(200).default('收到，正在处理，请稍等。'),
  /** Seconds between "still working" notes while the bot has said nothing; 0 turns them off. */
  progressAfterSeconds: z.number().int().min(0).max(3600).default(180),
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

/**
 * Fold a group's members into the allow list. Rows that came from a previous sync are replaced; rows a person added by hand stay,
 * and win a collision by id, so a sync never duplicates or drops a manual entry. `via` is bookkeeping only - it decides what a
 * later sync replaces, never whether someone may originate work.
 */
export function mergeSynced(
  allowed: readonly { id: string; name?: string; via?: 'group' | 'direct' | '' }[],
  members: readonly { id: string; name?: string }[],
  mode: 'replace' | 'union' = 'replace',
): { id: string; name?: string; via?: 'group' | 'direct' | '' }[] {
  // `replace` suits a backend that returns the whole roster: what a previous sync added and is no longer there has left the group.
  // `union` suits one that only reports who has spoken: absence is not evidence of leaving, so nothing is ever removed.
  const kept = mode === 'replace' ? allowed.filter(entry => entry.via !== 'group') : [...allowed]
  const taken = new Set(kept.map(entry => entry.id))
  const synced = members.filter(member => !taken.has(member.id))
    .map(member => ({ id: member.id, ...(member.name ? { name: member.name } : {}), via: 'group' as const }))
  return [...kept, ...synced]
}

/**
 * What one group hands over, resolved the one way every reader uses: the group's own `listen`, else the instance default `atOnly`.
 * A configuration written before per-group reception existed only has `atOnly`, and this keeps its behaviour.
 */
function listenOf(room: string, config: { rooms?: readonly { id: string; listen?: 'mentions' | 'all' }[]; atOnly?: boolean }): 'mentions' | 'all' {
  const own = config.rooms?.find(entry => entry.id === room)?.listen
  return own ?? (config.atOnly === false ? 'all' : 'mentions')
}

/**
 * Ask Windows to run or end one scheduled task. Only the task name reaches the command line, and it is validated against a task-name
 * pattern here as well as in the schema, so this can never execute something other than `schtasks ... /tn <task>`.
 */
async function schtasks(host: SourceHost, task: string, verb: '/run' | '/end', signal?: AbortSignal): Promise<void> {
  if (!/^[A-Za-z0-9 _.\-\\]{1,200}$/.test(task)) throw new Error('计划任务名不合法')
  const commands = host.context({ kind: SOURCE, health: ['weixin'] }).commands.withSignal(signal)
  await commands.run('schtasks', [verb, '/tn', task])
}

/** Absolute path of the launcher, or empty when the panel has not been given one. */
const launcherOf = (config: Record<string, unknown>): string => String(config.bridgeLauncher ?? '').trim()

/**
 * Start the bridge through this machine's launcher. Detached and windowless, so it keeps running after DSH exits - which is the
 * whole point: a restarted DSH must not cost a UI re-attach. The argv is the launcher path alone: what it runs is the machine's
 * business, and stays out of the repository.
 */
function startLauncher(config: Record<string, unknown>): number | undefined {
  const launcher = launcherOf(config)
  if (!launcher) return undefined
  if (!existsSync(launcher)) throw new Error(`桥启动器不存在：${launcher}`)
  const child = spawn(launcher, [], { detached: true, stdio: 'ignore', windowsHide: true, cwd: dirname(launcher) })
  child.unref()
  return child.pid
}

/** The PID listening on the bridge's own port, or none. Read from netstat so it works after a DSH restart lost any in-memory state. */
async function bridgePids(host: SourceHost, config: Record<string, unknown>, signal?: AbortSignal): Promise<string[]> {
  const port = Number(new URL(String(config.baseUrl ?? 'http://127.0.0.1:8787')).port || 80)
  const commands = host.context({ kind: SOURCE, health: ['weixin'] }).commands.withSignal(signal)
  const listing = await commands.run('netstat', ['-ano', '-p', 'tcp'])
  const pattern = new RegExp(`127\\.0\\.0\\.1:${port}\\s+0\\.0\\.0\\.0:0\\s+LISTENING\\s+(\\d+)`, 'g')
  return [...new Set([...listing.matchAll(pattern)].map(match => match[1]!))]
}

/** Stop the bridge: end whatever listens on its port, but only if its own command line says it is the bridge. */
async function stopBridge(host: SourceHost, config: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const pids = await bridgePids(host, config, signal)
  if (!pids.length) return '桥没有在监听，可能已经停止。'
  const commands = host.context({ kind: SOURCE, health: ['weixin'] }).commands.withSignal(signal)
  let ended = 0
  for (const pid of pids) {
    const commandLine = await commands.run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`]).catch(() => '')
    // Never kill a stranger that happens to own the port: the command line has to name the sidecar.
    if (!/wxauto-bridge|server\.py/i.test(commandLine)) continue
    await commands.run('taskkill', ['/PID', pid, '/T', '/F'])
    ended += 1
  }
  return ended ? '已停止桥。' : '端口上那个进程不是微信桥，没有动它。'
}

const Fields: FieldSpec[] = [
  { key: 'baseUrl', type: 'text', advanced: true, label: { zh: '桥地址', en: 'Bridge URL' },
    hint: { zh: 'wxauto-bridge 的 loopback 地址，例如 http://127.0.0.1:8787；只允许本机，不要填公网地址。', en: 'Loopback address of wxauto-bridge, such as http://127.0.0.1:8787; localhost only, never a public address.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '桥 token 文件', en: 'Bridge token file' },
    hint: { zh: '保存 sidecar bearer token 的文件路径；文件权限必须是 0600，否则客户端拒绝读取。', en: 'Path of the file holding the sidecar bearer token; it must have mode 0600 or the client refuses to read it.' } },
  { key: 'selfWxid', type: 'text', pattern: '^[A-Za-z0-9_\\-]+$', label: { zh: '本账号 wxid', en: 'This account wxid' },
    hint: { zh: '群 @ 判定和自消息识别都以它为准，昵称改了也不会失效。', en: 'Group @-detection and own-message detection are judged against it, so a renamed account still works.' } },
  { key: 'rooms', type: 'rows', label: { zh: '接收的群', en: 'Groups to receive' },
    hint: { zh: '这里只填群：这些群里发给机器人的消息会被接收（按结构化 @ 判定，不看文本里的 @昵称）。每行的「接收」决定这个群是只交 @ 机器人的消息，还是交全部消息。私聊不需要在这里配——私聊本来就收得到。「谁能发起工作」只在「评估 → 策略 → 在各来源上」的名单里配一次，这里没有第二个开关。ID 必须是桥给出的稳定标识（形如 wxname_…），不能填昵称；点「刷新会话列表」从桥能看到的会话里选。',
      en: 'Groups only: messages to the bot in these groups are received (judged on the structured @ list, never on @name in the text). A direct message needs no entry here - it arrives anyway - and the list of people who may originate work lives in one place: Eval -> Policy -> per Source.' },
    columns: [
      { key: 'id', type: 'text', label: { zh: '群 ID', en: 'Chat ID' }, pattern: '^[A-Za-z0-9_\-]+$',
        choose: { zh: '选择桥能看到的会话', en: 'Choose a chat the bridge can see' },
        refresh: { zh: '刷新会话列表', en: 'Refresh chats' } },
      { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' },
        options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
    ] },
  { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Receive direct messages' },
    hint: { zh: '开启时读取私聊消息流（微信的私聊是一条流，不是每人一个会话），具体谁能发起工作仍由「评估 → 策略 → 能发起工作的用户」决定——所以人只在那一个地方配。关掉则只收群。', en: 'On reads the direct-message stream (WeChat delivers direct messages as one stream keyed by sender, not as a chat per person). Who may originate work is still decided by the Policy list, which is the only place people are configured. Off keeps the Source to groups.' } },
  { key: 'atOnly', type: 'switch', advanced: true, label: { zh: '新群的默认接收', en: 'Default reception for a new group' },
    hint: { zh: '只对还没单独设置「接收」的群生效：开启时只收 @ 机器人的消息，关闭时也收其余消息、交评估按规则推断。上表每一行的「接收」会覆盖它。后端完全无法判定群 @ 时（能力为 none），开启会让群消息全部被过滤，此时应关闭并靠规则与名单准入。', en: 'On receives only messages that mention the bot; off also receives the rest, from which Eval may infer work under the rules. A backend that cannot detect mentions at all (capability `none`) filters every group message while this is on, so turn it off and rely on the rules and the sender list.' } },
  { key: 'keywords', type: 'rows', advanced: true, label: { zh: '关键词（不 @ 也算找机器人）', en: 'Keywords (admitted without an @)' },
    hint: { zh: '群消息正文里出现任一个关键词，就当作在找机器人，不需要 @；是否成为可接的工作仍由准入模型判断。大小写不敏感。', en: 'A group message whose text names any of these is treated as addressed to the bot without an @; whether it becomes work is still the admission model\'s decision. Case-insensitive.' },
    columns: [
      { key: 'any', type: 'text', label: { zh: '关键词', en: 'Keyword' } },
    ] },
  { key: 'autoReplies', type: 'rows', advanced: true, label: { zh: '关键词自动回复', en: 'Canned keyword replies' },
    hint: { zh: '命中即由轮询循环直接回固定文字，不经过模型。这条消息仍会交给模型——用模板顶掉一个人说的话，剩下的内容就丢了。', en: 'On a match the polling loop sends this fixed text itself, without the model. The message is still handed to the model: answering a person with a template and dropping the rest of what they said loses it.' },
    columns: [
      { key: 'any', type: 'text', label: { zh: '关键词', en: 'Keyword' } },
      { key: 'reply', type: 'text', label: { zh: '回复内容', en: 'Reply' } },
    ] },
  { key: 'sendFiles', type: 'switch', advanced: true, label: { zh: '允许模型回传文件', en: 'Let the model send files' },
    hint: { zh: '开启后，工单里的模型可以把它自己工作目录内的文件（≤20 MiB、非可执行文件）回传到这个会话。默认关闭——这等于给模型一条把文件发出去的通道。', en: 'When on, the model working a ticket may send a file from its own working directory (≤ 20 MiB, not an executable) to this conversation. Off by default: it is a channel for files to leave the machine.' } },
  { key: 'acknowledge', type: 'switch', advanced: true, label: { zh: '收到就先回一句', en: 'Acknowledge on receipt' },
    hint: { zh: '开启时，有人 @ 机器人或私聊机器人就在评估之前立刻回一句「收到」。默认关闭：评估可能把这条判为忽略，那样「收到」会让人以为在干活。关闭后改为评估完按结果回——被忽略的会收到一句「这条我没有接：…」，被接受的由接受时的回执回复。', en: 'On: a receipt goes out immediately when someone mentions the bot or messages it directly, before the assessment. Off by default, because the assessment may ignore the message and "on it" then reads as work in progress. Off: the reply follows the decision - a refused message gets one line saying it was not taken, an accepted one gets the acceptance reply.' } },
  { key: 'ackText', type: 'text', advanced: true, label: { zh: '回执内容', en: 'Receipt text' },
    hint: { zh: '回执只表示「收到了」，此时还没读懂你要做什么，所以别写具体承诺。', en: 'A receipt only says it arrived; nothing has been understood yet, so do not promise anything specific.' } },
  { key: 'progressAfterSeconds', type: 'number', advanced: true, min: 0, max: 3600, label: { zh: '处理中提醒 / 秒', en: 'Still-working note / s' },
    hint: { zh: '发出回执后，机器人在这个会话里一直没说话，就每隔这么久补一句「还在处理中」（最多 3 次）。机器人一开口就停。填 0 关闭。', en: 'After the receipt, if the bot has said nothing in that chat, add a "still working" note at this interval (at most 3). It stops as soon as the bot speaks. 0 turns it off.' } },
  { key: 'mentionBack', type: 'switch', advanced: true, label: { zh: '回复时 @ 发言人', en: 'Mention the sender in a reply' },
    hint: { zh: '仅对群聊生效：回复群里找机器人的那个人时带上 @，让对方确实收到提醒。私聊没有 @ 这一说，开了也不会带。', en: 'Groups only: a reply to the person who addressed the bot carries an @, so they are actually notified. A direct message has no mention to make, so this does nothing there.' } },
  { key: 'voice', type: 'switch', advanced: true, label: { zh: '转写语音消息', en: 'Transcribe voice messages' },
    hint: { zh: '开启时语音会转成文字再交给评估；转写要驱动客户端界面，每条最多占用 8 秒，因此可以在不需要时关掉（关掉后文字是「[语音消息]」占位）。', en: 'On transcribes voice into text before Eval sees it; transcription drives the client UI and may hold it for up to eight seconds per message, so it can be turned off - the text then stays a `[语音消息]` placeholder.' } },
  { key: 'images', type: 'switch', advanced: true, label: { zh: '接收图片', en: 'Receive images' },
    hint: { zh: '开启时图片会作为附件交给模型；关闭时只在文字里留「[图片]」占位，不下载任何字节。', en: 'On hands images to the model as attachments; off leaves a `[图片]` placeholder in the text and downloads nothing.' } },
  { key: 'bridgeLauncher', type: 'text', advanced: true, label: { zh: '桥启动器', en: 'Bridge launcher' },
    hint: { zh: '本机用来启动 wxauto-bridge 的脚本绝对路径（.cmd / .bat），例如 C:\dev\dsh-superagent-channels-ext\start-wxbridge.cmd。插件只负责把它拉起来（后台、无窗口、脱离 DSH），脚本里写了什么由你决定——微信客户端库和本机 shim 都留在机器上，不进仓库。填了它就用它启动，比计划任务更直接。', en: 'Absolute path of the script that starts wxauto-bridge on this machine (a .cmd or .bat). The plugin only launches it - detached, hidden, independent of DSH - and does not care what is inside: the client library and the machine shim stay out of the repository. With this set, Start runs it directly instead of using the scheduled task.' } },
  { key: 'bridgeTask', type: 'text', advanced: true, label: { zh: '桥的计划任务', en: 'Bridge scheduled task' },
    hint: { zh: '本机跑 wxauto-bridge 的 Windows 计划任务名。插件不自己拉起进程，只用「启动桥 / 停止桥」按钮让这个任务启停；因为桥必须跑在已登录的桌面会话里，且要活过 DSH 重启。', en: 'The Windows scheduled task that runs wxauto-bridge on this machine. The plugin never spawns it; the Start/Stop buttons ask this task to run or end it, because the bridge must live in the signed-in desktop session and outlive a DSH restart.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 5, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Poll interval / s' },
    hint: { zh: '轮询传输向桥询问新消息的间隔。', en: 'How often the polling transport asks the bridge for new messages.' } },
  { key: 'timeoutSeconds', type: 'number', advanced: true, min: 5, max: 300, label: { zh: '桥请求超时 / 秒', en: 'Bridge request timeout / s' },
    hint: { zh: '单个桥请求最多等多久。有些端点要驱动客户端界面（例如列会话会翻联系人群组，忙时约 10 秒），这个值太小会被误报成「桥没有响应」。', en: 'How long one bridge request may take. Some endpoints drive the client UI - listing chats walks the contact pages and takes about 10 s on a busy account - so too small a value is reported as "the bridge did not answer".' } },
]

const WeixinPolicySchema = z.object({
  allowed: z.array(z.object({
    // The bridge reports a member id where it has one and the display name where it does not, so accepting only the strict wxid
    // shape made a person the picker offered impossible to save. Any non-blank identifier up to 100 characters is taken, and the
    // duplicate check below still keeps the list unambiguous.
    id: z.string().trim().min(1).max(100),
    name: z.string().trim().max(100).optional(),
    /** Where this person came from: a group the list was synced from, or a direct message. A marking only, never authorization. */
    via: z.union([z.enum(['group', 'direct']), z.literal('')]).optional(),
  }).strict())
    .refine(people => new Set(people.map(person => person.id)).size === people.length, 'Duplicate wxids')
    .default([]),
  /** The group the list is synced from; empty means no sync target. */
  syncChat: z.string().trim().regex(/^[A-Za-z0-9_\-]*$/).default(''),
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
  const policy: SourcePolicyPart<Record<string, unknown> & {
    allowed: { id: string; name?: string; via?: 'group' | 'direct' | '' }[]
  }> = {
    unnamed: { person: { zh: '微信用户', en: 'WeChat user' }, bot: { zh: '微信机器人', en: 'WeChat bot' } },
    schema: WeixinPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的微信用户', en: 'WeChat users who may originate work' },
        hint: { zh: '这里是授权：只有名单里的人发来的消息才可能成为可接的工作。它与「接收的群」是两件事——那个列表决定消息收不收得到，这个名单决定收到后能不能变成可接的工作。群消息还是私聊消息由消息本身决定，准入表据此自动分行政，这里不用标来源。候选只含桥真见过的对象：先让对方在微信里发一条消息，再点同步。',
          en: 'Authorization: only messages from people on this list can become work. It is separate from "Groups to receive" - that list decides what arrives, this one decides what may become work. Candidates only hold people the bridge has seen: have them message the bot once, then sync.' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '用户 ID', en: 'User ID' }, pattern: '^[A-Za-z0-9_\-]+$',
            choose: { zh: '选择桥见过的发送人', en: 'Choose a sender the bridge has seen' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
      { key: 'syncChat', type: 'text', pattern: '^[A-Za-z0-9_\-]*$', label: { zh: '同步来源群', en: 'Sync from group' },
        choose: { zh: '不同步', en: 'Do not sync' },
        hint: { zh: '选一个群，再点「立即同步」，把它的人加进上面的名单，省得一个个手填。能否拿到完整名册取决于后端：wxautox4 没有群成员表接口，只能给出「在这个群里发过言的人」，所以同步是「加人不删人」——群里有谁没说过话，就不会被同步进来，需要时手动添加。它不读聊天内容，也不改变「接收的群」。',
          en: 'Pick a group and press Sync now: its members are read into the list above, marked as coming from a group, so you do not add them one by one. It reads the member roster only - no message content - and does not change the groups you receive; people you marked as direct are kept.' },
      },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    // 行＝接收范围：每个已订阅的群（注解「仅 @」或「全部消息」）与私聊；云效之外的会话（其他群）根本不会被监听，所以不列。
    rows(stored) {
      const config = stored as Partial<WeixinConfig>
      const rooms = Array.isArray(config.rooms) ? config.rooms : []
      return [
        ...rooms.map(room => {
          const everyMessage = listenOf(room.id, config) === 'all'
          return { id: room.id, label: room.name || room.id,
            note: everyMessage ? { zh: '全部消息', en: 'All' } : { zh: '仅 @', en: '@ only' },
            cells: { listedUnaddressed: everyMessage, unlistedAddressed: true, unlistedUnaddressed: everyMessage } }
        }),
        { id: 'directMessages', label: { zh: '私聊', en: 'Direct messages' },
          note: config.directMessages === false ? { zh: '不接收', en: 'Not received' } : { zh: '接收', en: 'Received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages !== false, unlistedUnaddressed: false } },
      ]
    },
    sync: {
      label: { zh: '立即同步', en: 'Sync now' },
      ready: part => !!part.syncChat,
      async run(host, part, signal) {
        const room = String(part.syncChat)
        const config = host.sources.instance<WeixinConfig>(SOURCE)?.config
        if (!config) throw new Error('微信来源尚未配置，无法同步成员')
        if (signal.aborted) return part
        const bridge = bridgeFor(config)
        const health = await bridge.health()
        const roster = health.capabilities?.members ?? 'full'
        if (roster === 'none') throw new Error('这个微信后端不提供成员信息（members: none），无法同步；请在上面手动添加。')
        // The bridge knows a group by its display name; the configuration holds the stable id.
        const target = (config.rooms ?? []).find(entry => entry.id === room)
        const members = await bridge.members(target?.name || room)
        if (signal.aborted) return part
        if (members.length === 0) {
          throw new Error(roster === 'full'
            ? '这个群里没有读到任何成员，请确认群的 ID 正确。'
            : '这个后端拿不到群成员名册（wxautox4 只提供「在这个群里发过言的人」），而这个群还没有人发过言。让成员在群里说一句再同步，或在上面手动添加。')
        }
        // A roster backend can replace what it wrote last time; an observed one can only add.
        return { ...part, allowed: mergeSynced(part.allowed, members, roster === 'full' ? 'replace' : 'union') }
      },
    },
    warnings(config, part) {
      if (part.allowed.length > 0) return []
      return [{ zh: '「能发起工作的微信用户」是空的：现在任何人发消息都会被判为「名单外」而拒绝。人只在这一个地方配——私聊不需要在「接收的群」里再写一次。',
        en: 'The list of people who may originate work is empty, so every message is refused as unlisted. People are configured here, once: a direct chat needs no entry among the groups.' }]
    },
  }
  const channel: SourceChannel<WeixinConfig> = {
    // A chat message is a person writing to the bot, so a refusal owes them one line; a work item does not.
    acceptsNotice: true,
    // Declarative transport metadata: message length limit, no Markdown, and whether a send may start a conversation.
    // Nothing reads it yet; the sidecar enforces these, and it reports what it can carry.
    // A retried send carries the OutboundMessage ID as the sidecar's Idempotency-Key and the sidecar answers `deduped`, so a
    // conversation is keyed: a retry returns the message already sent instead of posting a second one (not echo-matched).
    capabilities: { idempotency: 'keyed', maxChars: 2000, markdown: false, proactive: true,
      files: { maxBytes: 20 * 1024 * 1024 } },
    // A reply goes only to a chat the Source still receives. A direct message carries no room - the direct
    // stream is one conversation per person - so the person's id is what the configuration names.
    allowed: (address, config) => address.room ? config.rooms.some(room => room.id === address.room) : true,
    send: async (host: ChannelHost, message: OutboundMessage): Promise<'sent' | 'gone'> => {
      const { room = '', wxid = '', quoteId } = message.channel.address
      const config = host.config as WeixinConfig
      // A mention only exists in a group, and it names the sender by id: the sidecar knows the display name it observed
      // for that id, so a rewritten nickname cannot make the reply mention the wrong person.
      const at = config.mentionBack && room && wxid ? { at: [wxid] } : {}
      // Files only leave when the operator turned it on; the tool that produces them refuses earlier, and this is the
      // second guard for anything else that puts files on a message.
      const files = config.sendFiles === true ? message.files ?? [] : []
      const bridge = bridgeFor(config)
      const result = await bridge.send({
        room, wxid, text: message.text, ...(quoteId ? { quoteId } : {}), ...at,
        ...(files[0] ? { file: files[0] } : {}), idempotencyKey: message.id,
      })
      if (result === 'gone') return 'gone'
      // `/send` carries one file per call, so the rest follow, each keyed by its own position.
      for (const [index, file] of files.slice(1).entries()) {
        await bridge.send({ room, wxid, text: '', file, idempotencyKey: `${message.id}:file${index + 2}` })
      }
      return 'sent'
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
      // What this group hands over; a group set to "all messages" needs no mention to be listened to.
      const ambient = listenOf(room, config) === 'all'
      if (capabilitiesOf()?.mentions === 'none') {
        return !ambient && !keyword
          ? { listened: false, reason: 'mentions_unsupported', observed: true, row: room }
          : { listened: true, observed: true, row: room }
      }
      const ats = Array.isArray(meta.ats) ? meta.ats.filter((id): id is string => typeof id === 'string') : []
      const addressed = ats.includes(config.selfWxid)
      // The group names its own admission row, one line per conversation in the table.
      const row = room
      return addressed || ambient || keyword
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
    /**
     * Bridge control. The sidecar is deliberately not this plugin's child: it needs the interactive desktop session, has to survive
     * a DSH restart, and its local shim must stay out of the repository. So the panel asks the machine's scheduled task to start or
     * stop it, and "check" reads /health for a straight answer about what the backend can do.
     */
    actions: [
      { id: 'bridge.start', label: { zh: '启动桥', en: 'Start bridge' },
        hint: { zh: '让本机计划任务启动 wxauto-bridge。需要微信客户端已登录，且这台机器上没有别的 UI 自动化客户端。', en: 'Asks the machine task to start wxauto-bridge. The WeChat client must be signed in, and no other UI-automation client may run.' },
        ready: config => !!launcherOf(config) || !!config.bridgeTask,
        run: async (host, config, signal) => {
          const pid = startLauncher(config)
          if (pid !== undefined) return `已启动桥（pid ${pid}）；几秒后点「检查桥」确认。`
          await schtasks(host, String(config.bridgeTask ?? ''), '/run', signal)
          return '已请求计划任务启动桥；几秒后点「检查桥」确认。'
        } },
      { id: 'bridge.stop', label: { zh: '停止桥', en: 'Stop bridge' },
        hint: { zh: '结束这个计划任务里的桥进程；之后消息不会再进来，直到再次启动。', en: 'Ends the bridge in that task; messages stop arriving until it is started again.' },
        ready: config => !!launcherOf(config) || !!config.bridgeTask,
        run: async (host, config, signal) => {
          if (launcherOf(config)) return stopBridge(host, config, signal)
          await schtasks(host, String(config.bridgeTask ?? ''), '/end', signal)
          return '已请求停止桥。'
        } },
      { id: 'bridge.restart', label: { zh: '重启桥', en: 'Restart bridge' },
        hint: { zh: '先结束再启动。客户端界面卡住、或换了微信账号之后用它。', en: 'Ends then starts it. Use it when the client UI is stuck or the WeChat account changed.' },
        ready: config => !!launcherOf(config) || !!config.bridgeTask,
        run: async (host, config, signal) => {
          if (launcherOf(config)) {
            await stopBridge(host, config, signal)
            const pid = startLauncher(config)
            return `已重启桥（pid ${pid}）；几秒后点「检查桥」确认。`
          }
          const task = String(config.bridgeTask ?? '')
          await schtasks(host, task, '/end', signal)
          await schtasks(host, task, '/run', signal)
          return '已重启桥；几秒后点「检查桥」确认。'
        } },
      { id: 'bridge.check', label: { zh: '检查桥', en: 'Check bridge' },
        hint: { zh: '读一次 /health：是否可达、后端能给出哪些能力。', en: 'Reads /health once: reachable, and which capabilities the backend reports.' },
        async run(host) {
          const config = host.sources.instance<WeixinConfig>(SOURCE)?.config
          if (!config) throw new Error('微信来源未配置')
          const health = await bridgeFor(config).health()
          if (!health.ok) throw new Error(`桥不可用：${health.detail || '没有响应'}；先点「启动桥」。`)
          const capability = health.capabilities
          const roster = capability?.members === 'full' ? '完整成员表' : capability?.members === 'observed' ? '仅发过言的人' : '无成员信息'
          const mentions = capability?.mentions === 'structured' ? '结构化 @' : capability?.mentions === 'markup' ? '仅 @ 标记' : '无法判定 @'
          return `桥正常（后端 ${health.backend ?? '?'}）：成员 ${roster}，@ 判定 ${mentions}。`
        } },
    ],
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
