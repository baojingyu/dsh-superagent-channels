/**
 * DingTalk Stream transport. The WebSocket protocol itself is not implemented here on purpose: production runs the
 * `dingtalk-stream` SDK's long-connection client and hands its callback iterable to `startStream`, while this module only
 * consumes an injected `connect()` iterable, so tests can drive it with fakes and the repo takes no SDK dependency.
 */
import type { Health } from '../../host.ts'
import type { ChatEvent } from '../port.ts'
import { parseStreamEvent } from './adapter.ts'

/** What one stream run needs: a connection source, per-event handling, health reporting, and the abort signal that ends it. */
export interface StreamOptions {
  /** Opens the inbound stream; production closes over the SDK client, tests pass an in-memory iterable. */
  connect(): AsyncIterable<unknown>
  handler(event: ChatEvent): void
  report(health: Health): void
  signal: AbortSignal
  /** Parses one raw callback; defaults to `parseStreamEvent` so a caller can supply the account identity. */
  parse?(raw: unknown): ChatEvent | null
}

/** Tuning of the reconnect loop: how long to wait between attempts, when to stop, and where connection errors go. */
export interface LongPollingOptions {
  retryMs?: number
  signal?: AbortSignal
  onError?(error: unknown): void
}

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Waits `ms`, or resolves as soon as `signal` aborts; the timer is always cleared, so no wait outlives a dispose. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    if (signal?.aborted) { resolve(); return }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
    // The signal may have aborted between the check above and the listener being added.
    if (signal?.aborted) done()
  })
}

/**
 * Runs the injected stream until `signal` aborts: each raw callback is parsed and handed to `handler` inside its own
 * try/catch, so one malformed callback (or a throwing handler) is reported as an `error` health state instead of ending the
 * stream. Iteration races the abort signal, so aborting returns promptly even while the SDK is waiting for the next event.
 */
export async function startStream(options: StreamOptions): Promise<void> {
  const parse = options.parse ?? parseStreamEvent
  const { handler, report, signal } = options
  report({ state: 'starting', detail: 'Connecting to the DingTalk stream' })
  const iterator = options.connect()[Symbol.asyncIterator]()
  const aborted = new Promise<'aborted'>(resolve => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  try {
    while (!signal.aborted) {
      const next = await Promise.race([iterator.next(), aborted])
      if (next === 'aborted' || next.done) break
      try {
        const event = parse(next.value)
        if (event) handler(event)
      } catch (error) {
        report({ state: 'error', detail: errorText(error) })
      }
    }
    report({ state: 'paused', detail: 'The DingTalk stream stopped' })
  } catch (error) {
    report({ state: 'error', detail: errorText(error) })
  } finally {
    try { await iterator.return?.() } catch { /* the SDK closes its own connection */ }
  }
}

/**
 * Adapts an injected connector into one long-lived iterable: when a connection ends (normally or with an error) it waits
 * `retryMs` and connects again, until `signal` aborts. A connection error goes to `onError` and is otherwise absorbed, so one
 * dropped long connection never ends the stream.
 */
export function createLongPollingStream(connect: () => AsyncIterable<unknown>, options: LongPollingOptions = {}): AsyncIterable<unknown> {
  const retryMs = options.retryMs ?? 5_000
  return {
    async *[Symbol.asyncIterator]() {
      while (!options.signal?.aborted) {
        try {
          for await (const value of connect()) {
            if (options.signal?.aborted) return
            yield value
          }
        } catch (error) {
          if (options.signal?.aborted) return
          options.onError?.(error)
        }
        if (options.signal?.aborted) return
        await sleep(retryMs, options.signal)
        if (options.signal?.aborted) return
      }
    },
  }
}