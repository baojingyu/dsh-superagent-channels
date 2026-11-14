/** Per-item execution environment of a work Source: which work item a worker is on, and where that item lives. */
import type { EnvironmentInput, SourceKind, VariableSpec } from '../kind.ts'
import { projectOf } from './context.ts'

/** Variables and values a host adds to the shared set, such as a Projex organization ID or a GitLab base URL. */
export interface WorkEnvironmentAddition<C> {
  variables: readonly VariableSpec[]
  values(input: EnvironmentInput<C>): Record<string, string>
}

/** The status of a Trigger's item as one readable value: the host's name for it, else its id. */
function statusOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const status = value as { name?: unknown; id?: unknown }
  return typeof status.name === 'string' && status.name ? status.name : typeof status.id === 'string' ? status.id : ''
}

/**
 * The environment a work kind publishes.
 *
 * A worker that does not know which work item it is on can only answer in its own chat: it cannot name the item in a
 * commit message, cannot write the item's serial into a pull request, and cannot tell a person reading the board which
 * item it meant. So the item's identity is exported per ticket, the same way the GitHub kind exports a repository and a
 * number. Values come from the Trigger the ticket started from; a ticket that did not start on this host sees empty
 * values, which is what the GitHub kind does with its own keys.
 */
export function workEnvironment<C extends Record<string, unknown>>(host: string,
  extra?: WorkEnvironmentAddition<C>): NonNullable<SourceKind<C>['environment']> {
  const prefix = `DSH_SUPERAGENT_${host.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`
  const variables: VariableSpec[] = [
    { key: `${prefix}_PROJECT`, description: { zh: '本实例监听的项目空间 ID；工单不是从工作项来的时为空。',
      en: 'The project space this instance watches; empty when the ticket did not start on a work item.' } },
    { key: `${prefix}_WORKITEM`, description: { zh: '接下工单的工作项 ID（宿主自己的句柄，云效是 workitem id）；工单不是从工作项来的时为空。',
      en: 'ID of the work item that started the ticket, in the host\'s own form (a Yunxiao work-item id); empty when the ticket did not start on a work item.' } },
    { key: `${prefix}_SERIAL`, description: { zh: '工作项对人显示时的编号（云效形如 ESFX-6228）；回复、提交与 PR 里引用工作项就用它。',
      en: 'The number people use for the work item (Yunxiao `ESFX-6228`); cite this when naming the item in a reply, a commit or a pull request.' } },
    { key: `${prefix}_CATEGORY`, description: { zh: '工作项类别：需求 / 缺陷 / 任务；工单不是从工作项来的时为空。',
      en: 'Work-item category: requirement, bug or task; empty when the ticket did not start on a work item.' } },
    { key: `${prefix}_STATUS`, description: { zh: '工单开始时工作项的状态名，用来判断它是不是又被人改回去了。',
      en: 'The item\'s status name when the ticket started, so a worker can tell whether somebody moved it since.' } },
    { key: `${prefix}_URL`, description: { zh: '工作项在本实例里的页面地址；工单不是从工作项来的时为空。',
      en: 'Page address of the work item on this instance; empty when the ticket did not start on a work item.' } },
    ...extra?.variables ?? [],
  ]
  return {
    variables,
    values: (input: EnvironmentInput<C>) => {
      const address = input.trigger?.channel?.address ?? {}
      const meta = input.trigger?.meta ?? {}
      return {
        [`${prefix}_PROJECT`]: address.project ?? projectOf(input.config),
        [`${prefix}_WORKITEM`]: address.key ?? (typeof meta.identifier === 'string' ? meta.identifier : ''),
        [`${prefix}_SERIAL`]: address.serial ?? (typeof meta.serial === 'string' ? meta.serial : ''),
        [`${prefix}_CATEGORY`]: typeof meta.category === 'string' ? meta.category : '',
        [`${prefix}_STATUS`]: statusOf(meta.status),
        [`${prefix}_URL`]: input.trigger?.url ?? '',
        ...extra?.values?.(input) ?? {},
      }
    },
  }
}
