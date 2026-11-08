/** Weixin source plugin entry: registers the kind and polls its sidecar bridge for new messages in the configured chats. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { createBridgeClient, type BridgeClient, type BridgeInboundOptions } from './chat/weixin/bridge.ts'
import { rememberWeixinStatus, SOURCE, weixinKind, type WeixinConfig } from './chat/weixin/kind.ts'
import type { ChatEvent } from './chat/port.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

export const kind = weixinKind
export const name = 'dsh-superagent-weixin'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(weixinKind), 'weixin: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, weixinKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report('weixin', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}

/**
 * The Trigger of one bridge event: the platform message ID namespaced by the instance, on the Thread of its chat. Exported
 * for the tests: the image IDs of a message must survive into `meta.media`, which is what assessments read.
 */
export function triggerOf(event: ChatEvent, instance: string): Trigger {
  const thread = event.chatId || event.sender.id
  return {
    id: key(SOURCE, event.nativeId),
    source: instance,
    threads: [{ source: instance, id: thread }],
    actor: { source: instance, id: event.sender.id },
    human: !event.sender.bot,
    ...event.direct ? { addressed: 'direct' as const } : event.mentionsAgent ? { addressed: 'mention' as const } : {},
    at: event.at,
    text: event.text,
    ...event.url ? { url: event.url } : {},
    channel: { source: instance, thread: `${instance}:${thread}`,
      address: { room: event.chatId, wxid: event.sender.id, ...event.nativeId ? { quoteId: event.nativeId } : {} } },
    meta: { room: event.chatId, direct: event.direct, senderId: event.sender.id, ats: event.ats ?? [], nativeId: event.nativeId,
      ...event.media?.length ? { media: event.media.map(item => item.id) } : {},
      ...event.parentId ? { parentId: event.parentId } : {} },
  }
}

/** Everything the loop needs to answer a message besides the message itself. */
export interface PollOptions {
  autoReplies?: readonly { any: string; reply: string }[]
  /** Send a receipt the moment a message addresses the bot, before any model is asked. */
  acknowledge?: boolean
  ackText?: string
  /** Seconds between "still working" notes while nothing has come back; 0 turns them off. */
  progressAfterSeconds?: number
}

/** Per chat: when the last receipt went out, so a burst of messages gets one receipt rather than five. */
const lastReceiptAt = new Map<string, number>()
/** Messages whose receipt is out and which the bot has not answered yet: `id -> {chat, owner, at, notes}`. */
const awaiting = new Map<string, { chat: string; owner: string; at: number; notes: number }>()

const RECEIPT_GAP_MS = 30_000
const MAX_PROGRESS_NOTES = 3
const AWAIT_TTL_MS = 60 * 60_000

/** The first canned reply whose keyword the text names, case-insensitively; `undefined` when none does. */
function autoReplyFor(text: string, rules: readonly { any: string; reply: string }[]) {
  const haystack = text.toLowerCase()
  return rules.find(rule => rule.any !== '' && haystack.includes(rule.any.toLowerCase()))
}

/** Reads one chat from its stored cursor and hands every message not the agent's own to the Engine. */
export async function pollChat(ctx: SourceContext, bridge: BridgeClient, instance: string, chat: string,
  options: PollOptions = {}): Promise<number> {
  const autoReplies = options.autoReplies ?? []
  const cursor = ctx.state.get(KV.chat.history(instance, chat))
  const page = await bridge.messages(chat, cursor)
  // A sidecar restart used to begin its sequence at zero while this cursor is stored, so every later event was filtered
  // out and the chat went silent with no error anywhere. The page now carries the backend's head: a cursor ahead of it
  // means the counter moved backwards, and starting over is the only way to see the messages again. Repeats are absorbed
  // upstream, which keys a Trigger by its message id.
  if (page.head && cursor && Number(cursor) > Number(page.head)) {
    ctx.state.set(KV.chat.history(instance, chat), '')
    return 0
  }
  let received = 0
  for (const event of page.events) {
    // The bridge delivers the agent's own messages back as echoes; they never authorize work, but they do say the bot has
    // answered this chat, so the "still working" notes for it stop here.
    if (event.ownMessage) {
      for (const [id, pending] of awaiting) if (pending.chat === chat && pending.owner === instance) awaiting.delete(id)
      continue
    }
    // A receipt goes out before the model is asked anything: the assessor takes from 53 s to over two minutes here, and a
    // follow-up on an existing ticket never produced one at all. Only a message that addresses the bot is receipted, and
    // at most one per chat per half minute, so a burst of messages gets one "收到" rather than five.
    if (options.acknowledge && (event.mentionsAgent || event.direct)) {
      const key = `${instance}:${chat}`
      const last = lastReceiptAt.get(key) ?? 0
      if (Date.now() - last >= RECEIPT_GAP_MS) {
        lastReceiptAt.set(key, Date.now())
        try {
          await bridge.send({ room: event.chatId, wxid: event.sender.id,
            text: options.ackText || '收到，正在处理，请稍等。', idempotencyKey: `ack:${instance}:${event.nativeId}` })
          awaiting.set(`${instance}:${event.nativeId}`, { chat, owner: instance, at: Date.now(), notes: 0 })
        } catch { /* a receipt that cannot be sent must not stop the message being handed over */ }
      }
    }
    // A configured template goes out from here, without the agent: its own idempotency key keeps a redelivered page from
    // posting it twice. The message is still handed over below - a template is not a reason to drop what the person said.
    const canned = autoReplyFor(event.text, autoReplies)
    if (canned) {
      try {
        await bridge.send({ room: event.chatId, wxid: event.sender.id, text: canned.reply,
          idempotencyKey: `auto:${instance}:${event.nativeId}` })
      } catch { /* a canned reply that cannot be sent must not stop the round or lose the message */ }
    }
    await ctx.receive(triggerOf(event, instance))
    received += 1
  }
  // One "still working" note per due message, after the page is handled: a person who asked for something long-running
  // should learn that it is still running rather than guess. It stops as soon as the bot speaks in that chat.
  const every = (options.progressAfterSeconds ?? 0) * 1000
  if (every > 0) {
    for (const [id, pending] of awaiting) {
      if (pending.chat !== chat || pending.owner !== instance) continue
      if (Date.now() - pending.at > AWAIT_TTL_MS || pending.notes >= MAX_PROGRESS_NOTES) { awaiting.delete(id); continue }
      if (Date.now() - pending.at < every * (pending.notes + 1)) continue
      pending.notes += 1
      try {
        await bridge.send({ room: chat, wxid: '', text: `还在处理中，完成后会在这里告诉你（进度提醒 ${pending.notes}/3）。`,
          idempotencyKey: `note:${id}:${pending.notes}` })
      } catch { /* best effort, like the receipt */ }
    }
  }
  // The cursor advances only after the page is handed over, so a stopped poll reads the same page again.
  if (page.next !== cursor) ctx.state.set(KV.chat.history(instance, chat), page.next)
  return received
}

/**
 * Tells the backend which chats to watch, and reports what it confirmed plus what it could not resolve. The configuration
 * decides; the sidecar acts only on the difference, so this runs every round and adding or removing a chat in the panel
 * takes effect without restarting the sidecar. An empty configuration is skipped on purpose: it would silence a sidecar
 * whose chats someone configured on its own, while a Source with no chats already reads nothing. A backend that cannot
 * change its listen set at runtime answers `undefined` and is left alone.
 */
export async function reconcileListen(bridge: BridgeClient, rooms: readonly { id: string }[],
  options?: BridgeInboundOptions): Promise<{ watching: number; unresolved: string[] }> {
  if (rooms.length === 0 || !bridge.listen) return { watching: 0, unresolved: [] }
  const result = await bridge.listen(rooms.map(room => room.id), options)
  return { watching: result.listening.length, unresolved: result.failed.map(entry => entry.room) }
}

/** One polling round over the configured chats; the bridge's status is recorded for the kind's synchronous `facts`. */
async function pollRound(ctx: SourceContext, config: WeixinConfig, signal: AbortSignal): Promise<PollRound> {
  const instance = SOURCE
  const bridge = createBridgeClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile, timeoutMs: config.timeoutSeconds * 1000 })
  // `/health` carries what the backend can actually do, and `scope` must answer synchronously, so it is read once per round
  // and remembered beside the status. It is a loopback call, and reading it every round is what lets a backend swap be
  // noticed without restarting this plugin.
  const health = await bridge.health()
  rememberWeixinStatus(await bridge.status(), health.capabilities)
  // The switches ride along with the chat set: the sidecar decides what to render as each message arrives, and a
  // changed switch has to reach it even when no chat changed.
  const { watching, unresolved } = await reconcileListen(bridge, config.rooms,
    { voice: config.voice, images: config.images })
  let received = 0
  for (const room of config.rooms) {
    signal.throwIfAborted()
    received += await pollChat(ctx, bridge, instance, room.id, {
      autoReplies: config.autoReplies, acknowledge: config.acknowledge,
      ackText: config.ackText, progressAfterSeconds: config.progressAfterSeconds })
  }
  return { received, watching, unresolved }
}

/** What one round did: messages handed over, chats the backend confirmed it watches, and chats it could not resolve. */
interface PollRound { received: number; watching: number; unresolved: string[] }

/** Polls each chat every `pollSeconds`; setup and an off Source keep it quiet instead of failing. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report('weixin', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<WeixinConfig>(SOURCE)
    if (!config) ctx.report('weixin', health('paused', 'sourceOff'))
    else {
      try {
        const round = await pollRound(ctx, config, signal)
        if (!signal.aborted) {
          // The detail names the chats the backend confirmed it watches, so "configured but not watched" is visible in the
          // panel instead of looking like a quiet group. An unresolved chat is named rather than counted: it is the one
          // thing an operator has to fix.
          const watching = round.watching || config.rooms.length
          const unresolved = round.unresolved.length ? `; could not watch ${round.unresolved.join(', ')}` : ''
          ctx.report('weixin', { state: 'ready', detail: `${round.received} messages; watching ${watching}/${config.rooms.length}${unresolved}; next poll ≥ ${config.pollSeconds}s`,
            at: new Date().toISOString() })
        }
      } catch (error) { if (!signal.aborted) ctx.report('weixin', { state: 'error', detail: String(error) }) }
    }
    await pause((ctx.config<WeixinConfig>(SOURCE)?.pollSeconds ?? 5) * 1000, signal)
  }
}
