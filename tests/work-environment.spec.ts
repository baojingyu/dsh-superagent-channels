/** The shared work execution environment: which work item a worker is on, and the host values a kind adds to it. */
import { describe, expect, it } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import { workEnvironment } from '../src/sources/work/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

const trigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 't1', source: 'projex', threads: [{ source: 'projex', id: 'ab12' }], actor: { source: 'projex', id: 'acc-7' },
  human: true, at: '2026-11-02T00:00:00.000Z', text: '登录失败', url: 'https://devops.aliyun.com/projex/project/proj-1/workitem/ESFX-6228',
  channel: { source: 'projex', thread: 'projex:ab12', address: { project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' } },
  meta: { category: 'bug', identifier: 'ab12', serial: 'ESFX-6228', status: { id: 's2', name: '处理中' } }, ...overrides })

describe('workEnvironment', () => {
  it('names its variables after the host, so two work hosts never overwrite each other', () => {
    const keys = workEnvironment<Record<string, unknown>>('gitlab-issues').variables.map(variable => variable.key)
    expect(keys).toEqual(['DSH_SUPERAGENT_GITLAB_ISSUES_PROJECT', 'DSH_SUPERAGENT_GITLAB_ISSUES_WORKITEM',
      'DSH_SUPERAGENT_GITLAB_ISSUES_SERIAL', 'DSH_SUPERAGENT_GITLAB_ISSUES_CATEGORY', 'DSH_SUPERAGENT_GITLAB_ISSUES_STATUS',
      'DSH_SUPERAGENT_GITLAB_ISSUES_URL'])
  })
  it('fills every variable from the Trigger a ticket started on', () => {
    const environment = workEnvironment<Record<string, unknown>>('projex')
    expect(environment.values({ deployment: testDeployment(), config: { project: 'proj-1' }, trigger: trigger() })).toEqual({
      DSH_SUPERAGENT_PROJEX_PROJECT: 'proj-1',
      DSH_SUPERAGENT_PROJEX_WORKITEM: 'ab12',
      DSH_SUPERAGENT_PROJEX_SERIAL: 'ESFX-6228',
      DSH_SUPERAGENT_PROJEX_CATEGORY: 'bug',
      DSH_SUPERAGENT_PROJEX_STATUS: '处理中',
      DSH_SUPERAGENT_PROJEX_URL: 'https://devops.aliyun.com/projex/project/proj-1/workitem/ESFX-6228',
    })
  })
  it('leaves the item values empty for a ticket that did not start on a work item, and keeps the project', () => {
    const environment = workEnvironment<Record<string, unknown>>('projex')
    const values = environment.values({ deployment: testDeployment(), config: { project: 'proj-1' },
      trigger: { ...trigger(), channel: undefined, meta: {}, url: undefined } })
    expect(values).toMatchObject({ DSH_SUPERAGENT_PROJEX_PROJECT: 'proj-1', DSH_SUPERAGENT_PROJEX_WORKITEM: '',
      DSH_SUPERAGENT_PROJEX_SERIAL: '', DSH_SUPERAGENT_PROJEX_CATEGORY: '', DSH_SUPERAGENT_PROJEX_STATUS: '',
      DSH_SUPERAGENT_PROJEX_URL: '' })
  })
  it('reads a status the host gives as a bare string, and an item address the Trigger carries in meta only', () => {
    const environment = workEnvironment<Record<string, unknown>>('projex')
    const values = environment.values({ deployment: testDeployment(), config: {},
      trigger: { ...trigger(), channel: undefined, meta: { identifier: 'ab12', serial: 'ESFX-1', category: 'task', status: '已完成' } } })
    expect(values).toMatchObject({ DSH_SUPERAGENT_PROJEX_WORKITEM: 'ab12', DSH_SUPERAGENT_PROJEX_SERIAL: 'ESFX-1',
      DSH_SUPERAGENT_PROJEX_CATEGORY: 'task', DSH_SUPERAGENT_PROJEX_STATUS: '已完成', DSH_SUPERAGENT_PROJEX_PROJECT: '' })
  })
  it('appends the variables and values a host adds, without dropping the shared ones', () => {
    const environment = workEnvironment<{ organizationId: string; project: string }>('projex', {
      variables: [{ key: 'DSH_SUPERAGENT_PROJEX_ORG', description: { zh: '组织', en: 'Organization' } }],
      values: ({ config }) => ({ DSH_SUPERAGENT_PROJEX_ORG: config.organizationId }),
    })
    expect(environment.variables.map(variable => variable.key)).toContain('DSH_SUPERAGENT_PROJEX_ORG')
    expect(environment.variables.map(variable => variable.key)).toHaveLength(7)
    expect(environment.values({ deployment: testDeployment(), config: { organizationId: 'org-1', project: 'proj-1' } }))
      .toMatchObject({ DSH_SUPERAGENT_PROJEX_ORG: 'org-1', DSH_SUPERAGENT_PROJEX_PROJECT: 'proj-1' })
  })
})
