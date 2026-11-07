/** Aliyun Yunxiao Projex work adapter: list/read work items, list/post comments, and optional status write-back. */
import { createYunxiaoApi, YunxiaoHttpError, type YunxiaoApi } from '../../../infra/yunxiao-api.ts'
import type { Commands } from '../../../infra/commands.ts'
import type { Person, WorkAdapter, WorkCategory, WorkItem, WorkItemPage, WorkNote, WorkNotePage } from '../port.ts'

/** Configuration a Projex instance supplies beyond the shared work schema. */
export interface ProjexConfig extends Record<string, unknown> {
  /** Aliyun organization ID that scopes every path (the accountID-level ID, never a display name). */
  organization: string
  /** File holding the access token; read on every request and required to be mode 0600. */
  tokenFile: string
  /** Project-space ID used when a caller names none; also the page-link segment. */
  project?: string
  categories?: readonly string[]
  /** Status write-back; off by default, which leaves the adapter read-only. */
  writeBack?: boolean
}

/** How a Projex adapter is bound: an injected client (tests), or the pieces to build one. */
export interface ProjexAdapterOptions {
  /** Injected OpenAPI client; when omitted it is built from `tokenFile`, `organization`, and `baseUrl`. */
  api?: YunxiaoApi
  organization?: string
  tokenFile?: string
  baseUrl?: string
  /** Status write-back; when off, `setStatus` is absent so callers never write state. */
  writeBack?: boolean
  /** Page size requested from Yunxiao. */
  maxResults?: number
}

/** The Projex adapter with its bound client and organization exposed, so a work kind (or a test) can swap them. */
export interface ProjexAdapter extends WorkAdapter<ProjexConfig> {
  /** OpenAPI client every method reads through; replace it to inject a fake in tests. */
  api: YunxiaoApi
  /** Organization ID that scopes every path. */
  organization: string
  /** Whether `setStatus` is enabled. */
  writeBack: boolean
}

const DEFAULT_MAX_RESULTS = 100
/** Safety cap on pages consumed per category per poll; see the `SearchWorkitems` window TODO in `listWorkItems`. */
const MAX_PAGES = 10
/** Work category to the API's `category` code; categories without a code (risk/topic/request) are not polled. */
const API_CATEGORY: Readonly<Record<string, string>> = { requirement: 'Req', bug: 'Bug', task: 'Task' }

/**
 * Builds a Projex adapter. A work kind binds one per instance from the instance configuration; tests pass an
 * injected `api`. The default export below is the unbound template used for static checks and scaffolding.
 */
export function createProjexAdapter(options: ProjexAdapterOptions = {}): ProjexAdapter {
  const organization = options.organization ?? ''
  const adapter: ProjexAdapter = {
    host: 'projex',
    organization,
    writeBack: options.writeBack ?? false,
    api: options.api ?? (options.tokenFile
      ? createYunxiaoApi({ ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        tokenFile: options.tokenFile, orgWhitelist: organization ? [organization] : [] })
      : unconfiguredApi()),
    listWorkItems: (_commands, project, since, categories) => listWorkItems(adapter, project, since, categories),
    readWorkItem: (_commands, project, key) => readWorkItem(adapter, project, key),
    listNotes: (_commands, project, key, cursor) => listNotes(adapter, project, key, cursor),
    postNote: (_commands, item, text, marker) => postNote(adapter, item, text, marker),
    page: (project, key) => projexPage(project, key),
  }
  // Leaving `setStatus` absent keeps the default read-only: callers cannot write back without opting in.
  if (adapter.writeBack) adapter.setStatus = (_commands, item, stage) => writeStatus(adapter, item, stage)
  return adapter
}

/** Unbound Projex adapter template; a work kind binds the real one per instance with `createProjexAdapter`. */
export const projexAdapter: ProjexAdapter = createProjexAdapter()

/** Client of the unbound template: refuses every call until a work kind binds a real client and organization. */
function unconfiguredApi(): YunxiaoApi {
  const fail = async (): Promise<never> => { throw new Error('Projex adapter is not configured: pass an api or a tokenFile') }
  return { get: fail, post: fail }
}

/** Web page of one Projex work item. */
export function projexPage(project: string, key: string): string {
  return `https://devops.aliyun.com/projex/project/${encodeURIComponent(project)}/workitem/${encodeURIComponent(key)}`
}

/** Maps a host `categoryIdentifier` to a work category; unknown identifiers fall back to `task`. */
export function categoryOf(value: unknown): WorkCategory {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'req':
    case 'requirement': return 'requirement'
    case 'bug': return 'bug'
    case 'task': return 'task'
    case 'risk': return 'risk'
    case 'topic': return 'topic'
    case 'request': return 'request'
    default: return 'task'
  }
}

/**
 * Maps one raw Yunxiao work item to the normalized shape. `assignedTo` is an Aliyun accountID, not a nickname:
 * it becomes `assignee.id` and never `assignee.name`, so callers must never compare it to a display name.
 */
export function mapWorkItem(raw: Record<string, unknown>, project: string): WorkItem {
  const key = String(raw.identifier ?? raw.id ?? '')
  const assignee = personOf(raw.assignedTo)
  const stage = raw.statusStageIdentifier
  const updatedAt = raw.gmtModified ?? raw.updatedAt
  return {
    key,
    serial: String(raw.serialNumber ?? key),
    category: categoryOf(raw.categoryIdentifier),
    title: String(raw.subject ?? raw.title ?? ''),
    body: String(raw.description ?? ''),
    author: personOf(raw.creator ?? raw.author) ?? { id: '' },
    ...(assignee ? { assignee } : {}),
    status: { id: String(raw.statusIdentifier ?? ''), name: String(raw.status ?? raw.statusName ?? ''),
      ...(typeof stage === 'string' && stage ? { stage } : {}) },
    url: projexPage(project, key),
    createdAt: isoFromMs(raw.gmtCreate ?? raw.createdAt),
    updatedAt: isoFromMs(updatedAt),
    ...(raw.parentIdentifier ? { parent: String(raw.parentIdentifier) } : {}),
    ...(raw.sprintIdentifier ? { sprint: String(raw.sprintIdentifier) } : {}),
    ...(raw.finishTime ? { doneAt: isoFromMs(raw.finishTime) } : {}),
  }
}

/** Maps one raw Yunxiao comment to a WorkNote. */
export function mapNote(raw: Record<string, unknown>): WorkNote {
  const updatedAt = raw.gmtModified ?? raw.updatedAt
  return {
    id: String(raw.id ?? raw.commentId ?? ''),
    body: String(raw.content ?? raw.body ?? ''),
    author: personOf(raw.creator ?? raw.author) ?? { id: '' },
    at: isoFromMs(raw.gmtCreate ?? raw.createdAt),
    ...(updatedAt ? { updatedAt: isoFromMs(updatedAt) } : {}),
  }
}

/** Converts a millisecond epoch (or an ISO/date string) to an ISO timestamp; unparsable values become `''`. */
export function isoFromMs(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  const ms = typeof value === 'number' ? value : /^\d+$/.test(String(value)) ? Number(value) : Date.parse(String(value))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : ''
}

/** Reads an accountID (or an object carrying one) as a Person, with no name invented for a bare accountID. */
function personOf(value: unknown): Person | undefined {
  if (typeof value === 'string') return value ? { id: value } : undefined
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const id = record.id ?? record.accountId ?? record.identifier
    if (!id) return undefined
    const name = record.name ?? record.displayName
    return { id: String(id), ...(typeof name === 'string' && name ? { name } : {}) }
  }
  return undefined
}

/** Lists items of every requested category, following `nextToken` page by page within the safety cap. */
async function listWorkItems(adapter: ProjexAdapter, project: string, since: string, categories: readonly string[]): Promise<WorkItemPage> {
  const codes = apiCategories(categories)
  if (codes.length === 0) return { items: [] }
  const items: WorkItem[] = []
  // TODO: SearchWorkitems caps page*perPage at 10000 (perPage=200 allows 50 pages). Split the time window per
  // category before the window is exhausted; the current loop only follows nextToken with a safety cap.
  for (const category of codes) {
    let nextToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query: Record<string, string | number> = { spaceType: 'Project', spaceIdentifier: project, category,
        maxResults: DEFAULT_MAX_RESULTS }
      if (nextToken) query.nextToken = nextToken
      if (since) query.conditions = conditionsOf(since)
      const { body } = await adapter.api.get(listPath(adapter.organization), query)
      const result = pageOf(body, 'workitems')
      items.push(...result.values.map(raw => mapWorkItem(raw, project)))
      nextToken = result.next
      if (!nextToken) break
    }
  }
  return { items }
}

async function readWorkItem(adapter: ProjexAdapter, project: string, key: string): Promise<WorkItem> {
  const { body } = await adapter.api.get(itemPath(adapter.organization, key))
  return mapWorkItem(recordOf(body), project)
}

async function listNotes(adapter: ProjexAdapter, project: string, key: string, cursor: string | undefined): Promise<WorkNotePage> {
  const query: Record<string, string | number> = { maxResults: DEFAULT_MAX_RESULTS }
  if (cursor) query.nextToken = cursor
  const { body } = await adapter.api.get(commentsPath(adapter.organization, key), query)
  const result = pageOf(body, 'comments')
  return { notes: result.values.map(mapNote), ...(result.next ? { next: result.next } : {}) }
}

/** Posts a comment unless one already carries `marker`; returns `'gone'` when the item no longer accepts comments. */
async function postNote(adapter: ProjexAdapter, item: WorkItem, text: string, marker: string): Promise<'sent' | 'gone'> {
  const existing = await adapter.api.get(commentsPath(adapter.organization, item.key), { maxResults: DEFAULT_MAX_RESULTS })
  const mine = pageOf(existing.body, 'comments').values.some(comment => String(comment.content ?? comment.body ?? '').includes(marker))
  if (mine) return 'sent'
  try {
    await adapter.api.post(commentsPath(adapter.organization, item.key), { content: `${text}\n\n${marker}` })
    return 'sent'
  } catch (error) {
    if (error instanceof YunxiaoHttpError && (error.status === 404 || error.status === 410)) return 'gone'
    throw error
  }
}

async function writeStatus(adapter: ProjexAdapter, item: WorkItem, stage: string): Promise<void> {
  await adapter.api.post(statusPath(adapter.organization, item.key), { statusStageIdentifier: stage })
}

/** The API codes of the requested categories, deduplicated and preserving request order. */
function apiCategories(categories: readonly string[]): string[] {
  const codes = categories.flatMap(category => {
    const code = API_CATEGORY[categoryOf(category)]
    return code ? [code] : []
  })
  return [...new Set(codes)]
}

/** Conditions filter on `gmtModified`, because the host has no updated-after parameter. */
function conditionsOf(since: string): string {
  return JSON.stringify({ conditionGroups: [{ conditions: [{ fieldIdentifier: 'gmtModified', operator: 'MORE_THAN', value: [since] }] }] })
}

const orgPath = (organization: string): string => `/oapi/v1/projex/organizations/${encodeURIComponent(organization)}`
const listPath = (organization: string): string => `${orgPath(organization)}/listWorkitems`
const itemPath = (organization: string, key: string): string => `${orgPath(organization)}/workitems/${encodeURIComponent(key)}`
const commentsPath = (organization: string, key: string): string => `${itemPath(organization, key)}/comments`
const statusPath = (organization: string, key: string): string => `${itemPath(organization, key)}/status`

/** Unwraps a `{ result: … }` envelope when present. */
function recordOf(body: any): Record<string, unknown> {
  const root = body && typeof body === 'object' && 'result' in body ? body.result : body
  return root && typeof root === 'object' ? root as Record<string, unknown> : {}
}

/** Reads one named array (`workitems`/`comments`) and its `nextToken` from a response body. */
function pageOf(body: any, key: string): { values: Record<string, unknown>[]; next?: string } {
  const root = recordOf(body)
  const listed = root[key]
  const values = Array.isArray(listed) ? listed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : []
  const next = root.nextToken ?? root.next
  return { values, ...(typeof next === 'string' && next ? { next } : {}) }
}