/** The work port and the generic work kind: category rows, shared configuration, and marker-idempotent comment replies. */
import { describe, expect, it } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import type { ChannelHost } from '../src/sources/kind.ts'
import { workKind, type WorkNoteReply } from '../src/sources/work/kind.ts'
import type { WorkAdapter, WorkItem } from '../src/sources/work/port.ts'
import { testDeployment } from './fixtures/deployment.ts'

/** A bug assigned to the agent, the shape a Projex work item is normalized into. */
const item: WorkItem = {
  key: 'AB-12', serial: 'AB-12', category: 'bug', title: 'Login fails', body: 'Repro steps',
  author: { id: 'acc-9', name: 'Reporter' }, assignee: { id: 'acc-1', name: 'Lin' },
  status: { id: 's1', name: '处理中', stage: 'in_progress' },
  url: 'https://projex.example/proj-1/workitems/AB-12',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z',
}
const adapter: WorkAdapter = {
  host: 'projex',
  listWorkItems: async () => ({ items: [item] }),
  readWorkItem: async () => item,
  listNotes: async () => ({ notes: [] }),
  postNote: async (): Promise<'sent' | 'gone'> => 'sent',
  page: (project, key) => `https://projex.example/${project}/workitems/${key}`,
}
const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
/** The host an instance's channel receives; the work kind never reads it when no provider is configured. */
const host = (config: Record<string, unknown> = {}): ChannelHost =>
  ({ commands: commands(), deployment: testDeployment(), config, instance: 'projex-rdc' })
const reply = (id = 'r1'): OutboundMessage => ({ id, kind: 'reply', text: 'AB-12 已交付',
  channel: { source: 'projex-rdc', thread: 'projex-rdc:AB-12', address: { project: 'proj-1', key: 'AB-12', serial: 'AB-12' } } })
const storedConfig = (overrides: Record<string, unknown> = {}) =>
  ({ project: 'proj-1', tokenFile: '/tmp/projex-token', ...overrides })

describe('work port', () => {
  it('keeps the assignee and the status stage: the structured basis for "assigned to me"', async () => {
    const read = await adapter.readWorkItem(commands(), 'proj-1', 'AB-12')
    expect(read.assignee).toEqual({ id: 'acc-1', name: 'Lin' })
    expect(read.status).toEqual({ id: 's1', name: '处理中', stage: 'in_progress' })
    expect(read.category).toBe('bug')
  })
})

describe('workKind scope', () => {
  const kind = workKind(adapter)
  const config = kind.schema.parse(storedConfig())
  it.each([
    ['requirement', 'requirements'],
    ['bug', 'bugs'],
    ['task', 'tasks'],
    ['risk', undefined],
  ] as const)('maps category %s to admission row %s', (category, row) => {
    expect(kind.scope!({ meta: { category } }, config)).toEqual(row
      ? { listened: true, observed: true, row }
      : { listened: true, observed: true })
  })
})

describe('workKind configuration', () => {
  const kind = workKind(adapter)
  it('fills the default categories and keeps write-back off', () => {
    const config = kind.schema.parse(storedConfig())
    expect(config.categories).toEqual(['requirement', 'bug', 'task'])
    expect(config.writeBack).toBe(false)
  })
  it('fails when the required project is missing', () => {
    expect(() => kind.schema.parse({ tokenFile: '/tmp/projex-token' })).toThrow(/project/)
  })
  it('fails when the project is empty', () => {
    expect(() => kind.schema.parse(storedConfig({ project: '   ' }))).toThrow(/project/)
  })
})

describe('workKind channel', () => {
  it('declares marker-idempotent Markdown comments with a limit far above chat', () => {
    expect(workKind(adapter).channel!.capabilities).toEqual({ idempotency: 'marker', markdown: true, maxChars: 60000 })
  })
  it('throws instead of silently succeeding when no outbound provider is configured', async () => {
    const kind = workKind(adapter)
    await expect(kind.channel!.send(host(), reply())).rejects.toThrow('provider not configured')
  })
  it('publishes a comment through the configured provider with the retry-stable marker', async () => {
    const sent: WorkNoteReply[] = []
    const kind = workKind(adapter, { provider: async note => { sent.push(note); return 'gone' } })
    const instance = host({ project: 'proj-1' })
    await expect(kind.channel!.send(instance, reply('r7'))).resolves.toBe('gone')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ project: 'proj-1', key: 'AB-12', text: 'AB-12 已交付',
      marker: '<!-- dsh-superagent:r7 -->', host: { instance: 'projex-rdc' } })
  })
  it('refuses a reply whose channel address names no work item', async () => {
    const kind = workKind(adapter, { provider: async () => 'sent' })
    const message: OutboundMessage = { ...reply(), channel: { source: 'projex-rdc', thread: 'projex-rdc:AB-12', address: {} } }
    await expect(kind.channel!.send(host(), message)).rejects.toThrow('Missing work item reply target')
  })
  it('links to the item page through the adapter', () => {
    expect(workKind(adapter).channel!.link({ project: 'proj-1', key: 'AB-12', serial: 'AB-12' }, {})).toEqual({
      url: 'https://projex.example/proj-1/workitems/AB-12', label: { zh: '工作项 AB-12', en: 'Work item AB-12' },
    })
  })
})

describe('workKind identity', () => {
  it('defaults the kind and its health entry to the adapter host, and lets meta override them', () => {
    const base = workKind(adapter)
    expect(base.kind).toBe('projex')
    expect(base.health).toEqual(['projex'])
    expect(workKind(adapter, { kind: 'projex', host: 'projex-rdc' }).health).toEqual(['projex-rdc'])
  })
})