/** Work-item polling: per-category rounds, watermark advance rules, deterministic Trigger IDs, and abort handling. */
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV, type Key } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { WorkAdapter, WorkItem } from '../src/sources/work/port.ts'
import { pollWorkItems } from '../src/sources/work/stream.ts'
import { testDeployment } from './fixtures/deployment.ts'

const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const item = (overrides: Partial<WorkItem> & { key: string }): WorkItem => ({
  serial: overrides.key, category: 'bug', title: `Title ${overrides.key}`, body: '',
  author: { id: 'acc-author' }, status: { id: 's1', name: '处理中', stage: 'in_progress' },
  url: '', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', ...overrides })

interface Call { project: string; since: string; categories: readonly string[] }
/** A WorkAdapter stand-in that records each list call and answers with items chosen by category. */
function fakeAdapter(items: (categories: readonly string[]) => WorkItem[] = () => []): { adapter: WorkAdapter; calls: Call[] } {
  const calls: Call[] = []
  const adapter: WorkAdapter = {
    host: 'projex',
    listWorkItems: async (_commands, project, since, categories) => {
      calls.push({ project, since, categories })
      return { items: items(categories) }
    },
    readWorkItem: async () => { throw new Error('readWorkItem is not used by the stream') },
    listNotes: async () => ({ notes: [] }),
    postNote: async () => 'sent',
    page: () => '',
  }
  return { adapter, calls }
}

interface FakeContext { ctx: SourceContext; received: Trigger[]; store: Map<string, unknown> }
/** A SourceContext stand-in with an in-memory store, per-instance config, and received-Trigger tracking. */
function fakeContext(configs: Record<string, Record<string, unknown>> = {}): FakeContext {
  const store = new Map<string, unknown>()
  const received: Trigger[] = []
  const triggers = new Map<string, Trigger>()
  const ctx = {
    commands: commands(),
    config: <C extends Record<string, unknown>>(id: string) => configs[id] as C | undefined,
    state: {
      get: <V>(name: Key<V>) => store.get(name) as V | undefined,
      set: <V>(name: Key<V>, value: V | undefined) => { if (value === undefined) store.delete(name); else store.set(name, value) },
      keys: () => [],
    },
    receive: async (trigger: Trigger) => { received.push(trigger); triggers.set(trigger.id, trigger); return 'stored' as const },
    triggers: { get: (id: string) => triggers.get(id), latest: () => undefined },
  }
  return { ctx: ctx as unknown as SourceContext, received, store }
}

describe('pollWorkItems', () => {
  it('starts from the epoch watermark, receives items, and advances the cursor only after a clean round', async () => {
    const { adapter, calls } = fakeAdapter(categories => categories.includes('bug') ? [item({ key: 'AB-1' })] : [])
    const { ctx, received, store } = fakeContext({ projex: { project: 'proj-1' } })
    const result = await pollWorkItems(ctx, adapter, { instance: 'projex', project: 'proj-1', categories: ['bug'] })
    expect(result).toEqual({ received: 1, errors: [] })
    expect(received).toHaveLength(1)
    expect(calls[0]).toMatchObject({ project: 'proj-1', since: new Date(0).toISOString(), categories: ['bug'] })
    const cursor = store.get(KV.work.cursor('projex')) as string
    expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    await pollWorkItems(ctx, adapter, { instance: 'projex', project: 'proj-1', categories: ['bug'] })
    expect(calls[1]!.since).toBe(cursor)
  })

  it('polls each of the three default categories once', async () => {
    const { adapter, calls } = fakeAdapter()
    const { ctx } = fakeContext({ projex: { project: 'proj-1' } })
    await pollWorkItems(ctx, adapter, { instance: 'projex' })
    expect(calls.map(call => call.categories[0])).toEqual(['requirement', 'bug', 'task'])
  })

  it('is idempotent: the same item revision is handed over only once', async () => {
    const { adapter } = fakeAdapter(categories => categories.includes('bug') ? [item({ key: 'AB-1' })] : [])
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } })
    const options = { instance: 'projex', project: 'proj-1', categories: ['bug'] as const }
    await pollWorkItems(ctx, adapter, options)
    await pollWorkItems(ctx, adapter, options)
    expect(received).toHaveLength(1)
    expect(received[0]!.id).toBe(key('projex-open', 'AB-1', '2026-11-02T00:00:00.000Z'))
  })

  it('gives each trigger the native ID, instance source/thread, and the item status (with stage) in meta', async () => {
    const { adapter } = fakeAdapter(categories => categories.includes('bug')
      ? [item({ key: 'AB-9', serial: 'ABCD-9', assignee: { id: 'acc-1' }, updatedAt: '2026-11-03T00:00:00.000Z' })] : [])
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } })
    await pollWorkItems(ctx, adapter, { instance: 'projex-rdc', project: 'proj-1', categories: ['bug'] })
    const trigger = received[0]!
    expect(trigger).toMatchObject({
      id: key('projex-open', 'AB-9', '2026-11-03T00:00:00.000Z'),
      source: 'projex-rdc',
      threads: [{ source: 'projex-rdc', id: 'AB-9' }],
      meta: { category: 'bug', identifier: 'AB-9', serial: 'ABCD-9',
        status: { id: 's1', name: '处理中', stage: 'in_progress' } },
      channel: { source: 'projex-rdc', thread: 'projex-rdc:AB-9',
        address: { project: 'proj-1', key: 'AB-9', serial: 'ABCD-9' } },
    })
    expect(trigger.actor).toEqual({ source: 'projex-rdc', id: 'acc-1' })
  })

  it('reads an item whose list row has no body, so the trigger carries what the person actually wrote', async () => {
    // Projex's search endpoint returns `description: ''` while the detail endpoint has the text; the body is where the request
    // lives, so a listed item without one is read once before it is handed over.
    const listed = item({ key: 'AB-7', serial: 'PROJ-7', body: '', title: '【test】接收验证2', updatedAt: '2026-11-09T06:49:26.000Z' })
    const detail = item({ key: 'AB-7', serial: 'PROJ-7', body: '把贪吃蛇的国内访问网址告诉我', title: '【test】接收验证2',
      updatedAt: '2026-11-09T06:49:26.000Z' })
    const reads: string[] = []
    const { adapter } = fakeAdapter(() => [listed])
    adapter.readWorkItem = async (_commands, _project, key) => { reads.push(key); return detail }
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } })
    await pollWorkItems(ctx, adapter, { instance: 'projex', project: 'proj-1', categories: ['bug'] })
    expect(reads).toEqual(['AB-7'])
    expect(received[0]!.text).toBe('把贪吃蛇的国内访问网址告诉我')
  })

  it('keeps the listed item when the detail read fails, because the title still asks for something', async () => {
    const listed = item({ key: 'AB-8', serial: 'PROJ-8', body: '', title: '修一下登录', updatedAt: '2026-11-09T07:00:00.000Z' })
    const { adapter } = fakeAdapter(() => [listed])
    adapter.readWorkItem = async () => { throw new Error('detail unavailable') }
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } })
    await pollWorkItems(ctx, adapter, { instance: 'projex', project: 'proj-1', categories: ['bug'] })
    expect(received[0]!.text).toBe('修一下登录')
  })

  it('stops before polling when the signal is already aborted', async () => {
    const { adapter, calls } = fakeAdapter()
    const { ctx, received, store } = fakeContext({ projex: { project: 'proj-1' } })
    const controller = new AbortController()
    controller.abort()
    expect(await pollWorkItems(ctx, adapter, { instance: 'projex' }, controller.signal)).toEqual({ received: 0, errors: [] })
    expect(calls).toHaveLength(0)
    expect(received).toHaveLength(0)
    expect(store.has(KV.work.cursor('projex'))).toBe(false)
  })

  it('stops between categories when aborted mid-round', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    const adapter: WorkAdapter = {
      host: 'projex',
      listWorkItems: async (_commands, _project, _since, categories) => { seen.push(categories[0]!); controller.abort(); return { items: [] } },
      readWorkItem: async () => { throw new Error('readWorkItem is not used') },
      listNotes: async () => ({ notes: [] }),
      postNote: async () => 'sent',
      page: () => '',
    }
    const { ctx, store } = fakeContext({ projex: { project: 'proj-1' } })
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['requirement', 'bug'] }, controller.signal)
    expect(seen).toEqual(['requirement'])
    expect(store.has(KV.work.cursor('projex'))).toBe(false)
  })

  it('records a failing category, still polls the others, and keeps the watermark', async () => {
    const seen: string[] = []
    const adapter: WorkAdapter = {
      host: 'projex',
      listWorkItems: async (_commands, _project, _since, categories) => {
        const category = categories[0]!
        seen.push(category)
        if (category === 'bug') throw new Error('boom')
        return { items: [] }
      },
      readWorkItem: async () => { throw new Error('readWorkItem is not used') },
      listNotes: async () => ({ notes: [] }),
      postNote: async () => 'sent',
      page: () => '',
    }
    const { ctx, store } = fakeContext({ projex: { project: 'proj-1' } })
    const result = await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['requirement', 'bug', 'task'] })
    expect(result.errors).toEqual(['bug: Error: boom'])
    expect(seen).toEqual(['requirement', 'bug', 'task'])
    expect(store.has(KV.work.cursor('projex'))).toBe(false)
  })

  it('does nothing and does not throw when the instance names no project', async () => {
    const { adapter, calls } = fakeAdapter()
    const { ctx } = fakeContext({})
    expect(await pollWorkItems(ctx, adapter, { instance: 'projex' })).toEqual({ received: 0, errors: [] })
    expect(calls).toHaveLength(0)
  })
})