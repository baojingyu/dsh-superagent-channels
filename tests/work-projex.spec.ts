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

interface Recorded { method: 'get' | 'post' | 'put' | 'postForm'; path: string; query?: YunxiaoQuery; body?: unknown; form?: FormData }
type Responder = (call: Recorded) => YunxiaoResult | Promise<YunxiaoResult>
/** A YunxiaoApi stand-in that records every call and answers through `respond`. */
function stubApi(respond: Responder): { api: YunxiaoApi; calls: Recorded[] } {
  const calls: Recorded[] = []
  const api: YunxiaoApi = {
    get: async (path, query) => { const call: Recorded = { method: 'get', path, query }; calls.push(call); return respond(call) },
    post: async (path, body) => { const call: Recorded = { method: 'post', path, body }; calls.push(call); return respond(call) },
    put: async (path, body) => { const call: Recorded = { method: 'put', path, body }; calls.push(call); return respond(call) },
    postForm: async (path, form) => { const call: Recorded = { method: 'postForm', path, form }; calls.push(call); return respond(call) },
  }
  return { api, calls }
}
const ok = (body: unknown): YunxiaoResult => ({ status: 200, body })
const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const workItem: WorkItem = { key: 'AB-12', serial: 'AB-12', category: 'bug', title: 'Login fails', body: '',
  author: { id: 'acc-9' }, status: { id: 's1', name: '处理中' }, url: '', createdAt: '', updatedAt: '' }
/** A work item as `POST workitems:search` returns it (measured against a live organisation, 2026-11-09). */
const rawItem = { id: '8813b032fee93e13ecc69fc6af', serialNumber: 'ESFX-6209', categoryId: 'Bug',
  subject: 'Login fails', description: 'Repro steps',
  status: { id: 's1', name: '处理中', displayName: '处理中' }, statusStageId: 'in_progress',
  gmtCreate: 1730000000000, gmtModified: 1730000100000, finishTime: 1730000200000,
  space: { id: 'proj-1', name: 'Welltivity产研' }, sprint: { id: 'S1', name: '202611' },
  assignedTo: { id: 'acc-001' }, creator: { id: 'acc-777' }, parentId: 'AB-1' }

describe('Projex mapping', () => {
  it('maps identifiers, the status stage, and millisecond timestamps to the normalized work item', () => {
    const item = mapWorkItem(rawItem, 'proj-1')
    // `id` is the handle the API takes; the serial is the name people use, and it is what the web page is addressed by.
    expect(item).toMatchObject({ key: '8813b032fee93e13ecc69fc6af', serial: 'ESFX-6209', category: 'bug',
      title: 'Login fails', body: 'Repro steps', status: { id: 's1', name: '处理中', stage: 'in_progress' },
      parent: 'AB-1', sprint: 'S1',
      createdAt: new Date(1730000000000).toISOString(), updatedAt: new Date(1730000100000).toISOString(),
      doneAt: new Date(1730000200000).toISOString(), url: projexPage('proj-1', 'ESFX-6209') })
    expect(item.author).toEqual({ id: 'acc-777' })
  })
  it('reads a RICHTEXT description as text, because that is how the detail endpoint returns it', () => {
    // The search endpoint answers `description: ''`; the detail endpoint answers a JSON string with `htmlValue`.
    const rich = JSON.stringify({ htmlValue: '<article><p>把贪吃蛇的国内访问网址告诉我</p><p>谢谢</p></article>' })
    const item = mapWorkItem({ ...rawItem, description: rich, formatType: 'RICHTEXT' }, 'proj-1')
    expect(item.body).toBe('把贪吃蛇的国内访问网址告诉我\n谢谢')
    // Plain text and an absent description still behave.
    expect(mapWorkItem({ ...rawItem, description: 'plain words' }, 'proj-1').body).toBe('plain words')
    expect(mapWorkItem({ ...rawItem, description: '' }, 'proj-1').body).toBe('')
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
        at: new Date(1730000000000).toISOString(), updatedAt: new Date(1730000050000).toISOString(), self: false })
  })
  it('converts milliseconds to ISO and tolerates empty or unparsable values', () => {
    expect(isoFromMs(1730000000000)).toBe(new Date(1730000000000).toISOString())
    expect(isoFromMs('')).toBe('')
    expect(isoFromMs('not-a-date')).toBe('')
  })
})

describe('Projex listWorkItems', () => {
  it('posts the search with the project as spaceId and reads the bare array it answers', async () => {
    // `listWorkitems` and `GET workitems` both answer 404; `workitems:search` answers 200 with an array, not an envelope.
    const { api, calls } = stubApi(() => ok([{ id: 'B-1', categoryId: 'Bug' }, { id: 'B-2', categoryId: 'Bug' }]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const page = await adapter.listWorkItems(commands(), 'proj-1', '', ['bug'])
    expect(page.items.map(item => item.key)).toEqual(['B-1', 'B-2'])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'post', path: '/oapi/v1/projex/organizations/org-1/workitems:search',
      body: { category: 'Bug', spaceId: 'proj-1', page: 1, perPage: 100 } })
  })
  it('maps requested categories to Req|Bug|Task and drops categories the host cannot poll', async () => {
    const { api, calls } = stubApi(() => ok([]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    await adapter.listWorkItems(commands(), 'proj-1', '', ['requirement', 'bug', 'task', 'risk'])
    expect(calls.map(call => (call.body as { category: string }).category)).toEqual(['Req', 'Bug', 'Task'])
    expect(calls.every(call => call.path === '/oapi/v1/projex/organizations/org-1/workitems:search')).toBe(true)
  })
  it('sends the modification window in the shape the endpoint accepts, and still filters what comes back', async () => {
    // `conditionGroups` is an array of arrays with the field's class and format; the flatter shape answers 400. The cutoff is
    // kept as a second net, because the server-side window is inclusive of the boundary.
    const { api, calls } = stubApi(() => ok([
      { id: 'new', gmtModified: Date.parse('2026-02-01T00:00:00.000Z') },
      { id: 'old', gmtModified: Date.parse('2026-01-01T00:00:00.000Z') },
    ]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const page = await adapter.listWorkItems(commands(), 'proj-1', '2026-01-15T00:00:00.000Z', ['bug'])
    expect(page.items.map(item => item.key)).toEqual(['new'])
    expect(calls).toHaveLength(1)
    const conditions = JSON.parse(String((calls[0]!.body as Record<string, unknown>).conditions)) as
      { conditionGroups: { fieldIdentifier: string; className: string; format: string }[][] }
    expect(conditions.conditionGroups[0]![0]).toMatchObject({ fieldIdentifier: 'gmtModified', className: 'dateTime',
      format: 'input' })
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
    expect(item.key).toBe('8813b032fee93e13ecc69fc6af')
    expect(item.serial).toBe('ESFX-6209')
    // The API takes either the id or the serial in the item path; the adapter keeps the handle a person used.
    expect(calls[0]!.path).toBe('/oapi/v1/projex/organizations/org-1/workitems/AB-12')
  })
  it('lists comments by page and maps each note, reading RICHTEXT content and the `user` author', async () => {
    const richtext = JSON.stringify({ htmlValue: '<article><p>看看这里</p><p>再试一次</p></article>' })
    const { api, calls } = stubApi(() => ok([{ id: 'c1', content: richtext, user: { id: 'acc-9', name: '郑超' },
      gmtCreate: 1730000000000 }]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const page = await adapter.listNotes(commands(), 'proj-1', 'AB-12', '2')
    expect(calls[0]).toMatchObject({ path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12/comments',
      query: { page: 2, perPage: 100 } })
    // A short page ends the listing; the cursor counts pages, not opaque tokens.
    expect(page).toEqual({ notes: [{ id: 'c1', body: '看看这里\n再试一次', author: { id: 'acc-9', name: '郑超' },
      at: new Date(1730000000000).toISOString(), self: false }] })
  })
  it('does not post when a comment already carries the marker', async () => {
    const marker = '<!-- dsh-superagent:r1 -->'
    const { api, calls } = stubApi(() => ok([{ id: 'c1', content: `done ${marker}` }]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.postNote(commands(), workItem, 'done', marker)).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe('get')
  })
  it('posts the comment with the marker appended when no comment carries it', async () => {
    const marker = '<!-- dsh-superagent:r1 -->'
    const { api, calls } = stubApi(call => call.method === 'post' ? ok({}) : ok([]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.postNote(commands(), workItem, 'done', marker)).toBe('sent')
    expect(calls[1]).toMatchObject({ method: 'post', path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12/comments',
      body: { content: `done\n\n${marker}` } })
  })
  it('reports gone when the item no longer accepts comments', async () => {
    const { api } = stubApi(call => { if (call.method === 'post') throw new YunxiaoHttpError(410, 'item gone'); return ok([]) })
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
  it('writes the status back with a PUT of the status id, the only route and field that exist', async () => {
    // `POST /workitems/{id}/status` answers 404 and `{statusStageId}` is not a field; `PUT` with `{status: <id>}` answers 204.
    const { api, calls } = stubApi(() => ok({}))
    const adapter = createProjexAdapter({ api, organization: 'org-1', writeBack: true })
    await adapter.setStatus!(commands(), workItem, 'status-done')
    expect(calls[0]).toMatchObject({ path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12',
      body: { status: 'status-done' } })
    expect(calls[0]!.method).toBe('put')
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
  it('posts a multipart body without a content-type of its own, leaving the boundary to fetch', async () => {
    const { fetchFn, calls } = captureFetch(200, JSON.stringify({ id: 'f1' }))
    const api = createYunxiaoApi({ tokenFile: tokenFile('tok'), orgWhitelist: ['org-1'], fetchFn })
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'shot.png')
    await api.postForm!(workPath, form)
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
    expect((calls[0]!.init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })
})

describe('Projex project members', () => {
  it('reads the project roster and keeps each userId with its name', async () => {
    const { api, calls } = stubApi(() => ok([{ userId: 'acc-1', userName: 'Lin' }, { userId: 'acc-2', userName: '郑超' }]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.listMembers!(commands(), 'proj-1')).toEqual([{ id: 'acc-1', name: 'Lin' }, { id: 'acc-2', name: '郑超' }])
    expect(calls[0]).toMatchObject({ method: 'get', path: '/oapi/v1/projex/organizations/org-1/projects/proj-1/members',
      query: { page: 1, perPage: 100 } })
  })
  it('follows pages until a short one, and never lists the same member twice', async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ userId: `acc-${index}`, userName: `P${index}` }))
    const pages = [full, [{ userId: 'acc-0', userName: 'Again' }, { userId: 'acc-x', userName: 'New' }]]
    const { api, calls } = stubApi(call => ok(pages[Number((call.query as { page: number }).page) - 1]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const members = await adapter.listMembers!(commands(), 'proj-1')
    expect(members).toHaveLength(101)
    expect(members.at(-1)).toEqual({ id: 'acc-x', name: 'New' })
    expect(calls.map(call => (call.query as { page: number }).page)).toEqual([1, 2])
  })
})

describe('Projex attachments', () => {
  it('uploads one file as multipart and returns the host embeds, linking the permanent address', async () => {
    const { api, calls } = stubApi(call => call.method === 'postForm'
      ? ok({ id: 'f1', name: 'shot.png', embedHtml: '<img src="https://x.test/embed/1" alt="shot"/>',
        embedMarkdown: '![shot](https://x.test/embed/1)', embedUrl: 'https://x.test/embed/1', url: 'https://x.test/tmp/1' })
      : ok({}))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const attachment = await adapter.uploadFile!(commands(), workItem, { name: 'shot.png', data: Buffer.from('png').toString('base64') })
    expect(attachment).toEqual({ name: 'shot.png',
      // The image embed, then a caption link to the permanent address (never the expiring `url`).
      html: '<p><img src="https://x.test/embed/1" alt="shot"/><br/><a href="https://x.test/embed/1">shot.png</a></p>',
      markdown: '![shot](https://x.test/embed/1)' })
    expect(calls[0]).toMatchObject({ method: 'postForm',
      path: '/oapi/v1/projex/organizations/org-1/workitems/AB-12/attachments' })
    expect(calls[0]!.form!.get('file')).toBeInstanceOf(Blob)
  })
  it('falls back to a link for a file the host returns no embed for', async () => {
    const { api } = stubApi(() => ok({ id: 'f2', name: 'report.pdf', url: 'https://x.test/tmp/2' }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.uploadFile!(commands(), workItem, { name: 'report.pdf', data: 'AA==' })).toEqual({
      name: 'report.pdf', html: '<p><a href="https://x.test/tmp/2">report.pdf</a></p>', markdown: '[report.pdf](https://x.test/tmp/2)' })
  })
  it('refuses a host response that carries no link at all', async () => {
    const { api } = stubApi(() => ok({ id: 'f3', name: 'x.bin' }))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    await expect(adapter.uploadFile!(commands(), workItem, { name: 'x.bin', data: 'AA==' }))
      .rejects.toThrow(/no link/)
  })
  it('posts a RICHTEXT comment carrying the attachment HTML, escaped text, and the marker', async () => {
    const { api, calls } = stubApi(call => call.method === 'post' ? ok({ id: 'c1' }) : ok([]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    const marker = '<!-- dsh-superagent:r1 -->'
    await adapter.postNote(commands(), workItem, '看附件 <b>\n\n第二段', marker,
      [{ name: 'shot.png', html: '<img src="u"/>', markdown: '![shot](u)' }])
    const body = calls[1]!.body as { content: string; formatType: string }
    expect(body.formatType).toBe('RICHTEXT')
    expect(body.content).toContain('<p>看附件 &lt;b&gt;</p><p>第二段</p>')
    expect(body.content).toContain('<img src="u"/>')
    expect(body.content).toContain(marker)
  })
  it('detects its own RICHTEXT comment by the marker, so a retry stays one comment', async () => {
    const marker = '<!-- dsh-superagent:r1 -->'
    const { api, calls } = stubApi(() => ok([{ id: 'c1', content: `<p>done</p>${marker}` }]))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.postNote(commands(), workItem, 'done', marker, [])).toBe('sent')
    expect(calls).toHaveLength(1)
  })
})

describe('Projex workflow statuses', () => {
  it('reads each category\'s item types and their workflow statuses, deduplicated', async () => {
    const types = [{ id: 't1', name: '技术需求', categoryId: 'Req', enable: true }, { id: 't2', name: '停用类型', categoryId: 'Req', enable: false }]
    const workflow = { defaultStatusId: 's1', id: 'w1', name: 'flow',
      statuses: [{ id: 's1', name: '待处理', displayName: '待处理' }, { id: 's2', name: '已完成', displayName: '已完成', nameEn: 'Done' }] }
    const { api, calls } = stubApi(call => call.path.endsWith('/workitemTypes') ? ok(types) : ok(workflow))
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.listStatuses!(commands(), 'proj-1', ['requirement']))
      .toEqual([{ id: 's1', name: '待处理' }, { id: 's2', name: '已完成', nameEn: 'Done' }])
    expect(calls[0]).toMatchObject({ method: 'get',
      path: '/oapi/v1/projex/organizations/org-1/projects/proj-1/workitemTypes', query: { category: 'Req' } })
    expect(calls[1]!.path).toBe('/oapi/v1/projex/organizations/org-1/projects/proj-1/workitemTypes/t1/workflows')
    // A disabled type is not asked for a workflow.
    expect(calls.map(call => call.path).filter(path => path.includes('t2'))).toEqual([])
  })
  it('skips a type whose workflow cannot be read, keeping the statuses the others returned', async () => {
    const types = [{ id: 'bad', enable: true }, { id: 'good', enable: true }]
    const { api } = stubApi(call => {
      if (call.path.endsWith('/workitemTypes')) return ok(types)
      if (call.path.includes('/bad/')) throw new YunxiaoHttpError(403, 'no permission')
      return ok({ statuses: [{ id: 's1', name: '待处理' }] })
    })
    const adapter = createProjexAdapter({ api, organization: 'org-1' })
    expect(await adapter.listStatuses!(commands(), 'proj-1', ['bug'])).toEqual([{ id: 's1', name: '待处理' }])
  })
})