/** Factory of the work (work-item) source kind: shared configuration, admission rows by category, comment channel, and health. */
import { z } from 'zod'
import type { OutboundFile, OutboundMessage } from '../../core/index.ts'
import type { AdmissionRowView, ChannelHost, ChannelLink, FieldSpec, Localized, SourceKind, SourcePolicyPart, ThreadContext } from '../kind.ts'
import { workThreadContext } from './context.ts'
import { workEnvironment, type WorkEnvironmentAddition } from './environment.ts'
import type { WorkAdapter, WorkAttachment } from './port.ts'

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
  /** Status id written to the item while a ticket works on it; only used when `writeBack` is on. */
  statusOnStart: z.string().trim().max(120).optional(),
  /** Status id written to the item once the ticket ended; only used when `writeBack` is on. */
  statusOnDone: z.string().trim().max(120).optional(),
  /** Whether a ticket's model may attach a file from its working directory to a work-item comment. */
  sendFiles: z.boolean().default(false),
  /** How many of the newest person comments a first-sight work item backfills; older comments are dropped (0 disables). */
  backfillComments: z.number().int().min(0).max(200).default(20),
}).strict()
export type WorkConfig = z.infer<typeof WorkConfigSchema>

/** Admission row each work-item category belongs to; categories without a row are received but not admitted. */
const ROWS: Readonly<Record<string, string>> = { requirement: 'requirements', bug: 'bugs', task: 'tasks' }
/**
 * The Policy part of a work kind: the members who may originate work here. Ids are the host's own account ids - the very value
 * the adapter puts in `WorkItem.assignee`/`author.id` - because that is what the gate compares against.
 */
const WorkPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().trim().min(1), name: z.string().trim().max(100).optional() }).strict()).default([]),
}).strict()
/**
 * The reception ranges every work kind polls, one admission row each, in the shape GitHub's and Feishu's tables use: `note` is
 * the small annotation under the label ("received" or not), and `cells` names the columns that apply.
 *
 * A work item never mentions the agent, so the "an outsider addresses the agent" cell does not exist here - it renders as a
 * dash, the same way Feishu shows the listed-and-unaddressed cell it cannot use.
 */
const CATEGORY_ROWS: readonly { id: string; category: string; label: { zh: string; en: string } }[] = [
  { id: 'requirements', category: 'requirement', label: { zh: '需求', en: 'Requirements' } },
  { id: 'bugs', category: 'bug', label: { zh: '缺陷', en: 'Bugs' } },
  { id: 'tasks', category: 'task', label: { zh: '任务', en: 'Tasks' } },
]
const DEFAULT_CATEGORIES: readonly string[] = ['requirement', 'bug', 'task']
/** Largest file a work-item comment accepts; the operator's `sendFiles` switch gates whether any may be sent at all. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/**
 * The rows of one instance: a category it polls is received, one it does not poll has nothing to admit.
 *
 * The configuration here is the instance's whole config, which carries the host's own keys too (Projex adds `organizationId`), so
 * it is read rather than validated - `WorkConfigSchema` is strict and would reject the sibling keys the host legitimately stores.
 */
function admissionRows(stored: Record<string, unknown>): AdmissionRowView[] {
  const listed = stored.categories
  const categories = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === 'string') : DEFAULT_CATEGORIES
  return CATEGORY_ROWS.map(row => {
    const received = categories.includes(row.category)
    return { id: row.id, label: row.label,
      note: received ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
      // No mention exists on a work item, so only the two "not addressed" columns are offered.
      cells: { listedUnaddressed: received, unlistedAddressed: false, unlistedUnaddressed: received } }
  })
}
/** Form fields of the shared configuration; a concrete kind may supply its own through `meta.fields`. */
const FIELDS: readonly FieldSpec[] = [
  { key: 'project', type: 'text', label: { zh: '项目空间', en: 'Project' },
    hint: { zh: '工作项所在的项目空间，用宿主自己的 ID 形式。', en: 'Project space that holds the work items, in the host\'s own ID form.' } },
  { key: 'tokenFile', type: 'text', label: { zh: '访问令牌文件', en: 'Token file' },
    hint: { zh: '保存访问令牌的文件路径；凭证不写进设置。', en: 'Path of the file holding the access token; credentials are not stored in settings.' } },
  { key: 'pollSeconds', type: 'number', advanced: true, min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  { key: 'writeBack', type: 'switch', label: { zh: '回写工作项状态', en: 'Write status back to work items' },
    hint: { zh: '默认关闭：智能体只在评论里交付结论，不改看板状态。打开后，还要填下面两个状态，看板才会跟着工单走。',
      en: 'Off by default: the agent delivers in a comment and never changes the board status. Once on, name the two statuses below so the board follows the ticket.' } },
  { key: 'statusOnStart', type: 'text', advanced: true, choose: { zh: '选择状态（先在卡片上读取云效状态词表）', en: 'Choose a status (read the status list on the card first)' },
    label: { zh: '开始执行时写入的状态 ID', en: 'Status id while the agent works' },
    hint: { zh: '工单一开始就写到工作项上的状态；从下拉里选（先点卡片上的「读取云效状态词表」，或字段旁的刷新），存的是状态 ID，显示的是看板上的名字。留空则不写。',
      en: 'Status written to the item as soon as a ticket starts; pick it from the list (read the status list on the card first, or use the refresh beside the field). The id is stored, the board name is shown. Empty writes nothing.' } },
  { key: 'statusOnDone', type: 'text', advanced: true, choose: { zh: '选择状态（先在卡片上读取云效状态词表）', en: 'Choose a status (read the status list on the card first)' },
    label: { zh: '工单结束时写入的状态 ID', en: 'Status id when the ticket ends' },
    hint: { zh: '工单完成、合并或放弃时写到工作项上的状态；从下拉里选（先读取状态词表），存 ID、显示名字；人工停止的工单不写。留空把工作项留在原状态。',
      en: 'Status written to the item when the ticket completes, merges, or is dropped; pick it from the list (read the status list first). The id is stored, the name is shown; a ticket a person stopped writes nothing. Empty leaves the item where it is.' } },
  { key: 'sendFiles', type: 'switch', advanced: true, label: { zh: '允许模型把文件挂到评论', en: 'Let the model attach files to comments' },
    hint: { zh: '开启后，工单里的模型可以把执行目录内的文件（≤10 MiB、非可执行文件）作为附件加到工作项评论上。默认关闭——这等于给模型一条把文件发出去的通道。',
      en: 'When on, the model working a ticket may attach a file from its ticket directory (≤ 10 MiB, not an executable) to a work-item comment. Off by default: it is a channel for files to leave the machine.' } },
  { key: 'backfillComments', type: 'number', advanced: true, min: 0, max: 200,
    label: { zh: '首见回填评论条数', en: 'First-sight comment backfill' },
    hint: { zh: '首次看到某工单时补投最近多少条真人评论；更早的丢弃。0 表示不补。', en: 'How many of the newest person comments to backfill when a work item is first seen; older ones are dropped. 0 disables it.' } },
]

/** What a configured outbound provider receives to post one work-item comment. */
export interface WorkNoteReply {
  readonly host: ChannelHost
  readonly project: string
  readonly key: string
  readonly text: string
  /** Idempotency marker to embed in the comment; a retry carrying the same marker stays one comment. */
  readonly marker: string
  /** Files to attach to the comment, already gated by the operator's `sendFiles` switch. */
  readonly files?: readonly OutboundFile[]
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
  /** Bounded thread context (including image reads) this host can serve to assessments; absent when it serves none. */
  threadContext?: ThreadContext<C>
  /** Execution-environment variables a host adds beyond the shared per-item set (an organization ID, a base URL). */
  extraEnvironment?: WorkEnvironmentAddition<C>
  /** Extra Policy schema keys and their fields, for a host's own authorization switch (such as a member sync). */
  policyExtras?: { schema: z.ZodRawShape; fields: readonly FieldSpec[] }
  /** Roster sync that fills the Policy's member list from the host; shown as its own button on the Policy card. */
  sync?: SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>['sync']
  /** Reference resolution for the panel's search and for links found in text; defaults to none. */
  find?: (query: string) => { threads: string[]; terms: string[] }
}

/**
 * A provider backed by the adapter: read the item named by the reply target, upload any files the operator allowed, then
 * post the comment with one line per attachment. A host that cannot upload refuses the files rather than dropping them,
 * and a file over the channel's cap is named in the comment instead of failing the delivery.
 */
function adapterProvider(adapter: WorkAdapter): WorkNoteProvider {
  return async ({ host, project, key, text, marker, files }) => {
    const item = await adapter.readWorkItem(host.commands, project, key)
    let body = text
    const attachments: WorkAttachment[] = []
    if (files?.length) {
      if (!adapter.uploadFile) throw new Error('This work host cannot attach files to a comment')
      for (const file of files) {
        const bytes = decodedSize(file.data)
        if (bytes > MAX_ATTACHMENT_BYTES) {
          body += `\n\n[附件 ${file.name} 未发送：${bytes} 字节，超过 ${MAX_ATTACHMENT_BYTES} 字节上限]`
          continue
        }
        attachments.push(await adapter.uploadFile(host.commands, item, file))
      }
    }
    return adapter.postNote(host.commands, item, body, marker, attachments)
  }
}

/** The decoded size of a standard-base64 payload, without decoding it (this module also loads in the panel bundle). */
function decodedSize(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(data.length / 4) * 3 - padding
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
  // Files only leave when the operator turned them on; the tool that produces them refuses earlier, and this is the second
  // guard for anything else that puts files on a message.
  const files = host.config.sendFiles === true ? message.files ?? [] : []
  return provider({ host, project, key, text: message.text, marker: `<!-- dsh-superagent:${message.id} -->`,
    ...files.length ? { files } : {} })
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
  // Likewise for the Policy: the shared part plus whatever authorization switch a host adds (a member sync, for instance).
  const policySchema = (meta.policyExtras ? WorkPolicySchema.extend(meta.policyExtras.schema) : WorkPolicySchema) as unknown as
    z.ZodType<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>
  const provider = resolveProvider(adapter, meta.provider)
  return {
    kind: meta.kind ?? adapter.host,
    title,
    description,
    schema,
    fields: [...(meta.fields ?? FIELDS), ...(meta.extraFields ?? [])],
    health: [meta.host ?? adapter.host],
    threadContext: meta.threadContext ?? workThreadContext(() => adapter),
    environment: workEnvironment<C>(meta.host ?? adapter.host, meta.extraEnvironment),
    ...meta.find ? { find: meta.find } : {},
    policy: {
      unnamed: { person: { zh: '云效成员', en: 'Yunxiao member' }, bot: { zh: '云效机器人', en: 'Yunxiao bot' } },
      schema: policySchema,
      fields: [
        { key: 'allowed', type: 'rows', label: { zh: '能发起工作的云效成员', en: 'Members who may originate work' },
          hint: { zh: '这里是授权：名单里的人的工作项（需求/缺陷/任务）才会被当作可接的工作。填云效的成员 accountId——就是工作项'
            + '「指派给」里那个人的 id，不是姓名。不填则所有工作项都会被判「名单外」而拒绝（`/health` 与事件都会这么说）。',
            en: 'Authorization: only work items belonging to a listed member can become work. Ids are Yunxiao account ids - the '
              + 'assignee\'s id, not a name. Empty refuses every work item as unlisted.' },
          columns: [
            { key: 'id', type: 'text', label: { zh: '成员 ID', en: 'Member ID' } },
            { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
          ] },
        ...meta.policyExtras?.fields ?? [],
      ],
      // A work item has no mention to give, so nothing about it can be an explicit request on its own; the table decides.
      explicit: { zh: '云效工作项没有「@」这回事，所以这张表说了算。负责人（没有负责人时用创建人）在名单里，这条就落到「名单内」那一列；不在名单里，就落到「名单外」那一列。两列各配什么就按什么处理：配「忽略」就不接，配「允许推断」就成为候选，并在「自动接单」模式下接单。',
        en: 'A Yunxiao work item has no mention, so this table decides. The person responsible (the assignee, or the creator when there is none) puts the item in the listed column or the unlisted one, and each column is handled exactly as configured: ignored, or an inferred candidate accepted in auto mode.' },
      rows: admissionRows,
      warnings(_config, part) {
        if (part.allowed.length > 0) return []
        return [{ zh: '「能发起工作的云效成员」是空的：任何工作项都会被判「名单外」而拒绝。填入成员 accountId（工作项「指派给」里那个人的 id），或打开同步从项目成员生成。',
          en: 'The member list is empty, so every work item is refused as unlisted. Add the member account id - the id the item '
            + 'is assigned to - or turn on the sync to build it from the project members.' }]
      },
      ...meta.sync ? { sync: meta.sync } : {},
    } satisfies SourcePolicyPart<Record<string, unknown> & { allowed: { id: string; name?: string }[] }>,
    // Work items are received as a whole; the category only selects the admission row of the Policy.
    scope: input => {
      const category = input.meta.category
      const row = typeof category === 'string' ? ROWS[category] : undefined
      return row ? { listened: true, observed: true, row } : { listened: true, observed: true }
    },
    channel: {
      capabilities: { idempotency: 'marker', markdown: true, maxChars: 60000, files: { maxBytes: MAX_ATTACHMENT_BYTES } },
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