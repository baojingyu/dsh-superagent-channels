/** The Projex work kind built from the shared factory: identity, organization-aware schema, category rows, and environment. */
import { describe, expect, it } from 'vitest'
import { projexKind } from '../src/sources/work/projex/kind.ts'
import { testDeployment } from './fixtures/deployment.ts'

const storedConfig = (overrides: Record<string, unknown> = {}) =>
  ({ project: 'proj-1', tokenFile: '/tmp/projex-token', organizationId: 'org-1', ...overrides })
const config = () => projexKind.schema.parse(storedConfig())

describe('projexKind identity', () => {
  it('is the Projex kind built by workKind, with its own title and health entry', () => {
    expect(projexKind.kind).toBe('projex')
    expect(projexKind.title).toEqual({ zh: '云效 Projex', en: 'Yunxiao Projex' })
    expect(projexKind.health).toEqual(['projex'])
  })
  it('offers the shared configuration fields plus the organization ID field', () => {
    expect(projexKind.fields.map(field => field.key))
      .toEqual(['project', 'tokenFile', 'pollSeconds', 'writeBack', 'organizationId'])
  })
})

describe('projexKind schema', () => {
  it('defaults categories and write-back, and keeps the organization ID', () => {
    expect(config()).toMatchObject({ project: 'proj-1', organizationId: 'org-1',
      categories: ['requirement', 'bug', 'task'], writeBack: false })
  })
  it('requires a non-empty organizationId', () => {
    expect(() => projexKind.schema.parse({ project: 'proj-1', tokenFile: '/tmp/projex-token' })).toThrow(/organizationId/)
    expect(() => projexKind.schema.parse(storedConfig({ organizationId: '' }))).toThrow(/organizationId/)
  })
  it('still requires the project', () => {
    expect(() => projexKind.schema.parse({ tokenFile: '/tmp/projex-token', organizationId: 'org-1' })).toThrow(/project/)
  })
})

describe('projexKind scope', () => {
  it.each([
    ['requirement', 'requirements'],
    ['bug', 'bugs'],
    ['task', 'tasks'],
    ['risk', undefined],
  ] as const)('maps category %s to admission row %s', (category, row) => {
    expect(projexKind.scope!({ meta: { category } }, config())).toEqual(row
      ? { listened: true, observed: true, row }
      : { listened: true, observed: true })
  })
})

describe('projexKind environment', () => {
  it('exposes the project and organization variables with values from the instance config', () => {
    const environment = projexKind.environment!
    expect(environment.variables.map(variable => variable.key))
      .toEqual(['DSH_SUPERAGENT_PROJEX_PROJECT', 'DSH_SUPERAGENT_PROJEX_ORG'])
    expect(environment.values({ deployment: testDeployment(), config: config() })).toEqual({
      DSH_SUPERAGENT_PROJEX_PROJECT: 'proj-1',
      DSH_SUPERAGENT_PROJEX_ORG: 'org-1',
    })
  })
})

describe('projexKind channel', () => {
  it('still replies as a marker-idempotent comment', () => {
    expect(projexKind.channel!.capabilities).toEqual({ idempotency: 'marker', markdown: true, maxChars: 60000 })
  })
})