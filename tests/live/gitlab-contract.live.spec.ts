/**
 * Live read-only contract check of the GitLab adapter against gitlab.com's public API.
 * Only `LIVE=1` runs it: the default suite skips it so no test depends on the network.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Commands } from '../../src/infra/commands.ts'
import { createHostingApi } from '../../src/infra/hosting-api.ts'
import { createGitlabAdapter, mapMr, mapNote, type GitlabMr, type GitlabNote } from '../../src/sources/hosting/gitlab/adapter.ts'

const LIVE = process.env.LIVE === '1'
const ORIGIN = 'https://gitlab.com'
const API = `${ORIGIN}/api/v4`
/** A public project whose merge requests are readable anonymously; never a private repository. */
const PROJECT = 'gitlab-org/cli'
/** Every external request gets the same 15 s budget, and one run makes at most four of them. */
const TIMEOUT_MS = 15_000
const commands = {} as unknown as Commands
/** The merge request number read first, reused so the note read needs no second list call. */
let iid: number | undefined

interface Answer { status: number; body: unknown }

/** Skips a test with a reason that is printed, so a service limitation never looks like a pass. */
function stop(skip: (note?: string) => void, reason: string): void {
  console.warn(`[live] skipped: ${reason}`)
  skip(reason)
}

/** One anonymous GET with the shared timeout; a network failure or a throttled answer skips the test with a stated reason. */
async function read(path: string, skip: (note?: string) => void): Promise<Answer | undefined> {
  let response: Response
  try {
    response = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    stop(skip, `gitlab.com unreachable: ${String(error)}`)
    return undefined
  }
  const text = await response.text()
  if (response.status === 429 || response.status >= 500) {
    stop(skip, `gitlab.com answered HTTP ${response.status}`)
    return undefined
  }
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null }
}

describe.skipIf(!LIVE)('GitLab live contract (read-only)', () => {
  it('maps a real merge request list through mapMr', async ({ skip }) => {
    const answer = await read(`/projects/${encodeURIComponent(PROJECT)}/merge_requests?per_page=2&state=all`, skip)
    if (!answer) return
    expect(answer.status).toBe(200)
    expect(Array.isArray(answer.body)).toBe(true)
    const list = answer.body as GitlabMr[]
    expect(list.length).toBeGreaterThan(0)
    for (const raw of list) {
      const change = mapMr(raw, PROJECT)
      expect(change.number).toBe(raw.iid)
      expect(change.number).toBeGreaterThan(0)
      expect(['open', 'closed']).toContain(change.state)
      expect(change.head.ref.length).toBeGreaterThan(0)
      expect(change.author.length).toBeGreaterThan(0)
      expect(change.url.startsWith(ORIGIN)).toBe(true)
    }
    iid = list[0]!.iid
  }, 30_000)

  it('maps real notes, treating an empty list as a valid answer', async ({ skip }) => {
    const number = iid ?? 1
    const answer = await read(`/projects/${encodeURIComponent(PROJECT)}/merge_requests/${number}/notes`
      + '?per_page=2&order_by=updated_at&sort=desc', skip)
    if (!answer) return
    // gitlab.com answers 401 for anonymous note reads (a service policy); the anonymous contract covers the change list.
    if (answer.status === 401) {
      stop(skip, 'gitlab.com requires authentication for merge request notes (HTTP 401); the anonymous contract covers the change list')
      return
    }
    expect(answer.status).toBe(200)
    const notes = Array.isArray(answer.body) ? answer.body as GitlabNote[] : []
    const mapped = notes.map(note => mapNote(note)).filter((note): note is NonNullable<typeof note> => note !== undefined)
    expect(Array.isArray(mapped)).toBe(true)
    if (notes.length === 0) expect(mapped).toEqual([])
    for (const note of mapped) {
      expect(note.id.length).toBeGreaterThan(0)
      expect(note.author.length).toBeGreaterThan(0)
      expect(note.at.length).toBeGreaterThan(0)
      expect(['conversation', 'inline', 'review']).toContain(note.kind)
    }
  }, 30_000)

  it('maps a bogus token to HTTP 401 without echoing the token', async ({ skip }) => {
    const directory = mkdtempSync(join(tmpdir(), 'gitlab-live-'))
    const tokenFile = join(directory, 'token')
    writeFileSync(tokenFile, 'glpat-bogus')
    chmodSync(tokenFile, 0o600)
    try {
      const api = createHostingApi({ baseUrl: API, tokenFile, projectWhitelist: [PROJECT] })
      let answer: Answer | undefined
      try { answer = await api.get(`/projects/${encodeURIComponent(PROJECT)}`) }
      catch (error) { skip(`gitlab.com unreachable: ${String(error)}`); return }
      expect(answer!.status).toBe(401)
      expect(JSON.stringify(answer!.body)).not.toContain('glpat-bogus')
      // The adapter turns a non-2xx answer into a thrown Error naming the status; the token never appears in it.
      const failure = await createGitlabAdapter(api).readChange(commands, PROJECT, 1)
        .then(() => undefined, (error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure!.message).toMatch(/HTTP 401/)
      expect(failure!.message).not.toContain('glpat-bogus')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }, 30_000)
})
