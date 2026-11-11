/** Work-item polling: per-category rounds, watermark advance rules, deterministic Trigger IDs, and abort handling. */
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { KV, type Key } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { WorkAdapter, WorkItem, WorkNote } from '../src/sources/work/port.ts'
import { noteTrigger, notesToDeliver, pollWorkItems } from '../src/sources/work/stream.ts'
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
/** A Thread the instance is subscribed to; `subscriptions` names the tickets that follow it. */
interface FakeThread { key: string; ref: { source: string; id: string }; subscriptions: string[] }
/** Extra state a comment test needs: followed threads, open tickets, and the newest Trigger per thread. */
interface FakeContextOptions { threads?: FakeThread[]; open?: { id: string }[]; latest?: Map<string, Trigger> }
/** A SourceContext stand-in with an in-memory store, per-instance config, and received-Trigger tracking. */
function fakeContext(configs: Record<string, Record<string, unknown>> = {}, options: FakeContextOptions = {}): FakeContext {
  const store = new Map<string, unknown>()
  const received: Trigger[] = []
  const triggers = new Map<string, Trigger>()
  const threads = options.threads ?? []
  const open = options.open ?? []
  const latest = options.latest ?? new Map<string, Trigger>()
  const ctx = {
    commands: commands(),
    config: <C extends Record<string, unknown>>(id: string) => configs[id] as C | undefined,
    state: {
      get: <V>(name: Key<V>) => store.get(name) as V | undefined,
      set: <V>(name: Key<V>, value: V | undefined) => { if (value === undefined) store.delete(name); else store.set(name, value) },
      keys: () => [],
    },
    receive: async (trigger: Trigger) => { received.push(trigger); triggers.set(trigger.id, trigger); return 'stored' as const },
    triggers: { get: (id: string) => triggers.get(id), latest: (thread: string) => latest.get(thread) },
    threads: { subscribed: (source: string) => threads.filter(thread => thread.ref.source === source) },
    tickets: { open: () => open },
  }
  return { ctx: ctx as unknown as SourceContext, received, store }
}

/** A WorkAdapter that returns the given items for any scan and the given comments for any read. */
function noteAdapter(comments: (key: string) => WorkNote[], items: (categories: readonly string[]) => WorkItem[] = () => [])
  : { adapter: WorkAdapter; noteCalls: { key: string; cursor: string | undefined }[] } {
  const noteCalls: { key: string; cursor: string | undefined }[] = []
  const adapter: WorkAdapter = {
    host: 'projex',
    listWorkItems: async (_commands, _project, _since, categories) => ({ items: items(categories) }),
    readWorkItem: async () => { throw new Error('readWorkItem is not used by the stream') },
    listNotes: async (_commands, _project, key, cursor) => { noteCalls.push({ key, cursor }); return { notes: comments(key) } },
    postNote: async () => 'sent',
    page: () => '',
  }
  return { adapter, noteCalls }
}

/** A person comment fixture; `self`/bot overrides exercise the filtering. */
const note = (id: string, at: string, overrides: Partial<WorkNote> = {}): WorkNote =>
  ({ id, body: `comment ${id}`, author: { id: 'acc-9' }, at, ...overrides })

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

describe('work-item comments', () => {
  const KEY = 'ff47b160187e982b9d8704602d'
  const TICKET = '02296436f3fff268e5893ac61a89de85'
  const HUMAN = '673c7f0d25be8f2424a64361'
  const thread: FakeThread = { key: `projex:${KEY}`, ref: { source: 'projex', id: KEY }, subscriptions: [TICKET] }
  /** The newest Trigger already on the thread; its channel address supplies project + serial for the comment. */
  const latest = new Map<string, Trigger>([[`projex:${KEY}`, {
    id: 'work-1', source: 'projex', threads: [{ source: 'projex', id: KEY }], actor: { source: 'projex', id: HUMAN },
    human: true, at: '2026-11-11T02:34:46.000Z', text: 'body', meta: {},
    channel: { source: 'projex', thread: `projex:${KEY}`, address: { project: 'proj-1', key: KEY, serial: 'ESFX-6240' } },
  }]])

  it('builds a deterministic comment Trigger: native id + creation time, the comment author, and the work-item thread', () => {
    const person = note('24192682', '2026-11-11T02:41:39.000Z', { body: '授权你权限，自行评估决策和推进实施', author: { id: HUMAN, name: '鲍靖宇' } })
    const trigger = noteTrigger(person, { instance: 'projex', project: 'proj-1', key: KEY, serial: 'ESFX-6240' })
    expect(trigger.id).toBe(key('projex-note', KEY, '24192682', '2026-11-11T02:41:39.000Z'))
    expect(noteTrigger({ ...person }, { instance: 'projex', project: 'proj-1', key: KEY, serial: 'ESFX-6240' }).id).toBe(trigger.id)
    expect(trigger).toMatchObject({
      source: 'projex', threads: [{ source: 'projex', id: KEY }], actor: { source: 'projex', id: HUMAN },
      human: true, at: '2026-11-11T02:41:39.000Z', text: '授权你权限，自行评估决策和推进实施',
      channel: { source: 'projex', thread: `projex:${KEY}`, address: { project: 'proj-1', key: KEY, serial: 'ESFX-6240' } },
      meta: { identifier: KEY, serial: 'ESFX-6240', kind: 'comment', commentId: '24192682' },
    })
  })

  it('drops the agent\'s marked comment, bots, and empty bodies from delivery', () => {
    expect(notesToDeliver([
      note('a', '2026-11-11T02:35:32.000Z', { self: true }),
      note('b', '2026-11-11T02:36:00.000Z', { author: { id: 'bot', bot: true } }),
      note('c', '2026-11-11T02:37:00.000Z', { body: '   ' }),
      note('d', '2026-11-11T02:41:39.000Z', { author: { id: HUMAN } }),
    ], undefined).map(n => n.id)).toEqual(['d'])
  })

  it('backfills the newest person comments on first sight (default N=20), oldest first, then every newer one after the cursor', () => {
    const all = [note('1', '2026-11-11T02:00:00.000Z'), note('2', '2026-11-11T02:10:00.000Z'), note('3', '2026-11-11T02:20:00.000Z')]
    expect(notesToDeliver(all, undefined).map(n => n.id)).toEqual(['1', '2', '3'])
    expect(notesToDeliver(all, '2026-11-11T02:05:00.000Z').map(n => n.id)).toEqual(['2', '3'])
  })

  it('caps the first-sight backfill at N, dropping the older comments, and treats 0 as none', () => {
    const all = ['1', '2', '3', '4', '5'].map((id, index) => note(id, `2026-11-11T02:0${index}:00.000Z`))
    expect(notesToDeliver(all, undefined, 2).map(n => n.id)).toEqual(['4', '5'])
    expect(notesToDeliver(all, undefined, 0)).toEqual([])
  })

  it('does not let marked self comments or bots consume the N slots', () => {
    const all = [note('h1', '2026-11-11T02:01:00.000Z'), note('s', '2026-11-11T02:02:00.000Z', { self: true }),
      note('b', '2026-11-11T02:03:00.000Z', { author: { id: 'bot', bot: true } }),
      note('h2', '2026-11-11T02:04:00.000Z'), note('h3', '2026-11-11T02:05:00.000Z')]
    expect(notesToDeliver(all, undefined, 2).map(n => n.id)).toEqual(['h2', 'h3'])
  })

  it('hands the newest person comment of a followed, live work item to the engine and advances its comment cursor', async () => {
    const comments = [
      note('24191212', '2026-11-11T02:35:32.000Z', { self: true, author: { id: HUMAN } }),
      note('24192977', '2026-11-11T02:39:25.000Z', { self: true, author: { id: HUMAN } }),
      note('24192682', '2026-11-11T02:41:39.000Z', { author: { id: HUMAN, name: '鲍靖宇' },
        body: '授权你权限，自行评估决策和推进实施；ECPay、S3、USport、Himipoint、Every8D、AWS SES、Facebook、Line、Google 明确要求直接删除' }),
    ]
    const { adapter, noteCalls } = noteAdapter(() => comments)
    const { ctx, received, store } = fakeContext({ projex: { project: 'proj-1' } },
      { threads: [thread], open: [{ id: TICKET }], latest })
    const round = await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(round.errors).toEqual([])
    expect(round.received).toBe(1)
    expect(noteCalls).toEqual([{ key: KEY, cursor: undefined }])
    expect(received.map(t => t.meta.commentId)).toEqual(['24192682'])
    expect(received[0]).toMatchObject({ human: true, actor: { source: 'projex', id: HUMAN } })
    expect(received[0]!.text).toContain('直接删除')
    expect(store.get(KV.work.notes('projex', KEY))).toBeDefined()
  })

  it('does not redeliver the same comment on the next round', async () => {
    const comments = [note('24192682', '2026-11-11T02:41:39.000Z', { author: { id: HUMAN } })]
    const { adapter } = noteAdapter(() => comments)
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } }, { threads: [thread], open: [{ id: TICKET }], latest })
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(received).toHaveLength(1)
  })

  it('delivers a comment that arrives after the cursor while skipping the already-read history', async () => {
    const comments = [note('old', '2026-11-11T02:00:00.000Z', { author: { id: HUMAN } })]
    const { adapter } = noteAdapter(() => comments)
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } }, { threads: [thread], open: [{ id: TICKET }], latest })
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(received.map(t => t.meta.commentId)).toEqual(['old'])
    comments.push(note('new', new Date(Date.now() + 60_000).toISOString(), { author: { id: HUMAN } }))
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(received.map(t => t.meta.commentId)).toEqual(['old', 'new'])
  })

  it('honours a per-source backfillComments cap on the first sight, then stops after the cursor', async () => {
    const comments = [note('1', '2026-11-11T02:00:00.000Z', { author: { id: HUMAN } }),
      note('2', '2026-11-11T02:10:00.000Z', { author: { id: HUMAN } }),
      note('3', '2026-11-11T02:20:00.000Z', { author: { id: HUMAN } })]
    const { adapter } = noteAdapter(() => comments)
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1', backfillComments: 2 } }, { threads: [thread], open: [{ id: TICKET }], latest })
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(received.map(t => t.meta.commentId)).toEqual(['2', '3'])
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(received.map(t => t.meta.commentId)).toEqual(['2', '3'])
  })

  it('reads no comments for a followed thread whose only ticket has ended', async () => {
    const { adapter, noteCalls } = noteAdapter(() => [note('1', '2026-11-11T02:41:39.000Z')])
    const { ctx, received } = fakeContext({ projex: { project: 'proj-1' } }, { threads: [thread], open: [], latest })
    await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(noteCalls).toHaveLength(0)
    expect(received).toHaveLength(0)
  })

  it('reports a comment read failure without blocking the work-item cursor', async () => {
    const adapter: WorkAdapter = {
      host: 'projex',
      listWorkItems: async (_c, _p, _s, categories) => ({ items: categories.includes('bug') ? [item({ key: 'AB-1' })] : [] }),
      readWorkItem: async () => { throw new Error('readWorkItem is not used') },
      listNotes: async () => { throw new Error('comments unavailable') },
      postNote: async () => 'sent',
      page: () => '',
    }
    const { ctx, store } = fakeContext({ projex: { project: 'proj-1' } }, { threads: [thread], open: [{ id: TICKET }], latest })
    const round = await pollWorkItems(ctx, adapter, { instance: 'projex', categories: ['bug'] })
    expect(round.received).toBe(1)
    expect(round.errors).toEqual([`${KEY}: Error: comments unavailable`])
    expect(store.has(KV.work.cursor('projex'))).toBe(true)
    expect(store.has(KV.work.notes('projex', KEY))).toBe(false)
  })
})
