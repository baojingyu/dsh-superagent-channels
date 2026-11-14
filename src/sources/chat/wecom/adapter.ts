/**
 * The WeCom (enterprise WeChat) callback adapter: reads a callback's XML into the normalized `ChatEvent`, and sends text
 * through the WeCom API with an `access_token` it caches until shortly before expiry. It is a pure seam: tests inject
 * their own `fetchFn`, so no test reaches the network.
 */
import { readFileSync, statSync } from 'node:fs'
import { requireOwnerOnly } from '../../../infra/secret-file.ts'
import type { ChatEvent, ChatMedia } from '../port.ts'

/** One callback message as this adapter reads it: the normalized event plus the WeCom fields the kind keeps. */
export interface WecomEvent extends ChatEvent {
  /** The self-built app the message reached, kept for the Log and diagnostics. */
  agentId?: string
  /** The corporation the message reached (the callback's `ToUserName`). */
  toUser?: string
}

/** WeCom application credentials and the agent a message is sent from. */
export interface WecomConfig {
  corpId: string
  corpSecret: string
  agentId: string | number
  /** Optional file holding the application secret; when set it must be a 0600 regular file and wins over `corpSecret`. */
  tokenFile?: string
  /** API origin; defaults to `https://qyapi.weixin.qq.com`. */
  baseUrl?: string
}

/** Who a message goes to: a user, a department, or a group chat (the three are alternatives in WeCom). */
export interface WecomAddress { touser?: string; toparty?: string; chatid?: string }

export interface WecomSenderOptions {
  fetchFn?: typeof fetch
  /** API origin when a config leaves `baseUrl` out; defaults to `https://qyapi.weixin.qq.com`. */
  baseUrl?: string
  now?: () => number
  timeoutMs?: number
}

/** The outbound seam of the WeCom adapter; the access token is cached per corporation and secret. */
export interface WecomSender {
  accessToken(config: WecomConfig): Promise<string>
  sendMessage(config: WecomConfig, address: WecomAddress, text: string): Promise<'sent' | 'gone'>
  /** Downloads one image's bytes by its callback `MediaId`; the platform answers JSON on an error, binary on success. */
  media(config: WecomConfig, mediaId: string, maxBytes?: number): Promise<{ bytes: Uint8Array; mime: string }>
  /** Lists the users of one department (name for the Policy pickers); requires the app's contact read permission. */
  users(config: WecomConfig, departmentId: string): Promise<{ id: string; name?: string }[]>
}

/**
 * Reads a secret from its file when one is named, else returns the inline value. A named file must be a regular 0600 file
 * (the owner-only test is skipped on Windows, whose synthesized mode carries no ACL information); a file that does not
 * exist falls back to the inline value, and no error ever echoes the secret itself.
 */
export function readSecret(filePath: string | undefined, inline: string): string {
  if (!filePath) return inline
  let info
  try { info = statSync(filePath) } catch {
    // Not created yet: fall back to the inline value so a half-configured deployment still starts.
    return inline
  }
  if (!info.isFile()) throw new Error('The secret file is not a regular file')
  requireOwnerOnly(info.mode, filePath, 'The secret file')
  const value = readFileSync(filePath, 'utf8').trim()
  if (!value) throw new Error('The secret file is empty')
  return value
}

const DEFAULT_BASE = 'https://qyapi.weixin.qq.com'
const TIMEOUT_MS = 15_000
/** WeCom error codes that mean the target can never receive a message. */
const GONE = new Set([60111, 81013, 81014])

/** Reads one XML tag's text, accepting both the CDATA and the plain form WeCom uses. */
function tag(xml: string, name: string): string | undefined {
  const cdata = new RegExp(`<${name}>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${name}>`).exec(xml)
  if (cdata) return cdata[1]
  return new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`).exec(xml)?.[1]
}

/** Unescapes the five XML entities a message body may carry. */
const unescape = (text: string): string => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&')

/**
 * Parses one callback message. A text message becomes a `ChatEvent`: `MsgId` is the native ID, `ChatId` (or else the
 * sender, for a direct message) names the Thread, `Content` is the text, and `AgentID`/`ToUserName` are kept. Any other
 * `MsgType` (an event, an image, a voice note) returns `null`, since this adapter carries text only.
 */
export function parseXml(xml: string): WecomEvent | null {
  const msgType = tag(xml, 'MsgType')
  if (msgType !== 'text' && msgType !== 'image') return null
  const msgId = tag(xml, 'MsgId')
  const from = tag(xml, 'FromUserName')
  if (!msgId || !from) return null
  const chatId = tag(xml, 'ChatId') || from
  const created = Number(tag(xml, 'CreateTime'))
  const at = Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString() : new Date(0).toISOString()
  const agentId = tag(xml, 'AgentID')
  const toUser = tag(xml, 'ToUserName')
  // An image callback carries no text, only a MediaId the media API downloads; a text one carries Content.
  const media: ChatMedia[] = []
  let text = ''
  if (msgType === 'image') {
    const mediaId = tag(xml, 'MediaId')
    if (!mediaId) return null
    media.push({ id: mediaId, kind: 'image' })
  } else {
    text = unescape(tag(xml, 'Content') ?? '')
  }
  return {
    nativeId: msgId,
    chatId,
    direct: chatId === from,
    threadRoot: chatId,
    sender: { id: from, bot: false },
    text,
    at,
    ...media.length ? { media } : {},
    ...agentId ? { agentId } : {},
    ...toUser ? { toUser } : {},
  }
}

/** Builds the outbound seam of one WeCom configuration, reading `fetch` lazily so a test can inject its own. */
export function createWecomSender(options: WecomSenderOptions = {}): WecomSender {
  const fetcher = options.fetchFn ?? fetch
  const now = options.now ?? (() => Date.now())
  const timeout = options.timeoutMs ?? TIMEOUT_MS
  const base = (config: WecomConfig) => (config.baseUrl ?? options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
  const tokens = new Map<string, { token: string; expiresAt: number }>()

  const accessToken = async (config: WecomConfig): Promise<string> => {
    const secret = readSecret(config.tokenFile, config.corpSecret)
    const key = `${config.corpId}|${secret}`
    const cached = tokens.get(key)
    if (cached && now() < cached.expiresAt) return cached.token
    const url = `${base(config)}/cgi-bin/gettoken?corpid=${encodeURIComponent(config.corpId)}&corpsecret=${encodeURIComponent(secret)}`
    const answer = await fetcher(url, { signal: AbortSignal.timeout(timeout) })
    if (!answer.ok) throw new Error(`The WeCom token request answered HTTP ${answer.status}`)
    const body = await answer.json() as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
    if (!body.access_token) throw new Error(`The WeCom token request failed (errcode ${body.errcode ?? 'unknown'}: ${body.errmsg ?? 'no message'})`)
    tokens.set(key, { token: body.access_token, expiresAt: now() + (body.expires_in ?? 7200) * 1000 - 60_000 })
    return body.access_token
  }

  const sendMessage = async (config: WecomConfig, address: WecomAddress, text: string): Promise<'sent' | 'gone'> => {
    const token = await accessToken(config)
    const target: Record<string, string> = {}
    if (address.touser) target.touser = address.touser
    if (address.toparty) target.toparty = address.toparty
    if (address.chatid) target.chatid = address.chatid
    const answer = await fetcher(`${base(config)}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...target, msgtype: 'text', agentid: Number(config.agentId), text: { content: text } }),
      signal: AbortSignal.timeout(timeout),
    })
    if (!answer.ok) throw new Error(`The WeCom message answered HTTP ${answer.status}`)
    const body = await answer.json() as { errcode?: number; errmsg?: string }
    const code = body.errcode ?? 0
    if (code === 0) return 'sent'
    if (GONE.has(code)) return 'gone'
    throw new Error(`The WeCom message was not sent (errcode ${code}: ${body.errmsg ?? 'no message'})`)
  }

  /** Downloads one image by `MediaId`. WeCom answers JSON with an `errcode` on failure even at HTTP 200, so the body is read
   * as bytes only after the content type proves it is not JSON, and the byte cap is checked on the whole body. */
  const media = async (config: WecomConfig, mediaId: string, maxBytes?: number): Promise<{ bytes: Uint8Array; mime: string }> => {
    const token = await accessToken(config)
    const url = `${base(config)}/cgi-bin/media/get?access_token=${encodeURIComponent(token)}&media_id=${encodeURIComponent(mediaId)}`
    const answer = await fetcher(url, { signal: AbortSignal.timeout(timeout) })
    if (!answer.ok) throw new Error(`The WeCom media request answered HTTP ${answer.status}`)
    const type = answer.headers.get('content-type') ?? ''
    if (type.includes('json')) {
      const body = await answer.json() as { errcode?: number; errmsg?: string }
      throw new Error(`The WeCom media request failed (errcode ${body.errcode ?? 'unknown'}: ${body.errmsg ?? 'no message'})`)
    }
    const bytes = new Uint8Array(await answer.arrayBuffer())
    if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error(`The WeCom image is ${bytes.length} bytes, over the ${maxBytes}-byte limit`)
    return { bytes, mime: type.split(';')[0] || 'application/octet-stream' }
  }

  /** Lists one department's users (recursively) for the Policy pickers. An app without contact permission answers a JSON error. */
  const users = async (config: WecomConfig, departmentId: string): Promise<{ id: string; name?: string }[]> => {
    const token = await accessToken(config)
    const url = `${base(config)}/cgi-bin/user/simplelist?access_token=${encodeURIComponent(token)}&department_id=${encodeURIComponent(departmentId)}&fetch_child=1`
    const answer = await fetcher(url, { signal: AbortSignal.timeout(timeout) })
    if (!answer.ok) throw new Error(`The WeCom user list answered HTTP ${answer.status}`)
    const body = await answer.json() as { errcode?: number; errmsg?: string; userlist?: { userid?: string; name?: string }[] }
    if ((body.errcode ?? 0) !== 0) throw new Error(`The WeCom user list failed (errcode ${body.errcode}: ${body.errmsg ?? 'no message'})`)
    return (body.userlist ?? []).filter(user => typeof user.userid === 'string' && user.userid !== '')
      .map(user => ({ id: user.userid!, ...user.name ? { name: user.name } : {} }))
  }

  return { accessToken, sendMessage, media, users }
}
