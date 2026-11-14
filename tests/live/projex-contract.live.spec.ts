/**
 * Live read-only contract check of the Projex adapter against one real Yunxiao organisation.
 * Only `LIVE=1` runs it, and it reads: no comment is posted and no status is written.
 *
 * It exists because the adapter shipped against a route the gateway no longer has - `GET /listWorkitems` answered 404 for every
 * category - and only a real call could have shown that. Set `YUNXIAO_ORG`, `YUNXIAO_PROJECT` and `YUNXIAO_TOKEN_FILE`.
 */
import { describe, expect, it } from 'vitest'
import type { Commands } from '../../src/infra/commands.ts'
import { categoryOf, createProjexAdapter } from '../../src/sources/work/projex/adapter.ts'

const LIVE = process.env.LIVE === '1'
const ORG = process.env.YUNXIAO_ORG ?? ''
const PROJECT = process.env.YUNXIAO_PROJECT ?? ''
const TOKEN_FILE = process.env.YUNXIAO_TOKEN_FILE ?? ''
const commands = {} as unknown as Commands

describe.skipIf(!LIVE || !ORG || !PROJECT || !TOKEN_FILE)('Projex live contract', () => {
  const adapter = createProjexAdapter({ organization: ORG, tokenFile: TOKEN_FILE })

  it('lists the work items of every polled category with the search route', async () => {
    const page = await adapter.listWorkItems(commands, PROJECT, '', ['requirement', 'bug', 'task'])
    expect(page.items.length).toBeGreaterThan(0)
    for (const item of page.items.slice(0, 5)) {
      // Every field the Engine relies on is present and shaped as expected.
      expect(item.key, 'the API handle').not.toBe('')
      expect(item.serial).toMatch(/^[A-Z]+-\d+$/)
      expect(categoryOf(item.category)).toBe(item.category)
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('reads one work item by the serial a person uses, and finds it by its id', async () => {
    const page = await adapter.listWorkItems(commands, PROJECT, '', ['requirement'])
    const first = page.items[0]!
    const bySerial = await adapter.readWorkItem(commands, PROJECT, first.serial)
    expect(bySerial.serial).toBe(first.serial)
    const byId = await adapter.readWorkItem(commands, PROJECT, first.key)
    expect(byId.key).toBe(first.key)
  })

  it('lists comments as readable text, not as the JSON envelope the API stores', async () => {
    const page = await adapter.listWorkItems(commands, PROJECT, '', ['requirement'])
    for (const item of page.items.slice(0, 5)) {
      const notes = await adapter.listNotes(commands, PROJECT, item.key, undefined)
      for (const note of notes.notes) {
        expect(note.body.startsWith('{"'), `note ${note.id} still holds JSON`).toBe(false)
        expect(note.body).not.toContain('<article')
      }
    }
    expect(true).toBe(true)
  })

  it('reads the project roster, and every item it reads has a status that names an id', async () => {
    // The member list is what the Policy sync fills; a status id is what the write-back sends. Both are read here so a
    // route that moved shows up as a failing contract rather than as an empty picker in the panel.
    const members = await adapter.listMembers!(commands, PROJECT)
    for (const member of members) expect(member.id, 'a member id').not.toBe('')
    const page = await adapter.listWorkItems(commands, PROJECT, '', ['requirement', 'bug', 'task'])
    for (const item of page.items.slice(0, 20)) {
      expect(item.status.id, `status id of ${item.serial}`).not.toBe('')
    }
    // The Policy compares `allowed[].id` with the assignee, so at least one assignee must appear in the roster when both
    // sides have entries; this is the assumption ADR-009 records, and it fails loudly here if Yunxiao ever differs.
    const assignees = page.items.flatMap(item => item.assignee ? [item.assignee.id] : [])
    if (members.length && assignees.length) expect(members.map(member => member.id)).toEqual(expect.arrayContaining([assignees[0]!]))
  })

  it('reads the workflow status list a write-back status name resolves against', async () => {
    const statuses = await adapter.listStatuses!(commands, PROJECT, ['requirement', 'bug', 'task'])
    expect(statuses.length).toBeGreaterThan(0)
    for (const status of statuses) {
      expect(status.id, `status id of ${status.name}`).not.toBe('')
      expect(status.name.length).toBeGreaterThan(0)
    }
  })
})
