/** Worker-facing read of the one message a DingTalk callback carried; the stream keeps no history to page. */
import type { Trigger } from '../../../core/index.ts'

/** The reference a DingTalk Trigger keeps. */
export interface DingtalkRef { triggerId: string; messageId: string }

/** The reference of a DingTalk Trigger, or nothing for another chat kind (its meta names a `conversationId`). */
export function dingtalkRef(trigger: Trigger): DingtalkRef | undefined {
  if (typeof trigger.meta.conversationId !== 'string') return undefined
  const messageId = String(trigger.meta.nativeId ?? '')
  if (!messageId) return undefined
  return { triggerId: trigger.id, messageId }
}

/** The resource anchored to an accepted Trigger, as a DingTalk skill describes. */
export function dingtalkReferences(ref: DingtalkRef) {
  return { skill: 'dsh-superagent-dingtalk', message: `dingtalk/${ref.triggerId}/message` }
}

/** Validates a model-supplied resource string; a stream callback has one message and no pages. */
export function dingtalkResource(resource: string): { triggerId: string } {
  const match = /^dingtalk\/([^/]+)\/message$/.exec(resource)
  if (!match) throw new Error('Use dingtalk/<trigger-id>/message; a DingTalk callback keeps no history to page')
  return { triggerId: match[1]! }
}

/** Reads the Trigger's own message: the stream delivered it, so this is the only copy. */
export function readDingtalk(trigger: Trigger, resource: string): { status: string; message: Record<string, unknown>; next_resource: null } {
  const request = dingtalkResource(resource)
  if (request.triggerId !== trigger.id) throw new Error('A DingTalk source trigger is required')
  return { status: 'ok', next_resource: null,
    message: { id: String(trigger.meta.nativeId ?? ''), from: trigger.actor.id, at: trigger.at, text: trigger.text,
      ...trigger.human === false ? { bot: true as const } : {} } }
}
