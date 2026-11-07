/** Weixin source plugin entry: registers the kind and polls its sidecar bridge for new messages in the configured chats. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import { createBridgeClient, type BridgeClient } from './chat/weixin/bridge.ts'
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

/** Reads one chat from its stored cursor and hands every message not the agent's own to the Engine. */
async function pollChat(ctx: SourceContext, bridge: BridgeClient, instance: string, chat: string): Promise<number> {
  const cursor = ctx.state.get(KV.chat.history(instance, chat))
  const page = await bridge.messages(chat, cursor)
  let received = 0
  for (const event of page.events) {
    // The bridge delivers the agent's own messages back as echoes; they never authorize work.
    if (event.ownMessage) continue
    await ctx.receive(triggerOf(event, instance))
    received += 1
  }
  // The cursor advances only after the page is handed over, so a stopped poll reads the same page again.
  if (page.next !== cursor) ctx.state.set(KV.chat.history(instance, chat), page.next)
  return received
}

/** One polling round over the configured chats; the bridge's status is recorded for the kind's synchronous `facts`. */
async function pollRound(ctx: SourceContext, config: WeixinConfig, signal: AbortSignal): Promise<number> {
  const instance = SOURCE
  const bridge = createBridgeClient({ baseUrl: config.baseUrl, tokenFile: config.tokenFile })
  // `/health` carries what the backend can actually do, and `scope` must answer synchronously, so it is read once per round
  // and remembered beside the status. It is a loopback call, and reading it every round is what lets a backend swap be
  // noticed without restarting this plugin.
  const health = await bridge.health()
  rememberWeixinStatus(await bridge.status(), health.capabilities)
  let received = 0
  for (const room of config.rooms) {
    signal.throwIfAborted()
    received += await pollChat(ctx, bridge, instance, room.id)
  }
  return received
}

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
        const received = await pollRound(ctx, config, signal)
        if (!signal.aborted) {
          ctx.report('weixin', { state: 'ready', detail: `${received} messages; next poll ≥ ${config.pollSeconds}s`,
            at: new Date().toISOString() })
        }
      } catch (error) { if (!signal.aborted) ctx.report('weixin', { state: 'error', detail: String(error) }) }
    }
    await pause((ctx.config<WeixinConfig>(SOURCE)?.pollSeconds ?? 5) * 1000, signal)
  }
}
