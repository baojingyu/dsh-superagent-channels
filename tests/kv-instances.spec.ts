/** Instance dimension of health entries and KV families: each instance of one kind reports and reads apart from its siblings. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { healthEntry } from '../src/sources/host.ts'

const HR = 'wecom-hr'
const OPS = 'wecom-ops'
const at = '2026-01-01T00:00:00.000Z'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'kv-instances-'))
  store = new Store(join(directory, 'db.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('names a health entry as 实例:条目, so two instances of one kind report the same entry apart', () => {
  expect(healthEntry('wecom-hr', 'wecom')).toBe('wecom-hr:wecom')
  expect(healthEntry('wecom-ops', 'wecom')).toBe('wecom-ops:wecom')
  expect(healthEntry('wecom-ops', 'wecom')).not.toBe(healthEntry('wecom-hr', 'wecom'))
  expect(healthEntry('wecom-hr', 'history')).toBe('wecom-hr:history')
})

it('keeps every new family per instance: one logical key under two instances is two store keys, and neither overwrites the other', () => {
  // hosting: cursor, notes per Issue/PR number, CI per number, default-branch CI, and tracked work items.
  expect([KV.hosting.cursor(HR), KV.hosting.cursor(OPS)]).toEqual(['hosting-cursor:wecom-hr', 'hosting-cursor:wecom-ops'])
  store.set(KV.hosting.cursor(HR), `${at}`); store.set(KV.hosting.cursor(OPS), '2026-01-02T00:00:00.000Z')
  expect([store.get(KV.hosting.cursor(HR)), store.get(KV.hosting.cursor(OPS))]).toEqual([at, '2026-01-02T00:00:00.000Z'])
  expect([KV.hosting.notes(HR, 3), KV.hosting.notes(OPS, 3), KV.hosting.notes(HR, 4)])
    .toEqual(['hosting-notes:wecom-hr:3', 'hosting-notes:wecom-ops:3', 'hosting-notes:wecom-hr:4'])
  store.set(KV.hosting.notes(HR, 3), at); store.set(KV.hosting.notes(OPS, 3), '2026-01-03T00:00:00.000Z')
  expect([store.get(KV.hosting.notes(HR, 3)), store.get(KV.hosting.notes(OPS, 3))]).toEqual([at, '2026-01-03T00:00:00.000Z'])
  expect([KV.hosting.ci(HR, 3), KV.hosting.ci(OPS, 3)]).toEqual(['hosting-ci:wecom-hr:3', 'hosting-ci:wecom-ops:3'])
  store.set(KV.hosting.ci(HR, 3), { fingerprint: 'hr', revision: 1 }); store.set(KV.hosting.ci(OPS, 3), { fingerprint: 'ops', revision: 2 })
  expect([store.get(KV.hosting.ci(HR, 3)), store.get(KV.hosting.ci(OPS, 3))]).toEqual([{ fingerprint: 'hr', revision: 1 }, { fingerprint: 'ops', revision: 2 }])
  expect([KV.hosting.branchCi(HR), KV.hosting.branchCi(OPS)]).toEqual(['hosting-branch-ci:wecom-hr', 'hosting-branch-ci:wecom-ops'])
  store.set(KV.hosting.branchCi(HR), { branch: 'main', failures: ['test'], revision: 1 })
  store.set(KV.hosting.branchCi(OPS), { branch: 'main', failures: [], revision: 2 })
  expect([store.get(KV.hosting.branchCi(HR)), store.get(KV.hosting.branchCi(OPS))])
    .toEqual([{ branch: 'main', failures: ['test'], revision: 1 }, { branch: 'main', failures: [], revision: 2 }])
  expect([KV.hosting.tracked(HR), KV.hosting.tracked(OPS)]).toEqual(['hosting-tracked:wecom-hr', 'hosting-tracked:wecom-ops'])
  store.set(KV.hosting.tracked(HR), ['7']); store.set(KV.hosting.tracked(OPS), ['8'])
  expect([store.get(KV.hosting.tracked(HR)), store.get(KV.hosting.tracked(OPS))]).toEqual([['7'], ['8']])

  // chat: delivered message IDs, per-chat history cursor, per-thread seen IDs, and per-chat active topics.
  expect([KV.chat.delivered(HR), KV.chat.delivered(OPS)]).toEqual(['chat-delivered:wecom-hr', 'chat-delivered:wecom-ops'])
  store.set(KV.chat.delivered(HR), ['om_hr']); store.set(KV.chat.delivered(OPS), ['om_ops'])
  expect([store.get(KV.chat.delivered(HR)), store.get(KV.chat.delivered(OPS))]).toEqual([['om_hr'], ['om_ops']])
  expect([KV.chat.history(HR, 'oc_1'), KV.chat.history(OPS, 'oc_1')]).toEqual(['chat-history:wecom-hr:oc_1', 'chat-history:wecom-ops:oc_1'])
  store.set(KV.chat.history(HR, 'oc_1'), at); store.set(KV.chat.history(OPS, 'oc_1'), '2026-01-04T00:00:00.000Z')
  expect([store.get(KV.chat.history(HR, 'oc_1')), store.get(KV.chat.history(OPS, 'oc_1'))]).toEqual([at, '2026-01-04T00:00:00.000Z'])
  expect([KV.chat.seen(HR, 'oc_1:om_1'), KV.chat.seen(OPS, 'oc_1:om_1')]).toEqual(['chat-seen:wecom-hr:oc_1:om_1', 'chat-seen:wecom-ops:oc_1:om_1'])
  store.set(KV.chat.seen(HR, 'oc_1:om_1'), ['om_1']); store.set(KV.chat.seen(OPS, 'oc_1:om_1'), ['om_2'])
  expect([store.get(KV.chat.seen(HR, 'oc_1:om_1')), store.get(KV.chat.seen(OPS, 'oc_1:om_1'))]).toEqual([['om_1'], ['om_2']])
  expect([KV.chat.topics(HR, 'oc_1'), KV.chat.topics(OPS, 'oc_1')]).toEqual(['chat-topics:wecom-hr:oc_1', 'chat-topics:wecom-ops:oc_1'])
  store.set(KV.chat.topics(HR, 'oc_1'), { omt_1: at }); store.set(KV.chat.topics(OPS, 'oc_1'), { omt_2: at })
  expect([store.get(KV.chat.topics(HR, 'oc_1')), store.get(KV.chat.topics(OPS, 'oc_1'))]).toEqual([{ omt_1: at }, { omt_2: at }])

  // work: notification cursor and per-key note read cursor.
  expect([KV.work.cursor(HR), KV.work.cursor(OPS)]).toEqual(['work-cursor:wecom-hr', 'work-cursor:wecom-ops'])
  store.set(KV.work.cursor(HR), at); store.set(KV.work.cursor(OPS), '2026-01-05T00:00:00.000Z')
  expect([store.get(KV.work.cursor(HR)), store.get(KV.work.cursor(OPS))]).toEqual([at, '2026-01-05T00:00:00.000Z'])
  expect([KV.work.notes(HR, 'T-1'), KV.work.notes(OPS, 'T-1')]).toEqual(['work-notes:wecom-hr:T-1', 'work-notes:wecom-ops:T-1'])
  store.set(KV.work.notes(HR, 'T-1'), at); store.set(KV.work.notes(OPS, 'T-1'), '2026-01-06T00:00:00.000Z')
  expect([store.get(KV.work.notes(HR, 'T-1')), store.get(KV.work.notes(OPS, 'T-1'))]).toEqual([at, '2026-01-06T00:00:00.000Z'])

  // Listing a family's prefix lists the keys of every instance, and each instance's own keys stay apart.
  expect(store.keys(KV.hosting.cursor).sort()).toEqual([KV.hosting.cursor(HR), KV.hosting.cursor(OPS)].sort())
  expect(store.keys(KV.chat.history).sort()).toEqual([KV.chat.history(HR, 'oc_1'), KV.chat.history(OPS, 'oc_1')].sort())
  expect(store.keys(KV.work.notes).sort()).toEqual([KV.work.notes(HR, 'T-1'), KV.work.notes(OPS, 'T-1')].sort())
})

it('still reads and writes the families a single-instance kind used before', () => {
  // github
  expect([KV.github.since, KV.github.retries, KV.github.branchCi]).toEqual(['github-since', 'github-retry', 'github-branch-ci'])
  store.set(KV.github.since, at)
  store.set(KV.github.retries, { 7: { since: at, pr: true } })
  store.set(KV.github.cursor(7), at)
  store.set(KV.github.branchCi, { branch: 'main', failures: ['test'], revision: 1 })
  store.set(KV.github.ci(7), { fingerprint: 'f', revision: 1 })
  expect([store.get(KV.github.since), store.get(KV.github.retries), store.get(KV.github.cursor(7)),
    store.get(KV.github.branchCi), store.get(KV.github.ci(7))])
    .toEqual([at, { 7: { since: at, pr: true } }, at, { branch: 'main', failures: ['test'], revision: 1 }, { fingerprint: 'f', revision: 1 }])
  // feishu
  expect([KV.feishu.chats, KV.feishu.history('oc_1'), KV.feishu.topics('oc_1'), KV.feishu.seen('oc_1:om_1'), KV.feishu.initialized('oc_1:om_1')])
    .toEqual(['feishu-chats', 'feishu-history:oc_1', 'feishu-history-threads:oc_1', 'thread-seen:oc_1:om_1', 'thread-initialized:oc_1:om_1'])
  store.set(KV.feishu.chats, { oc_1: false })
  store.set(KV.feishu.history('oc_1'), at)
  store.set(KV.feishu.topics('oc_1'), { omt_1: at })
  store.set(KV.feishu.seen('oc_1:om_1'), ['om_1'])
  store.set(KV.feishu.initialized('oc_1:om_1'), true)
  expect([store.get(KV.feishu.chats), store.get(KV.feishu.history('oc_1')), store.get(KV.feishu.topics('oc_1')),
    store.get(KV.feishu.seen('oc_1:om_1')), store.get(KV.feishu.initialized('oc_1:om_1'))])
    .toEqual([{ oc_1: false }, at, { omt_1: at }, ['om_1'], true])
})