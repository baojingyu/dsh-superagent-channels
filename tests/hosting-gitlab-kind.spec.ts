/** The GitLab Source kind: identity and health, the shared configuration plus its own fields, and the execution environment. */
import { describe, expect, it } from 'vitest'
import { gitlabKind, type GitlabKindConfig } from '../src/sources/hosting/gitlab/kind.ts'
import { testDeployment } from './fixtures/deployment.ts'

const config: GitlabKindConfig = { project: 'team/app', tokenFile: '/home/agent/gitlab-token',
  hostUrl: 'https://gitlab.example.com:8443/', organizationId: 'org-1' }

/** The schema's keys in declaration order, which the form fields must mirror. */
const schemaKeys = (schema: unknown): string[] => Object.keys((schema as { shape: Record<string, unknown> }).shape)

describe('gitlabKind', () => {
  it('is the gitlab hosting kind with its own identity, health entry, and shared channel', () => {
    expect(gitlabKind.kind).toBe('gitlab')
    expect(gitlabKind.title).toEqual({ zh: 'GitLab', en: 'GitLab' })
    expect(gitlabKind.health).toEqual(['gitlab'])
    expect(gitlabKind.channel?.capabilities).toEqual({ idempotency: 'marker', markdown: true })
    expect(typeof gitlabKind.scope).toBe('function')
  })

  it('validates the shared hosting configuration and the central-version organization', () => {
    expect(gitlabKind.schema.safeParse({ tokenFile: '/t' }).success).toBe(false)
    expect(gitlabKind.schema.safeParse({ project: '', tokenFile: '/t' }).success).toBe(false)
    expect(gitlabKind.schema.safeParse({ project: 'team/app', tokenFile: '/t', organizationId: 'org-1', hostUrl: 'https://gitlab.example.com' }).success).toBe(true)
    expect(gitlabKind.schema.parse({ project: 'team/app', tokenFile: '/t' })).toMatchObject({ project: 'team/app', tokenFile: '/t', pollSeconds: 60 })
    // The shared schema stays strict: an unlisted key is refused.
    expect(gitlabKind.schema.safeParse({ project: 'team/app', tokenFile: '/t', unknown: 1 }).success).toBe(false)
  })

  it('keeps the form fields aligned with the schema keys and marks the central-version field advanced', () => {
    expect(gitlabKind.fields.map(field => field.key)).toEqual(['project', 'tokenFile', 'pollSeconds', 'organizationId', 'hostUrl'])
    expect(gitlabKind.fields.map(field => field.key)).toEqual(schemaKeys(gitlabKind.schema))
    expect(gitlabKind.fields.find(field => field.key === 'organizationId')).toMatchObject({ type: 'text', advanced: true })
    expect(gitlabKind.fields.find(field => field.key === 'hostUrl')).toMatchObject({ type: 'text' })
  })

  it('computes the execution environment from the instance configuration', () => {
    expect(gitlabKind.environment?.variables.map(variable => variable.key))
      .toEqual(['DSH_SUPERAGENT_GITLAB_PROJECT', 'DSH_SUPERAGENT_GITLAB_HOST'])
    expect(gitlabKind.environment!.values({ deployment: testDeployment(), config }))
      .toEqual({ DSH_SUPERAGENT_GITLAB_PROJECT: 'team/app', DSH_SUPERAGENT_GITLAB_HOST: 'gitlab.example.com' })
    // An unset or unparsable address leaves the host empty rather than failing the environment.
    expect(gitlabKind.environment!.values({ deployment: testDeployment(), config: { project: 'team/app', tokenFile: '/t' } }))
      .toEqual({ DSH_SUPERAGENT_GITLAB_PROJECT: 'team/app', DSH_SUPERAGENT_GITLAB_HOST: '' })
    expect(gitlabKind.environment!.values({ deployment: testDeployment(), config: { project: 'team/app', tokenFile: '/t', hostUrl: 'not a url' } }))
      .toEqual({ DSH_SUPERAGENT_GITLAB_PROJECT: 'team/app', DSH_SUPERAGENT_GITLAB_HOST: '' })
  })

  it('maps a merge request Trigger onto the pulls row through the shared factory', () => {
    expect(gitlabKind.scope!({ meta: { kind: 'pull', number: 3 } }, config)).toMatchObject({ listened: true, observed: true, row: 'pulls' })
    expect(gitlabKind.scope!({ meta: { ci: true, branch: 'main' } }, config)).toMatchObject({ listened: true, row: 'ci' })
  })
})