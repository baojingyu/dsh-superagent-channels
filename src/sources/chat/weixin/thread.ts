/** Thread context of one WeChat chat through the sidecar: its own message, a page of the room, its parent, or the page around it. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Trigger } from '../../../core/index.ts'
import type { Commands } from '../../../infra/commands.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from '../../kind.ts'
import type { BridgeClient } from './bridge.ts'
import type { ChatMedia, ChatEvent } from '../port.ts'
import { imageIds, readWeixinImage, requireMessageImageCount } from './media.ts'
import { renderMessageText, triggerMedia, weixinRef } from './read.ts'

export { imageIds, imageMarker } from './media.ts'

/** How many of a chat's recent messages one read returns when the caller names no page size. */
const RECENT_MESSAGES = 50
/** How many pages a parent/around read walks before it gives up; bounded so a bad cursor never loops. */
const SEARCH_PAGES = 5

/** One backend event as a context message; an echo of the agent's own message is a bot message. */
const contextMessage = (event: ChatEvent): ContextMessage => ({
  id: event.nativeId,
  from: event.sender.id,
  at: event.at,
  // WeChat keeps images out of the text, so the reader names them inline like Feishu does with its keys.
  text: renderMessageText(event.text, event.media),
  ...event.ownMessage === true ? { bot: true as const } : {},
})

/** Builds the client for the instance whose configuration the caller reads with. */
export type WeixinClientFor = (config: Record<string, unknown>) => BridgeClient

/** Walks at most `SEARCH_PAGES` pages looking for one message; nothing when the backend does not report it. */
async function findMessage(bridge: BridgeClient, room: string, nativeId: string, pageSize: number): Promise<ContextMessage | undefined> {
  let cursor: string | undefined
  for (let page = 0; page < SEARCH_PAGES; page += 1) {
    const result = await bridge.messages(room, cursor, pageSize)
    const found = result.events.find(event => event.nativeId === nativeId)
    if (found) return contextMessage(found)
    if (!result.next) return undefined
    cursor = result.next
  }
  return undefined
}

/**
 * Builds the weixin ThreadContext over a bridge client, or over a factory for one when the client can only be built once the
 * instance's configuration is known (the kind passes a factory). A factory leaves the client unknown until the first `read`,
 * so `image` answers only after the assessment has read the thread — the same order the assessment tool documents.
 *
 * The assessment reads `thread` (a page of the room), `parent` (the message it answers) and `root`; WeChat has no topic
 * root, so `root` answers `no_root` rather than inventing an anchor. The message itself and the page around it are the
 * worker-facing resources `weixin/<trigger-id>/message` and `/around`.
 */
export function weixinThreadContext(client: BridgeClient | WeixinClientFor): ThreadContext<Record<string, unknown>> {
  let known: BridgeClient | undefined = typeof client === 'function' ? undefined : client
  const resolve = (config: Record<string, unknown>): BridgeClient => {
    const bridge = typeof client === 'function' ? client(config) : client
    known = bridge
    return bridge
  }
  const nativeId = (trigger: Trigger): string => String(trigger.meta.nativeId ?? '')
  return {
    // The Trigger ID is a hash; its own message is named by the platform ID kept in `meta`.
    messageId: nativeId,
    async read(_commands: Commands, trigger: Trigger, part: ContextPartName, cursor: string | undefined,
      config: Record<string, unknown>): Promise<ContextPart> {
      const bridge = resolve(config)
      const ref = weixinRef(trigger)
      // A group reads by its room; a direct conversation has none and is keyed by the person (the Thread id) instead.
      const room = ref?.room ?? String(trigger.threads[0]?.id ?? '')
      const pageSize = typeof config.readPageSize === 'number' ? config.readPageSize : RECENT_MESSAGES
      // A WeChat conversation is one stream: there is no topic root above the message, so no anchor is invented.
      if (part === 'root') return { messages: [], body: { room, part }, status: 'no_root' }
      if (!room) return { messages: [], body: { room, part }, status: 'no_room' }
      if (part === 'parent') {
        const parentId = typeof trigger.meta.parentId === 'string' ? trigger.meta.parentId : ''
        if (!parentId) return { messages: [], body: { room, part }, status: 'no_parent' }
        const found = await findMessage(bridge, room, parentId, pageSize)
        return { messages: found ? [found] : [], body: { room, part }, status: found ? 'ok' : 'not_found' }
      }
      const page = await bridge.messages(room, cursor, pageSize)
      return { messages: page.events.map(contextMessage), ...(page.next ? { next: page.next } : {}), body: { room, part }, status: 'ok' }
    },
    // The markers the reader appends are what `image` can download: one regular expression serves both sides. Filtering
    // them here would need the Trigger, which this signature does not carry; `image` is where a request would start, and
    // it accepts only the IDs the backend named.
    images: (text: string) => imageIds(text),
    async image(agent: Agent, _commands: Commands, trigger: Trigger, message: { id: string; text: string }, key: string, stateDir: string,
      signal: AbortSignal): Promise<unknown> {
      const bridge = known
      if (!bridge) throw new Error('Read the thread before its images: the bridge client is not known yet')
      const download = bridge.media
      if (!download) throw new Error('This bridge client cannot download images: it has no /media endpoint')
      const id = message.id || nativeId(trigger)
      // Only an ID the backend named may start a download. The Trigger's own text is the raw message text, so `meta.media`
      // decides for it; any other message's text is what `read` rendered, whose markers all came from that message's media.
      const media: ChatMedia[] = id === nativeId(trigger)
        ? triggerMedia(trigger)
        : imageIds(message.text).map(mediaId => ({ id: mediaId, kind: 'image' as const }))
      if (!media.some(item => item.id === key)) throw new Error(`The image ${key} is not one of the images of message ${id}`)
      requireMessageImageCount(agent, media, id)
      return readWeixinImage(agent, { media: (mediaId, maxBytes) => download.call(bridge, mediaId, maxBytes) },
        { id: key, kind: 'image' }, id, stateDir, signal)
    },
  }
}