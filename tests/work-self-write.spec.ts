/**
 * The self-write ledger: what this process wrote is not a request to read again.
 *
 * One work item, two Triggers six minutes apart, the second caused by the agent's own status write-back - that is the shape of
 * the bug this holds shut. A person's own comment bumps the same modification time, which is why the ledger records *who* wrote
 * rather than comparing content.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  forgetSelfWrites, isSelfWrite, rememberSelfWrite, selfWriteCount,
} from '../src/sources/work/self-writes.ts'
import { createProjexAdapter, PROJEX_HOST } from '../src/sources/work/projex/adapter.ts'
import type { YunxiaoApi, YunxiaoQuery, YunxiaoResult } from '../src/infra/yunxiao-api.ts'
import type { Commands } from '../src/infra/commands.ts'

const ORG = 'org-1'
const PROJECT = 'proj-1'
const commands = {} as unknown as Commands
const ok = (body: unknown): YunxiaoResult => ({ status: 200, body })

interface Recorded { method: string; path: string; body?: unknown }
/** A client that records calls and answers through `respond`; `list` decides what a search returns. */
function stubApi(respond: (call: Recorded) => YunxiaoResult) {
  const calls: Recorded[] = []
  const api: YunxiaoApi = {
    get: async (path: string, _query?: YunxiaoQuery) => { const call = { method: 'get', path }; calls.push(call); return respond(call) },
    post: async (path: string, body: unknown) => { const call = { method: 'post', path, body }; calls.push(call); return respond(call) },
    put: async (path: string, body: unknown) => { const call = { method: 'put', path, body }; calls.push(call); return respond(call) },
  }
  return { api, calls }
}
const item = (updatedAt: number, id = 'AB-1') => ({ id, serialNumber: 'PROJ-1', categoryId: 'Task', subject: '做一件事', gmtModified: updatedAt })

describe('self-write ledger', () => {
  beforeEach(() => { forgetSelfWrites() })

  it('remembers one revision per key, and nothing else', () => {
    expect(isSelfWrite('projex', ORG, 'AB-1', '2026-11-09T06:00:00.000Z')).toBe(false)
    rememberSelfWrite('projex', ORG, 'AB-1', '2026-11-09T06:00:00.000Z')
    expect(isSelfWrite('projex', ORG, 'AB-1', '2026-11-09T06:00:00.000Z')).toBe(true)
    // A later revision - a person's edit - is not ours.
    expect(isSelfWrite('projex', ORG, 'AB-1', '2026-11-09T06:05:00.000Z')).toBe(false)
    // Another host, organisation or item never matches.
    expect(isSelfWrite('github', ORG, 'AB-1', '2026-11-09T06:00:00.000Z')).toBe(false)
    expect(isSelfWrite('projex', 'org-2', 'AB-1', '2026-11-09T06:00:00.000Z')).toBe(false)
    expect(isSelfWrite('projex', ORG, 'AB-2', '2026-11-09T06:00:00.000Z')).toBe(false)
  })

  it('stays bounded, so a long-running process does not grow without end', () => {
    for (let index = 0; index < 700; index += 1) rememberSelfWrite('projex', ORG, `AB-${index}`, '2026-11-09T06:00:00.000Z')
    expect(selfWriteCount()).toBeLessThanOrEqual(512)
    // The newest entry survives; the oldest were forgotten.
    expect(isSelfWrite('projex', ORG, 'AB-699', '2026-11-09T06:00:00.000Z')).toBe(true)
    expect(isSelfWrite('projex', ORG, 'AB-0', '2026-11-09T06:00:00.000Z')).toBe(false)
  })
})

describe('Projex writes are recognised on the next poll', () => {
  beforeEach(() => { forgetSelfWrites() })

  it('drops the revision its own status write produced, and keeps the one a person made later', async () => {
    // The write answers 204, so the adapter reads the item once more to learn the revision it produced.
    const written = 1_800_000_000_000
    const later = written + 600_000
    const { api, calls } = stubApi(call => {
      if (call.method === 'put') return { status: 204, body: {} }
      if (call.method === 'get' && call.path.endsWith('/workitems/AB-1')) return ok({ ...item(written) })
      // Every search answers the same item, at whichever revision `current` holds.
      return ok([{ ...item(current) }])
    })
    let current = written
    const adapter = createProjexAdapter({ api, organization: ORG, writeBack: true })
    await adapter.setStatus!(commands, { key: 'AB-1', serial: 'PROJ-1', category: 'task', title: '做一件事', body: '',
      author: { id: 'acc-1' }, status: { id: 's-old', name: '待处理' }, url: '', createdAt: '', updatedAt: '' }, 's-done')
    expect(calls.some(call => call.method === 'get' && call.path.endsWith('/workitems/AB-1'))).toBe(true)

    // The poll sees the revision our write produced: nothing to hand over.
    const first = await adapter.listWorkItems(commands, PROJECT, '', ['task'])
    expect(first.items).toEqual([])

    // A person edits the item afterwards: a new revision, which is a real request.
    current = later
    const second = await adapter.listWorkItems(commands, PROJECT, '', ['task'])
    expect(second.items.map(entry => entry.key)).toEqual(['AB-1'])
  })

  it('drops the revision its own comment produced', async () => {
    const written = 1_800_000_000_000
    const { api } = stubApi(call => {
      if (call.method === 'post' && call.path.endsWith('/comments')) return ok({ id: 'c-new' })
      if (call.method === 'get' && call.path.endsWith('/comments')) return ok([])
      if (call.method === 'get' && call.path.endsWith('/workitems/AB-1')) return ok({ ...item(written) })
      return ok([{ ...item(written) }])
    })
    const adapter = createProjexAdapter({ api, organization: ORG })
    const target = { key: 'AB-1', serial: 'PROJ-1', category: 'task', title: '做一件事', body: '', author: { id: 'acc-1' },
      status: { id: 's1', name: '待处理' }, url: '', createdAt: '', updatedAt: '' } as const
    expect(await adapter.postNote(commands, target, '结论', '<!-- marker -->')).toBe('sent')
    expect(isSelfWrite(PROJEX_HOST, ORG, 'AB-1', new Date(written).toISOString())).toBe(true)
    expect((await adapter.listWorkItems(commands, PROJECT, '', ['task'])).items).toEqual([])
  })
})
