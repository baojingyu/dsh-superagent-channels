/**
 * GitLab host adapter: merge requests, their notes, and pipeline CI, normalized to the hosting port's vocabulary.
 * It speaks GitLab's REST API through an injected `HostingApi`, never through the CLI transport, and every mapping is a
 * pure function (`mapMr` / `mapNote` / `mapPipeline`) so the semantics stay unit-tested without a network.
 */
import type { CiSnapshot } from '../../github-read.ts'
import type { HostingApi } from '../../../infra/hosting-api.ts'
import type { ChangeNote, ChangeRequest, HostAdapter } from '../port.ts'

/** Configuration a GitLab hosting instance stores; the adapter gets the project by argument and its client by injection. */
export interface GitlabConfig extends Record<string, unknown> {
  /** Project path (`group/project`) or numeric ID GitLab names the repository by. */
  project: string
  /** File holding the `PRIVATE-TOKEN`, read on every call by the injected client. */
  tokenFile: string
  /** Origin of the GitLab instance, such as `https://gitlab.example.com`. */
  baseUrl: string
  /** Polling interval; the kind's own default applies when absent. */
  pollSeconds?: number
}

/** A merge request as the list and read endpoints return it; only the fields this adapter maps are named. */
export interface GitlabMr {
  iid: number
  title?: string
  description?: string | null
  state?: string
  merged_at?: string | null
  author?: { username?: string; name?: string; state?: string } | null
  web_url?: string
  created_at?: string
  updated_at?: string
  source_branch?: string
  target_branch?: string
  sha?: string
  diff_refs?: { head_sha?: string } | null
  draft?: boolean
  work_in_progress?: boolean
}

/** A merge-request note; `DiffNote` notes carry a diff `position` and are inline comments. */
export interface GitlabNote {
  id: number | string
  body?: string | null
  system?: boolean
  type?: string | null
  author?: { username?: string; name?: string; state?: string } | null
  created_at?: string
  updated_at?: string
  position?: { new_path?: string; old_path?: string; new_line?: number; old_line?: number } | null
}

/** A pipeline as the list and detail endpoints return it. */
export interface GitlabPipeline { id?: number; sha?: string; ref?: string; status?: string }

/** One pipeline job, the unit GitHub calls a check run. */
export interface GitlabJob { id?: number; name?: string; stage?: string; status?: string }

/** GitLab merge request states that mean the change is over; every other state but `opened` is closed too. */
const OPEN = 'opened'

/** Reads a JSON array out of an API body, treating a non-array as empty. */
const asArray = (body: unknown): unknown[] => Array.isArray(body) ? body : []
/** Narrows a JSON value to an object without lying about its shape. */
const asRecord = (body: unknown): Record<string, unknown> => body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}

/**
 * Normalizes a GitLab merge request into a `ChangeRequest`: `iid` is the number, `opened` is the only open state, a
 * merged request is closed and merged, `source_branch`/`target_branch` are head/base, and `author.state === 'bot'`
 * marks a bot. `project` is carried on `head.project` so later calls (notes, CI) can rebuild the project path.
 */
export function mapMr(mr: GitlabMr, project: string): ChangeRequest {
  const merged = mr.state === 'merged' || mr.merged_at != null
  const inline = mr.draft === true || mr.work_in_progress === true
  return {
    number: mr.iid,
    title: mr.title ?? '',
    body: mr.description ?? '',
    author: mr.author?.username ?? '',
    authorIsBot: mr.author?.state === 'bot',
    url: mr.web_url ?? '',
    state: mr.state === OPEN ? 'open' : 'closed',
    merged,
    ...inline ? { draft: true } : {},
    head: { ref: mr.source_branch ?? '', sha: mr.sha ?? mr.diff_refs?.head_sha ?? '', project },
    base: { ref: mr.target_branch ?? '' },
    createdAt: mr.created_at ?? '',
    updatedAt: mr.updated_at ?? '',
  }
}

/**
 * Normalizes one GitLab note into a `ChangeNote`, or drops it: system notes (state changes, approvals, label edits)
 * are not conversation, and a `DiffNote` is an inline comment carrying its file path and line.
 */
export function mapNote(note: GitlabNote): ChangeNote | undefined {
  if (note.system === true) return undefined
  const diff = note.type === 'DiffNote' ? note.position : undefined
  const path = diff?.new_path ?? diff?.old_path
  const line = diff?.new_line ?? diff?.old_line
  return {
    id: String(note.id),
    body: note.body ?? '',
    author: note.author?.username ?? '',
    authorIsBot: note.author?.state === 'bot',
    at: note.created_at ?? '',
    ...note.updated_at ? { updatedAt: note.updated_at } : {},
    kind: diff ? 'inline' : 'conversation',
    ...path ? { path } : {},
    ...line != null ? { line } : {},
  }
}

/** GitLab job states that are over; anything else is still running. */
const FINISHED = new Set(['success', 'failed', 'canceled', 'skipped', 'manual'])
/** GitLab job states that count as a failure in GitHub's vocabulary, which the CI summary and facts already speak. */
const FAILING = new Set(['failed', 'canceled'])

/**
 * Normalizes a pipeline and its jobs into GitHub's `CiSnapshot`, keeping the wording of `ciSummary`/`ciFailures`
 * identical across hosts: `failed`/`canceled` become `conclusion: 'failure'`, and only finished jobs are `completed`.
 */
export function mapPipeline(pipeline: GitlabPipeline, jobs: readonly GitlabJob[]): CiSnapshot {
  return {
    head: pipeline.sha ?? '',
    checks: jobs.map(job => ({ name: job.name ?? '', status: FINISHED.has(job.status ?? '') ? 'completed' : 'in_progress',
      conclusion: job.status === 'success' ? 'success' : job.status === 'skipped' ? 'skipped' : FAILING.has(job.status ?? '') ? 'failure' : null })),
    statuses: [],
  }
}

/** The API path of one merge request; the project is URL-encoded so a `group/project` path stays one segment. */
const mrPath = (project: string, number: number): string => `/projects/${encodeURIComponent(project)}/merge_requests/${number}`

/** The project path earlier calls carried on `head.project`; every later call needs it to rebuild the API path. */
function projectOf(change: ChangeRequest): string {
  const project = change.head.project
  if (!project) throw new Error('Missing GitLab project on the change')
  return project
}

/** A cursor that is all digits names a page; anything else is an ISO watermark filtering notes by update time. */
const pageOf = (cursor: string | undefined): string | undefined => cursor && /^\d+$/.test(cursor) ? cursor : undefined

/**
 * Builds the GitLab adapter over an injected HTTP client: a fake client in tests, and one
 * `createHostingApi({ baseUrl, tokenFile, projectWhitelist: [project] })` per configured instance in production.
 */
export function createGitlabAdapter<C extends Record<string, unknown> = GitlabConfig>(api: HostingApi): HostAdapter<C> {
  /** Reads every page of notes until `visit` returns true; bounded so a host that repeats a page cannot loop forever. */
  const eachNotePage = async (change: ChangeRequest, signal: AbortSignal | undefined, visit: (notes: ChangeNote[]) => boolean): Promise<boolean> => {
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const answer = await api.get(`${mrPath(projectOf(change), change.number)}/notes?order_by=updated_at&sort=asc&per_page=100`
        + (cursor ? `&page=${cursor}` : ''), signal)
      if (answer.status === 404 || answer.status === 410) return false
      if (answer.status >= 400) throw new Error(`GitLab rejected the notes read (HTTP ${answer.status})`)
      const notes = asArray(answer.body).map(item => mapNote(item as GitlabNote))
        .filter((note): note is ChangeNote => note !== undefined)
      if (visit(notes)) return true
      cursor = answer.headers.get('x-next-page') || undefined
      if (!cursor) return false
    }
    return false
  }

  return {
    host: 'gitlab',
    // The browser URL is the instance origin plus the project page; `host.project` is the merge request's project path.
    page: (project, number) => `${api.baseUrl}/${project}/-/merge_requests/${number}`,
    // The HTTP client is injected, so `commands` (the CLI transport) is not used by this host.
    listChanges: async (_commands, project, since, signal) => {
      const answer = await api.get(`/projects/${encodeURIComponent(project)}/merge_requests?state=all&order_by=updated_at&sort=asc&per_page=100`
        + `&updated_after=${encodeURIComponent(since)}`, signal)
      if (answer.status >= 400) throw new Error(`GitLab rejected the merge request list (HTTP ${answer.status})`)
      return { changes: asArray(answer.body).map(item => mapMr(item as GitlabMr, project)),
        ...answer.headers.get('x-next-page') ? { next: answer.headers.get('x-next-page')! } : {} }
    },
    readChange: async (_commands, project, number, signal) => {
      const answer = await api.get(mrPath(project, number), signal)
      if (answer.status === 404) throw new Error(`GitLab has no merge request !${number}`)
      if (answer.status >= 400) throw new Error(`GitLab rejected the merge request read (HTTP ${answer.status})`)
      return mapMr(answer.body as GitlabMr, project)
    },
    readNotes: async (_commands, change, cursor, signal) => {
      const page = pageOf(cursor)
      const since = cursor && !page ? cursor : undefined
      const answer = await api.get(`${mrPath(projectOf(change), change.number)}/notes?order_by=updated_at&sort=asc&per_page=100`
        + (page ? `&page=${page}` : ''), signal)
      if (answer.status === 404 || answer.status === 410) return { notes: [] }
      if (answer.status >= 400) throw new Error(`GitLab rejected the notes read (HTTP ${answer.status})`)
      const notes = asArray(answer.body).map(item => mapNote(item as GitlabNote))
        .filter((note): note is ChangeNote => note !== undefined && (!since || (note.updatedAt ?? note.at) >= since))
      return { notes, ...answer.headers.get('x-next-page') ? { next: answer.headers.get('x-next-page')! } : {} }
    },
    postNote: async (_commands, change, text, marker) => {
      // Idempotency: GitLab has no client key, so the marker is looked for in the notes before posting.
      const already = await eachNotePage(change, undefined, notes => notes.some(note => note.body.includes(marker)))
      if (already) return 'sent'
      const answer = await api.post(`${mrPath(projectOf(change), change.number)}/notes`, { body: `${text}\n\n${marker}` })
      if (answer.status === 404 || answer.status === 410) return 'gone'
      if (answer.status >= 400) throw new Error(`GitLab rejected the note (HTTP ${answer.status})`)
      return 'sent'
    },
    ci: async (_commands, change, signal) => {
      const project = projectOf(change)
      const listed = await api.get(`/projects/${encodeURIComponent(project)}/pipelines?ref=${encodeURIComponent(change.head.ref)}&per_page=1`, signal)
      if (listed.status >= 400) throw new Error(`GitLab rejected the pipeline list (HTTP ${listed.status})`)
      const first = asArray(listed.body)[0]
      if (first === undefined) return undefined
      const id = (first as GitlabPipeline).id
      if (id === undefined) throw new Error('GitLab returned a pipeline without an id')
      const detail = await api.get(`/projects/${encodeURIComponent(project)}/pipelines/${id}`, signal)
      if (detail.status >= 400) throw new Error(`GitLab rejected the pipeline read (HTTP ${detail.status})`)
      const pipeline = { ...first as GitlabPipeline, ...asRecord(detail.body) as GitlabPipeline }
      // A pipeline carries no jobs of its own on GitLab, so the jobs are read separately; a body that already has them is respected.
      const inlineJobs = asRecord(detail.body).jobs
      const jobs = Array.isArray(inlineJobs) ? inlineJobs as GitlabJob[]
        : asArray((await api.get(`/projects/${encodeURIComponent(project)}/pipelines/${id}/jobs?per_page=100`, signal)).body) as GitlabJob[]
      return mapPipeline(pipeline, jobs)
    },
  }
}

/** An unconfigured client: the P0 base never wires GitLab, so the exported adapter reports that instead of reaching the network. */
const unconfigured: HostingApi = {
  baseUrl: '',
  get: async () => { throw new Error('provider not configured') },
  post: async () => { throw new Error('provider not configured') },
}
/** The GitLab adapter before an instance binds its client; the kind factory builds a configured one with `createGitlabAdapter`. */
export const gitlabAdapter: HostAdapter<GitlabConfig> = createGitlabAdapter(unconfigured)