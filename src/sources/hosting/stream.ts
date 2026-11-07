/**
 * Watermark polling of a hosting adapter: change requests, their notes, and CI become Triggers, and one cursor per
 * instance records how far the host has been read (§5.2 of the extension design). Each change is isolated, so one
 * unreadable merge request records `pollError` on its Thread without stopping the round or holding back the cursor.
 */
import { key, type Trigger } from '../../core/index.ts'
import { ciCounts, ciSummary } from '../github-read.ts'
import { KV } from '../../kv.ts'
import { cursorAt } from '../poll.ts'
import type { SourceContext } from '../host.ts'
import type { HostingConfig } from './kind.ts'
import type { ChangeNote, ChangeRequest, HostAdapter } from './port.ts'

export interface HostingStreamOptions {
  /** Instance id whose KV records and Triggers this loop owns; defaults to the adapter's host name (its default instance). */
  instance?: string
  /** Changes tracked per round; the newest by `updatedAt` win and the rest are reported as overflow. */
  maxTrackedChanges?: number
}

/** What one polling round did: changes returned by the host, Triggers handed to the Engine, and changes beyond the limit. */
export interface HostingRound { scanned: number; received: number; overflow: number }

/** Default cap on changes tracked per round, so a large repository cannot stall one round. */
const TRACKED_CHANGES = 50
/** Empty round result, for a kind whose instance is disabled or unconfigured. */
const EMPTY: HostingRound = { scanned: 0, received: 0, overflow: 0 }

/** The Thread key of one change request inside an instance. */
const threadOf = (instance: string, number: number): string => `${instance}:${number}`
/** The reply address of a change request: the project and host-local number the channel posts to. */
const channelOf = (instance: string, project: string, number: number): { source: string; thread: string; address: Record<string, string> } =>
  ({ source: instance, thread: threadOf(instance, number), address: { project, number: String(number) } })

/** The Trigger of a change request's own title and description; its `updatedAt` versions an edit as a new event. */
function changeTrigger(instance: string, project: string, change: ChangeRequest): Trigger {
  return {
    id: key('gitlab-pull', `${project}#${change.number}`, String(change.number), change.updatedAt || change.createdAt),
    source: instance,
    threads: [{ source: instance, id: String(change.number) }],
    actor: { source: instance, id: change.author },
    human: !change.authorIsBot,
    at: change.updatedAt || change.createdAt,
    text: `${change.title}\n\n${change.body}`.trim(),
    ...change.url ? { url: change.url } : {},
    channel: channelOf(instance, project, change.number),
    meta: { number: change.number, kind: 'pull' },
  }
}

/** The Trigger of one note; its kind (`conversation`/`inline`/`review`) names the Policy row it is admitted under. */
function noteTrigger(instance: string, project: string, change: ChangeRequest, note: ChangeNote): Trigger {
  const at = note.updatedAt ?? note.at
  return {
    id: key(`gitlab-${note.kind}`, `${project}#${change.number}`, note.id, at),
    source: instance,
    threads: [{ source: instance, id: String(change.number) }],
    actor: { source: instance, id: note.author },
    human: !note.authorIsBot,
    at,
    text: note.body,
    ...note.url ? { url: note.url } : {},
    channel: channelOf(instance, project, change.number),
    meta: { number: change.number, kind: note.kind, ...note.decision ? { decision: note.decision } : {},
      ...note.path ? { path: note.path } : {}, ...note.line != null ? { line: note.line } : {},
      ...note.replyTo ? { replyTo: note.replyTo } : {} },
  }
}

/** The Trigger of a CI transition on a change request, built in GitHub's vocabulary so summaries read the same everywhere. */
function ciTrigger(instance: string, project: string, change: ChangeRequest, summary: string, revision: number, failed: number): Trigger {
  return {
    id: key('gitlab-ci', `${project}#${change.number}`, String(revision)),
    source: instance,
    threads: [{ source: instance, id: String(change.number) }],
    actor: { source: instance, id: '' },
    human: false,
    at: new Date().toISOString(),
    text: summary,
    ...change.url ? { url: change.url } : {},
    channel: channelOf(instance, project, change.number),
    meta: { number: change.number, kind: 'pull', ci: true, revision, failed },
  }
}

/**
 * Hands over a change request's own event. The first round has no previous cursor and trusts the host's own filter; a later
 * round only repeats changes updated since that cursor, so an unsolicited old row cannot become a duplicate event.
 */
async function observeChange(ctx: SourceContext, instance: string, project: string, change: ChangeRequest, previous: string | undefined): Promise<number> {
  if (previous && (change.updatedAt || change.createdAt) < previous) return 0
  await ctx.receive(changeTrigger(instance, project, change))
  return 1
}

/** Reads the change's notes after its own watermark, hands each over, then advances that watermark. */
async function observeNotes(ctx: SourceContext, adapter: HostAdapter<Record<string, unknown>>, instance: string, project: string,
  change: ChangeRequest, since: string, started: string, signal: AbortSignal): Promise<number> {
  const cursor = ctx.state.get(KV.hosting.notes(instance, change.number)) ?? since
  const { notes } = await adapter.readNotes(ctx.commands, change, cursor, signal)
  let received = 0
  for (const note of notes) {
    signal.throwIfAborted()
    await ctx.receive(noteTrigger(instance, project, change, note))
    received += 1
  }
  ctx.state.set(KV.hosting.notes(instance, change.number), cursorAt(started))
  return received
}

/** Reads CI and emits a Trigger only when the snapshot changes after its first baseline, as the GitHub PR loop does. */
async function observeCi(ctx: SourceContext, adapter: HostAdapter<Record<string, unknown>>, instance: string, project: string,
  change: ChangeRequest, signal: AbortSignal): Promise<number> {
  if (!adapter.ci) return 0
  const snapshot = await adapter.ci(ctx.commands, change, signal)
  if (!snapshot) return 0
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.hosting.ci(instance, change.number))
  if (previous?.fingerprint === fingerprint) return 0
  const revision = previous ? previous.revision + 1 : 0
  // The first observation is a baseline; only a later change is an event worth a Trigger.
  if (previous) await ctx.receive(ciTrigger(instance, project, change, ciSummary(snapshot, `MR !${change.number}`, 'the pipeline'), revision,
    ciCounts(snapshot).failed))
  ctx.state.set(KV.hosting.ci(instance, change.number), { fingerprint, revision })
  return previous ? 1 : 0
}

/**
 * One polling round over a hosting instance: read the stored cursor (now when there is none), list changes updated since
 * it, hand each change's own event, notes, and CI to the Engine, then advance the cursor to five seconds before the round
 * started. A failing change records `pollError` on its Thread and the round continues; overflow beyond the tracked limit is
 * reported in the kind's health entry instead of being read.
 */
export async function pollHosting<C extends Record<string, unknown>>(ctx: SourceContext, adapter: HostAdapter<C>,
  opts: HostingStreamOptions, signal: AbortSignal): Promise<HostingRound> {
  signal.throwIfAborted()
  const instance = opts.instance ?? adapter.host
  const max = opts.maxTrackedChanges ?? TRACKED_CHANGES
  const config = ctx.config<HostingConfig>(instance)
  // A disabled or unconfigured instance polls nothing; the watcher reports that state instead of failing.
  if (!config) return EMPTY
  const started = new Date().toISOString()
  const previous = ctx.state.get(KV.hosting.cursor(instance))
  const since = previous ?? started
  const { changes } = await adapter.listChanges(ctx.commands, config.project, since, signal)
  const fresh = previous ? changes.filter(change => (change.updatedAt || change.createdAt) >= previous) : changes
  const tracked = [...fresh].sort((a, b) => (a.updatedAt || a.createdAt).localeCompare(b.updatedAt || b.createdAt)).slice(-max)
  const overflow = fresh.length - tracked.length
  let received = 0
  for (const change of tracked) {
    signal.throwIfAborted()
    const threaded = threadOf(instance, change.number)
    try {
      received += await observeChange(ctx, instance, config.project, change, previous)
      received += await observeNotes(ctx, adapter as HostAdapter<Record<string, unknown>>, instance, config.project, change, since, started, signal)
      received += await observeCi(ctx, adapter as HostAdapter<Record<string, unknown>>, instance, config.project, change, signal)
      ctx.threads.patch(threaded, { pollError: undefined })
    } catch (error) {
      // An aborted round is a stop, not a failed change; anything else stays on the Thread and the round goes on.
      if (signal.aborted) throw error
      ctx.threads.patch(threaded, { pollError: String(error) })
    }
  }
  // A stopped round does not advance the cursor, so the same changes are read again next time.
  signal.throwIfAborted()
  ctx.state.set(KV.hosting.cursor(instance), cursorAt(started))
  ctx.report(adapter.host, overflow
    ? { state: 'ready', detail: `${received} triggers; ${overflow} changes beyond the ${max} tracked`, at: started }
    : { state: 'ready', detail: `${received} triggers`, at: started })
  return { scanned: fresh.length, received, overflow }
}