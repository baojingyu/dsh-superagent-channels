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
})
