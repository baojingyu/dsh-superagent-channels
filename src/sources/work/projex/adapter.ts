/** Aliyun Yunxiao Projex work adapter: list/read work items, list/post comments, and optional status write-back. */
import { createYunxiaoApi, YunxiaoHttpError, type YunxiaoApi } from '../../../infra/yunxiao-api.ts'
import type { Commands } from '../../../infra/commands.ts'
import type { Person, WorkAdapter, WorkCategory, WorkItem, WorkItemPage, WorkNote, WorkNotePage } from '../port.ts'
import { imageRefs } from '../images.ts'
import type { WorkImageFile, WorkImageRef } from '../images.ts'
import { isSelfWrite, rememberSelfWrite } from '../self-writes.ts'

/** The host this adapter speaks for; the self-write ledger is scoped by it so two hosts never collide on one key. */
export const PROJEX_HOST = 'projex'

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

/**
 * Items per page. The search endpoint takes `perPage` up to 200 and ignores `maxResults`, so a poll reads whole pages.
 */
const PAGE_SIZE = 100
/** Safety cap on pages consumed per category per poll: 5 × 100 items is a week of a busy project. */
const MAX_PAGES = 5
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
    readImageFile: (_commands, _project, key, image, signal) => readImageFile(adapter, key, image, signal),
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
  return { get: fail, post: fail, put: fail }
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
export function mapWorkItem(raw: Record<string, unknown>, project: string, requested?: string): WorkItem {
  // `id` is the stable handle the API uses; `serialNumber` (`ESFX-6209`) is what people and the web page name. The search
  // response carries no `identifier`, and its `status` is an object rather than a string.
  const key = String(raw.id ?? raw.identifier ?? '')
  const serial = String(raw.serialNumber ?? key)
  const status = raw.status && typeof raw.status === 'object' ? raw.status as Record<string, unknown> : {}
  const stage = raw.statusStageId ?? raw.statusStageIdentifier
  const updatedAt = raw.gmtModified ?? raw.updatedAt
  const space = raw.space && typeof raw.space === 'object' ? raw.space as Record<string, unknown> : {}
  const sprint = raw.sprint && typeof raw.sprint === 'object' ? raw.sprint as Record<string, unknown> : {}
  const assignee = personOf(raw.assignedTo)
  return {
    key,
    serial,
    category: categoryOf(raw.categoryId ?? raw.categoryIdentifier ?? requested),
    title: String(raw.subject ?? raw.title ?? ''),
    body: workBody(raw),
    ...imagesOf(raw.description ?? raw.body),
    author: personOf(raw.creator ?? raw.author) ?? { id: '' },
    ...(assignee ? { assignee } : {}),
    status: { id: String(status.id ?? raw.statusIdentifier ?? ''),
      name: String(status.displayName ?? status.name ?? raw.statusName ?? ''),
      ...(typeof stage === 'string' && stage ? { stage } : {}) },
    url: projexPage(String(space.id ?? project), serial),
    createdAt: isoFromMs(raw.gmtCreate ?? raw.createdAt),
    updatedAt: isoFromMs(updatedAt),
    ...(raw.parentId ?? raw.parentIdentifier ? { parent: String(raw.parentId ?? raw.parentIdentifier) } : {}),
    ...(sprint.id ?? raw.sprintIdentifier ? { sprint: String(sprint.id ?? raw.sprintIdentifier) } : {}),
    ...(raw.finishTime ? { doneAt: isoFromMs(raw.finishTime) } : {}),
  }
}

/**
 * A work item's body. The detail endpoint returns `description` as a RICHTEXT JSON string carrying `htmlValue` - the same shape a
 * comment has - and the list endpoint returns it empty, so both forms have to be handled here.
 */
export function workBody(raw: Record<string, unknown>): string {
  return noteBody({ content: raw.description ?? raw.body })
}

/**
 * A comment's text. Projex returns `content` as a JSON string carrying `htmlValue`, so a plain read would store the JSON;
 * tags are stripped because every Channel here is text-first.
 */
export function noteBody(raw: Record<string, unknown>): string {
  const content = raw.content ?? raw.body
  if (typeof content !== 'string') return ''
  const trimmed = content.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed.htmlValue === 'string') return stripTags(parsed.htmlValue)
    } catch {
      /* Plain text that happens to start with a brace. */
    }
  }
  return trimmed
}

const ENTITIES: Readonly<Record<string, string>> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }
/** Rendered HTML to readable text: paragraphs and breaks become newlines, entities become their characters. */
export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(nbsp|amp|lt|gt|quot);/g, entity => ENTITIES[entity] ?? entity)
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** A response body's items: a bare array (what the search endpoint returns) or a named envelope. */
function itemsOf(body: unknown, key: string): Record<string, unknown>[] {
  const values = Array.isArray(body) ? body : pageOf(body, key).values
  return values.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
}

/** Maps one raw Yunxiao comment to a WorkNote. */
export function mapNote(raw: Record<string, unknown>): WorkNote {
  const updatedAt = raw.gmtModified ?? raw.updatedAt
  return {
    id: String(raw.id ?? raw.commentId ?? ''),
    body: noteBody(raw),
    ...imagesOf(raw.content ?? raw.body),
    // A comment names its author `user`; `creator`/`author` stay for the older shape.
    author: personOf(raw.user ?? raw.creator ?? raw.author) ?? { id: '' },
    at: isoFromMs(raw.gmtCreate ?? raw.createdAt),
    ...(updatedAt ? { updatedAt: isoFromMs(updatedAt) } : {}),
    self: carriesAgentMarker(raw),
  }
}

/** The idempotency marker postNote appends to every comment this agent writes. */
const AGENT_MARKER = 'dsh-superagent:'
/** True when the raw payload already carries the agent's marker, so the comment is ours and must not become a Trigger. */
function carriesAgentMarker(comment: Record<string, unknown>): boolean {
  const content = comment.content ?? comment.body
  return String(content ?? '').includes(AGENT_MARKER)
}

/** The image references a rich-text payload embeds, or nothing when it has none (an absent field, not an empty array). */
function imagesOf(value: unknown): { images?: WorkImageRef[] } {
  const images = imageRefs(value)
  return images.length ? { images } : {}
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
  const cutoff = since ? Date.parse(since) : Number.NaN
  for (const category of codes) {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      // `conditions` is rejected by this endpoint, so the modification filter runs below. The endpoint answers newest first,
      // which lets a page that holds something older than the cutoff end the loop.
      const { body } = await adapter.api.post(searchPath(adapter.organization),
        { category, spaceId: project, page, perPage: PAGE_SIZE, ...(since ? { conditions: conditionsOf(since) } : {}) })
      const raw = itemsOf(body, 'workitems')
      let older = false
      for (const entry of raw) {
        const item = mapWorkItem(entry, project, category)
        // Our own comment or status write moved this item's modification time; reading it back would start a second Assignment
        // on a ticket that has already answered. A person's later edit changes the revision again and passes through.
        if (isSelfWrite(PROJEX_HOST, adapter.organization, item.key, item.updatedAt)) continue
        if (!Number.isNaN(cutoff) && Date.parse(item.updatedAt) < cutoff) { older = true; continue }
        items.push(item)
      }
      if (raw.length < PAGE_SIZE || older) break
    }
  }
  return { items }
}

async function readWorkItem(adapter: ProjexAdapter, project: string, key: string): Promise<WorkItem> {
  const { body } = await adapter.api.get(itemPath(adapter.organization, key))
  return mapWorkItem(recordOf(body), project)
}

/** Reads one embedded image's host metadata: the work item's `files/{fileId}` record, whose `url` is a signed download. */
async function readImageFile(adapter: ProjexAdapter, key: string, image: WorkImageRef, signal?: AbortSignal): Promise<WorkImageFile> {
  if (signal?.aborted) throw new Error('aborted')
  const { body } = await adapter.api.get(filesPath(adapter.organization, key, image.key))
  const meta = recordOf(body)
  const url = String(meta.url ?? '')
  if (!url) throw new Error('the host returned no download URL for this image')
  return { name: String(meta.name ?? image.name ?? 'image'), suffix: String(meta.suffix ?? ''), size: Number(meta.size ?? 0), url }
}

async function listNotes(adapter: ProjexAdapter, project: string, key: string, cursor: string | undefined): Promise<WorkNotePage> {
  const page = cursor ? Math.max(1, Number(cursor) || 1) : 1
  const { body } = await adapter.api.get(commentsPath(adapter.organization, key), { page, perPage: PAGE_SIZE })
  const values = itemsOf(body, 'comments')
  return { notes: values.map(mapNote), ...(values.length >= PAGE_SIZE ? { next: String(page + 1) } : {}) }
}

/** Posts a comment unless one already carries `marker`; returns `'gone'` when the item no longer accepts comments. */
async function postNote(adapter: ProjexAdapter, item: WorkItem, text: string, marker: string): Promise<'sent' | 'gone'> {
  const existing = await adapter.api.get(commentsPath(adapter.organization, item.key), { page: 1, perPage: PAGE_SIZE })
  const mine = itemsOf(existing.body, 'comments').some(comment =>
    JSON.stringify(comment).includes(marker) || noteBody(comment).includes(marker))
  if (mine) return 'sent'
  try {
    await adapter.api.post(commentsPath(adapter.organization, item.key), { content: `${text}\n\n${marker}` })
    await rememberWrite(adapter, item.key)
    return 'sent'
  } catch (error) {
    if (error instanceof YunxiaoHttpError && (error.status === 404 || error.status === 410)) return 'gone'
    throw error
  }
}

/**
 * Record the revision this process's write produced, so the next poll recognises it as its own.
 *
 * `PUT` and `POST comments` do not return the work item, so it is read once more; a failed read leaves the ledger without an
 * entry, which costs one duplicate trigger at worst - the direction that cannot lose a person's request.
 */
async function rememberWrite(adapter: ProjexAdapter, key: string): Promise<void> {
  try {
    const { body } = await adapter.api.get(itemPath(adapter.organization, key))
    const updatedAt = isoFromMs(recordOf(body).gmtModified)
    rememberSelfWrite(PROJEX_HOST, adapter.organization, key, updatedAt)
  } catch {
    /* The write itself succeeded; only the ledger entry is missing. */
  }
}

async function writeStatus(adapter: ProjexAdapter, item: WorkItem, stage: string): Promise<void> {
  // `POST /workitems/{id}/status` was never a route, and `{statusStageId}` is not a field. The update is a `PUT` carrying
  // `status`, whose value is a status **id**; a bare stage number is only usable when it is the item's own stage.
  const status = /^[0-9]+$/.test(stage) && item.status.stage === stage ? item.status.id : stage
  if (!status) throw new Error('Projex needs a status id to write back, and this item reports none')
  await adapter.api.put(itemPath(adapter.organization, item.key), { status })
  await rememberWrite(adapter, item.key)
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
  // An array of arrays, with the field's class and input format spelled out; the flatter shape answers 400.
  return JSON.stringify({ conditionGroups: [[{ fieldIdentifier: 'gmtModified', operator: 'MORE_THAN', value: [since],
    className: 'dateTime', format: 'input' }]] })
}

const orgPath = (organization: string): string => `/oapi/v1/projex/organizations/${encodeURIComponent(organization)}`
const searchPath = (organization: string): string => `${orgPath(organization)}/workitems:search`
const itemPath = (organization: string, key: string): string => `${orgPath(organization)}/workitems/${encodeURIComponent(key)}`
const commentsPath = (organization: string, key: string): string => `${itemPath(organization, key)}/comments`
const filesPath = (organization: string, key: string, fileId: string): string => `${itemPath(organization, key)}/files/${encodeURIComponent(fileId)}`
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