/** A Projex work item is admitted by the Policy: assigned to a listed member is work, unlisted is refused. */
import { describe, expect, it } from 'vitest'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { projexKind } from '../src/sources/work/projex/kind.ts'
import { workTrigger } from '../src/sources/work/stream.ts'
import type { Thread } from '../src/core/index.ts'
import type { WorkItem } from '../src/sources/work/port.ts'

const PROJECT = 'proj-1'
const MEMBER = 'acc-owner'

const workItem = (overrides: Partial<WorkItem> = {}): WorkItem => ({
  key: 'AB-1', serial: 'PROJ-1', category: 'requirement', title: '做一件事', body: '把这个功能做出来',
  author: { id: MEMBER }, status: { id: 's1', name: '待处理' }, url: '',
  createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T01:00:00.000Z', ...overrides,
})

const thread = (): Thread => ({
  key: 'projex:AB-1', ref: { source: 'projex', id: 'AB-1' }, createdAt: '2026-11-09T00:00:00.000Z',
  subscriptions: [], correlated: [], pending: [], meta: {},
})

const settings = (allowed: { id: string; name?: string }[], mode = 'observe', admission: Record<string, unknown> = {}) =>
  SettingsSchema.parse({
    eval: { mode },
    policy: { sources: { projex: { allowed, ...Object.keys(admission).length ? { admission } : {} } } },
  // An installed but disabled Source is not listened to at all, so the fixture enables it: the point here is the list.
  sources: { projex: { enabled: true, config: { project: PROJECT, tokenFile: '/tmp/projex.token',
    organizationId: 'org-1' } } },
})

const gateFor = (allowed: { id: string; name?: string }[], mode = 'observe', admission: Record<string, unknown> = {}) => {
  const value = settings(allowed, mode, admission)
  const registry = new SourceRegistry(() => value)
  registry.register(projexKind)
  return { policy: settingsPolicy(value, registry), registry }
}

describe('Projex admission', () => {
  it('never claims an address, because no field of a work item names the agent', () => {
    // This is what makes the admission table the authority: the item cannot be an explicit request on its own.
    expect(workTrigger(workItem({ assignee: { id: MEMBER } }), 'projex', PROJECT).addressed).toBeUndefined()
    expect(workTrigger(workItem(), 'projex', PROJECT).addressed).toBeUndefined()
    // The responsible person decides which column it falls in: the assignee, else the creator.
    expect(workTrigger(workItem({ assignee: { id: 'acc-other' } }), 'projex', PROJECT).actor.id).toBe('acc-other')
    expect(workTrigger(workItem(), 'projex', PROJECT).actor.id).toBe(MEMBER)
  })

  it('falls in the listed column, and does exactly what that column says', () => {
    const trigger = workTrigger(workItem({ assignee: { id: MEMBER } }), 'projex', PROJECT)
    // An item on a listed member is a candidate - "允许推断" - and nothing more without auto mode.
    expect(gateFor([{ id: MEMBER, name: 'Owner' }]).policy.gate(trigger, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred' })
    // Configured as "忽略", it is refused: that is what "配置什么就做什么" means.
    expect(gateFor([{ id: MEMBER }], 'observe', { requirements: { listedUnaddressed: 'ignore' } })
      .policy.gate(trigger, thread(), [])).toMatchObject({ admissible: false, reason: 'admission_ignored' })
  })

  it('refuses an unlisted member, and says the list is why', () => {
    const { policy } = gateFor([])
    const trigger = workTrigger(workItem({ assignee: { id: MEMBER } }), 'projex', PROJECT)
    expect(policy.gate(trigger, thread(), [])).toMatchObject({ admissible: false, reason: 'not_a_member' })
  })

  it('keeps an unassigned item of a listed member an inferred candidate, which needs auto mode', () => {
    const trigger = workTrigger(workItem(), 'projex', PROJECT)
    // Observe mode never accepts an inferred candidate; it records what it would have taken.
    expect(gateFor([{ id: MEMBER }]).policy.gate(trigger, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred' })
    expect(gateFor([{ id: MEMBER }], 'auto').policy.gate(trigger, thread(), []))
      .toMatchObject({ admissible: true, strength: 'inferred' })
    // With everybody refused, so is the backlog.
    expect(gateFor([]).policy.gate(trigger, thread(), [])).toMatchObject({ admissible: false, reason: 'not_a_member' })
  })

  it('offers the rows and cells the other kinds offer: received or not, and no mention column', () => {
    const policy = projexKind.policy!
    const rows = policy.rows!({ categories: ['requirement', 'task'] })
    expect(rows.map(row => row.id)).toEqual(['requirements', 'bugs', 'tasks'])
    // A category the instance does not poll has nothing to admit, exactly like GitHub's CI row when it is off.
    expect(rows[0]).toMatchObject({ note: { zh: '接收' }, cells: { listedUnaddressed: true, unlistedAddressed: false, unlistedUnaddressed: true } })
    expect(rows[1]).toMatchObject({ note: { zh: '不接收' }, cells: { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false } })
    // Nothing about a work item mentions the agent, so that column is a dash in every row.
    expect(rows.every(row => row.cells.unlistedAddressed === false)).toBe(true)
    expect(policy.warnings!({}, { allowed: [] })).toHaveLength(1)
    expect(policy.warnings!({}, { allowed: [{ id: MEMBER }] })).toHaveLength(0)
    // The panel labels the list and says an id, not a name, is what it holds.
    expect(policy.fields[0]!.key).toBe('allowed')
  })
})
