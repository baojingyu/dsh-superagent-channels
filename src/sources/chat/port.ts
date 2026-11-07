/** Chat channel ports: the transport kinds inbound events arrive through, the normalized event a backend yields, and the backend SPI a chat kind is built from. */
import type { Health } from '../host.ts'
import type { ChannelLink, SourceChannel } from '../kind.ts'

/** How a backend receives inbound events: a read cursor (`poll`), a long-lived connection (`stream`), or a signed callback (`webhook`). */
export type TransportKind = 'poll' | 'stream' | 'webhook'
/** What a chat backend reports it can carry, taken from the channel contract so a kind's channel stays in step with it. */
export type ChannelCapabilities = NonNullable<SourceChannel<Record<string, unknown>>['capabilities']>

/**
 * One message a backend received, normalized before it becomes a Trigger. `nativeId` is the platform's own message ID and,
 * with the instance, the transport-level dedupe key; `chatId` names the Thread the message belongs to (a group, or a direct
 * conversation); `ats` carries structured mention IDs so renaming an account never breaks @-detection.
 */
export interface ChatEvent {
  nativeId: string
  chatId: string
  /** A message between the agent and one person rather than in a group. */
  direct: boolean
  /** The message the conversation's topic or quote chain hangs from: the message itself when it starts one. */
  threadRoot: string
  /** The message this one answers, when the platform reports it; `repliesTo` derives the answered Trigger from it. */
  parentId?: string
  sender: { id: string; name?: string; bot: boolean }
  text: string
  /** ISO-8601 time the platform recorded for the message. */
  at: string
  /** Deep link to the message, when the backend can build one. */
  url?: string
  /** The agent's own account sent this message (an echo the backend delivers back); such an event never authorizes work. */
  ownMessage?: boolean
  /** The message mentions the agent, judged from structured mention IDs rather than text (`mentionsMe` in the plan's shorthand). */
  mentionsAgent?: boolean
  /** The message was read back from history rather than received live. */
  historical?: boolean
  /** Structured mention targets: IDs of the accounts the message @-ed. */
  ats?: string[]
  /** Images on the message, when the backend names them; absent for backends that deliver text only. */
  media?: ChatMedia[]
}

/**
 * An image attached to one chat message. WeChat delivers only the message's text, so a backend names the images of a message
 * here and the reader downloads the bytes later by `id`; the platform's declared `mime` is a hint, never trusted for the bytes.
 */
export interface ChatMedia {
  /** Backend ID of the image, downloaded through the backend's media endpoint. */
  id: string
  kind: 'image'
  /** Media type the platform declared; the downloaded bytes decide the real one. */
  mime?: string
}

/** One page of a Thread read back from a backend; `next` is the cursor of the following page. */
export interface ChatThreadPage { events: ChatEvent[]; next?: string }

/**
 * A backend transport of one kind: it starts listening with the adapter and the instance's configuration, hands every inbound
 * event to `handler`, reports `starting`/`ready`/`paused`/`error` through `report`, and returns once `signal` aborts.
 */
export interface InboundTransport<C extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: TransportKind
  start(adapter: ChatAdapter<C>, config: C, handler: (event: ChatEvent) => void, report: (health: Health) => void,
    signal: AbortSignal): Promise<void>
}

/**
 * Backend SPI of a chat kind: one adapter per backend (official, PC, iPad, hosted), interchangeable behind the same kind so
 * Thread semantics, `scope()`, the `allowed` Policy table, and the outbound shape stay identical across backends.
 */
export interface ChatAdapter<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Source kind ID this adapter implements; it names the kind and its `host` health entry. */
  readonly host: string
  /** Transport kinds this backend can deliver inbound events through. */
  readonly transports: readonly TransportKind[]
  readonly capabilities: ChannelCapabilities
  /** Verifies the backend answers with `config` (credentials, endpoint, login state); throws with a message for the panel. */
  probe(config: C): Promise<void>
  /** Reads one page of a Thread's messages, oldest first; `cursor` is the previous page's `next`. */
  readThread(config: C, thread: string, cursor: string | undefined): Promise<ChatThreadPage>
  /**
   * Sends a message idempotently by ID; returns `'gone'` when the conversation can never receive it.
   * @throws when delivery failed but may succeed on a later retry.
   */
  send(config: C, address: Record<string, string>, text: string, id: string): Promise<'sent' | 'gone'>
  /** Returns the URL and label for `address`; a backend without deep links returns an empty `url`. */
  link(config: C, address: Record<string, string>): ChannelLink
}