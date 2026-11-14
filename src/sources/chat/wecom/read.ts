/** Worker-facing read of the one message a WeCom callback carried; a callback keeps no history to page. */
import type { Trigger } from '../../../core/index.ts'
import { imageIds, imageMarker, stripImageMarkers } from '../weixin/media.ts'

/** The reference a WeCom Trigger keeps: the Trigger itself and the platform message ID. */
export interface WecomRef { triggerId: string; messageId: string }

/** One message as a read returns it, with the `[image:<id>]` markers its callback carried. */
export interface WecomMessage { id: string; from: string; at: string; text: string; bot?: true; images?: string[] }

/**
 * The reference of a WeCom Trigger, or nothing for another chat kind. Both `senderId` and the boolean `mentionsAgent`
 * are what the WeCom Trigger builder sets, which no other chat kind's meta does, so a WeChat or DingTalk Trigger cannot
 * resolve here.
 */
export function wecomRef(trigger: Trigger): WecomRef | undefined {
  if (typeof trigger.meta.senderId !== 'string' || typeof trigger.meta.mentionsAgent !== 'boolean') return undefined
  const messageId = String(trigger.meta.nativeId ?? '')
  if (!messageId) return undefined
  return { triggerId: trigger.id, messageId }
}

/** The resources anchored to an accepted Trigger, as the `dsh-superagent-wecom` skill describes. */
export function wecomReferences(ref: WecomRef) {
  return { skill: 'dsh-superagent-wecom', message: `wecom/${ref.triggerId}/message` }
}

/** Validates a model-supplied resource string before any read. A callback has one message and no pages. */
export function wecomResource(resource: string): { triggerId: string } {
  const match = /^wecom\/([^/]+)\/message$/.exec(resource)
  if (!match) throw new Error('Use wecom/<trigger-id>/message; a WeCom callback keeps no history to page')
  return { triggerId: match[1]! }
}

/** Reads the Trigger's own message. The Trigger is the only copy of it, so this answers one message and no next page. */
export function readWecom(trigger: Trigger, resource: string): { status: string; message: WecomMessage; next_resource: null } {
  const request = wecomResource(resource)
  if (request.triggerId !== trigger.id) throw new Error('A WeCom source trigger is required')
  const media = Array.isArray(trigger.meta.media)
    ? trigger.meta.media.filter((id): id is string => typeof id === 'string') : []
  const text = [stripImageMarkers(trigger.text).trim(), ...media.map(id => imageMarker(id))].filter(part => part !== '').join(' ')
  return { status: 'ok', next_resource: null,
    message: { id: String(trigger.meta.nativeId ?? ''), from: trigger.actor.id, at: trigger.at, text,
      ...trigger.human === false ? { bot: true as const } : {}, ...media.length ? { images: media } : {} } }
}

export { imageIds }
