/** Bounded thread context of a work item: the item's own description as the root message and its comments as the thread. */
import type { Trigger } from '../../core/index.ts'
import type { Commands } from '../../infra/commands.ts'
import type { ContextMessage, ContextPart, ThreadContext } from '../kind.ts'
import { readArchivedImage, workImageKeys } from './images.ts'
import type { WorkAdapter, WorkItem, WorkNote } from './port.ts'

/** The project space a stored configuration names, or `''` when it names none. */
export function projectOf(config: Record<string, unknown> | undefined): string {
  const value = config?.project
  return typeof value === 'string' ? value : ''
}

/** The work item a Trigger belongs to: the channel address the poll wrote, else the Trigger's own meta. */
export interface WorkContextAddress { project: string; key: string; serial: string }

/** True when the Trigger is a comment on an item rather than the item itself. */
export const isCommentTrigger = (trigger: Trigger): boolean => trigger.meta.kind === 'comment'

/**
 * The address of a Trigger's work item. The poll writes `project`/`key`/`serial` into the channel address, which is the
 * only form that survives a restart; the meta fallback keeps a hand-made Trigger (a test, a replayed event) readable.
 */
export function workAddress(trigger: Trigger, config: { project?: unknown } = {}): WorkContextAddress {
  const address = trigger.channel?.address ?? {}
  const key = address.key ?? (typeof trigger.meta.identifier === 'string' ? trigger.meta.identifier : '')
  const project = typeof config.project === 'string' ? config.project : ''
  return { project: address.project ?? project, key,
    serial: address.serial ?? (typeof trigger.meta.serial === 'string' ? trigger.meta.serial : key) }
}

/**
 * The ID of a Trigger's own message among its thread's messages: the comment id for a comment, the item's own key for the
 * item. Without this the assessment window cannot place the Trigger in the conversation it belongs to.
 */
export function workMessageId(trigger: Trigger, config: { project?: unknown } = {}): string {
  const comment = trigger.meta.commentId
  return isCommentTrigger(trigger) && typeof comment === 'string' && comment ? comment : workAddress(trigger, config).key
}

/** The root message of an item: its serial, title, and description, attributed to the person who created it. */
export function itemMessage(item: WorkItem): ContextMessage {
  const heading = item.serial ? `[${item.serial}] ${item.title}` : item.title
  return { id: item.key, from: item.author.id, at: item.createdAt, text: item.body ? `${heading}\n\n${item.body}` : heading,
    ...item.url ? { url: item.url } : {}, ...item.author.bot ? { bot: true as const } : {} }
}

/**
 * One comment as a context message. The agent's own comments (those carrying its marker) are marked `bot`, so a reader
 * never mistakes its earlier answer for a person's request.
 */
export function noteMessage(note: WorkNote, item: WorkItem): ContextMessage {
  return { id: note.id, from: note.author.id, at: note.at, text: note.body,
    ...item.url ? { url: `${item.url}#comment-${note.id}` } : {},
    ...note.author.bot || note.self ? { bot: true as const } : {} }
}

/** The structured facts of an item that a reader shows beside its messages. */
function factsOf(item: WorkItem): Record<string, unknown> {
  return { serial: item.serial, category: item.category, status: item.status.name || item.status.id,
    ...item.assignee ? { assignee: item.assignee.id } : {}, ...item.url ? { url: item.url } : {} }
}

/**
 * The thread context of a work item, shared by every work host.
 *
 * A work item is one conversation with two kinds of message: the description the item was opened with, and the comments
 * written later. Without this reader an assessment of a comment sees that comment alone - no title, no description, no
 * earlier answers - and the agent replies to a fragment. `root` is the item's own message, `thread` is the description
 * followed by the comments in order, and `parent` is the description a comment replies to.
 *
 * The adapter is resolved per read from the instance configuration, because a work adapter is bound to an organization
 * and a token file rather than to a global one.
 */
export function workThreadContext<C extends Record<string, unknown> = Record<string, unknown>>(
  adapterFor: (config: C) => WorkAdapter | undefined): ThreadContext<C> {
  // One item read serves every page of one conversation: a window is built from a few pages of the same item.
  const items = new Map<string, Promise<WorkItem>>()
  const itemOf = (adapter: WorkAdapter, commands: Commands, address: WorkContextAddress): Promise<WorkItem> => {
    const cached = items.get(address.key)
    if (cached) return cached
    const loading = adapter.readWorkItem(commands, address.project, address.key)
    items.set(address.key, loading)
    // A failed read is not remembered: the next page may succeed, and a stale rejection would hide the item for ever.
    loading.catch(() => items.delete(address.key))
    return loading
  }
  const page = (item: WorkItem, notes: readonly WorkNote[], withRoot: boolean): ContextMessage[] =>
    [...withRoot ? [itemMessage(item)] : [], ...notes.map(note => noteMessage(note, item))]
  return {
    messageId: trigger => workMessageId(trigger),
    read: async (commands, trigger, part, cursor, config): Promise<ContextPart> => {
      const adapter = adapterFor(config)
      if (!adapter) throw new Error('The work Source is not configured: no adapter is bound to this instance')
      const address = workAddress(trigger, config)
      if (!address.key) throw new Error('This Trigger names no work item, so it has no context to read')
      const item = await itemOf(adapter, commands, address)
      if (part === 'root') return { messages: [itemMessage(item)], body: factsOf(item) }
      // A comment replies to the description; the item itself has nothing above it but the board it lives on.
      if (part === 'parent') return { messages: isCommentTrigger(trigger) ? [itemMessage(item)] : [], body: factsOf(item) }
      const notes = await adapter.listNotes(commands, address.project, address.key, cursor)
      return { messages: page(item, notes.notes, !cursor), body: factsOf(item), status: 'work_item',
        ...notes.next ? { next: notes.next } : {} }
    },
    images: text => workImageKeys(text),
    image: (agent, _commands, _trigger, _message, key, stateDir, signal) => readArchivedImage(agent, key, stateDir, signal),
  }
}
