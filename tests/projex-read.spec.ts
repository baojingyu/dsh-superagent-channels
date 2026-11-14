/** Projex worker reads: the item and its comment thread as resources, with paging and the reference grammar. */
import { describe, expect, it } from 'vitest'
import { key, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { WorkAdapter } from '../src/sources/work/port.ts'
import { projexRef, projexReferences, projexResource, readProjex } from '../src/sources/work/projex/read.ts'
import { testDeployment } from './fixtures/deployment.ts'

const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const adapter: WorkAdapter = {
  host: 'projex',
  listWorkItems: async () => ({ items: [] }),
  readWorkItem: async () => ({ key: 'ab12', serial: 'ESFX-6228', category: 'bug', title: '登录失败', body: '复现步骤：…',
    author: { id: 'acc-1', name: 'Lin' }, status: { id: 's2', name: '处理中' }, url: 'https://devops/projex/project/p/workitem/ab12',
    createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', images: [{ key: 'img-1' }] }),
  listNotes: async (_c, _p, _k, cursor) => cursor === 'n2'
    ? { notes: [{ id: 'c2', body: '还在看', author: { id: 'acc-1' }, at: '2026-11-02T02:00:00.000Z', self: true }] }
    : { notes: [{ id: 'c1', body: '这个修好了吗', author: { id: 'acc-7', name: 'Zheng' }, at: '2026-11-02T01:00:00.000Z' }], next: 'n2' },
  postNote: async () => 'sent',
  page: () => '',
}
const trigger: Trigger = { id: key('projex', 'ab12'), source: 'projex', threads: [{ source: 'projex', id: 'ab12' }],
  actor: { source: 'projex', id: 'acc-7' }, human: true, at: '2026-11-02T00:00:00.000Z', text: '登录失败',
  channel: { source: 'projex', thread: 'projex:ab12', address: { project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' } },
  meta: { identifier: 'ab12', serial: 'ESFX-6228' } }

describe('Projex references', () => {
  it('resolves the project and item from the Trigger, and names both resources', () => {
    const ref = projexRef(trigger)!
    expect(ref).toEqual({ triggerId: key('projex', 'ab12'), project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' })
    expect(projexReferences(ref)).toEqual({ skill: 'dsh-superagent-projex', item: `projex/${ref.triggerId}/item`,
      comments: `projex/${ref.triggerId}/comments` })
    expect(projexResource('projex/t1/comments/n2')).toEqual({ triggerId: 't1', section: 'comments', cursor: 'n2' })
    expect(() => projexResource('projex/t1/item/x')).toThrow(/next_resource/)
    expect(projexRef({ ...trigger, channel: undefined } as Trigger)).toBeUndefined()
  })
})

describe('readProjex', () => {
  it('reads the item with its status, author, body and image keys', async () => {
    const read = await readProjex(adapter, commands(), projexRef(trigger)!, `projex/${key('projex', 'ab12')}/item`)
    expect(read).toMatchObject({ status: 'ok', next_resource: null,
      item: { id: 'ab12', serial: 'ESFX-6228', category: 'bug', title: '登录失败', status: '处理中', author: 'Lin',
        text: '复现步骤：…', images: ['img-1'] } })
  })
  it('pages the comments, marking the agent\'s own comment as a bot', async () => {
    const first = await readProjex(adapter, commands(), projexRef(trigger)!, `projex/${key('projex', 'ab12')}/comments`)
    expect(first).toMatchObject({ status: 'ok', messages: [{ id: 'c1', from: 'Zheng', text: '这个修好了吗' }] })
    expect(first.next_resource).toBe(`projex/${key('projex', 'ab12')}/comments/n2`)
    const second = await readProjex(adapter, commands(), projexRef(trigger)!, String(first.next_resource))
    expect(second).toMatchObject({ status: 'ok', messages: [{ id: 'c2', bot: true }], next_resource: null })
  })
})
