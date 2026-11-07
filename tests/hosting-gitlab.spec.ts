/** GitLab hosting adapter and hosting HTTP client: mapping semantics, pagination, idempotent notes, CI, token checks, and path whitelisting. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHostingApi, type HostingApi } from '../src/infra/hosting-api.ts'
import type { Commands } from '../src/infra/commands.ts'
import { createGitlabAdapter, gitlabAdapter, mapMr, mapNote, mapPipeline,
  type GitlabJob, type GitlabMr, type GitlabNote } from '../src/sources/hosting/gitlab/adapter.ts'
import { withPlatform } from './fixtures/platform.ts'

const BASE = 'https://gitlab.example.com'
const PROJECT = 'team/app'
const commands = {} as unknown as Commands

const mr = (overrides: Partial<GitlabMr> = {}): GitlabMr => ({ iid: 7, title: 'Add widget', description: 'body', state: 'opened',
  author: { username: 'dev', state: 'active' }, web_url: `${BASE}/${PROJECT}/-/merge_requests/7`,
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  source_branch: 'feature', target_branch: 'main', sha: 'abc1234', ...overrides })

interface Call { method: 'GET' | 'POST'; path: string; body?: unknown }
interface Answer { status?: number; body?: unknown; headers?: Record<string, string> }

/** An injected HostingApi: every request goes to `handler`, and the calls are recorded for assertions. */
function fakeApi(handler: (call: Call) => Answer | Promise<Answer>): { api: HostingApi; calls: Call[] } {
  const calls: Call[] = []
  const answer = async (call: Call) => {
    const result = await handler(call)
    return { status: result.status ?? 200, body: result.body, headers: new Headers(result.headers), baseUrl: BASE }
  }
  return {
    calls,
    api: {
      baseUrl: BASE,
      get: async path => { const call: Call = { method: 'GET', path }; calls.push(call); return answer(call) },
      post: async (path, body) => { const call: Call = { method: 'POST', path, body }; calls.push(call); return answer(call) },
    },
  }
}

describe('mapMr', () => {
  it('normalizes a merge request: iid is the number, source/target branches are head/base, and the project rides on head', () => {
    expect(mapMr(mr(), PROJECT)).toMatchObject({ number: 7, title: 'Add widget', body: 'body', author: 'dev', authorIsBot: false,
      url: `${BASE}/${PROJECT}/-/merge_requests/7`, state: 'open', merged: false,
      head: { ref: 'feature', sha: 'abc1234', project: PROJECT }, base: { ref: 'main' },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' })
    expect(mapMr(mr(), PROJECT)).not.toHaveProperty('draft')
  })

  it('turns merged and closed states into state closed, keeps merged apart, and marks drafts', () => {
    expect(mapMr(mr({ state: 'merged' }), PROJECT)).toMatchObject({ state: 'closed', merged: true })
    expect(mapMr(mr({ state: 'closed', merged_at: '2026-01-03T00:00:00.000Z' }), PROJECT)).toMatchObject({ state: 'closed', merged: true })
    expect(mapMr(mr({ state: 'closed' }), PROJECT)).toMatchObject({ state: 'closed', merged: false })
    expect(mapMr(mr({ state: 'locked' }), PROJECT)).toMatchObject({ state: 'closed', merged: false })
    expect(mapMr(mr({ work_in_progress: true }), PROJECT)).toMatchObject({ draft: true })
  })

  it('marks a bot author from GitLab\'s user state', () => {
    expect(mapMr(mr({ author: { username: 'renovate', state: 'bot' } }), PROJECT).authorIsBot).toBe(true)
  })
})

describe('mapNote', () => {
  it('drops system notes, which are state changes and approvals rather than conversation', () => {
    expect(mapNote({ id: 1, body: 'approved this merge request', system: true })).toBeUndefined()
  })

  it('maps a DiffNote to an inline note with its file path and line, and a plain note to conversation', () => {
    const inline = mapNote({ id: 2, body: 'nit', type: 'DiffNote', author: { username: 'rev', state: 'active' },
      created_at: '2026-01-02T00:00:00.000Z', position: { new_path: 'src/a.ts', new_line: 12 } })
    expect(inline).toMatchObject({ id: '2', body: 'nit', author: 'rev', authorIsBot: false, at: '2026-01-02T00:00:00.000Z',
      kind: 'inline', path: 'src/a.ts', line: 12 })
    expect(mapNote({ id: 3, body: 'looks good', created_at: '' })).toMatchObject({ id: '3', kind: 'conversation' })
    expect(mapNote({ id: 3, body: 'looks good', created_at: '' })).not.toHaveProperty('path')
    expect(mapNote({ id: 4, body: 'x', type: 'DiffNote', position: { old_path: 'old.ts', old_line: 3 } }))
      .toMatchObject({ kind: 'inline', path: 'old.ts', line: 3 })
  })
})

describe('mapPipeline', () => {
  it('maps failed and canceled jobs to conclusion failure, running to in_progress, and success/skipped as finished', () => {
    const jobs: GitlabJob[] = [{ name: 'test', status: 'failed' }, { name: 'lint', status: 'canceled' },
      { name: 'build', status: 'running' }, { name: 'docs', status: 'success' }, { name: 'opt', status: 'skipped' }]
    const snapshot = mapPipeline({ sha: 'deadbeef' }, jobs)
    expect(snapshot).toEqual({ head: 'deadbeef', statuses: [], checks: [
      { name: 'test', status: 'completed', conclusion: 'failure' },
      { name: 'lint', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'in_progress', conclusion: null },
      { name: 'docs', status: 'completed', conclusion: 'success' },
      { name: 'opt', status: 'completed', conclusion: 'skipped' },
    ] })
  })
})

describe('GitLab adapter over an injected client', () => {
  it('lists merge requests and passes the X-Next-Page cursor through, with the watermark in the query', async () => {
    const { api, calls } = fakeApi(call => call.path.includes('/merge_requests?state=all')
      ? { body: [mr(), mr({ iid: 8 })], headers: { 'x-next-page': '2' } }
      : { body: [] })
    const { changes, next } = await createGitlabAdapter(api).listChanges(commands, PROJECT, '2026-01-01T00:00:00.000Z')
    expect(changes.map(change => change.number)).toEqual([7, 8])
    expect(next).toBe('2')
    expect(calls[0]!.path).toBe(`/projects/team%2Fapp/merge_requests?state=all&order_by=updated_at&sort=asc&per_page=100`
      + '&updated_after=2026-01-01T00%3A00%3A00.000Z')
    expect(changes[0]!.head.project).toBe(PROJECT)
  })

  it('reports no next cursor on the last page', async () => {
    const { api } = fakeApi(() => ({ body: [mr()] }))
    expect((await createGitlabAdapter(api).listChanges(commands, PROJECT, '2026-01-01T00:00:00.000Z')).next).toBeUndefined()
  })

  it('reads one merge request by its host-local number', async () => {
    const { api, calls } = fakeApi(() => ({ body: mr() }))
    const change = await createGitlabAdapter(api).readChange(commands, PROJECT, 7)
    expect(change.number).toBe(7)
    expect(calls[0]!.path).toBe('/projects/team%2Fapp/merge_requests/7')
  })

  it('reads notes, dropping system notes and turning DiffNotes into inline notes', async () => {
    const notes: GitlabNote[] = [
      { id: 1, body: 'approved this merge request', system: true },
      { id: 2, body: 'nit', type: 'DiffNote', position: { new_path: 'src/a.ts', new_line: 12 }, created_at: '2026-01-02T00:00:00.000Z' },
      { id: 3, body: 'looks good', created_at: '2026-01-03T00:00:00.000Z' },
      { id: 4, body: 'old', system: true },
    ]
    const { api, calls } = fakeApi(() => ({ body: notes }))
    const page = await createGitlabAdapter(api).readNotes(commands, mapMr(mr(), PROJECT), undefined)
    expect(calls[0]!.path).toBe('/projects/team%2Fapp/merge_requests/7/notes?order_by=updated_at&sort=asc&per_page=100')
    expect(page.notes.map(note => note.id)).toEqual(['2', '3'])
    expect(page.notes[0]).toMatchObject({ kind: 'inline', path: 'src/a.ts', line: 12 })
    expect(page.notes[1]!.kind).toBe('conversation')
  })

  it('filters notes by an ISO watermark cursor and pages with a numeric one', async () => {
    const notes: GitlabNote[] = [{ id: 1, body: 'old', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 2, body: 'new', created_at: '2026-01-05T00:00:00.000Z' }]
    const { api, calls } = fakeApi(() => ({ body: notes }))
    const adapter = createGitlabAdapter(api)
    expect((await adapter.readNotes(commands, mapMr(mr(), PROJECT), '2026-01-03T00:00:00.000Z')).notes.map(note => note.id)).toEqual(['2'])
    await adapter.readNotes(commands, mapMr(mr(), PROJECT), '2')
    expect(calls.at(-1)!.path).toContain('&page=2')
  })

  it('posts a note once: a marker already in the notes returns sent without writing', async () => {
    const marker = '<!-- dsh-superagent:r1 -->'
    const { api, calls } = fakeApi(call => call.method === 'GET'
      ? { body: [{ id: 9, body: `done\n\n${marker}`, created_at: '2026-01-02T00:00:00.000Z' }] }
      : { body: { id: 10 } })
    expect(await createGitlabAdapter(api).postNote(commands, mapMr(mr(), PROJECT), 'done', marker)).toBe('sent')
    expect(calls.some(call => call.method === 'POST')).toBe(false)
  })

  it('posts a note with the marker appended when absent, and maps a deleted thread to gone', async () => {
    const marker = '<!-- dsh-superagent:r2 -->'
    const missed = fakeApi(call => call.method === 'GET' ? { body: [] } : { body: { id: 10 } })
    expect(await createGitlabAdapter(missed.api).postNote(commands, mapMr(mr(), PROJECT), 'done', marker)).toBe('sent')
    const post = missed.calls.find(call => call.method === 'POST')!
    expect(post.path).toBe('/projects/team%2Fapp/merge_requests/7/notes')
    expect(post.body).toEqual({ body: `done\n\n${marker}` })

    const gone = fakeApi(call => call.method === 'GET' ? { body: [] } : { status: 404, body: { message: '404 Not Found' } })
    expect(await createGitlabAdapter(gone.api).postNote(commands, mapMr(mr(), PROJECT), 'done', marker)).toBe('gone')
  })

  it('maps the newest pipeline and its jobs to a CiSnapshot, and returns undefined when there is no pipeline', async () => {
    const { api, calls } = fakeApi(call => {
      if (call.path.includes('/pipelines?ref=')) return { body: [{ id: 5, sha: 'headsha', status: 'failed' }] }
      if (call.path.endsWith('/pipelines/5')) return { body: { id: 5, sha: 'headsha', status: 'failed' } }
      if (call.path.includes('/pipelines/5/jobs')) return { body: [{ name: 'test', status: 'failed' }, { name: 'build', status: 'canceled' }] }
      return { body: [] }
    })
    const adapter = createGitlabAdapter(api)
    const snapshot = await adapter.ci!(commands, mapMr(mr(), PROJECT))
    expect(snapshot).toEqual({ head: 'headsha', statuses: [], checks: [
      { name: 'test', status: 'completed', conclusion: 'failure' },
      { name: 'build', status: 'completed', conclusion: 'failure' },
    ] })
    expect(calls.map(call => call.path)).toEqual([
      '/projects/team%2Fapp/pipelines?ref=feature&per_page=1',
      '/projects/team%2Fapp/pipelines/5',
      '/projects/team%2Fapp/pipelines/5/jobs?per_page=100',
    ])

    const empty = fakeApi(() => ({ body: [] }))
    expect(await createGitlabAdapter(empty.api).ci!(commands, mapMr(mr(), PROJECT))).toBeUndefined()
    expect(empty.calls).toHaveLength(1)
  })

  it('keeps the exported adapter unconfigured until an instance injects a client', async () => {
    await expect(gitlabAdapter.listChanges(commands, PROJECT, '2026-01-01T00:00:00.000Z')).rejects.toThrow('provider not configured')
  })
})

describe('createHostingApi', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'hosting-api-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
  /** A token file with the given mode; the content is deliberately recognizable so a leak is detectable. */
  const tokenFile = (mode = 0o600, content = 'secret-token'): string => {
    const file = join(directory, `token-${Math.random().toString(36).slice(2)}`)
    writeFileSync(file, content)
    chmodSync(file, mode)
    return file
  }
  /** A fetch stand-in that answers with one JSON body and records the calls, so no test touches the network. */
  function fakeFetch(body: unknown = { id: 1 }, status = 200, headers: Record<string, string> = {}) {
    const calls: { url: string; init?: RequestInit }[] = []
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers })
    }) as typeof fetch
    return { fn, calls }
  }

  it('sends the token as PRIVATE-TOKEN, returns the status, parsed body, and headers', async () => {
    const { fn, calls } = fakeFetch({ id: 1 }, 200, { 'x-next-page': '2' })
    const api = createHostingApi({ baseUrl: BASE, tokenFile: tokenFile(), projectWhitelist: [PROJECT], fetchFn: fn })
    const answer = await api.get('/projects/team%2Fapp/merge_requests?per_page=1')
    expect(answer).toMatchObject({ status: 200, body: { id: 1 }, baseUrl: BASE })
    expect(answer.headers.get('x-next-page')).toBe('2')
    expect(calls[0]!.url).toBe(`${BASE}/projects/team%2Fapp/merge_requests?per_page=1`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect((calls[0]!.init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('secret-token')
  })

  it('posts a JSON body', async () => {
    const { fn, calls } = fakeFetch({ id: 3 })
    const api = createHostingApi({ baseUrl: BASE, tokenFile: tokenFile(), projectWhitelist: [PROJECT], fetchFn: fn })
    await api.post('/projects/team%2Fapp/merge_requests/7/notes', { body: 'hi' })
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe('{"body":"hi"}')
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('reads the token file again on every call, so a rotated token needs no restart', async () => {
    const file = tokenFile(0o600, 'first-token')
    const { fn, calls } = fakeFetch()
    const api = createHostingApi({ baseUrl: BASE, tokenFile: file, projectWhitelist: [PROJECT], fetchFn: fn })
    await api.get('/projects/team%2Fapp/merge_requests')
    writeFileSync(file, 'second-token')
    chmodSync(file, 0o600)
    await api.get('/projects/team%2Fapp/merge_requests')
    expect((calls[0]!.init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('first-token')
    expect((calls[1]!.init?.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('second-token')
  })

  it('refuses a token file that is not mode 0600, without echoing the token', async () => {
    const api = createHostingApi({ baseUrl: BASE, tokenFile: tokenFile(0o644), projectWhitelist: [PROJECT], fetchFn: fakeFetch().fn })
    // Windows synthesizes `st.mode` (0o666 for any writable file) and cannot tell 0644 from 0600, so the owner-only rule is
    // judged as the POSIX rule it is; the file's real mode there is 0o666, which is what the stubbed branch refuses.
    const error = await withPlatform('linux', () => api.get('/projects/team%2Fapp/merge_requests')
      .then(() => undefined, (reason: unknown) => reason as Error))
    expect(error?.message).toMatch(/0600/)
    expect(error?.message).not.toContain('secret-token')
  })

  it('requires https except on 127.0.0.1', () => {
    const options = { tokenFile: tokenFile(), projectWhitelist: [PROJECT], fetchFn: fakeFetch().fn }
    expect(() => createHostingApi({ ...options, baseUrl: 'http://gitlab.example.com' })).toThrow(/https/)
    expect(() => createHostingApi({ ...options, baseUrl: 'https://gitlab.example.com/' })).not.toThrow()
    expect(() => createHostingApi({ ...options, baseUrl: 'http://127.0.0.1:8080' })).not.toThrow()
  })

  it('restricts every path to the configured projects and never leaks the token in that error', async () => {
    const api = createHostingApi({ baseUrl: BASE, tokenFile: tokenFile(), projectWhitelist: [PROJECT], fetchFn: fakeFetch().fn })
    for (const path of ['/projects/other%2Fapp/merge_requests', '/projects/team%2Fapp/../../admin', '/merge_requests', '/projects/']) {
      const error = await api.get(path).then(() => undefined, (reason: unknown) => reason as Error)
      expect(error?.message).toMatch(/restricted/)
      expect(error?.message).not.toContain('secret-token')
    }
    // The decoded project name is equally acceptable in the whitelist.
    await expect(api.get('/projects/team%2Fapp/merge_requests')).resolves.toMatchObject({ status: 200 })
  })

  it('rejects a non-JSON body with a status, not a token', async () => {
    const api = createHostingApi({ baseUrl: BASE, tokenFile: tokenFile(), projectWhitelist: [PROJECT], fetchFn: fakeFetch('<html>', 200).fn })
    const error = await api.get('/projects/team%2Fapp/merge_requests').then(() => undefined, (reason: unknown) => reason as Error)
    expect(error?.message).toMatch(/non-JSON body \(HTTP 200\)/)
    expect(error?.message).not.toContain('secret-token')
  })
})