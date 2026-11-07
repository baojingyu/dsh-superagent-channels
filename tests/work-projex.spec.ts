/** Projex adapter and Yunxiao client: injected fake API, mapping, pagination, comment idempotency, and accountID semantics. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { createYunxiaoApi, YunxiaoHttpError, type YunxiaoApi, type YunxiaoQuery, type YunxiaoResult }
  from '../src/infra/yunxiao-api.ts'
import { categoryOf, createProjexAdapter, isoFromMs, mapNote, mapWorkItem, projexAdapter, projexPage }
  from '../src/sources/work/projex/adapter.ts'
import { withPlatform } from './fixtures/platform.ts'
import type { WorkItem } from '../src/sources/work/port.ts'
import { testDeployment } from './fixtures/deployment.ts'

interface Recorded { method: 'get' | 'post'; path: string; query?: YunxiaoQuery; body?: unknown }
type Responder = (call: Recorded) => YunxiaoResult | Promise<YunxiaoResult>
/** A YunxiaoApi stand-in that records every call and answers through `respond`. */
function stubApi(respond: Responder): { api: YunxiaoApi; calls: Recorded[] } {
  const calls: Recorded[] = []
  const api: YunxiaoApi = {
    get: async (path, query) => { const call: Recorded = { method: 'get', path, query }; calls.push(call); return respond(call) },
    post: async (path, body) => { const call: Recorded = { method: 'post', path, body }; calls.push(call); return respond(call) },
  }
  return { api, calls }
}
const ok = (body: unknown): YunxiaoResult => ({ status: 200, body })
const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const workItem: WorkItem = { key: 'AB-12', serial: 'AB-12', category: 'bug', title: 'Login fails', body: '',
  author: { id: 'acc-9' }, status: { id: 's1', name: '处理中' }, url: '', createdAt: '', updatedAt: '' }
const rawItem = { identifier: 'AB-12', serialNumber: 'ABCD-12', subject: 'Login fails', description: 'Repro steps',
  categoryIdentifier: 'Bug', status: '处理中', statusIdentifier: 's1', statusStageIdentifier: 'in_progress',
  gmtCreate: 1730000000000, gmtModified: 1730000100000, finishTime: 1730000200000,
  assignedTo: 'acc-001', creator: 'acc-777', parentIdentifier: 'AB-1', sprintIdentifier: 'S1' }

describe('Projex mapping', () => {
  it('maps identifiers, the status stage, and millisecond timestamps to the normalized work item', () => {
    const item = mapWorkItem(rawItem, 'proj-1')
    expect(item).toMatchObject({ key: 'AB-12', serial: 'ABCD-12', category: 'bug', title: 'Login fails', body: 'Repro steps',
      status: { id: 's1', name: '处理中', stage: 'in_progress' }, parent: 'AB-1', sprint: 'S1',
      createdAt: new Date(1730000000000).toISOString(), updatedAt: new Date(1730000100000).toISOString(),
      doneAt: new Date(1730000200000).toISOString(), url: projexPage('proj-1', 'AB-12') })
    expect(item.author).toEqual({ id: 'acc-777' })
  })
  it('keeps assignedTo as an accountID in assignee.id and never invents a display name', () => {
    expect(mapWorkItem(rawItem, 'proj-1').assignee).toEqual({ id: 'acc-001' })
    expect(mapWorkItem(rawItem, 'proj-1').assignee?.name).toBeUndefined()
    // A host that does return both keeps them separate; the id stays the authority.
    expect(mapWorkItem({ ...rawItem, assignedTo: { id: 'acc-002', name: 'Lin' } }, 'proj-1').assignee)
      .toEqual({ id: 'acc-002', name: 'Lin' })
  })
  it.each([
    ['Req', 'requirement'], ['Bug', 'bug'], ['Task', 'task'], ['Risk', 'risk'], ['Topic', 'topic'],
    ['Request', 'request'], ['requirement', 'requirement'], ['unknown', 'task'],
  ] as const)('maps categoryIdentifier %s to %s', (raw, category) => {
    expect(categoryOf(raw)).toBe(category)
  })
  it('maps a comment with its author accountID and timestamps', () => {
    expect(mapNote({ id: 'c1', content: 'looks good', creator: 'acc-9', gmtCreate: 1730000000000, gmtModified: 1730000050000 }))
      .toEqual({ id: 'c1', body: 'looks good', author: { id: 'acc-9' },
        at: new Date(1730000000000).toISOString(), updatedAt: new Date(1730000050000).toISOString() })
  })
  it('converts milliseconds to ISO and tolerates empty or unparsable values', () => {
    expect(isoFromMs(1730000000000)).toBe(new Date(1730000000000).toISOString())
    expect(isoFromMs('')).toBe('')
    expect(isoFromMs('not-a-date')).toBe('')
  })
})

describe('Projex listWorkItems', () => {
  it('follows nextToken and passes it back to the next page of the same category', async () => {
    const { api, calls } = stubApi(call => call.query?.nextToken === 'n1'
      ? ok({ workitems: [{ identifier: 'B-2', categoryIdentifier: 'Bug' }] })
      : ok({ workitems: [{ identifier: 'B-1', categoryIdentifier: 'Bug' }], nextToken: 'n1' }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const page = await adapter.listWorkItems(commands(), 'proj-1', '', ['bug'])
    expect(page.items.map(item => item.key)).toEqual(['B-1', 'B-2'])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ method: 'get', path: '/oapi/v1/projex/organizations/org-1/listWorkitems',
      query: { spaceType: 'Project', spaceIdentifier: 'proj-1', category: 'Bug', maxResults: 100 } })
    expect(calls[0]!.query?.nextToken).toBeUndefined()
    expect(calls[1]!.query?.nextToken).toBe('n1')
  })
  it('maps requested categories to Req|Bug|Task and drops categories the host cannot poll', async () => {
    const { api, calls } = stubApi(() => ok({ workitems: [] }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    await adapter.listWorkItems(commands(), 'proj-1', '', ['requirement', 'bug', 'task', 'risk'])
    expect(calls.map(call => call.query?.category)).toEqual(['Req', 'Bug', 'Task'])
    expect(calls.every(call => call.path === '/oapi/v1/projex/organizations/org-1/listWorkitems')).toBe(true)
  })
  it('adds the gmtModified conditions when a watermark is given, and makes no call with no categories', async () => {
    const { api, calls } = stubApi(() => ok({ workitems: [] }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    await adapter.listWorkItems(commands(), 'proj-1', '2026-01-01T00:00:00.000Z', ['bug'])
    expect(String(calls[0]!.query?.conditions)).toContain('gmtModified')
    const before = calls.length
    expect(await adapter.listWorkItems(commands(), 'proj-1', '', [])).toEqual({ items: [] })
    expect(calls).toHaveLength(before)
  })
})

describe('Projex reads and comments', () => {
  it('reads one work item through the item path and unwraps the result envelope', async () => {
    const { api, calls } = stubApi(() => ok({ result: rawItem }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const item = await adapter.readWorkItem(commands(), 'proj-1', 'AB-12')
    expect(item.key).toBe('AB-12')
    expect(item.serial).toBe('ABCD-12')
    expect(calls[0]!.path).toBe('/oapi/v1/projex/organizations/org-1/workitems/AB-12')
  })
  it('lists comments with the cursor as nextToken and maps each note', async () => {
    const { api, calls } = stubApi(() => ok({ comments: [{ id: 'c1', content: 'hi', creator: 'acc-9', gmtCreate: 1730000000000 }], nextToken: 'c2' }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const page = await adapter.listNotes(commands(), 'proj-1', 'AB-12', 'c1')
    expect(calls[0]).toMatchObject({ path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12/comments',
      query: { maxResults: 100, nextToken: 'c1' } })
    expect(page).toEqual({ notes: [{ id: 'c1', body: 'hi', author: { id: 'acc-9' }, at: new Date(1730000000000).toISOString() }], next: 'c2' })
  })
  it('does not post when a comment already carries the marker', async () => {
    const marker = '<!-- dsh-superagent:r1 -->'
    const { api, calls } = stubApi(() => ok({ comments: [{ id: 'c1', content: `done ${marker}` }] }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.postNote(commands(), workItem, 'done', marker)).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('get')
  })
  it('posts the comment with the marker appended when no comment carries it', async () => {
    const marker = '<!-- dsh-superagent:r1 -->'
    const { api, calls } = stubApi(call => call.method === 'post' ? ok({}) : ok({ comments: [] }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.postNote(commands(), workItem, 'done', marker)).toBe('sent')
    expect(calls[1]).toMatchObject({ method: 'post', path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12/comments',
      body: { content: `done\n\n${marker}` } })
  })
  it('reports gone when the item no longer accepts comments', async () => {
    const { api } = stubApi(call => { if (call.method === 'post') throw new YunxiaoHttpError(410, 'item gone'); return ok({ comments: [] }) })
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.postNote(commands(), workItem, 'done', '<!-- dsh-superagent:r1 -->')).toBe('gone')
  })
})

describe('Projex status write-back', () => {
  it('omits setStatus by default so the adapter stays read-only', () => {
    const adapter = createProjexAdapter({ api: stubApi(() => ok({})).api, organization: 'org-1' })
    expect(adapter.setStatus).toBeUndefined()
    expect(projexAdapter.host).toBe('projex')
  })
  it('posts the status stage when write-back is enabled', async () => {
    const { api, calls } = stubApi(() => ok({}))
    const adapter = createProjexAdapter({ api, organization: 'org-1', writeBack: true })
    await adapter.setStatus!(commands(), workItem, 'done')
    expect(calls[0]).toMatchObject({ method: 'post', path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12/status',
      body: { statusStageIdentifier: 'done' } })
  })
})

describe('Yunxiao client', () => {
  const dirs: string[] = []
  afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })
  /** Writes a token file with the mode the client requires. */
  function tokenFile(content: string, mode = 0o600): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-yunxiao-'))
    dirs.push(dir)
    const file = join(dir, 'token')
    writeFileSync(file, content)
    chmodSync(file, mode)
    return file
  }
  interface FetchCall { url: string; init: RequestInit }
  /** A fetch stand-in answering with one fixed status and text while recording each call. */
  function captureFetch(status: number, text: string): { fetchFn: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init: init ?? {} })
      return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response
    }) as typeof fetch
    return { fetchFn, calls }
  }
  const workPath = '/oapi/v1/projex/organizations/org-1/workitems/AB-12'

  it('sends the token from the file in x-yunxiao-token against the default base URL', async () => {
    const { fetchFn, calls } = captureFetch(200, JSON.stringify({ result: { ok: true } }))
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok-123'), orgWhitelist: ['org-1'], fetchFn })
    await expect(api.get(workPath)).resolves.toEqual({ status: 200, body: { result: { ok: true } } })
    expect(calls[0]!.url).toBe(`https://openapi-rdc.aliyuncs.com${workPath}`)
    expect(calls[0]!.init.headers).toMatchObject({ 'x-yunxiao-token': 'tok-123' })
  })
  it('reads the token file again on every request', async () => {
    const file = tokenFile('tok-a')
    const { fetchFn, calls } = captureFetch(200, '')
    const api = createYunxiaoApi({ tokenFile: file, orgWhitelist: ['org-1'], fetchFn })
    await api.get(workPath)
    writeFileSync(file, 'tok-b')
    await api.get(workPath)
    expect((calls[0]!.init.headers as Record<string, string>)['x-yunxiao-token']).toBe('tok-a')
    expect((calls[1]!.init.headers as Record<string, string>)['x-yunxiao-token']).toBe('tok-b')
  })
  it('refuses a token file whose mode is not 0600', async () => {
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok', 0o644), orgWhitelist: ['org-1'], fetchFn: captureFetch(200, '').fetchFn })
    // Windows synthesizes `st.mode` (0o666 for any writable file) and cannot tell 0644 from 0600, so the owner-only rule is
    // judged as the POSIX rule it is; the file's real mode there is 0o666, which is what the stubbed branch refuses.
    await withPlatform('linux', () => expect(api.get(workPath)).rejects.toThrow(/0600/))
  })
  it('confines paths to /oapi/v1/ and organizations to the whitelist', async () => {
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn: captureFetch(200, '').fetchFn })
    await expect(api.get('/v1/nope')).rejects.toThrow(/\/oapi\/v1\//)
    await expect(api.get('/oapi/v1/projex/organizations/org-2/workitems/1')).rejects.toThrow(/not allowed/)
  })
  it('refuses a plain or percent-encoded dot-segment escape of the organization whitelist before any request', async () => {
    const { fetchFn, calls } = captureFetch(200, '')
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn })
    await expect(api.get('/oapi/v1/projex/organizations/org-1/../org-2/workitems/1')).rejects.toThrow(/restricted/)
    await expect(api.get('/oapi/v1/projex/organizations/org-1/%2e%2e/org-2/workitems/1')).rejects.toThrow(/restricted/)
    await expect(api.get('/oapi/v1/projex/organizations/org-1/%2E%2E/org-2/workitems/1')).rejects.toThrow(/restricted/)
    expect(calls).toHaveLength(0)
  })
  it('requires an https base URL, admitting loopback http only', () => {
    const ok = { tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn: captureFetch(200, '').fetchFn }
    expect(() => createYunxiaoApi({ ...ok, baseUrl: 'http://api.example.com' })).toThrow(/https/)
    expect(() => createYunxiaoApi({ ...ok, baseUrl: 'http://127.0.0.1:8080' })).not.toThrow()
    expect(() => createYunxiaoApi({ ...ok, baseUrl: 'https://api.example.com' })).not.toThrow()
  })
  it('bounds every request with an abort timeout', async () => {
    const { fetchFn, calls } = captureFetch(200, '{}')
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn })
    await api.get(workPath)
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal)
  })
  it('honours its timeoutMs by aborting a hung request', async () => {
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })) as typeof fetch
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn, timeoutMs: 5 })
    await expect(api.get(workPath)).rejects.toThrow(/Yunxiao request failed/)
  })
  it('never lets the token appear in an error message', async () => {
    const api = createYunxiaoApi({ tokenFile: tokenFile('super-secret-token'), orgWhitelist: ['org-1'],
      fetchFn: captureFetch(400, 'bad super-secret-token').fetchFn })
    await expect(api.get(workPath)).rejects.toThrow(/HTTP 400/)
    try {
      await api.get(workPath)
      throw new Error('expected a rejection')
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-token')
      expect(String(error)).toContain('[redacted]')
    }
  })
  it('posts JSON bodies', async () => {
    const { fetchFn, calls } = captureFetch(200, '{}')
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn })
    await api.post(workPath, { content: 'hi' })
    expect(calls[0]!.init).toMatchObject({ method: 'POST', body: '{"content":"hi"}',
      headers: { 'x-yunxiao-token': 'tok', 'content-type': 'application/json' } })
  })
})