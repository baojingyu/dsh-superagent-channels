/** Work-item polling: per-category fetch with a persisted watermark and deterministic, idempotent Triggers. */
import { key, type Trigger } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { SourceContext } from '../host.ts'
import type { WorkAdapter, WorkItem, WorkNote } from './port.ts'
import { appendImageMarkers, archiveWorkImages } from './images.ts'
import { reflectWorkTickets } from './feedback.ts'
import { isWorkItemGone } from '../../infra/yunxiao-api.ts'

/** Categories polled when neither the caller nor the instance configuration names any. */
export const DEFAULT_WORK_CATEGORIES: readonly string[] = ['requirement', 'bug', 'task']
/** First watermark of an instance that never polled; the adapter filters on gmtModified so the scan has a lower bound. */
const EPOCH = new Date(0).toISOString()

/** What one polling round needs: the instance (its settings key) and optional project/category overrides. */
export interface WorkStreamOptions {
  /** Instance id: the persisted `source` of every Trigger and the key of the watermark. */
  instance: string
  /** Project space to poll; defaults to the instance configuration's `project`. */
  project?: string
  /** Categories to poll; defaults to the instance configuration's `categories`, then requirement/bug/task. */
  categories?: readonly string[]
}

/** Outcome of one polling round. */
export interface WorkPollResult {
  /** Triggers handed to the engine this round; duplicates are skipped. */
  received: number
  /** Failures by category; a non-empty list keeps the watermark from advancing. */
  errors: string[]
}

/** The parts of a work config this stream reads; the instance schema supplies both keys. */
interface WorkStreamConfig extends Record<string, unknown> { project?: string; categories?: readonly string[]; backfillComments?: number
  /** Status write-back, off unless the operator turned it on and named the statuses. */
  writeBack?: boolean; statusOnStart?: string; statusOnDone?: string }

/**
 * The Trigger of one work item. Its ID is derived from native fields (`identifier` + `updatedAt`), so redelivering the
 * same revision is the same event while a later revision is a new one.
 */
export function workTrigger(item: WorkItem, instance: string, project: string): Trigger {
  return {
    id: key('projex-open', item.key, item.updatedAt),
    source: instance,
    threads: [{ source: instance, id: item.key }],
    actor: { source: instance, id: item.assignee?.id ?? item.author.id },
    human: !item.author.bot,
    at: item.updatedAt || item.createdAt,
    text: item.body || item.title,
    ...item.url ? { url: item.url } : {},
    channel: { source: instance, thread: `${instance}:${item.key}`,
      address: { project, key: item.key, serial: item.serial } },
    meta: { category: item.category, identifier: item.key, serial: item.serial, status: item.status },
  }
}

/** Default number of newest person comments a first-sight work item backfills; a Source may override it by config. */
const DEFAULT_BACKFILL_COMMENTS = 20

/** The target a comment belongs to: the work item and the instance/project its thread already lives under. */
export interface NoteTarget { instance: string; project: string; key: string; serial: string
  /** Category of the item the comment sits on, so a comment falls in the same admission row as its item. */
  category?: string }

/**
 * The Trigger of one work-item comment. Its ID is derived from the native comment id + creation time, so re-reading the
 * same comment is the same event while a later comment is a new one — the same determinism workTrigger has.
 *
 * The item's category travels with the comment so the Policy's admission table decides a comment exactly as it decides
 * its item: a comment whose item falls in a row the operator switched off must not slip through on the table's defaults.
 */
export function noteTrigger(note: WorkNote, target: NoteTarget): Trigger {
  return {
    id: key('projex-note', target.key, note.id, note.at),
    source: target.instance,
    threads: [{ source: target.instance, id: target.key }],
    actor: { source: target.instance, id: note.author.id },
    human: !note.author.bot,
    at: note.at,
    text: note.body,
    channel: { source: target.instance, thread: `${target.instance}:${target.key}`,
      address: { project: target.project, key: target.key, serial: target.serial } },
    meta: { identifier: target.key, serial: target.serial, kind: 'comment', commentId: note.id,
      ...target.category ? { category: target.category } : {} },
  }
}

/** A comment worth a Trigger: a person's words, never the agent's own marked comment or a bot's. */
function isPersonNote(note: WorkNote): boolean {
  return !note.self && !note.author.bot && note.body.trim().length > 0 && !note.body.includes('<!-- dsh-superagent:')
}

/**
 * The comments to hand over this round: every unseen one after a cursor, or — on the first sight of a work item — only
 * the newest person comment. The bounded first-sight backfill is what lets a reply that predates this deployment arrive
 * once without replaying a work item's whole comment history into a ticket.
 */
export function notesToDeliver(notes: readonly WorkNote[], cursor: string | undefined,
  backfill = DEFAULT_BACKFILL_COMMENTS): WorkNote[] {
  const eligible = notes.filter(isPersonNote).sort((a, b) => a.at.localeCompare(b.at))
  if (cursor) return eligible.filter(note => note.at > cursor)
  // First sight: the newest `backfill` person comments, oldest first; anything older is dropped so an upgrade never
  // replays a long history into a ticket.
  return backfill > 0 ? eligible.slice(-backfill) : []
}

/**
 * Polls every configured category once. Each category lists through the adapter, which owns its own paging and
 * returns one complete page (t16); a failing category is recorded in `errors` and never stops the others.
 * The watermark advances only after a wholly successful round, so a partial round is re-read next time and the derived
 * Trigger IDs deduplicate the repeats.
 */
export async function pollWorkItems(ctx: SourceContext, adapter: WorkAdapter, options: WorkStreamOptions,
  signal?: AbortSignal): Promise<WorkPollResult> {
  const config = ctx.config<WorkStreamConfig>(options.instance)
  const project = options.project ?? config?.project
  const categories = options.categories ?? config?.categories ?? DEFAULT_WORK_CATEGORIES
  // Nothing to poll until the instance names a project; that is not an error, so the loop stays quiet.
  if (!project || signal?.aborted) return { received: 0, errors: [] }
  const since = ctx.state.get(KV.work.cursor(options.instance)) ?? EPOCH
  const started = new Date().toISOString()
  let received = 0
  const errors: string[] = []
  const observed: Record<string, string> = {}
  for (const category of categories) {
    if (signal?.aborted) break
    try {
      const result = await pollCategory(ctx, adapter, options.instance, project, since, category, signal)
      received += result.received
      Object.assign(observed, result.statuses)
    } catch (error) {
      if (signal?.aborted) break
      errors.push(`${category}: ${String(error)}`)
    }
  }
  // The statuses read this round are the vocabulary a configured status name resolves against.
  if (!signal?.aborted) rememberStatuses(ctx, options.instance, observed)
  if (!signal?.aborted && errors.length === 0) ctx.state.set(KV.work.cursor(options.instance), started)
  if (signal?.aborted) return { received, errors }
  // Yunxiao comments do not move an item's gmtModified, so they are read per followed work item after the item scan.
  // A comment read failure is reported but never blocks the work-item cursor — its own per-key cursor stays put and retries.
  const backfill = config?.backfillComments ?? DEFAULT_BACKFILL_COMMENTS
  const notes = await observeNotes(ctx, adapter, options.instance, project, started, backfill, signal)
  received += notes.received
  errors.push(...notes.errors)
  // The board follows the ticket: an item a live ticket works on carries the start status, and its end status once that ticket
  // ended. A write-back failure is reported and never stops the scan, which is what actually finds people's requests.
  const reflected = await reflectWorkTickets(ctx, adapter, { instance: options.instance, project,
    statuses: config?.writeBack ? { ...config.statusOnStart ? { start: config.statusOnStart } : {},
      ...config.statusOnDone ? { done: config.statusOnDone } : {} } : {}, ...signal ? { signal } : {} })
  errors.push(...reflected.errors)
  return { received, errors }
}

/** Lists one category's items and hands every unseen one to the engine. */
async function pollCategory(ctx: SourceContext, adapter: WorkAdapter, instance: string, project: string, since: string,
  category: string, signal?: AbortSignal): Promise<{ received: number; statuses: Record<string, string> }> {
  const page = await adapter.listWorkItems(ctx.commands, project, since, [category], signal)
  let received = 0
  const statuses: Record<string, string> = {}
  for (const listed of page.items) {
    if (signal?.aborted) break
    // A list endpoint may omit the body (Projex's search returns `description: ''`) while the detail endpoint has it.
    let item = listed
    if (!listed.body.trim()) {
      try {
        item = await adapter.readWorkItem(ctx.commands, project, listed.key)
      } catch {
        /* An unreadable detail keeps the listed item: the title still makes a usable request. */
      }
    }
    if (item.status.name) statuses[item.status.name] = item.status.id
    item = await withArchivedImages(ctx, adapter, project, item, signal)
    const trigger = workTrigger(item, instance, project)
    // The Engine would also answer 'duplicate'; the local check keeps a repeated page from re-entering the queue.
    if (ctx.triggers.get(trigger.id)) continue
    await ctx.receive(trigger)
    received += 1
  }
  return { received, statuses }
}

/** How many distinct status names one instance remembers; a project has a handful, so this is far above what it needs. */
const MAX_STATUSES = 200

/** Records the status names seen this round, newest last, so a configured status can be written by name. */
function rememberStatuses(ctx: SourceContext, instance: string, observed: Record<string, string>): void {
  const names = Object.keys(observed)
  if (!names.length) return
  const known: Record<string, string> = { ...ctx.state.get(KV.work.statuses(instance)) ?? {}, ...observed }
  const entries = Object.entries(known)
  ctx.state.set(KV.work.statuses(instance), Object.fromEntries(entries.slice(-MAX_STATUSES)))
}

/** Archives an item's embedded images and appends their markers (or failures) to its body text. */
async function withArchivedImages(ctx: SourceContext, adapter: WorkAdapter, project: string, item: WorkItem,
  signal?: AbortSignal): Promise<WorkItem> {
  if (!item.images?.length || !adapter.readImageFile) return item
  const archived = await archiveWorkImages({ refs: item.images, stateDir: ctx.deployment.stateDir,
    metadata: (ref, sig) => adapter.readImageFile!(ctx.commands, project, item.key, ref, sig), signal })
  return { ...item, body: appendImageMarkers(item.body, archived.images, archived.failures) }
}

/**
 * Reads comments for every work item a live ticket follows and hands each new person comment over as a Trigger.
 *
 * The work-item scan cannot see comments (they do not bump `gmtModified`), so this closes that gap: for each Thread the
 * instance is subscribed to whose ticket is still open, it lists the item's comments and converts the newest unseen
 * person comment(s) with `noteTrigger`. `KV.work.notes` is the per-item comment watermark; a first sight backfills only
 * the newest `backfillComments` person comments (see `notesToDeliver`), so a restart cannot flood a ticket with a history.
 */
async function observeNotes(ctx: SourceContext, adapter: WorkAdapter, instance: string, project: string,
  started: string, backfill: number, signal?: AbortSignal): Promise<{ received: number; errors: string[] }> {
  let received = 0
  const errors: string[] = []
  if (signal?.aborted) return { received, errors }
  const openIds = new Set((ctx.tickets?.open?.() ?? []).map(ticket => ticket.id))
  for (const thread of ctx.threads?.subscribed?.(instance) ?? []) {
    if (signal?.aborted) break
    // A work item in the recycle bin is gone; its Thread stays but is never read again.
    if (thread.meta.gone === true) continue
    if (!thread.subscriptions.some(id => openIds.has(id))) continue
    const itemKey = thread.ref.id
    if (!itemKey) continue
    const latest = ctx.triggers.latest(thread.key)
    const address = latest?.channel?.address
    const itemProject = address?.project ?? project
    const serial = address?.serial ?? itemKey
    // The item's category, read from the newest Trigger on its thread, puts the comment in the same admission row as the
    // item, so a category the operator switched off is not silently evaluated on the table's defaults.
    const category = typeof latest?.meta.category === 'string' ? latest.meta.category : undefined
    try {
      const { notes } = await adapter.listNotes(ctx.commands, itemProject, itemKey, undefined)
      const cursor = ctx.state.get(KV.work.notes(instance, itemKey))
      for (const picked of notesToDeliver(notes, cursor, backfill)) {
        const note = await withArchivedNoteImages(ctx, adapter, itemProject, itemKey, picked, signal)
        const trigger = noteTrigger(note, { instance, project: itemProject, key: itemKey, serial, ...category ? { category } : {} })
        if (ctx.triggers.get(trigger.id)) continue
        await ctx.receive(trigger)
        received += 1
      }
      if (!signal?.aborted) ctx.state.set(KV.work.notes(instance, itemKey), started)
    } catch (error) {
      if (signal?.aborted) break
      // The operator deleted the item: mark the Thread gone and report nothing, because nothing failed here.
      if (isWorkItemGone(error)) { ctx.threads?.patch(thread.key, { gone: true }); continue }
      errors.push(`${itemKey}: ${String(error)}`)
    }
  }
  return { received, errors }
}

/** Archives a comment's embedded images and appends their markers (or failures) to its body text. */
async function withArchivedNoteImages(ctx: SourceContext, adapter: WorkAdapter, project: string, itemKey: string,
  note: WorkNote, signal?: AbortSignal): Promise<WorkNote> {
  if (!note.images?.length || !adapter.readImageFile) return note
  const archived = await archiveWorkImages({ refs: note.images, stateDir: ctx.deployment.stateDir,
    metadata: (ref, sig) => adapter.readImageFile!(ctx.commands, project, itemKey, ref, sig), signal })
  return { ...note, body: appendImageMarkers(note.body, archived.images, archived.failures) }
}
