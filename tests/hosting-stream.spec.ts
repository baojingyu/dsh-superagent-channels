/** Watermark polling of a hosting adapter: first-round baseline, incremental rounds, per-change isolation, abort, and health. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import type { Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import { KV, type Family, type Key } from '../src/kv.ts'
import type { CiSnapshot } from '../src/sources/github-read.ts'
import type { Health, SourceContext } from '../src/sources/host.ts'
import type { ChangeNote, ChangeRequest, HostAdapter } from '../src/sources/hosting/port.ts'
import { pollHosting } from '../src/sources/hosting/stream.ts'

const INSTANCE = 'gitlab'
const CONFIG = { project: 'team/app', tokenFile: '/home/agent/gitlab-token', hostUrl: 'https://gitlab.example.com' }

/** A change request fixture; `updatedAt` decides which round sees it as fresh. */
const change = (number: number, overrides: Partial<ChangeRequest> = {}): ChangeRequest => ({
  number, title: `MR ${number}`, body: 'body', author: 'dev', authorIsBot: false,
  url: `https://gitlab.example.com/team/app/-/merge_requests/${number}`, state: 'open', merged: false,
  head: { ref: 'feature', sha: 'sha', project: 'team/app' }, base: { ref: 'main' },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...overrides,
})
/** A change updated after any cursor this test stores, so a later round still sees it as an increment. */
const fresh = (number: number): ChangeRequest => change(number, { updatedAt: new Date(Date.now() + 60_000).toISOString() })
const note = (id: string, overrides: Partial<ChangeNote> = {}): ChangeNote =>
  ({ id, body: `note ${id}`, author: 'rev', authorIsBot: false, at: '2026-01-03T00:00:00.000Z', kind: 'conversation', ...overrides })

interface Calls { since: string[]; notes: { number: number; cursor: string | undefined }[]; ci: number[] }
/** A fake GitLab adapter: the handlers decide the pages, and every call is recorded for assertions. */
function adapterOf(options: {
  changes?: (since: string) => ChangeRequest[]
  notes?: (change: ChangeRequest, cursor: string | undefined) => ChangeNote[] | Promise<ChangeNote[]>
  snapshot?: (change: ChangeRequest) => CiSnapshot | undefined
} = {}): { adapter: HostAdapter<Record<string, unknown>>; calls: Calls } {
  const calls: Calls = { since: [], notes: [], ci: [] }
  return {
    calls,
    adapter: {
      host: 'gitlab',
      page: (project, number) => `https://gitlab.example.com/${project}/-/merge_requests/${number}`,
      listChanges: async (_commands, _project, since) => { calls.since.push(since); return { changes: options.changes?.(since) ?? [] } },
      readChange: async (_commands, _project, number) => change(number),
      readNotes: async (_commands, current, cursor) => {
        calls.notes.push({ number: current.number, cursor })
        return { notes: (await options.notes?.(current, cursor)) ?? [] }
      },
      postNote: async () => 'sent',
      ci: async (_commands, current) => { calls.ci.push(current.number); return options.snapshot?.(current) },
    },
  }
}

interface Harness { ctx: SourceContext; received: Trigger[]; patches: Map<string, Record<string, unknown>>; reports: { entry: string; health: Health }[] }
/** A SourceContext over the in-memory Store: state reads/writes go to the store, and Triggers, patches, and reports are recorded. */
function context(store: Store, config: Record<string, unknown> | null = CONFIG, instance = INSTANCE): Harness {
  const received: Trigger[] = []
  const patches = new Map<string, Record<string, unknown>>()
  const reports: { entry: string; health: Health }[] = []
  const ctx = {
    commands: {} as unknown as Commands,
    config: <C extends Record<string, unknown>>(id: string) => (id === instance && config ? config as C : undefined),
    state: {
      get: <V>(key: Key<V>) => store.get(key),
      set: <V>(key: Key<V>, value: V | undefined) => { if (value === undefined) store.delete(key); else store.set(key, value) },
      keys: <V>(family: Family<V, never>) => store.keys(family),
    },
    receive: async (trigger: Trigger) => { received.push(trigger); return {} as never },
    threads: { patch: (key: string, meta: Record<string, unknown>) => { patches.set(key, { ...patches.get(key), ...meta }) } },
    report: (entry: string, value: Health) => { reports.push({ entry, health: value }) },
  } as unknown as SourceContext
  return { ctx, received, patches, reports }
}

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'hosting-stream-'))
  store = new Store(join(directory, 'db.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

describe('pollHosting', () => {
  it('initializes the watermark from now and hands over the first scan', async () => {
    const { adapter, calls } = adapterOf({ changes: () => [change(7)], notes: () => [note('1')] })
    const { ctx, received } = context(store)
    const before = Date.now()
    const round = await pollHosting(ctx, adapter, {}, new AbortController().signal)
    expect(calls.since).toHaveLength(1)
    expect(Date.parse(calls.since[0]!)).toBeGreaterThanOrEqual(before - 2000)
    expect(round).toEqual({ scanned: 1, received: 2, overflow: 0 })
    expect(received.map(trigger => trigger.meta.kind)).toEqual(['pull', 'conversation'])
    expect(received[0]).toMatchObject({ source: INSTANCE, threads: [{ source: INSTANCE, id: '7' }],
      channel: { source: INSTANCE, thread: 'gitlab:7', address: { project: 'team/app', number: '7' } } })
    const cursor = store.get(KV.hosting.cursor(INSTANCE))
    expect(cursor).toBeDefined()
    expect(Date.parse(cursor!)).toBeLessThanOrEqual(Date.now())
    expect(store.get(KV.hosting.notes(INSTANCE, 7))).toBeDefined()
  })

  it('reads only what changed since the stored cursor on the next round', async () => {
    const first = adapterOf({ changes: () => [change(7)], notes: () => [note('1')] })
    await pollHosting(context(store).ctx, first.adapter, {}, new AbortController().signal)
    const cursor = store.get(KV.hosting.cursor(INSTANCE))!

    const second = adapterOf({ changes: () => [change(7, { updatedAt: '2026-01-01T00:00:00.000Z' }), fresh(8)] })
    const { ctx, received } = context(store)
    const round = await pollHosting(ctx, second.adapter, {}, new AbortController().signal)
    expect(second.calls.since).toEqual([cursor])
    expect(round).toMatchObject({ scanned: 1, received: 1, overflow: 0 })
    expect(received.map(trigger => trigger.meta.number)).toEqual([8])
    // The per-change note watermark starts from the round's cursor on first sight of that change.
    expect(second.calls.notes).toEqual([{ number: 8, cursor }])
  })

  it('isolates one unreadable change: pollError on its Thread, the round and the cursor carry on', async () => {
    const { adapter } = adapterOf({ changes: () => [change(7), change(8)],
      notes: current => { if (current.number === 7) throw new Error('boom'); return [] } })
    const { ctx, received, patches } = context(store)
    const round = await pollHosting(ctx, adapter, {}, new AbortController().signal)
    expect(patches.get('gitlab:7')).toMatchObject({ pollError: expect.stringContaining('boom') })
    expect(patches.get('gitlab:8')).toEqual({ pollError: undefined })
    expect(received.map(trigger => trigger.meta.number)).toContain(8)
    expect(round.received).toBe(2) // change 7's own event, then change 8's event
    expect(store.get(KV.hosting.cursor(INSTANCE))).toBeDefined()
  })

  it('stops on a pre-aborted signal without reading anything or advancing the cursor', async () => {
    const controller = new AbortController()
    controller.abort()
    const { adapter, calls } = adapterOf({ changes: () => [change(7)] })
    await expect(pollHosting(context(store).ctx, adapter, {}, controller.signal)).rejects.toThrow(/abort/i)
    expect(calls.since).toHaveLength(0)
    expect(store.get(KV.hosting.cursor(INSTANCE))).toBeUndefined()
  })

  it('stops mid-round on abort and leaves the cursor where it was', async () => {
    const controller = new AbortController()
    const { adapter } = adapterOf({ changes: () => [change(7), change(8)],
      notes: current => { if (current.number === 8) controller.abort(); return [] } })
    await expect(pollHosting(context(store).ctx, adapter, {}, controller.signal)).rejects.toThrow(/abort/i)
    expect(store.get(KV.hosting.cursor(INSTANCE))).toBeUndefined()
  })

  it('keeps the cursor and Triggers in the instance dimension', async () => {
    const { adapter } = adapterOf({ changes: () => [change(7)] })
    const { ctx, received } = context(store, CONFIG, 'gitlab-lab')
    await pollHosting(ctx, adapter, { instance: 'gitlab-lab' }, new AbortController().signal)
    expect(KV.hosting.cursor('gitlab-lab')).toBe('hosting-cursor:gitlab-lab')
    expect(store.get(KV.hosting.cursor('gitlab-lab'))).toBeDefined()
    expect(store.get(KV.hosting.cursor(INSTANCE))).toBeUndefined()
    expect(received[0]).toMatchObject({ source: 'gitlab-lab', threads: [{ source: 'gitlab-lab', id: '7' }] })
  })

  it('caps tracked changes and reports the overflow in the kind health entry', async () => {
    const { adapter } = adapterOf({ changes: () => [change(1), change(2), change(3)] })
    const { ctx, received, reports } = context(store)
    const round = await pollHosting(ctx, adapter, { maxTrackedChanges: 2 }, new AbortController().signal)
    expect(round).toEqual({ scanned: 3, received: 2, overflow: 1 })
    expect(received.map(trigger => trigger.meta.number)).toEqual([2, 3])
    expect(reports.at(-1)!.entry).toBe('gitlab')
    expect(reports.at(-1)!.health).toMatchObject({ state: 'ready', detail: expect.stringMatching(/1 changes beyond the 2 tracked/) })
  })

  it('baselines CI and emits a Trigger only when the pipeline changes', async () => {
    const failed: CiSnapshot = { head: 'sha', checks: [{ name: 'test', status: 'completed', conclusion: 'failure' }], statuses: [] }
    const first = adapterOf({ changes: () => [fresh(7)], snapshot: () => failed })
    const { ctx: c1, received: r1 } = context(store)
    await pollHosting(c1, first.adapter, {}, new AbortController().signal)
    expect(store.get(KV.hosting.ci(INSTANCE, 7))).toMatchObject({ revision: 0 })
    expect(r1.some(trigger => trigger.meta.ci === true)).toBe(false)

    const second = adapterOf({ changes: () => [fresh(7)], snapshot: () => failed })
    const { ctx: c2, received: r2 } = context(store)
    await pollHosting(c2, second.adapter, {}, new AbortController().signal)
    expect(r2.some(trigger => trigger.meta.ci === true)).toBe(false)

    const passed: CiSnapshot = { ...failed, checks: [{ name: 'test', status: 'completed', conclusion: 'success' }] }
    const third = adapterOf({ changes: () => [fresh(7)], snapshot: () => passed })
    const { ctx: c3, received: r3 } = context(store)
    await pollHosting(c3, third.adapter, {}, new AbortController().signal)
    expect(r3.find(trigger => trigger.meta.ci === true)).toMatchObject({
      source: INSTANCE, meta: { number: 7, ci: true, revision: 1, failed: 0 },
    })
  })

  it('does nothing, and reports nothing, for a disabled or unconfigured instance', async () => {
    const { adapter, calls } = adapterOf({ changes: () => [change(7)] })
    const { ctx, received, reports } = context(store, null)
    expect(await pollHosting(ctx, adapter, {}, new AbortController().signal)).toEqual({ scanned: 0, received: 0, overflow: 0 })
    expect(calls.since).toHaveLength(0)
    expect(received).toEqual([])
    expect(reports).toEqual([])
  })
})