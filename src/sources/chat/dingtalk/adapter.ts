/** DingTalk adapter: parses robot stream callbacks into ChatEvents and sends replies through the message's sessionWebhook or the oapi robot API. */
import { readFileSync, statSync } from 'node:fs'
import { requireOwnerOnly } from '../../../infra/secret-file.ts'
import type { ChatEvent } from '../port.ts'

/** What the DingTalk adapter needs: the app credentials, its robot code, and whether only `@` messages are received. */
export interface DingTalkConfig {
  clientId: string
  clientSecret: string
  robotCode?: string
  tokenFile?: string
  atOnly?: boolean
}

/** Who this account is, for judging own messages and structured `@`s when the caller knows it. */
export interface DingTalkSelf { robotCode?: string; staffId?: string }

/** Where a reply goes: the conversation and, when the inbound message carried one, its sessionWebhook. */
export interface DingTalkAddress {
  conversationId: string
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
}
/** Fetch seam for the outbound calls, so tests inject a stub and nothing reaches the network. */
export interface SendMessageHooks { fetchFn?: typeof fetch }
/** A send either went out or can never go out (the conversation or session webhook is gone). */
export type DingTalkSendResult = 'sent' | 'gone'

/**
 * Reads the app secret from its file when `tokenFile` names one, else returns the inline value. A named file must be a
 * regular 0600 file (the owner-only test is skipped on Windows, whose synthesized mode carries no ACL information); a file
 * that does not exist falls back to the inline value, and no error ever echoes the secret.
 */
function readSecret(filePath: string | undefined, inline: string): string {
  if (!filePath) return inline
  let info
  try { info = statSync(filePath) } catch { return inline }
  if (!info.isFile()) throw new Error('The secret file is not a regular file')
  requireOwnerOnly(info.mode, filePath, 'The secret file')
  const value = readFileSync(filePath, 'utf8').trim()
  if (!value) throw new Error('The secret file is empty')
  return value
}

const OAPI = 'https://oapi.dingtalk.com'
/** DingTalk access tokens live two hours; refresh well inside that window (the contract asks for a 7000s cache). */
const TOKEN_TTL_MS = 7_000_000
/** Invisible separator before the in-band idempotency key carried in the text of a sessionWebhook send. */
const IDEMPOTENCY_MARKER = '\u2063'

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''

/**
 * Parses one DingTalk robot stream callback into a ChatEvent, or null for a message this kind cannot use: only `text` and
 * `markdown` carry readable body text, a message without a sender never authorizes work, and a message without `createAt`
 * cannot be placed on the Thread's time line. `ats` is the staffId list of `atUsers`, never a text `@nickname` match.
 */
export function parseStreamEvent(raw: unknown, self?: DingTalkSelf): ChatEvent | null {
  const event = record(raw)
  const msgtype = text(event.msgtype)
  if (msgtype !== 'text' && msgtype !== 'markdown') return null
  const senderId = text(event.senderStaffId) || text(event.senderId)
  if (!senderId) return null
  const createAt = Number(event.createAt)
  if (!Number.isFinite(createAt)) return null

  const conversationId = text(event.conversationId)
  const direct = String(event.conversationType ?? '') === '1'
  const markdown = record(event.markdown)
  const body = msgtype === 'text' ? text(record(event.text).content) : text(markdown.text) || text(markdown.content)
  const atUsers = Array.isArray(event.atUsers) ? event.atUsers : []
  const ats = atUsers
    .map(user => text(record(user).staffId))
    .filter(staffId => staffId !== '')
  const senderStaffId = text(event.senderStaffId)
  // DingTalk reports the bot's own sends with the robot's own identity; without one we cannot tell, and it stays false.
  const robotCode = text(event.robotCode)
  const ownMessage = (senderStaffId !== '' && robotCode !== '' && senderStaffId === robotCode)
    || (self !== undefined && senderStaffId !== '' && (senderStaffId === self.staffId || senderStaffId === self.robotCode))
  const mentioned = event.isInAtList === true || (self?.staffId !== undefined && ats.includes(self.staffId))

  return {
    nativeId: text(event.msgId),
    chatId: conversationId,
    direct,
    threadRoot: conversationId || senderId,
    sender: { id: senderId, ...(text(event.senderNick) ? { name: text(event.senderNick) } : {}), bot: text(event.senderId).startsWith('$') },
    text: body,
    at: new Date(createAt).toISOString(),
    ownMessage,
    mentionsAgent: mentioned,
    ats,
  }
}

/** Turns a non-2xx or non-zero answer into an error; `retryable` marks the ones a later attempt may succeed on. */
function failure(status: number, body: unknown, what: string, retryable: boolean): Error {
  const code = text(record(body).errmsg) || String(Number(record(body).errcode) || '')
  const error = new Error(`${what} failed with ${status}${code ? ` (${code})` : ''}`)
  if (retryable) (error as Error & { retryable?: boolean }).retryable = true
  return error
}

async function post(hooks: SendMessageHooks, url: string, payload: unknown, headers: Record<string, string>, what: string): Promise<DingTalkSendResult> {
  const response = await (hooks.fetchFn ?? fetch)(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) })
  let body: unknown
  try { body = await response.json() } catch { body = undefined }
  const errcode = Number(record(body).errcode)
  if (response.ok && errcode === 0) return 'sent'
  // 300001 (expired session webhook) and 310000 (the bot left the chat) mean the address is gone for good.
  if (errcode === 300001 || errcode === 310000 || response.status === 404 || response.status === 410) return 'gone'
  throw failure(response.status, body, what, true)
}

const tokens = new Map<string, { token: string; expiresAt: number }>()

/** Exchanges the app credentials for an oapi access token, cached for 7000s per credential pair. */
async function accessToken(hooks: SendMessageHooks, config: DingTalkConfig): Promise<string> {
  const secret = readSecret(config.tokenFile, config.clientSecret)
  const key = `${config.clientId}\u0000${secret}`
  const cached = tokens.get(key)
  const now = Date.now()
  if (cached && cached.expiresAt > now) return cached.token
  const url = `${OAPI}/gettoken?appkey=${encodeURIComponent(config.clientId)}&appsecret=${encodeURIComponent(secret)}`
  const response = await (hooks.fetchFn ?? fetch)(url, { method: 'GET' })
  let body: unknown
  try { body = await response.json() } catch { body = undefined }
  const token = text(record(body).access_token)
  if (!response.ok || Number(record(body).errcode) !== 0 || !token) throw failure(response.status, body, 'GET /gettoken', false)
  tokens.set(key, { token, expiresAt: now + TOKEN_TTL_MS })
  return token
}

/**
 * Sends one reply idempotently. The inbound message's own sessionWebhook is preferred (no token needed, and it works from an
 * internal network); without it the oapi robot API is used with an access token. `idempotencyKey` (the OutboundMessage ID) is
 * sent as the `Idempotency-Key` header where the endpoint accepts headers, and as an invisible text marker inside the body
 * otherwise, since a sessionWebhook has no server-side idempotency of its own.
 */
export function sendMessage(config: DingTalkConfig, address: DingTalkAddress, text: string, idempotencyKey: string): Promise<DingTalkSendResult>
export function sendMessage(hooks: SendMessageHooks, config: DingTalkConfig, address: DingTalkAddress, text: string, idempotencyKey: string): Promise<DingTalkSendResult>
export async function sendMessage(
  hooksOrConfig: SendMessageHooks | DingTalkConfig,
  configOrAddress: DingTalkConfig | DingTalkAddress,
  addressOrText: DingTalkAddress | string,
  textOrId: string,
  maybeId?: string,
): Promise<DingTalkSendResult> {
  const hooks = (maybeId === undefined ? {} : hooksOrConfig) as SendMessageHooks
  const config = (maybeId === undefined ? hooksOrConfig : configOrAddress) as DingTalkConfig
  const address = (maybeId === undefined ? configOrAddress : addressOrText) as DingTalkAddress
  const content = maybeId === undefined ? addressOrText as string : textOrId
  const idempotencyKey = maybeId === undefined ? textOrId : maybeId

  const marked = `${content}${IDEMPOTENCY_MARKER}${idempotencyKey}`
  const headers = { 'Idempotency-Key': idempotencyKey }
  const expired = typeof address.sessionWebhookExpiredTime === 'number' && Date.now() >= address.sessionWebhookExpiredTime
  const webhook = text(address.sessionWebhook)
  if (webhook && !expired) {
    return post(hooks, webhook, { msgtype: 'text', text: { content: marked }, ...(config.robotCode ? { robotCode: config.robotCode } : {}) }, headers, 'POST sessionWebhook')
  }
  const token = await accessToken(hooks, config)
  const payload = { robotCode: config.robotCode ?? config.clientId, msgtype: 'text', text: { content: marked } }
  return post(hooks, `${OAPI}/robot/send?access_token=${encodeURIComponent(token)}`, payload, headers, 'POST /robot/send')
}
