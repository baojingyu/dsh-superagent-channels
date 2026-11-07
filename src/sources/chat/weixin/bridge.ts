/** HTTP client of the wxauto-bridge sidecar: reads its bearer token, calls the six frozen endpoints, and normalizes replies. */
import { readSecretFile } from '../../../infra/secret-file.ts'
import type { ChatEvent } from '../port.ts'
import { BridgeEndpoints } from './backend.ts'
import type { WxPerson, WxRoom } from './backend.ts'

/** How to reach the sidecar: its loopback base URL, the 0600 file holding its bearer token, and optional timeout/transport. */
export interface BridgeOptions {
  baseUrl: string
  tokenFile: string
  /** Per-request timeout; 15s when omitted. */
  timeoutMs?: number
  /** Transport seam: `fetch` when omitted, so tests inject a stub and no test touches the network. */
  fetchFn?: typeof fetch
}
/** What this backend can actually do; absent means an older sidecar, which is read as capable on every count. */
export interface BridgeCapabilities { mentions: boolean; members: boolean; media: boolean }
/** `/health`: whether the sidecar and its backend are usable; `detail` explains an unavailable backend. */
export interface BridgeHealth {
  ok: boolean
  available: boolean
  version?: string
  sidecar?: string
  backend?: string
  detail?: string
  uptimeSec?: number
  capabilities?: BridgeCapabilities
}
/** `/status`: the account's sign-in state; `wxid` is the authoritative `@` basis and `lastEventAt` feeds the stale check. */
export interface BridgeStatus {
  loggedIn: boolean
  wxid: string
  name: string
  backend?: string
  available?: boolean
  lastEventAt?: string
}
/** `POST /send` input; `quoteId` replies to that message and `idempotencyKey` is the OutboundMessage ID. */
export interface BridgeSend {
  room: string
  wxid: string
  text: string
  quoteId?: string
  idempotencyKey?: string
}
/** `POST /send` outcome: the bridge's message ID (possibly a cached one), or `gone` when the conversation cannot receive it. */
export type BridgeSendResult = { msgId: string; deduped: boolean } | 'gone'
/** Bytes of one message image and the media type the sidecar served them with. */
export interface BridgeMedia { bytes: Uint8Array; mime: string }
/** The client the weixin adapter uses to read events and send through one sidecar. */
export interface BridgeClient {
  health(): Promise<BridgeHealth>
  status(): Promise<BridgeStatus>
  rooms(): Promise<WxRoom[]>
  members(room: string): Promise<WxPerson[]>
  messages(room: string, cursor?: string, limit?: number): Promise<{ events: ChatEvent[]; next: string }>
  send(message: BridgeSend): Promise<BridgeSendResult>
  /**
   * Downloads the bytes of one message image (`GET /media/<id>`); optional on the seam so a test double without the endpoint
   * still satisfies the client, while every real client implements it. `maxBytes` caps what is read: the caller passes the
   * deployment's image budget, and `DEFAULT_MEDIA_BYTES` bounds a caller that names none.
   */
  media?(id: string, maxBytes?: number): Promise<BridgeMedia>
}

/** Request options whose headers stay a plain record, so the bearer and idempotency headers can be merged safely. */
type CallInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> }
const IDENTITY_TTL_MS = 60_000
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200
/** Ceiling for one image body when the caller names no budget: a WeChat picture is never this large, so a body that is must be a mistake. */
const DEFAULT_MEDIA_BYTES = 8 * 1024 * 1024
/** `GET /media/<id>` is not in the shared `BridgeEndpoints` table yet, so the reader names it here. */
const MEDIA_PATH = '/media'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

/** Maps one `/messages` event to a ChatEvent, computing `mentionsAgent` from the structured `ats` list and the account's wxid. */
function toChatEvent(raw: unknown, selfWxid: string): ChatEvent {
  const event = record(raw)
  const sender = record(event.sender)
  const room = text(event.room)
  const senderId = text(sender.id)
  const senderName = text(sender.name)
  const quoteId = text(event.quoteId)
  const ats = Array.isArray(event.ats) ? event.ats.filter((id): id is string => typeof id === 'string') : []
  const media = (Array.isArray(event.media) ? event.media : [])
    .map(item => record(item))
    .filter(item => text(item.id) !== '' && item.kind === 'image')
    .map(item => ({ id: text(item.id), kind: 'image' as const, ...(text(item.mime) ? { mime: text(item.mime) } : {}) }))
  return {
    nativeId: text(event.nativeId),
    chatId: room,
    direct: room === '',
    // The Thread is the room; a direct conversation's Thread is the person it is with.
    threadRoot: room || senderId,
    ...(quoteId ? { parentId: quoteId } : {}),
    sender: { id: senderId, ...(senderName ? { name: senderName } : {}), bot: false },
    text: text(event.text),
    at: text(event.at),
    ...(event.own === true ? { ownMessage: true } : {}),
    mentionsAgent: ats.includes(selfWxid),
    ats,
    ...(media.length ? { media } : {}),
  }
}

/**
 * Reads a response body with a byte ceiling, so an image is never buffered whole before its size is known: a declared
 * `Content-Length` over the cap is refused before the body is touched, and the body is then consumed chunk by chunk,
 * cancelling the stream the moment the running total passes the cap.
 */
async function readCapped(response: Response, cap: number, path: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > cap) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`The bridge declared ${declared} bytes for ${path}, over the ${cap}-byte limit`)
  }
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > cap) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`The bridge served an image of more than ${cap} bytes for ${path}, over the ${cap}-byte limit`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Reads the capability report of a backend. A field is taken only when it is a boolean and the rest stay `true`, so a
 * sidecar that reports one limitation need not repeat what it always could do; a missing report stays missing rather than
 * becoming an all-`true` object, because "did not say" and "said it can" are different facts.
 */
function toCapabilities(raw: unknown): BridgeCapabilities | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = record(raw)
  return {
    mentions: typeof value.mentions === 'boolean' ? value.mentions : true,
    members: typeof value.members === 'boolean' ? value.members : true,
    media: typeof value.media === 'boolean' ? value.media : true,
  }
}

/**
 * Creates the client of one wxauto-bridge sidecar. Every call rereads the token file (it may rotate) and refuses a file that
 * others can read; a 401 becomes `unauthorized`, a 502 a retryable error, and a 409 `gone` a `'gone'` send result.
 */
export function createBridgeClient(options: BridgeOptions): BridgeClient {
  const base = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const doFetch = options.fetchFn ?? fetch
  let identity: { at: number; wxid: string } | undefined

  function token(): string {
    return readSecretFile(options.tokenFile, 'bridge token file')
  }

  /** Calls one endpoint with the bearer token, aborting after `timeoutMs`; returns the status and the parsed body. */
  async function call(path: string, init: CallInit = {}): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
      response = await doFetch(`${base}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token()}`, ...init.headers },
      })
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`The wxauto bridge did not answer ${path} within ${timeoutMs}ms`)
      throw error
    } finally {
      clearTimeout(timer)
    }
    let body: unknown
    try { body = await response.json() } catch { body = undefined }
    return { status: response.status, body }
  }

  /** Turns a non-2xx answer into the error the caller expects: `unauthorized`, a retryable 502, or a plain failure. */
  function failure(status: number, body: unknown, what: string): Error {
    if (status === 401) return new Error('unauthorized')
    const code = text(record(body).error)
    const error = new Error(`${what} failed with ${status}${code ? ` (${code})` : ''}`)
    if (status === 502) (error as Error & { retryable?: boolean }).retryable = true
    return error
  }

  async function status(): Promise<BridgeStatus> {
    const answer = await call(BridgeEndpoints.status)
    if (answer.status !== 200) throw failure(answer.status, answer.body, `GET ${BridgeEndpoints.status}`)
    const state = record(answer.body)
    return {
      loggedIn: state.loggedIn === true,
      wxid: text(state.wxid),
      name: text(state.name),
      backend: text(state.backend) || undefined,
      available: typeof state.available === 'boolean' ? state.available : undefined,
      lastEventAt: text(state.lastEventAt) || undefined,
    }
  }

  /** The account's wxid, reread at most once a minute so mapping a page of messages does not call `/status` per page. */
  async function selfWxid(): Promise<string> {
    const at = Date.now()
    if (identity && at - identity.at < IDENTITY_TTL_MS) return identity.wxid
    const state = await status()
    identity = { at, wxid: state.wxid }
    return state.wxid
  }

  return {
    async health(): Promise<BridgeHealth> {
      const answer = await call(BridgeEndpoints.health)
      if (answer.status !== 200) throw failure(answer.status, answer.body, `GET ${BridgeEndpoints.health}`)
      const state = record(answer.body)
      const capabilities = toCapabilities(state.capabilities)
      return {
        ok: state.ok === true,
        available: state.available === true,
        version: text(state.version) || undefined,
        sidecar: text(state.sidecar) || undefined,
        backend: text(state.backend) || undefined,
        detail: text(state.detail) || undefined,
        uptimeSec: typeof state.uptimeSec === 'number' ? state.uptimeSec : undefined,
        ...capabilities ? { capabilities } : {},
      }
    },
    status,
    async rooms(): Promise<WxRoom[]> {
      const answer = await call(BridgeEndpoints.rooms)
      if (answer.status !== 200) throw failure(answer.status, answer.body, `GET ${BridgeEndpoints.rooms}`)
      const list = record(answer.body).rooms
      return (Array.isArray(list) ? list : [])
        .map(room => ({ id: text(record(room).id), name: text(record(room).name) }))
        .filter(room => room.id !== '')
    },
    async members(room: string): Promise<WxPerson[]> {
      const answer = await call(`${BridgeEndpoints.members}?room=${encodeURIComponent(room)}`)
      if (answer.status !== 200) throw failure(answer.status, answer.body, `GET ${BridgeEndpoints.members}`)
      const list = record(answer.body).members
      return (Array.isArray(list) ? list : [])
        .map(person => ({ id: text(record(person).id), name: text(record(person).name) }))
        .filter(person => person.id !== '')
    },
    async messages(room: string, cursor?: string, limit?: number): Promise<{ events: ChatEvent[]; next: string }> {
      const page = Math.min(Math.max(limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
      const query = new URLSearchParams({ room, limit: String(page) })
      if (cursor) query.set('cursor', cursor)
      const answer = await call(`${BridgeEndpoints.messages}?${query.toString()}`)
      if (answer.status !== 200) throw failure(answer.status, answer.body, `GET ${BridgeEndpoints.messages}`)
      const body = record(answer.body)
      const wxid = await selfWxid()
      const events = (Array.isArray(body.events) ? body.events : []).map(event => toChatEvent(event, wxid))
      return { events, next: text(body.next) }
    },
    async send(message: BridgeSend): Promise<BridgeSendResult> {
      const answer = await call(BridgeEndpoints.send, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(message.idempotencyKey ? { 'Idempotency-Key': message.idempotencyKey } : {}) },
        body: JSON.stringify({ room: message.room, wxid: message.wxid, text: message.text, quoteId: message.quoteId ?? '' }),
      })
      const body = record(answer.body)
      if (answer.status === 200) return { msgId: text(body.msgId), deduped: body.deduped === true }
      if (answer.status === 409 && text(body.error) === 'gone') return 'gone'
      throw failure(answer.status, answer.body, `POST ${BridgeEndpoints.send}`)
    },
    async media(id: string, maxBytes?: number): Promise<BridgeMedia> {
      const path = `${MEDIA_PATH}/${encodeURIComponent(id)}`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let response: Response
      try {
        response = await doFetch(`${base}${path}`, { signal: controller.signal, headers: { Authorization: `Bearer ${token()}` } })
      } catch (error) {
        if (controller.signal.aborted) throw new Error(`The wxauto bridge did not answer ${path} within ${timeoutMs}ms`)
        throw error
      } finally {
        clearTimeout(timer)
      }
      // The sidecar answers 404 when the message or its image is not in the rendered window, and 501 when this backend cannot
      // download images at all (the free wxauto build has no `download()`); neither will ever succeed on a retry.
      if (response.status === 404) throw new Error('gone')
      if (response.status === 401) throw new Error('unauthorized')
      if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`)
      const mime = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!mime.startsWith('image/')) throw new Error(`The bridge answered ${path} with ${mime || 'no content type'}, not an image`)
      // The body is read against the cap rather than buffered first: a sidecar that streams an oversized image must not be
      // able to make this process hold it (IMG-2).
      return { bytes: await readCapped(response, maxBytes ?? DEFAULT_MEDIA_BYTES, path), mime }
    },
  }
}