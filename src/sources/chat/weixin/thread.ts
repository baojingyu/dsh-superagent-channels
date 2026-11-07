/** Thread context of one WeChat chat through the sidecar: its recent messages, and the images a message carries. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Trigger } from '../../../core/index.ts'
import type { Commands } from '../../../infra/commands.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from '../../kind.ts'
import type { BridgeClient } from './bridge.ts'
import type { ChatMedia } from '../port.ts'
import { imageIds, imageMarker, readWeixinImage, requireMessageImageCount, stripImageMarkers } from './media.ts'

export { imageIds, imageMarker } from './media.ts'

/** How many of a chat's recent messages one read returns when the caller gives no cursor. */
const RECENT_MESSAGES = 50

/**
 * A message's text with one `[image:<id>]` marker per image the backend named, so the model can ask for the bytes. Markers
 * already in the text are dropped first: the backend's media list is the only source of image IDs (IMG-4).
 */
const messageText = (text: string, media: ChatMedia[] | undefined): string =>
  [stripImageMarkers(text).trim(), ...(media ?? []).map(item => imageMarker(item.id))].filter(part => part !== '').join(' ')

/** The images the backend named for the Trigger's own message; a Trigger whose message carried none has an empty list. */
const triggerMedia = (trigger: Trigger): ChatMedia[] => Array.isArray(trigger.meta.media)
  ? trigger.meta.media.filter((id): id is string => typeof id === 'string').map(id => ({ id, kind: 'image' as const }))
  : []

/** Builds the client for the instance whose configuration the caller reads with. */
export type WeixinClientFor = (config: Record<string, unknown>) => BridgeClient

/**
 * Builds the weixin ThreadContext over a bridge client, or over a factory for one when the client can only be built once the
 * instance's configuration is known (the kind passes a factory). A factory leaves the client unknown until the first `read`,
 * so `image` answers only after the assessment has read the thread — the same order the assessment tool documents.
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
      const room = String(trigger.meta.room ?? trigger.threads[0]?.id ?? '')
      const page = await bridge.messages(room, cursor, RECENT_MESSAGES)
      const messages: ContextMessage[] = page.events.map(event => ({
        id: event.nativeId,
        from: event.sender.id,
        at: event.at,
        // WeChat keeps images out of the text, so the reader names them inline like Feishu does with its keys: the model
        // sees `[image:<id>]` and can hand that id back to `image`.
        text: messageText(event.text, event.media),
        // An echo of the agent's own message is a bot message: it can never authorize work on its own.
        ...(event.ownMessage === true ? { bot: true as const } : {}),
      }))
      return { messages, ...(page.next ? { next: page.next } : {}), body: { room, part }, status: 'ok' }
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
      const media = id === nativeId(trigger)
        ? triggerMedia(trigger)
        : imageIds(message.text).map(mediaId => ({ id: mediaId, kind: 'image' as const }))
      if (!media.some(item => item.id === key)) throw new Error(`The image ${key} is not one of the images of message ${id}`)
      requireMessageImageCount(agent, media, id)
      return readWeixinImage(agent, { media: (mediaId, maxBytes) => download.call(bridge, mediaId, maxBytes) },
        { id: key, kind: 'image' }, id, stateDir, signal)
    },
  }
}