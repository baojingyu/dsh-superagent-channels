/** The Yunxiao Projex source kind: the Projex work adapter wrapped with the shared work configuration, context, and environment. */
import { z } from 'zod'
import type { FieldSpec, SourceAction, SourceKind, SourcePolicyPart } from '../../kind.ts'
import { KV } from '../../../kv.ts'
import { authorizeWithBrowser, writeStored } from '../../../infra/yunxiao-oauth.ts'
import { sourceContext, type SourceContext, type SourceHost } from '../../host.ts'
import { workThreadContext } from '../context.ts'
import { workKind, type WorkConfig } from '../kind.ts'
import { createProjexAdapter, projexAdapter } from './adapter.ts'

/** Instance configuration of the Projex kind: the shared work keys plus the organization ID every Projex path is scoped by. */
export type ProjexKindConfig = WorkConfig & { organizationId: string }

/** Organization ID is required because Projex paths carry it; it is an accountID-level ID, never a display name. */
const ORGANIZATION_FIELD: FieldSpec = {
  key: 'organizationId', type: 'text', label: { zh: '组织 ID', en: 'Organization ID' },
  hint: { zh: '阿里云组织 ID（organizationId），不是组织显示名称。', en: 'Aliyun organization ID (organizationId), not a display name.' },
}

/** The API site: the central site unless a Region deployment names its own domain. */
const BASE_URL_FIELD: FieldSpec = {
  key: 'baseUrl', type: 'text', advanced: true, pattern: 'https://[^\\s]+',
  label: { zh: 'API 站点（Region 版才填）', en: 'API site (Region deployments only)' },
  hint: { zh: '留空用中心站 https://openapi-rdc.aliyuncs.com；Region 版填实例的访问域名，授权也在同一站点进行。',
    en: 'Empty uses the central site https://openapi-rdc.aliyuncs.com; a Region deployment names its instance domain here, and the sign-in runs on the same site.' },
}

/** A Policy switch that turns the member sync on; it is off by default, because a sync replaces a hand-kept list. */
const SYNC_FIELD: FieldSpec = {
  key: 'syncMembers', type: 'switch', label: { zh: '从项目成员同步名单', en: 'Sync the list from project members' },
  hint: { zh: '打开后，可以用下面的「同步项目成员」把名单换成项目成员（userId 即工作项「指派给」里那个 id），并在启动时同步一次。关闭时名单完全由你手填。',
    en: 'When on, "Sync project members" can replace the list with the project\'s members (their `userId` is the id a work item is assigned to), and one sync runs at startup. Off keeps the list entirely hand-written.' },
}

/**
 * How a bound adapter is built for a stored configuration. The sync and the status probe both need a real client; a test
 * replaces `create` to drive them without a network, which is why the seam is a value rather than a bare function.
 */
export const projexAdapters = {
  create(config: Record<string, unknown>) {
    return createProjexAdapter({ organization: String(config.organizationId ?? ''), tokenFile: String(config.tokenFile ?? ''),
      ...typeof config.baseUrl === 'string' && config.baseUrl.trim() ? { baseUrl: config.baseUrl.trim() } : {},
      writeBack: config.writeBack === true })
  },
}

/** The site a configuration talks to; the central one unless the instance names its own domain. */
const siteOf = (config: Record<string, unknown>): string =>
  typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config.baseUrl.trim() : 'https://openapi-rdc.aliyuncs.com'

/**
 * Records a status vocabulary in both shapes: `id → name` for the two write-back dropdowns (the panel reads
 * `KV.sources.labels`), and `name → id` for a write-back that names a status. Returns the `id → name` map.
 */
function rememberStatuses(context: SourceContext, instance: string,
  statuses: readonly { id: string; name: string }[]): Record<string, string> {
  const labels = Object.fromEntries(statuses.map(status => [status.id, status.name]))
  context.state.set(KV.sources.labels(instance), labels)
  const known: Record<string, string> = { ...context.state.get(KV.work.statuses(instance)) ?? {} }
  for (const status of statuses) known[status.name] = status.id
  context.state.set(KV.work.statuses(instance), Object.fromEntries(Object.entries(known).slice(-200)))
  return labels
}

/** One bound adapter for a stored configuration. */
const adapterOf = (config: Record<string, unknown>) => projexAdapters.create(config)

/** A Projex work-item serial such as `ESFX-6228`, or the page address people paste. */
const SERIAL = /^[A-Za-z][A-Za-z0-9]*-\d+$/
const WORKITEM_URL = /\/projex\/project\/[^/]+\/workitem\/([^/?#]+)/

/** Resolves a serial or a work-item page URL to the serial the panel searches on, upper-cased as the store holds it. */
function find(query: string): { threads: string[]; terms: string[] } {
  const value = query.trim()
  const fromUrl = WORKITEM_URL.exec(value)?.[1]
  const serial = fromUrl ? (() => { try { return decodeURIComponent(fromUrl) } catch { return fromUrl } })() : value
  if (!fromUrl && !SERIAL.test(serial)) return { threads: [], terms: [] }
  // The stored serial is upper case; accept what a person typed and search both spellings.
  return { threads: [], terms: [...new Set([serial, serial.toUpperCase()])] }
}

/** The Policy part the Projex member sync reads and rewrites. */
type ProjexPolicyPart = Record<string, unknown> & { allowed: { id: string; name?: string }[]; syncMembers?: boolean }

/** Fills the Policy's member list from the project's members, keeping the existing order and names in step. */
const syncMembers: NonNullable<SourcePolicyPart<ProjexPolicyPart>['sync']> = {
  label: { zh: '同步项目成员', en: 'Sync project members' },
  ready: part => part.syncMembers === true,
  async run(host, part, signal) {
    const instance = host.sources.instances().find(item => item.kind === projexKind.kind)
    const config = (instance?.config ?? {}) as Record<string, unknown>
    const project = typeof config.project === 'string' ? config.project.trim() : ''
    if (!project) throw new Error('Set the project space before syncing members')
    const commands = sourceContext(host, projexKind).commands.withSignal(signal)
    const adapter = adapterOf(config)
    if (!adapter.listMembers) throw new Error('This Projex client cannot read project members')
    const members = await adapter.listMembers(commands, project, signal)
    // Keep the operator's order and refresh names in place; append members the list did not have yet.
    const names = new Map(members.map(member => [member.id, member.name ?? '']))
    const known = new Set(part.allowed.map(entry => entry.id))
    return { ...part, allowed: [
      ...part.allowed.filter(entry => names.has(entry.id)).map(entry => ({ ...entry, name: names.get(entry.id)! })),
      ...members.filter(member => !known.has(member.id)).map(member => ({ id: member.id, name: member.name ?? '' })),
    ] }
  },
}

/**
 * Signs in with a Yunxiao account in the browser: dynamic client registration, authorization code with PKCE, a loopback
 * callback, and the token written to the same owner-only file the adapter already reads. No token is typed by hand and no
 * credential passes through the panel; the refresh token beside it renews the 24-hour access token for 90 days.
 */
const authorizeAction: SourceAction = {
  id: 'authorize',
  label: { zh: '用云效账号授权', en: 'Sign in with Yunxiao' },
  hint: { zh: '打开浏览器里的云效登录与授权页；授权后访问令牌写进来源配置的令牌文件（24 小时有效，自动续期，刷新令牌 90 天）。',
    en: 'Opens Yunxiao sign-in and consent in your browser, then writes the access token to the configured token file (24 hours, renewed automatically; the refresh token lasts 90 days).' },
  ready: config => typeof config.tokenFile === 'string' && config.tokenFile.trim() !== '',
  async run(_host, config, signal) {
    const tokenFile = String(config.tokenFile).trim()
    const { tokens, stored } = await authorizeWithBrowser({ baseUrl: siteOf(config), ...(signal ? { signal } : {}) })
    writeStored(tokenFile, { tokens, stored })
    return `已授权：访问令牌写入 ${tokenFile}（24 小时有效，自动续期；刷新令牌 90 天）`
  },
}

/**
 * Reads the project's real status vocabulary - the work item types per category, then each type's workflow statuses -
 * and records it, so the two write-back fields can be filled by the name a person reads on the board. It also returns
 * the list, which is what the source card shows.
 */
const statusAction: SourceAction = {
  id: 'statuses',
  label: { zh: '读取云效状态词表', en: 'Read Yunxiao status list' },
  hint: { zh: '从云效读取本项目工作项类型的工作流状态；读到的名字与 ID 会存下来，两个回写字段填名字或 ID 都行。',
    en: 'Reads the workflow statuses of this project\'s work item types; the names and ids are stored, and either one works in the two write-back fields.' },
  ready: config => typeof config.project === 'string' && config.project.trim() !== '',
  async run(host, config, signal) {
    const project = String(config.project)
    const categories = Array.isArray(config.categories) ? config.categories.map(String) : ['requirement', 'bug', 'task']
    const context = sourceContext(host, projexKind)
    const commands = context.commands.withSignal(signal ?? new AbortController().signal)
    const adapter = adapterOf(config)
    if (!adapter.listStatuses) throw new Error('This Projex client cannot read workflow statuses')
    const statuses = await adapter.listStatuses(commands, project, categories, signal)
    if (!statuses.length) return '云效没有返回状态；确认项目空间与令牌有「项目协作」读权限。'
    // Keep the names for the write-back fields: the poll merges what it reads, and this adds the full vocabulary.
    const instance = host.sources.instances().find(item => item.kind === projexKind.kind)?.id ?? projexKind.kind
    rememberStatuses(context, instance, statuses)
    return `云效状态词表（名字=ID）：${statuses.map(status => `${status.name}=${status.id}`).join('，')}`
  },
}

/**
 * Thread context of a Projex work item: the item's description as the root message, its comments as the thread, and the
 * images it embeds served from the local archive the poll wrote to `<stateDir>/projex-images`.
 *
 * The adapter is built from the instance configuration on every read rather than taken from the unbound template: a
 * Projex client needs the organization and the token file, and an assessment must read the item it is judging.
 */
const threadContext = workThreadContext<ProjexKindConfig>(config => adapterOf(config))

/** The shared work kind plus the Projex organization key; `provider: true` lets the adapter's own comment writer reply. */
const base = workKind<ProjexKindConfig>(projexAdapter, {
  host: 'projex',
  title: { zh: '云效 Projex', en: 'Yunxiao Projex' },
  description: {
    zh: '云效 Projex 工作项（需求/缺陷/任务）来源；收到指派给智能体的工作项与评论，并以工作项评论回复。',
    en: 'Yunxiao Projex work items (requirements, bugs, tasks); receives items assigned to the agent and its comments, and replies as a work-item comment.',
  },
  provider: true,
  threadContext,
  find,
  // The organization ID is part of a worker's environment too: a `aliyun devops` call names it on every Projex path.
  extraEnvironment: {
    variables: [{ key: 'DSH_SUPERAGENT_PROJEX_ORG',
      description: { zh: '本实例的云效组织 ID（organizationId），工单派发的 Projex 调用都用它。',
        en: 'Yunxiao organization ID (organizationId) of this instance; every Projex call a worker makes names it.' } }],
    values: ({ config }) => ({ DSH_SUPERAGENT_PROJEX_ORG: config.organizationId }),
  },
  policyExtras: { schema: { syncMembers: z.boolean().default(false) }, fields: [SYNC_FIELD] },
  sync: syncMembers,
  extraFields: [ORGANIZATION_FIELD, BASE_URL_FIELD],
  extraSchema: z.object({ organizationId: z.string().min(1), baseUrl: z.string().trim().optional() }).strict(),
})

/** The Projex SourceKind: the shared work kind plus its context reader, member sync, status list, sign-in action, and search. */
/**
 * Rereads the project's status vocabulary so the two write-back fields can be dropdowns rather than hand-typed ids.
 * The settings endpoint calls this for the card's refresh button; a read failure keeps the stored list.
 */
async function refreshStatusLabels(host: SourceHost, signal?: AbortSignal): Promise<Record<string, string>> {
  const context = sourceContext(host, projexKind)
  const config = context.config<ProjexKindConfig>(projexKind.kind)
  if (!config || typeof config.project !== 'string' || config.project.trim() === '') return {}
  const adapter = adapterOf(config as Record<string, unknown>)
  if (!adapter.listStatuses) return {}
  const abort = signal ?? new AbortController().signal
  const categories = Array.isArray(config.categories) ? config.categories.map(String) : ['requirement', 'bug', 'task']
  const statuses = await adapter.listStatuses(context.commands.withSignal(abort), config.project, categories, abort)
  if (!statuses.length) return {}
  const instance = host.sources.instances().find(item => item.kind === projexKind.kind)?.id ?? projexKind.kind
  return rememberStatuses(context, instance, statuses)
}

export const projexKind: SourceKind<ProjexKindConfig> = { ...base, refreshLabels: refreshStatusLabels,
  actions: [authorizeAction, statusAction] }