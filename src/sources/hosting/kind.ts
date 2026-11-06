/**
 * Factory of code-hosting Source kinds: one `hostingKind` per host builds the shared configuration, form fields,
 * health entry, receiving scope, and note channel on top of a `HostAdapter` (§5.2, §5.3 of the extension design).
 */
import { z } from 'zod'
import type { FieldSpec, Localized, SourceKind } from '../kind.ts'
import type { HostAdapter } from './port.ts'

/** Configuration every hosting kind shares: the repository to watch, the token file setup reads, and the polling interval. */
const HostingSchema = z.object({
  project: z.string().min(1),
  tokenFile: z.string(),
  pollSeconds: z.number().int().min(30).max(3600).default(60),
}).strict()
export type HostingConfig = z.infer<typeof HostingSchema>

/** The receiving-scope rows a hosting Trigger maps onto; the Policy's admission table names them. */
export type HostingRow = 'issues' | 'pulls' | 'comments' | 'ci'

/** Metadata that identifies one hosting kind; the adapter supplies the host behavior behind it. */
export interface HostingMeta {
  /** Host name, also the kind ID and its health entry. */
  host: string
  title: Localized
  description: Localized
  /** Form fields appended after the shared fields, such as a host's own observation switches. */
  extraFields?: FieldSpec[]
  /** Additional configuration keys merged into the shared schema. */
  extraSchema?: z.ZodRawShape
}

/** The shared form fields, identical on every host. */
const FIELDS: FieldSpec[] = [
  { key: 'project', type: 'text', label: { zh: '监听的仓库', en: 'Repository' },
    hint: { zh: '写作 group/project 或宿主要求的仓库标识；这个来源轮询它的变更请求与评论。', en: 'Written group/project, or the repository identifier the host requires; this Source polls its change requests and notes.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '访问令牌文件', en: 'Access token file' },
    hint: { zh: '存放访问令牌的绝对路径（权限 0600）。保存时读它去校验；令牌不写进设置、不写进日志，也不在面板回显。', en: 'Absolute path of the file holding the access token (mode 0600). Saving reads it to verify; the token never enters settings, logs, or the panel.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
    hint: { zh: '宿主要求更长间隔时以宿主为准。', en: 'A longer interval requested by the host wins.' } },
]

/** The row a Trigger's own metadata is admitted under: CI first, then the change's kind, then the kinds of its notes. */
function rowOf(meta: Record<string, unknown>): HostingRow | undefined {
  if (meta.ci === true) return 'ci'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'pull') return 'pulls'
  return meta.kind === 'conversation' || meta.kind === 'inline' || meta.kind === 'review' ? 'comments' : undefined
}

/** The hidden marker that makes a retried note idempotent; hosts have no server-side idempotency key (§5.3). */
export const hostingMarker = (id: string): string => `<!-- dsh-superagent:${id} -->`

/**
 * Builds the SourceKind of one hosting host: the shared `project`/`tokenFile`/`pollSeconds` settings extended with
 * `meta.extraSchema`, the shared fields followed by `meta.extraFields`, `meta.host` as its health entry, a scope derived
 * from each Trigger's metadata, and a Markdown channel that posts notes idempotently through the adapter.
 */
export function hostingKind<C extends Record<string, unknown>>(adapter: HostAdapter<C>, meta: HostingMeta): SourceKind<C> {
  // The merged schema's type is the shared settings plus the host's extra keys, which the factory cannot name; the
  // kind's configuration type `C` is that shape, so the schema is widened to it instead of restating it here.
  const schema = (meta.extraSchema ? HostingSchema.extend(meta.extraSchema) : HostingSchema) as unknown as z.ZodType<C>
  return {
    kind: meta.host,
    title: meta.title,
    description: meta.description,
    schema,
    fields: [...FIELDS, ...meta.extraFields ?? []],
    health: [meta.host],
    // Every change request, note, and CI change of the repository is received; the Policy's admission table decides which become candidates.
    scope: input => {
      const row = rowOf(input.meta)
      return row ? { listened: true, observed: true, row } : { listened: true, observed: false }
    },
    channel: {
      capabilities: { idempotency: 'marker', markdown: true },
      send: async (host, message) => {
        const { address } = message.channel
        const project = address.project ?? (typeof host.config.project === 'string' ? host.config.project : '')
        const number = Number(address.number)
        if (!project || !Number.isInteger(number) || number <= 0) throw new Error('Missing hosting reply target')
        // The change carries the host-local number and patchset the adapter posts to; the channel only adds the marker.
        const change = await adapter.readChange(host.commands, project, number)
        return adapter.postNote(host.commands, change, message.text, hostingMarker(message.id))
      },
      link: (address, _links, config) => {
        const project = address.project ?? (typeof config?.project === 'string' ? config.project : '')
        const number = Number(address.number)
        const url = project && Number.isInteger(number) && number > 0 ? adapter.page(project, number) : ''
        const named = url ? ` #${number}` : ''
        return { url, label: { zh: `${meta.title.zh}${named}`, en: `${meta.title.en}${named}` } }
      },
    },
  }
}