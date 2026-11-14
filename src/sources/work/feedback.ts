/** Reflects a ticket's lifecycle on the work item it came from: the board shows the agent is on it, and how it ended. */
import { KV } from '../../kv.ts'
import { isWorkItemGone } from '../../infra/yunxiao-api.ts'
import type { SourceContext } from '../host.ts'
import type { WorkAdapter } from './port.ts'

/** Status ids a work kind writes back, by phase; both absent keeps the Source read-only whatever `writeBack` says. */
export interface WorkStatuses { start?: string; done?: string }

/** What the poll remembers about one ticket, so each phase's status is written once and never again. */
export interface ReflectedTicket { project: string; key: string; serial: string; start?: true; done?: true
  /** The Thread this ticket follows, so a vanished item can mark it instead of retrying for ever. */
  thread?: string }

/** How many tickets the ledger keeps; the oldest are dropped first, the same bound the self-write ledger uses. */
const MAX_TRACKED = 200

/**
 * Resolves a configured status to the id to write.
 *
 * An operator should not have to hunt for an opaque status id in the web UI: a status name is what they read on the
 * board. The names this instance has seen on the items it read are the vocabulary (`KV.work.statuses`), so a name resolves
 * to its id; an opaque ASCII token is taken as an id the instance has not seen yet and passed through; anything else is a
 * name nobody has seen, which is refused with an actionable error rather than sent to the host as a status.
 */
export function resolveStatus(value: string, known: Readonly<Record<string, string>>): string | undefined {
  if (Object.values(known).includes(value)) return value
  const exact = known[value] ?? Object.entries(known).find(([name]) => name.toLowerCase() === value.toLowerCase())?.[1]
  if (exact) return exact
  return /^[\x21-\x7e]+$/.test(value) && !/\s/.test(value) ? value : undefined
}

/**
 * Writes the configured status onto every work item a ticket of this instance follows: the start status while the
 * ticket is open, the done status once it ended.
 *
 * This is the feedback half of a work channel. A comment is what a person reads in the item, but the board is what the
 * team reads in the sprint: without a status write an assigned item looks untouched from acceptance to delivery, so
 * nobody can tell whether the agent is on it, and the person who assigned it has to open the comments to find out. The
 * work kind stays read-only unless the operator turns write-back on and names the statuses - by name (resolved against the
 * statuses this instance has seen) or by id.
 *
 * Everything here is driven by the tickets the Source already follows, and the ledger keeps a status from being written
 * twice. A failure is reported in the poll result rather than thrown, because the work-item scan matters more.
 */
export async function reflectWorkTickets(ctx: SourceContext, adapter: WorkAdapter,
  options: { instance: string; project?: string; statuses: WorkStatuses; signal?: AbortSignal }): Promise<{ written: number; errors: string[] }> {
  const { statuses } = options
  if ((!statuses.start && !statuses.done) || !adapter.setStatus) return { written: 0, errors: [] }
  const ledger: Record<string, ReflectedTicket> = { ...ctx.state.get(KV.work.reflected(options.instance)) ?? {} }
  // Discovery: every ticket following one of this instance's threads is a ticket whose work item this instance can reflect.
  // The address of the newest Trigger on the thread names the item; the thread's own ref is the fallback after a restart.
  for (const thread of ctx.threads?.subscribed?.(options.instance) ?? []) {
    if (thread.meta.gone === true) continue
    const address = ctx.triggers.latest(thread.key)?.channel?.address ?? {}
    for (const id of thread.subscriptions) {
      ledger[id] ??= { project: address.project ?? options.project ?? '', key: thread.ref.id,
        serial: address.serial ?? thread.ref.id, thread: thread.key }
      // A ticket discovered before the Thread field existed still learns it, so a vanished item can be marked.
      ledger[id].thread ??= thread.key
    }
  }
  let written = 0
  const errors: string[] = []
  const known = ctx.state.get(KV.work.statuses(options.instance)) ?? {}
  for (const [ticketId, entry] of Object.entries(ledger)) {
    if (options.signal?.aborted) break
    const ticket = ctx.tickets.get(ticketId)
    // A ticket the store no longer holds is not worth remembering.
    if (!ticket) { delete ledger[ticketId]; continue }
    const phase: keyof WorkStatuses = ticket.ended ? 'done' : 'start'
    const wanted = statuses[phase]
    if (!wanted || entry[phase]) continue
    const status = resolveStatus(wanted, known)
    if (!status) {
      errors.push(`${entry.serial || entry.key}: status "${wanted}" was never seen on this instance; open the source card's `
        + 'status list and use one of those names or ids')
      continue
    }
    try {
      const project = entry.project || options.project || ''
      const item = await adapter.readWorkItem(ctx.commands, project, entry.key)
      // A board already showing this status needs no write; recording it keeps the next round quiet.
      if (item.status.id !== status) await adapter.setStatus(ctx.commands, item, status)
      entry[phase] = true
      written += 1
    } catch (error) {
      // A work item in the recycle bin can never take a status; mark its Thread gone, remember the phase as settled so the
      // next round is quiet, and never report the operator's own deletion as a failure of this plugin.
      if (isWorkItemGone(error)) {
        if (entry.thread) ctx.threads?.patch(entry.thread, { gone: true })
        entry[phase] = true
        continue
      }
      errors.push(`${entry.serial || entry.key}: ${String(error)}`)
    }
  }
  // Bound the ledger without ever dropping a ticket that is still open.
  const open = Object.entries(ledger)
  for (const [ticketId] of open.slice(0, Math.max(0, open.length - MAX_TRACKED))) {
    if (!ctx.tickets.get(ticketId)?.ended) continue
    delete ledger[ticketId]
  }
  ctx.state.set(KV.work.reflected(options.instance), ledger)
  return { written, errors }
}
