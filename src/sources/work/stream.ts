/** Work-item polling: per-category fetch with a persisted watermark and deterministic, idempotent Triggers. */
import { key, type Trigger } from '../../core/index.ts'
import { KV } from '../../kv.ts'
import type { SourceContext } from '../host.ts'
import type { WorkAdapter, WorkItem } from './port.ts'

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
interface WorkStreamConfig extends Record<string, unknown> { project?: string; categories?: readonly string[] }

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
    // A work item carries no mention. Being assigned is the explicit hand-off: someone put this on a person. An item still in
    // the backlog (`assignee` absent) is ambient, so it can only reach the agent as an inferred candidate.
    ...(item.assignee ? { addressed: 'direct' as const } : {}),
    at: item.updatedAt || item.createdAt,
    text: item.body || item.title,
    ...item.url ? { url: item.url } : {},
    channel: { source: instance, thread: `${instance}:${item.key}`,
      address: { project, key: item.key, serial: item.serial } },
    meta: { category: item.category, identifier: item.key, serial: item.serial, status: item.status },
  }
}

/**
 * Polls every configured category once. Each category lists through the adapter, which owns `nextToken` paging and
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
  for (const category of categories) {
    if (signal?.aborted) break
    try {
      received += await pollCategory(ctx, adapter, options.instance, project, since, category, signal)
    } catch (error) {
      if (signal?.aborted) break
      errors.push(`${category}: ${String(error)}`)
    }
  }
  if (!signal?.aborted && errors.length === 0) ctx.state.set(KV.work.cursor(options.instance), started)
  return { received, errors }
}

/** Lists one category's items and hands every unseen one to the engine. */
async function pollCategory(ctx: SourceContext, adapter: WorkAdapter, instance: string, project: string, since: string,
  category: string, signal?: AbortSignal): Promise<number> {
  const page = await adapter.listWorkItems(ctx.commands, project, since, [category], signal)
  let received = 0
  for (const listed of page.items) {
    if (signal?.aborted) break
    // A list endpoint may omit the body (Projex's search returns `description: ''`) while the detail endpoint has it, and the
    // body is where a person writes what they want. Reading it once per new item is the difference between working from the
    // instruction and working from the title.
    let item = listed
    if (!listed.body.trim()) {
      try {
        item = await adapter.readWorkItem(ctx.commands, project, listed.key)
      } catch {
        /* An unreadable detail keeps the listed item: the title still makes a usable request. */
      }
    }
    const trigger = workTrigger(item, instance, project)
    // The Engine would also answer 'duplicate'; the local check keeps a repeated page from re-entering the queue.
    if (ctx.triggers.get(trigger.id)) continue
    await ctx.receive(trigger)
    received += 1
  }
  return received
}