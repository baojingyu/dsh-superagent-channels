/** Worker-facing reads of a Yunxiao Projex work item: its description and its comment thread. */
import type { Commands } from '../../../infra/commands.ts'
import type { Trigger } from '../../../core/index.ts'
import type { WorkAdapter } from '../port.ts'

/** What a Projex Trigger keeps for reading its item: the project space and the item key. */
export interface ProjexReadRef { triggerId: string; project: string; key: string; serial: string }

/** The reference of a Projex Trigger, or nothing when the Trigger names no project/key. */
export function projexRef(trigger: Trigger): ProjexReadRef | undefined {
  const address = trigger.channel?.address ?? {}
  const project = String(address.project ?? '')
  const key = String(address.key ?? trigger.meta.identifier ?? '')
  if (!project || !key) return undefined
  return { triggerId: trigger.id, project, key, serial: String(address.serial ?? trigger.meta.serial ?? key) }
}

/** The resources anchored to an accepted Trigger, as the `dsh-superagent-projex` skill describes. */
export function projexReferences(ref: ProjexReadRef) {
  return { skill: 'dsh-superagent-projex', item: `projex/${ref.triggerId}/item`, comments: `projex/${ref.triggerId}/comments` }
}

/** Validates a model-supplied resource string; only `/comments` takes a cursor. */
export function projexResource(resource: string): { triggerId: string; section: 'item' | 'comments'; cursor?: string } {
  const match = /^projex\/([^/]+)\/(item|comments)(?:\/([^/]+))?$/.exec(resource)
  if (!match || (match[3] && match[2] === 'item')) {
    throw new Error('Use projex/<trigger-id>/item or /comments; follow next_resource for another comments page')
  }
  return { triggerId: match[1]!, section: match[2] as 'item' | 'comments', ...match[3] ? { cursor: decodeURIComponent(match[3]) } : {} }
}

/** One comment as a read returns it. */
export interface ProjexNote { id: string; from: string; at: string; text: string; bot?: true }

/** Reads one item or one page of its comments through the instance's adapter. Reads never write. */
export async function readProjex(adapter: WorkAdapter, commands: Commands, ref: ProjexReadRef, resource: string,
  signal?: AbortSignal): Promise<Record<string, unknown>> {
  const request = projexResource(resource)
  if (request.triggerId !== ref.triggerId) throw new Error('A Projex source trigger is required')
  if (request.section === 'item') {
    const item = await adapter.readWorkItem(commands, ref.project, ref.key, signal)
    return { status: 'ok', next_resource: null, item: { id: item.key, serial: item.serial, category: item.category,
      title: item.title, status: item.status.name, author: item.author.name ?? item.author.id, url: item.url,
      text: item.body, ...item.images?.length ? { images: item.images.map(image => image.key) } : {} } }
  }
  const page = await adapter.listNotes(commands, ref.project, ref.key, request.cursor)
  const notes: ProjexNote[] = page.notes.map(note => ({ id: note.id, from: note.author.name ?? note.author.id, at: note.at,
    text: note.body, ...note.self ? { bot: true as const } : {} }))
  return { status: 'ok', messages: notes,
    next_resource: page.next ? `projex/${ref.triggerId}/comments/${encodeURIComponent(page.next)}` : null }
}
