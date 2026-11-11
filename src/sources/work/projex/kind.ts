/** The Yunxiao Projex source kind: the Projex work adapter wrapped with the shared work configuration and its environment. */
import { z } from 'zod'
import type { FieldSpec, SourceKind, ThreadContext } from '../../kind.ts'
import { workKind, type WorkConfig } from '../kind.ts'
import { projexAdapter } from './adapter.ts'
import { readArchivedImage, workImageKeys } from '../images.ts'

/** Instance configuration of the Projex kind: the shared work keys plus the organization ID every Projex path is scoped by. */
export type ProjexKindConfig = WorkConfig & { organizationId: string }

/** Organization ID is required because Projex paths carry it; it is an accountID-level ID, never a display name. */
const ORGANIZATION_FIELD: FieldSpec = {
  key: 'organizationId', type: 'text', label: { zh: '组织 ID', en: 'Organization ID' },
  hint: { zh: '阿里云组织 ID（organizationId），不是组织显示名称。', en: 'Aliyun organization ID (organizationId), not a display name.' },
}

/** The shared work kind plus the Projex organization key; `provider: true` lets the adapter's own comment writer reply. */
const base = workKind<ProjexKindConfig>(projexAdapter, {
  host: 'projex',
  title: { zh: '云效 Projex', en: 'Yunxiao Projex' },
  description: {
    zh: '云效 Projex 工作项（需求/缺陷/任务）来源；收到指派给智能体的工作项与评论，并以工作项评论回复。',
    en: 'Yunxiao Projex work items (requirements, bugs, tasks); receives items assigned to the agent and their comments, and replies as a work-item comment.',
  },
  provider: true,
  extraFields: [ORGANIZATION_FIELD],
  extraSchema: z.object({ organizationId: z.string().min(1) }).strict(),
})

/**
 * Thread context for a Projex work item: its text is the Trigger's own text (description + comment text, with image
 * markers), and images are served from the local archive the poll wrote to `<stateDir>/projex-images`.
 */
const threadContext: ThreadContext<ProjexKindConfig> = {
  messageId: trigger => trigger.id,
  read: async (_commands, trigger) => ({
    messages: [{ id: trigger.id, from: trigger.actor.id, at: trigger.at, text: trigger.text }],
    body: {},
  }),
  images: text => workImageKeys(text),
  image: (agent, _commands, _trigger, _message, key, stateDir, signal) => readArchivedImage(agent, key, stateDir, signal),
}

/** The Projex SourceKind: the shared work kind plus the environment variables its workers read. */
export const projexKind: SourceKind<ProjexKindConfig> = {
  ...base,
  threadContext,
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_PROJEX_PROJECT',
        description: { zh: '本实例监听的云效项目空间 ID。', en: 'Project-space ID this instance watches in Yunxiao.' } },
      { key: 'DSH_SUPERAGENT_PROJEX_ORG',
        description: { zh: '本实例的云效组织 ID（organizationId）。', en: 'Yunxiao organization ID (organizationId) of this instance.' } },
    ],
    values: ({ config }) => ({ DSH_SUPERAGENT_PROJEX_PROJECT: config.project, DSH_SUPERAGENT_PROJEX_ORG: config.organizationId }),
  },
}