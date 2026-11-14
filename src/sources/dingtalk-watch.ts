/** DingTalk source plugin entry: registers the kind and consumes an injected event stream; the bundle ships no DingTalk SDK. */
import type { Context } from '@deepseek-ai/cordis'
import { key, type Trigger } from '../core/index.ts'
import { parseStreamEvent } from './chat/dingtalk/adapter.ts'
import { dingtalkKind, SOURCE, type DingTalkKindConfig } from './chat/dingtalk/kind.ts'
import { createLongPollingStream, startStream } from './chat/dingtalk/stream.ts'
import type { ChatEvent } from './chat/port.ts'
import { health, sourceContext, type SourceContext } from './host.ts'

export const kind = dingtalkKind
export const name = 'dsh-superagent-multi-channel-dingtalk'
export const inject = ['orchestrator']

/** The stream transport a deployment injects: an async iterable of raw DingTalk callbacks (its SDK lives outside this bundle). */
export type DingTalkConnect = () => AsyncIterable<unknown>
export interface DingTalkWatchConfig {
  /** Omitted in the bundle: the kind is registered and nothing listens until a deployment supplies this. */
  connect?: DingTalkConnect
}

export function apply(ctx: Context, config: DingTalkWatchConfig = {}): void {
  ctx.effect(() => ctx.orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    // Without an injected transport the kind is registered but nothing listens; enabling it later injects `connect`.
    if (!config.connect) return () => {}
    const source = sourceContext(ctx.orchestrator, dingtalkKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the stream is reported as source health instead.
    const running = watch(source, config.connect, controller.signal).catch((error: unknown) => {
      source.report('dingtalk', { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}

/** The Trigger of one callback: the platform message ID namespaced by the instance, on the Thread of its conversation. */
function triggerOf(event: ChatEvent, instance: string): Trigger {
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
    channel: { source: instance, thread: `${instance}:${thread}`, address: { conversationId: event.chatId } },
    meta: { conversationId: event.chatId, direct: event.direct, senderId: event.sender.id, ats: event.ats ?? [], nativeId: event.nativeId },
  }
}

/** Runs the injected stream, reconnecting until aborted; setup and an off Source keep it quiet instead of failing. */
async function watch(source: SourceContext, connect: DingTalkConnect, signal: AbortSignal): Promise<void> {
  await source.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is read.
  if (!source.configured()) { source.report('dingtalk', health('paused', 'setupPending')); return }
  const config = source.config<DingTalkKindConfig>(SOURCE)
  if (!config) { source.report('dingtalk', health('paused', 'sourceOff')); return }
  await startStream({
    connect: () => createLongPollingStream(connect, { signal }),
    handler: event => {
      Promise.resolve(source.receive(triggerOf(event, SOURCE)))
        .catch(error => source.report('dingtalk', { state: 'error', detail: String(error) }))
    },
    report: report => source.report('dingtalk', report),
    signal,
    // The account identity judges own messages and structured `@`s (the robot code is what the config names).
    parse: raw => parseStreamEvent(raw, config.robotCode ? { robotCode: config.robotCode } : undefined),
  })
}
