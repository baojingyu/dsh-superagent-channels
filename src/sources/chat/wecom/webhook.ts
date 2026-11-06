/**
 * The WeCom callback handler as a pure function: it verifies the signature, decrypts the payload, parses the message and
 * drops a redelivery through a `DeliveredRing`, and returns the body WeCom expects. The runtime mounts it on a route
 * (this module changes no HTTP code); a bad signature yields no event at all, so a stranger's POST can never reach the
 * domain.
 */
import type { ChatEvent } from '../port.ts'
import { DeliveredRing } from '../dedupe.ts'
import { decrypt, encrypt, verifySignature } from './crypto.ts'
import { parseXml, readSecret } from './adapter.ts'

/** The query WeCom signs: URL verification carries `echostr`, a message carries none. */
export interface WecomWebhookQuery { msg_signature?: string; timestamp?: string; nonce?: string; echostr?: string }

/**
 * The credentials one WeCom callback is checked and decrypted with; `instance` scopes the dedupe ring. `encodingAesKey`
 * may be empty when `encodingAesKeyFile` names the file that holds it (a 0600 regular file, read on every callback).
 */
export interface WecomWebhookConfig { token: string; encodingAesKey: string; encodingAesKeyFile?: string; corpId: string; instance?: string }

/** One raw callback: its query and, for a message, the XML body. */
export interface WecomWebhookRequest { query?: WecomWebhookQuery; body?: string }

/** What the route writes back: `ok` gates the HTTP status, `reply` is the body, and `events` are the messages to ingest. */
export interface WecomWebhookResult { ok: boolean; events: ChatEvent[]; reply?: string }

/** Reads the `<Encrypt>` payload of a message callback, in CDATA or plain form. */
function encryptedOf(xml: string): string | undefined {
  return /<Encrypt>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/Encrypt>/.exec(xml)?.[1]
    ?? /<Encrypt>\s*([\s\S]*?)\s*<\/Encrypt>/.exec(xml)?.[1]
}

/**
 * Handles one WeCom callback. A URL verification (`echostr`) is decrypted and echoed as plain text; a message is verified,
 * decrypted and parsed into a `ChatEvent`, deduplicated by `ring`, and answered with the encrypted `success`. On a missing
 * or wrong signature, or an undecryptable payload, it returns `{ ok: false, events: [] }` and never an event.
 */
export function handleWebhook(raw: WecomWebhookRequest, config: WecomWebhookConfig,
  ring: DeliveredRing = new DeliveredRing()): WecomWebhookResult {
  const query = raw.query ?? {}
  const { msg_signature: signature, timestamp, nonce } = query
  if (!signature || !timestamp || !nonce) return { ok: false, events: [] }
  // The EncodingAESKey comes from its file when one is named; a misconfigured file never yields an event.
  let encodingAesKey: string
  try { encodingAesKey = readSecret(config.encodingAesKeyFile, config.encodingAesKey) } catch { return { ok: false, events: [] } }

  if (query.echostr) {
    if (!verifySignature(config.token, timestamp, nonce, signature, query.echostr)) return { ok: false, events: [] }
    try { return { ok: true, events: [], reply: decrypt(query.echostr, encodingAesKey, config.corpId) } }
    catch { return { ok: false, events: [] } }
  }

  const encrypted = raw.body ? encryptedOf(raw.body) : undefined
  if (!encrypted) return { ok: false, events: [] }
  if (!verifySignature(config.token, timestamp, nonce, signature, encrypted)) return { ok: false, events: [] }

  let xml: string
  try { xml = decrypt(encrypted, encodingAesKey, config.corpId) } catch { return { ok: false, events: [] } }

  const reply = encrypt('success', encodingAesKey, config.corpId)
  const event = parseXml(xml)
  if (!event) return { ok: true, events: [], reply }
  if (ring.check(config.instance ?? config.corpId, event.nativeId)) return { ok: true, events: [], reply }
  return { ok: true, events: [event], reply }
}
