/** Work-item status feedback: the board shows a ticket's start and end status once each, and never a second time. */
import { describe, expect, it } from 'vitest'
import type { Ticket, Thread, Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { YunxiaoHttpError } from '../src/infra/yunxiao-api.ts'
import { KV } from '../src/kv.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { reflectWorkTickets, resolveStatus, type ReflectedTicket } from '../src/sources/work/feedback.ts'
import type { WorkAdapter, WorkItem } from '../src/sources/work/port.ts'
import { testDeployment } from './fixtures/deployment.ts'

const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const item = (status = 's2'): WorkItem => ({ key: 'ab12', serial: 'ESFX-6228', category: 'bug', title: '登录失败', body: '',
  author: { id: 'acc-777' }, status: { id: status, name: status === 's3' ? '已完成' : '处理中' }, url: '',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' })
const trigger: Trigger = { id: 't1', source: 'projex', threads: [{ source: 'projex', id: 'ab12' }],
  actor: { source: 'projex', id: 'acc-777' }, human: true, at: '2026-11-02T00:00:00.000Z', text: '登录失败',
  channel: { source: 'projex', thread: 'projex:ab12', address: { project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' } },
  meta: { identifier: 'ab12', serial: 'ESFX-6228' } }
const thread = (subscriptions: string[]): Thread => ({ key: 'projex:ab12', ref: { source: 'projex', id: 'ab12' },
  createdAt: '2026-11-01T00:00:00.000Z', subscriptions, correlated: [], pending: [], meta: {} })

interface Written { key: string; status: string }
interface Fake {
  ctx: SourceContext
  adapter: WorkAdapter
  store: Map<string, unknown>
  written: Written[]
  reads: string[]
  patched: { key: string; meta: Record<string, unknown> }[]
}
/** A WorkAdapter that records the statuses it writes and can refuse them, as a failing host would. */
function fakeAdapter(options: { written: Written[]; reads: string[]; itemStatus: string; failWrite?: boolean
  failRead?: Error }): WorkAdapter {
  return {
    host: 'projex',
    listWorkItems: async () => ({ items: [] }),
    readWorkItem: async (_commands, _project, key) => {
      options.reads.push(key)
      if (options.failRead) throw options.failRead
      return item(options.itemStatus)
    },
    listNotes: async () => ({ notes: [] }),
    postNote: async () => 'sent',
    setStatus: async (_commands, target, status) => {
      if (options.failWrite) throw new Error('HTTP 500 from the status endpoint')
      options.written.push({ key: target.key, status })
    },
    page: () => '',
  }
}
/** A SourceContext with one followed thread, the tickets named by `tickets`, and a state store the ledger persists through. */
function fakeContext(options: { threads?: Thread[]; tickets?: Record<string, Partial<Ticket> | undefined>; noTrigger?: boolean
  itemStatus?: string; failWrite?: boolean; failRead?: Error } = {}): Fake {
  const store = new Map<string, unknown>()
  const written: Written[] = []
  const reads: string[] = []
  const patched: { key: string; meta: Record<string, unknown> }[] = []
  const threads = options.threads ?? [thread(['t1'])]
  const tickets = options.tickets ?? { t1: { id: 't1' } }
  const ctx = {
    commands: commands(),
    state: {
      get: <V>(name: string) => store.get(name) as V | undefined,
      set: <V>(name: string, value: V | undefined) => { if (value === undefined) store.delete(name); else store.set(name, value) },
      keys: () => [],
    },
    threads: { subscribed: () => threads, patch: (key: string, meta: Record<string, unknown>) => { patched.push({ key, meta }) } },
    triggers: { latest: () => options.noTrigger ? undefined : trigger },
    tickets: { get: (id: string) => tickets[id] as unknown as Ticket | undefined },
  }
  const adapter = fakeAdapter({ written, reads, itemStatus: options.itemStatus ?? 's1', ...options.failWrite ? { failWrite: true } : {},
    ...options.failRead ? { failRead: options.failRead } : {} })
  return { ctx: ctx as unknown as SourceContext, adapter, store, written, reads, patched }
}
const statuses = { start: 's2', done: 's3' }
const ledgerOf = (fake: Fake): Record<string, ReflectedTicket> => fake.store.get(KV.work.reflected('projex')) as Record<string, ReflectedTicket>

describe('reflectWorkTickets', () => {
  it('writes the start status for an open ticket, and the done status once it ended', async () => {
    const fake = fakeContext()
    await expect(reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', project: 'proj-1', statuses }))
      .resolves.toEqual({ written: 1, errors: [] })
    expect(ledgerOf(fake).t1).toMatchObject({ project: 'proj-1', key: 'ab12', serial: 'ESFX-6228', start: true })
    // The same round again writes nothing: one status per phase per ticket.
    await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', project: 'proj-1', statuses })
    expect(fake.written).toEqual([{ key: 'ab12', status: 's2' }])
  })
  it('writes the done status once the ticket ended, and keeps both phases in the ledger', async () => {
    const fake = fakeContext({ threads: [thread(['t1'])],
      tickets: { t1: { id: 't1', ended: { at: '2026-11-03T00:00:00.000Z', by: 'executor', outcome: 'completed' } } } })
    await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses })
    expect(fake.written).toEqual([{ key: 'ab12', status: 's3' }])
    await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses })
    expect(fake.written).toHaveLength(1)
  })
  it('writes nothing while the operator leaves write-back off, or names no status', async () => {
    const fake = fakeContext()
    expect(await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses: {} })).toEqual({ written: 0, errors: [] })
    // A host with no status writer stays read-only even when statuses are named.
    const readOnly = { ...fake.adapter, setStatus: undefined } as WorkAdapter
    expect(await reflectWorkTickets(fake.ctx, readOnly, { instance: 'projex', statuses })).toEqual({ written: 0, errors: [] })
    expect(fake.written).toEqual([])
  })
  it('skips the write when the item already shows the status, but remembers it', async () => {
    const fake = fakeContext({ itemStatus: 's2' })
    expect(await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses })).toEqual({ written: 1, errors: [] })
    expect(fake.written).toEqual([])
    expect(ledgerOf(fake).t1!.start).toBe(true)
  })
  it('reports a failed write in the poll result and retries it on the next round', async () => {
    const failing = fakeContext({ failWrite: true })
    const result = await reflectWorkTickets(failing.ctx, failing.adapter, { instance: 'projex', statuses })
    expect(result.written).toBe(0)
    expect(result.errors.join()).toMatch(/HTTP 500 from the status endpoint/)
    // Nothing was recorded, so the next round tries again and this time it lands.
    const healthy = fakeContext()
    healthy.store.set(KV.work.reflected('projex'), failing.store.get(KV.work.reflected('projex')))
    await reflectWorkTickets(healthy.ctx, healthy.adapter, { instance: 'projex', statuses })
    expect(healthy.written).toEqual([{ key: 'ab12', status: 's2' }])
  })
  it('treats a work item in the recycle bin as gone: no error, the Thread marked, the phase settled', async () => {
    // Projex answers a deleted item with HTTP 400 and this payload; it is the operator's deletion, not our failure.
    const gone = new YunxiaoHttpError(400, 'Yunxiao request failed with HTTP 400: {"errorCode":"InvaildData.Failed","errorMessage":"操作失败，当前工作项已进回收站！"}')
    const fake = fakeContext({ failRead: gone })
    expect(await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses })).toEqual({ written: 0, errors: [] })
    expect(fake.patched).toEqual([{ key: 'projex:ab12', meta: { gone: true } }])
    // The phase is remembered, so the next round neither retries nor reports it again.
    expect(ledgerOf(fake).t1!.start).toBe(true)
  })
  it('falls back to the thread ref when the thread has no Trigger, so a restart still finds the item', async () => {
    const fake = fakeContext({ noTrigger: true, threads: [thread(['t1'])] })
    await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', project: 'proj-1', statuses })
    expect(ledgerOf(fake).t1).toMatchObject({ project: 'proj-1', key: 'ab12', serial: 'ab12' })
    expect(fake.written).toEqual([{ key: 'ab12', status: 's2' }])
  })
  it('forgets a ticket the store no longer holds instead of retrying it for ever', async () => {
    const fake = fakeContext({ tickets: { t1: undefined } })
    fake.store.set(KV.work.reflected('projex'), { gone: { project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' } })
    await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses })
    expect(fake.store.get(KV.work.reflected('projex'))).toEqual({})
    expect(fake.reads).toEqual([])
  })
  it('resolves a configured status name against the statuses this instance has seen', async () => {
    const fake = fakeContext()
    fake.store.set(KV.work.statuses('projex'), { 处理中: 's2', 已完成: 's3' })
    await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses: { start: '处理中', done: '已完成' } })
    expect(fake.written).toEqual([{ key: 'ab12', status: 's2' }])
  })
  it('refuses a status name it has never seen, and says what to do about it', async () => {
    const fake = fakeContext()
    fake.store.set(KV.work.statuses('projex'), { 处理中: 's2' })
    const result = await reflectWorkTickets(fake.ctx, fake.adapter, { instance: 'projex', statuses: { start: '在做' } })
    expect(result.written).toBe(0)
    expect(result.errors.join()).toMatch(/status "在做" was never seen/)
    expect(fake.written).toEqual([])
  })
})

describe('resolveStatus', () => {
  const known = { 处理中: 's2', 'In Progress': 's9' }
  it('takes an id it has seen, or a name it has seen, ignoring case', () => {
    expect(resolveStatus('s2', known)).toBe('s2')
    expect(resolveStatus('处理中', known)).toBe('s2')
    expect(resolveStatus('in progress', known)).toBe('s9')
  })
  it('passes an opaque token through as an id this instance has not seen yet', () => {
    expect(resolveStatus('status-done', known)).toBe('status-done')
    expect(resolveStatus('985353d622cc8521793e08abcd', known)).toBe('985353d622cc8521793e08abcd')
  })
  it('refuses human text that names no status this instance has read', () => {
    expect(resolveStatus('在做', known)).toBeUndefined()
    expect(resolveStatus('in review', known)).toBeUndefined()
  })
})
