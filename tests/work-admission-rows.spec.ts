/**
 * The Projex admission rows are built from the instance's own configuration, which also carries the host's keys.
 *
 * Regression: `rows()` validated that configuration with the work schema, which is strict, so the Projex instance's
 * `organizationId` was an unrecognised key - the settings view threw, and the panel reported `Invalid settings:` on save because
 * it could not build the form at all. Both the rows and the save payloads are covered here.
 */
import { describe, expect, it } from 'vitest'
import { PolicyConfigSchema, SettingsSchema } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { projexKind } from '../src/sources/work/projex/kind.ts'

/** The Projex instance configuration as it is stored: the shared work keys plus the host's own. */
const stored = {
  project: '8c4b28026499f283b3a0904766',
  tokenFile: 'C:\\Users\\Administrator\\projex-token.txt',
  categories: ['requirement', 'bug', 'task'],
  pollSeconds: 60,
  writeBack: true,
  organizationId: '63c655f4a0ad86aa2bfdfbeb',
}

describe('Projex admission rows', () => {
  it('builds the rows from a configuration that also holds the host keys', () => {
    const rows = projexKind.policy!.rows!(stored)
    expect(rows.map(row => row.id)).toEqual(['requirements', 'bugs', 'tasks'])
    expect(rows[0]).toMatchObject({ note: { zh: '接收' }, cells: { listedUnaddressed: true, unlistedAddressed: false } })
  })

  it('marks a category the instance does not poll as not received, and offers no cell for it', () => {
    const rows = projexKind.policy!.rows!({ ...stored, categories: ['requirement'] })
    const bugs = rows.find(row => row.id === 'bugs')!
    expect(bugs.note).toEqual({ zh: '不接收', en: 'Not received' })
    expect(bugs.cells).toEqual({ listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false })
  })

  it('survives a configuration that names no categories at all', () => {
    const rows = projexKind.policy!.rows!({ organizationId: 'org-1' })
    expect(rows).toHaveLength(3)
    expect(rows.every(row => row.note.zh === '接收')).toBe(true)
  })

  it('accepts the Policy and Source blocks the panel sends', () => {
    const policy = {
      rules: [],
      sources: { projex: { allowed: [{ id: '673c7f0d25be8f2424a64361', name: '鲍靖宇' }],
        admission: { requirements: { listedUnaddressed: 'ignore' } } } },
    }
    const parsedPolicy = PolicyConfigSchema.safeParse(policy)
    expect(parsedPolicy.success, JSON.stringify(parsedPolicy.error?.issues)).toBe(true)
    const registry = new SourceRegistry(() => SettingsSchema.parse({}))
    registry.register(projexKind)
    // The stored Source block validates against the kind's own schema, host keys included.
    expect(projexKind.schema.safeParse(stored).success).toBe(true)
    expect(registry.kind(projexKind.kind)).toBe(projexKind)
  })
})
