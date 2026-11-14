/** The Projex work kind built from the shared factory: identity, organization-aware schema, category rows, and environment. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SourceHost } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { projexAdapters, projexKind } from '../src/sources/work/projex/kind.ts'
import type { WorkAdapter, WorkItem } from '../src/sources/work/port.ts'
import { testDeployment } from './fixtures/deployment.ts'

const storedConfig = (overrides: Record<string, unknown> = {}) =>
  ({ project: 'proj-1', tokenFile: '/tmp/projex-token', organizationId: 'org-1', ...overrides })
const config = () => projexKind.schema.parse(storedConfig())

describe('projexKind identity', () => {
  it('is the Projex kind built by workKind, with its own title and health entry', () => {
    expect(projexKind.kind).toBe('projex')
    expect(projexKind.title).toEqual({ zh: '云效 Projex', en: 'Yunxiao Projex' })
    expect(projexKind.health).toEqual(['projex'])
  })
  it('offers the shared configuration fields plus the organization ID field', () => {
    expect(projexKind.fields.map(field => field.key))
      .toEqual(['project', 'tokenFile', 'pollSeconds', 'writeBack', 'statusOnStart', 'statusOnDone', 'sendFiles', 'backfillComments',
        'organizationId', 'baseUrl'])
  })
})

describe('projexKind schema', () => {
  it('defaults categories and write-back, and keeps the organization ID', () => {
    expect(config()).toMatchObject({ project: 'proj-1', organizationId: 'org-1',
      categories: ['requirement', 'bug', 'task'], writeBack: false })
  })
  it('requires a non-empty organizationId', () => {
    expect(() => projexKind.schema.parse({ project: 'proj-1', tokenFile: '/tmp/projex-token' })).toThrow(/organizationId/)
    expect(() => projexKind.schema.parse(storedConfig({ organizationId: '' }))).toThrow(/organizationId/)
  })
  it('still requires the project', () => {
    expect(() => projexKind.schema.parse({ tokenFile: '/tmp/projex-token', organizationId: 'org-1' })).toThrow(/project/)
  })
})

describe('projexKind scope', () => {
  it.each([
    ['requirement', 'requirements'],
    ['bug', 'bugs'],
    ['task', 'tasks'],
    ['risk', undefined],
  ] as const)('maps category %s to admission row %s', (category, row) => {
    expect(projexKind.scope!({ meta: { category } }, config())).toEqual(row
      ? { listened: true, observed: true, row }
      : { listened: true, observed: true })
  })
})

describe('projexKind environment', () => {
  it('exposes the item identity variables and the organization, empty until a Trigger names an item', () => {
    const environment = projexKind.environment!
    expect(environment.variables.map(variable => variable.key))
      .toEqual(['DSH_SUPERAGENT_PROJEX_PROJECT', 'DSH_SUPERAGENT_PROJEX_WORKITEM', 'DSH_SUPERAGENT_PROJEX_SERIAL',
        'DSH_SUPERAGENT_PROJEX_CATEGORY', 'DSH_SUPERAGENT_PROJEX_STATUS', 'DSH_SUPERAGENT_PROJEX_URL',
        'DSH_SUPERAGENT_PROJEX_ORG'])
    expect(environment.values({ deployment: testDeployment(), config: config() })).toEqual({
      DSH_SUPERAGENT_PROJEX_PROJECT: 'proj-1',
      DSH_SUPERAGENT_PROJEX_WORKITEM: '',
      DSH_SUPERAGENT_PROJEX_SERIAL: '',
      DSH_SUPERAGENT_PROJEX_CATEGORY: '',
      DSH_SUPERAGENT_PROJEX_STATUS: '',
      DSH_SUPERAGENT_PROJEX_URL: '',
      DSH_SUPERAGENT_PROJEX_ORG: 'org-1',
    })
  })
  it('fills the item variables from the Trigger the ticket started on', () => {
    const trigger: Trigger = { id: 't1', source: 'projex', threads: [{ source: 'projex', id: 'ab12' }],
      actor: { source: 'projex', id: 'acc-1' }, human: true, at: '2026-11-02T00:00:00.000Z', text: '登录失败',
      url: 'https://devops.aliyun.com/projex/project/proj-1/workitem/ESFX-6228',
      channel: { source: 'projex', thread: 'projex:ab12', address: { project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' } },
      meta: { category: 'bug', serial: 'ESFX-6228', status: { id: 's2', name: '处理中' } } }
    const values = projexKind.environment!.values({ deployment: testDeployment(), config: config(), trigger })
    expect(values).toMatchObject({ DSH_SUPERAGENT_PROJEX_WORKITEM: 'ab12', DSH_SUPERAGENT_PROJEX_SERIAL: 'ESFX-6228',
      DSH_SUPERAGENT_PROJEX_CATEGORY: 'bug', DSH_SUPERAGENT_PROJEX_STATUS: '处理中',
      DSH_SUPERAGENT_PROJEX_URL: 'https://devops.aliyun.com/projex/project/proj-1/workitem/ESFX-6228',
      DSH_SUPERAGENT_PROJEX_ORG: 'org-1' })
  })
})

describe('projexKind channel', () => {
  it('still replies as a marker-idempotent comment, and declares the size it can attach', () => {
    expect(projexKind.channel!.capabilities).toEqual({ idempotency: 'marker', markdown: true, maxChars: 60000,
      files: { maxBytes: 10 * 1024 * 1024 } })
  })
})

describe('projexKind search resolution', () => {
  it('resolves a serial or a work-item page URL, and nothing else', () => {
    expect(projexKind.find!('ESFX-6228')).toEqual({ threads: [], terms: ['ESFX-6228'] })
    // A lowercase serial is accepted too: the stored one is upper case, so both spellings are searched.
    expect(projexKind.find!('esfx-6228')).toEqual({ threads: [], terms: ['esfx-6228', 'ESFX-6228'] })
    expect(projexKind.find!('https://devops.aliyun.com/projex/project/proj-1/workitem/ESFX-6228'))
      .toEqual({ threads: [], terms: ['ESFX-6228'] })
    expect(projexKind.find!('修一下登录')).toEqual({ threads: [], terms: [] })
  })
})

describe('projexKind policy', () => {
  it('offers the member sync switch next to the member list, and only syncs when it is on', () => {
    expect(projexKind.policy!.fields.map(field => field.key)).toEqual(['allowed', 'syncMembers'])
    expect(projexKind.policy!.sync!.ready({ allowed: [], syncMembers: false })).toBe(false)
    expect(projexKind.policy!.sync!.ready({ allowed: [], syncMembers: true })).toBe(true)
  })
})

const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const item = (key: string, status: { id: string; name: string }): WorkItem => ({ key, serial: key, category: 'bug', title: key,
  body: '', author: { id: 'acc-1' }, status, url: '', createdAt: '', updatedAt: '' })
/** A WorkAdapter stand-in for the sync and the status probe; nothing here touches a network. */
function fakeAdapter(options: { members?: { id: string; name?: string }[]; items?: WorkItem[]
  statuses?: { id: string; name: string }[] } = {}): ReturnType<typeof projexAdapters.create> {
  const adapter: WorkAdapter = {
    host: 'projex',
    listWorkItems: async () => ({ items: options.items ?? [] }),
    readWorkItem: async () => { throw new Error('readWorkItem is not used here') },
    listNotes: async () => ({ notes: [] }),
    postNote: async () => 'sent',
    listMembers: async () => options.members ?? [],
    listStatuses: async () => options.statuses ?? [],
    page: () => '',
  }
  return adapter as unknown as ReturnType<typeof projexAdapters.create>
}
/** A host stub: the sync reads its configuration from the registry and its commands from the context. */
function hostStub(instances: { id: string; kind: string; enabled: boolean; config: Record<string, unknown> }[]): SourceHost & {
  state: Map<string, unknown> } {
  const state = new Map<string, unknown>()
  const host = { sources: { instances: () => instances } as unknown as SourceRegistry,
    state,
    context: () => ({ commands: commands(), config: (kind: string) => instances.find(item => item.kind === kind)?.config,
      state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) }, keys: () => [] } }) }
  return host as unknown as SourceHost & { state: Map<string, unknown> }
}
const stored = { id: 'projex', kind: 'projex', enabled: true,
  config: { project: 'proj-1', tokenFile: '/tmp/projex-token', organizationId: 'org-1' } }
afterEach(() => vi.restoreAllMocks())

describe('projexKind member sync', () => {
  it('keeps the existing order, refreshes names, and appends members the list did not have', async () => {
    vi.spyOn(projexAdapters, 'create').mockReturnValue(fakeAdapter({ members: [
      { id: 'acc-2', name: 'Zheng' }, { id: 'acc-1', name: 'Lin' }, { id: 'acc-3', name: 'New' }] }))
    const part = await projexKind.policy!.sync!.run(hostStub([stored]),
      { allowed: [{ id: 'acc-1', name: 'Old Lin' }, { id: 'acc-9', name: 'Left' }], syncMembers: true },
      new AbortController().signal)
    expect(part).toEqual({ allowed: [{ id: 'acc-1', name: 'Lin' }, { id: 'acc-2', name: 'Zheng' }, { id: 'acc-3', name: 'New' }],
      syncMembers: true })
  })
  it('refuses to sync before the project space is set', async () => {
    const bare = { ...stored, config: { organizationId: 'org-1', tokenFile: '/tmp/projex-token' } }
    await expect(projexKind.policy!.sync!.run(hostStub([bare]), { allowed: [], syncMembers: true },
      new AbortController().signal)).rejects.toThrow(/project space/)
  })
})

describe('projexKind status probe', () => {
  const action = projexKind.actions!.find(entry => entry.id === 'statuses')!
  it('is ready only once a project is set, and lists the workflow statuses it read', async () => {
    expect(action.ready!({ project: '' })).toBe(false)
    expect(action.ready!({ project: 'proj-1' })).toBe(true)
    vi.spyOn(projexAdapters, 'create').mockReturnValue(fakeAdapter({ statuses: [
      { id: 's2', name: '处理中' }, { id: 's3', name: '已完成' }] }))
    const host = hostStub([stored])
    expect(await action.run(host, { project: 'proj-1', organizationId: 'org-1', tokenFile: '/t', categories: ['bug'] }))
      .toBe('云效状态词表（名字=ID）：处理中=s2，已完成=s3')
    // The vocabulary is recorded, so a write-back can name a status instead of an id.
    expect(host.state.get('work-statuses:projex')).toMatchObject({ 处理中: 's2', 已完成: 's3' })
  })
  it('says so when the project returns no status at all', async () => {
    vi.spyOn(projexAdapters, 'create').mockReturnValue(fakeAdapter())
    expect(await action.run(hostStub([stored]), { project: 'proj-1' })).toMatch(/有「项目协作」读权限/)
  })
  it('rereads the vocabulary so the two write-back fields can be dropdowns', async () => {
    vi.spyOn(projexAdapters, 'create').mockReturnValue(fakeAdapter({ statuses: [
      { id: 's2', name: '处理中' }, { id: 's3', name: '已完成' }] }))
    const host = hostStub([stored])
    // `id -> name` fills the pickers the panel reads from `source-labels:<id>`.
    await expect(projexKind.refreshLabels!(host)).resolves.toEqual({ s2: '处理中', s3: '已完成' })
    expect(host.state.get('source-labels:projex')).toMatchObject({ s2: '处理中', s3: '已完成' })
    // `name -> id` still lets a write-back name a status.
    expect(host.state.get('work-statuses:projex')).toMatchObject({ 处理中: 's2', 已完成: 's3' })
  })
  it('answers no labels before the project space is set, so the pickers stay empty', async () => {
    const bare = { ...stored, config: { organizationId: 'org-1', tokenFile: '/tmp/projex-token' } }
    await expect(projexKind.refreshLabels!(hostStub([bare]))).resolves.toEqual({})
  })
})