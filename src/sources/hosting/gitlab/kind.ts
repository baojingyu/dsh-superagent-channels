/**
 * GitLab Source kind: the shared hosting factory (`hostingKind`) over the GitLab adapter, plus the instance's
 * execution environment variables. No domain logic lives here — merge request, note, and CI semantics stay in the adapter.
 */
import { z } from 'zod'
import type { FieldSpec, SourceKind } from '../../kind.ts'
import { hostingKind, type HostingMeta } from '../kind.ts'
import { gitlabAdapter } from './adapter.ts'

/**
 * Configuration of one GitLab instance: the shared hosting keys, the organization of a central GitLab (empty on a
 * self-hosted one), and the instance address used as the API base and the origin of merge request links.
 */
export interface GitlabKindConfig extends Record<string, unknown> {
  project: string
  tokenFile: string
  pollSeconds?: number
  /** Organization ID of a central GitLab; absent on a self-hosted instance. */
  organizationId?: string
  /** Origin of the GitLab instance, such as `https://gitlab.example.com`; instance wiring builds the API with it. */
  hostUrl?: string
}

/** The shared form fields, then the GitLab-only ones; their order matches the schema's keys. */
const FIELDS: FieldSpec[] = [
  { key: 'organizationId', type: 'text', advanced: true, label: { zh: '组织 ID（中心版）', en: 'Organization ID (central version)' },
    hint: { zh: '只有中心版 GitLab 需要组织 ID；自建 GitLab 留空。', en: 'Only a central GitLab needs an organization ID; leave it empty on a self-hosted instance.' } },
  { key: 'hostUrl', type: 'text', label: { zh: '实例地址', en: 'Instance URL' },
    hint: { zh: '自建 GitLab 的地址，例如 https://gitlab.example.com；用作 API 基址和合并请求链接的 origin。', en: 'Address of the GitLab instance, such as https://gitlab.example.com; used as the API base and the origin of merge request links.' } },
]

/** Identity and extra configuration of the GitLab kind; the rest comes from the shared hosting factory. */
const META: HostingMeta = {
  host: 'gitlab',
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '自建 GitLab 的合并请求、评论与流水线 CI；收到发给智能体的讨论后起工单，并以评论回复。',
    en: 'Merge requests, notes, and pipeline CI on a self-hosted GitLab; discussion addressed to the agent becomes a ticket, answered in a note.' },
  extraFields: FIELDS,
  extraSchema: { organizationId: z.string().optional(), hostUrl: z.string().optional() },
}

/** The hostname of the instance URL, or empty when it is unset or not a URL. */
function hostnameOf(url: string | undefined): string {
  if (!url) return ''
  try { return new URL(url).hostname } catch { return '' }
}

/** The GitLab SourceKind: the hosting factory's identity, schema, fields, scope, and channel, plus its environment. */
export const gitlabKind: SourceKind<GitlabKindConfig> = {
  ...hostingKind<GitlabKindConfig>(gitlabAdapter, META),
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT', description: { zh: '这个来源监听的 GitLab 项目路径，写作 group/project。', en: 'GitLab project path this Source watches, written group/project.' } },
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: '这个来源所用 GitLab 实例的主机名，例如 gitlab.example.com。', en: 'Hostname of the GitLab instance this Source uses, such as gitlab.example.com.' } },
    ],
    values: ({ config }) => ({ DSH_SUPERAGENT_GITLAB_PROJECT: config.project, DSH_SUPERAGENT_GITLAB_HOST: hostnameOf(config.hostUrl) }),
  },
}