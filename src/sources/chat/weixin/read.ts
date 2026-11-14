/** Worker-facing reads of one WeChat conversation through the sidecar, mirroring the Feishu resource grammar. */
import type { Trigger } from '../../../core/index.ts'
import type { ChatEvent } from '../port.ts'
import type { BridgeClient } from './bridge.ts'
import type { ChatMedia } from '../port.ts'
import { imageIds, imageMarker, stripImageMarkers } from './media.ts'

/** Reference a Trigger keeps for reading its conversation: the trigger, its room, and the platform message ID. */
export interface WeixinRef { triggerId: string; room: string; messageId: string; at?: string }

/** The reference of a WeChat Trigger, or nothing when the Trigger carries no WeChat room or message. */
export function weixinRef(trigger: Trigger): WeixinRef | undefined {
  // `room` and `senderId` are both WeChat-shaped: the watch always sets `room` (empty for a direct message), and no other
  // chat kind sets it, so a Trigger of another kind never resolves here even when its meta has an ID-like field.
  if (typeof trigger.meta.room !== 'string' || typeof trigger.meta.senderId !== 'string') return undefined
  // A group's room is its chat ID; a direct conversation has no room, and the Thread id (the person) is what holds it.
  const room = trigger.meta.room || String(trigger.threads[0]?.id ?? '')
  const messageId = String(trigger.meta.nativeId ?? '')
  if (!room && !messageId) return undefined
  return { triggerId: trigger.id, room, messageId, at: trigger.at }
}

/** Resource names anchored to an accepted Trigger, as the `dsh-superagent-weixin` skill describes. */
export function weixinReferences(ref: WeixinRef) {
  const read = (section: string) => `weixin/${ref.triggerId}/${section}`
  return { skill: 'dsh-superagent-weixin', message: read('message'), thread: read('thread'), around: read('around') }
}

/** Validates a model-supplied resource string before any request; only `thread` and `around` take a cursor. */
export function weixinResource(resource: string) {
  const match = /^weixin\/([^/]+)\/(message|thread|around)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] === 'message')) {
    throw new Error('Use weixin/<trigger-id>/message, /thread or /around; follow next_resource for another page')
  }
  return { triggerId: match[1]!, section: match[2]!, cursor: match[3] ? decodeURIComponent(match[3]) : undefined }
}

/** One message as a read returns it; `bot` marks the agent's own echo, `images` names what the message carried. */
export interface WeixinMessage { id: string; from: string; at: string; text: string; bot?: true; images?: string[] }
/** One page or one message of a conversation, with the resource name a caller follows for the next page. */
export interface WeixinRead { status: string; message?: WeixinMessage; messages?: WeixinMessage[]; next_resource: string | null }

/** A message's text with one `[image:<id>]` marker per image the backend named, so a model can ask for the bytes. */
export function renderMessageText(text: string, media: ChatMedia[] | undefined): string {
  return [stripImageMarkers(text).trim(), ...(media ?? []).map(item => imageMarker(item.id))].filter(part => part !== '').join(' ')
}

/** The images the backend named for a Trigger's own message. */
export function triggerMedia(trigger: Trigger): ChatMedia[] {
  return Array.isArray(trigger.meta.media)
    ? trigger.meta.media.filter((id): id is string => typeof id === 'string').map(id => ({ id, kind: 'image' as const }))
    : []
}

/** One backend event as a read reports it. */
export function toWeixinMessage(event: ChatEvent): WeixinMessage {
  const media = event.media?.filter(item => item.kind === 'image')
  return { id: event.nativeId, from: event.sender.name || event.sender.id, at: event.at,
    text: renderMessageText(event.text, media),
    ...event.ownMessage === true ? { bot: true as const } : {},
    ...media?.length ? { images: media.map(item => item.id) } : {} }
}

/** How many pages an `around` read walks before giving up: enough for a busy chat, bounded so it never loops. */
const AROUND_PAGES = 5

/**
 * Reads one Trigger's WeChat conversation: its own message, a page of the room, or the page that holds its message.
 * `around` walks from the newest page; the sidecar's cursor is the only ordering it offers, so a page that holds the
 * message stands in for Feishu's five-before/five-after window.
 */
export async function readWeixin(bridge: BridgeClient, trigger: Trigger, resource: string, pageSize = 50): Promise<WeixinRead> {
  const request = weixinResource(resource)
  if (request.triggerId !== trigger.id) throw new Error('A WeChat source trigger is required')
  const ref = weixinRef(trigger)
  if (!ref) throw new Error('A WeChat source trigger is required')
  if (request.section === 'message') {
    const media = triggerMedia(trigger)
    return { status: 'ok', message: { id: ref.messageId, from: trigger.actor.id, at: trigger.at,
      text: renderMessageText(trigger.text, media), ...trigger.human === false ? { bot: true as const } : {},
      ...media.length ? { images: media.map(item => item.id) } : {} }, next_resource: null }
  }
  if (!ref.room) return { status: 'no_room', messages: [], next_resource: null }
  if (request.section === 'thread') {
    const page = await bridge.messages(ref.room, request.cursor, pageSize)
    return { status: 'ok', messages: page.events.map(toWeixinMessage),
      next_resource: page.next ? `weixin/${ref.triggerId}/thread/${encodeURIComponent(page.next)}` : null }
  }
  // A cursor names the page to read; without one the walk starts at the newest page and stops at the message's own page.
  let cursor = request.cursor
  for (let page = 0; page < (request.cursor ? 1 : AROUND_PAGES); page += 1) {
    const result = await bridge.messages(ref.room, cursor, pageSize)
    const holds = result.events.some(event => event.nativeId === ref.messageId)
    if (holds || request.cursor) {
      return { status: holds ? 'ok' : 'not_found', messages: result.events.map(toWeixinMessage),
        next_resource: result.next ? `weixin/${ref.triggerId}/around/${encodeURIComponent(result.next)}` : null }
    }
    if (!result.next) break
    cursor = result.next
  }
  return { status: 'not_found', messages: [], next_resource: null }
}

export { imageIds, imageMarker }
