/** Factory of the work (work-item) source kind: shared configuration, admission rows by category, comment channel, and health. */
import { z } from 'zod'
import type { OutboundMessage } from '../../core/index.ts'
import type { ChannelHost, ChannelLink, FieldSpec, Localized, SourceKind } from '../kind.ts'
import type { WorkAdapter } from './port.ts'

/** Configuration every work-kind instance shares; a host adapter maps its project and token file onto these keys. */
const WorkConfigSchema = z.object({
  /** Project space that holds the work items, in the host's own ID form. */
  project: z.string().trim().min(1),
  /** File holding the access token; the credential itself is never stored in settings. */
  tokenFile: z.string().trim().min(1),
  /** Categories to poll; the default covers requirements, bugs, and tasks. */
  categories: z.array(z.string()).default(['requirement', 'bug', 'task']),
  /** Polling interval in seconds; absent means the kind's own default. */
  pollSeconds: z.number().int().min(60).max(3600).optional(),
  /** Status write-back; off by default, so the agent only ever comments. */
  writeBack: z.boolean().default(false),
}).strict()
export type WorkConfig = z.infer<typeof WorkConfigSchema>

/** Admission row each work-item category belongs to; categories without a row are received but not admitted. */
const ROWS: Readonly<Record<string, string>> = { requirement: 'requirements', bug: 'bugs', task: 'tasks' }
/** Form fields of the shared configuration; a concrete kind may supply its own through `meta.fields`. */
const FIELDS: readonly FieldSpec[] = [
  { key: 'project', type: 'text', label: { zh: '项目空间', en: 'Project' },
    hint: { zh: '工作项所在的项目空间，用宿主自己的 ID 形式。', en: 'Project space that holds the work items, in the host\'s own ID form.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '访问令牌文件', en: 'Token file' },
    hint: { zh: '保存访问令牌的文件路径；凭证不写进设置。', en: 'Path of the file holding the access token; credentials are not stored in settings.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  { key: 'writeBack', type: 'switch', label: { zh: '回写工作项状态', en: 'Write status back to work items' },
    hint: { zh: '默认关闭：智能体只在评论里交付结论，不改看板状态。', en: 'Off by default: the agent delivers in a comment and never changes the board status.' } },
]

/** What a configured outbound provider receives to post one work-item comment. */
export interface WorkNoteReply {
  readonly host: ChannelHost
  readonly project: string
  readonly key: string
  readonly text: string
  /** Idempotency marker to embed in the comment; a retry carrying the same marker stays one comment. */
  readonly marker: string
}
/** Posts work-item comments for the channel; without one the kind is read-only and refuses to reply. */
export type WorkNoteProvider = (reply: WorkNoteReply) => Promise<'sent' | 'gone'>

/** Identity and outbound wiring of one work kind; every field defaults to the adapter's own host name. */
export interface WorkKindMeta<C extends Record<string, unknown> = WorkConfig> {
  /** Kind ID registered with the registry; defaults to the adapter's host name. */
  kind?: string
  /** Health entry name this kind owns under `health[...]`; defaults to the adapter's host name. */
  host?: string
  title?: Localized
  description?: Localized
  /** Form fields of the configuration; defaults describe the shared work configuration. */
  fields?: readonly FieldSpec[]
  /** Extra form fields appended after the shared ones, for a host's own identity keys (such as an organization ID). */
  extraFields?: readonly FieldSpec[]
  /**
   * Extra configuration schema merged into the shared one. The caller narrows `C` to the merged shape so the kind's
   * schema, environment, and channel see the extra keys; omitting it leaves the shared schema untouched.
   */
  extraSchema?: z.ZodObject<z.ZodRawShape>
  /** Outbound comment provider; `true` derives one from the adapter's own reads and comment writer. */
  provider?: boolean | WorkNoteProvider
}

/** A provider backed by the adapter: read the item named by the reply target, then post the comment on it. */
function adapterProvider(adapter: WorkAdapter): WorkNoteProvider {
  return async ({ host, project, key, text, marker }) => {
    const item = await adapter.readWorkItem(host.commands, project, key)
    return adapter.postNote(host.commands, item, text, marker)
  }
}

/** Resolves the meta flag: a function is used as is, `true` means the adapter itself can write, and nothing else is read-only. */
function resolveProvider(adapter: WorkAdapter, provider: boolean | WorkNoteProvider | undefined): WorkNoteProvider | undefined {
  if (typeof provider === 'function') return provider
  return provider === true ? adapterProvider(adapter) : undefined
}

/**
 * Delivers a comment through the provider; publishing without one is a configuration error, never a silent success.
 * A channel address of this kind carries `project` and `key` of the item, plus its human-readable `serial`.
 */
async function sendNote(provider: WorkNoteProvider | undefined, host: ChannelHost, message: OutboundMessage): Promise<'sent' | 'gone'> {
  if (!provider) throw new Error('provider not configured')
  const { project, key } = message.channel.address
  if (!project || !key) throw new Error('Missing work item reply target')
  return provider({ host, project, key, text: message.text, marker: `<!-- dsh-superagent:${message.id} -->` })
}

/**
 * Builds a work source kind from its host adapter.
 * The adapter supplies reads and comments; this factory supplies the shared configuration, the category admission rows,
 * the marker-idempotent comment channel, and the health entry.
 */
export function workKind<C extends Record<string, unknown> = WorkConfig>(
  adapter: WorkAdapter,
  meta: WorkKindMeta<C> = {},
): SourceKind<C> {
  const title = meta.title ?? { zh: '工作项', en: 'Work items' }
  const description = meta.description ?? {
    zh: '工作项（需求/缺陷/任务）来源；收到指派给智能体的工作项与评论，并以工作项评论回复。',
    en: 'Work-item (requirement, bug, task) source; receives items assigned to the agent and their comments, and replies as a comment.',
  }
  // The shared schema stays exactly as before when a host brings no extra keys; a host that does merges them in.
  const schema = (meta.extraSchema ? WorkConfigSchema.extend(meta.extraSchema.shape) : WorkConfigSchema) as unknown as z.ZodType<C>
  const provider = resolveProvider(adapter, meta.provider)
  return {
    kind: meta.kind ?? adapter.host,
    title,
    description,
    schema,
    fields: [...(meta.fields ?? FIELDS), ...(meta.extraFields ?? [])],
    health: [meta.host ?? adapter.host],
    // Work items are received as a whole; the category only selects the admission row of the Policy.
    scope: input => {
      const category = input.meta.category
      const row = typeof category === 'string' ? ROWS[category] : undefined
      return row ? { listened: true, observed: true, row } : { listened: true, observed: true }
    },
    channel: {
      capabilities: { idempotency: 'marker', markdown: true, maxChars: 60000 },
      send: (host, message) => sendNote(provider, host, message),
      link: (address): ChannelLink => {
        const key = address.key ?? ''
        const serial = address.serial ?? key
        return { url: adapter.page(address.project ?? '', key),
          label: { zh: `工作项 ${serial}`, en: `Work item ${serial}` } }
      },
    },
  }
}