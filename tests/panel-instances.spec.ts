/**
 * Panel data-layer acceptance for multi-instance Sources, standing in for the three GUI checks that need a host restart:
 * two channel rows of one kind with their own health, deleting one instance, and starting from an old settings file.
 * It drives the real view functions (`sourcesStatus`, `settingsView`) over a real `Store` and `SourceRegistry`; the only
 * stub is the channel-link target, which returns a fixed URL/label (the views never need a resolved deployment).
 * Note: a status row carries `id`/`title`, not `kind` (see `ApiResponse<'GET sources'>`), so the per-instance kind is
 * asserted on `sources.instances()` and on `settingsView().sources` (which does expose `kind`).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { settingsView } from '../src/app/views/settings.ts'
import { sourcesStatus, type SetupState } from '../src/app/views/sources.ts'
import type { ChannelRef } from '../src/core/index.ts'
import { SETUP_FIELDS } from '../src/deployment.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { wecomKind } from '../src/sources/chat/wecom/kind.ts'
import { githubKind } from '../src/sources/github.ts'
import type { Health } from '../src/sources/host.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

let directory: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dsh-panel-instances-'))
  store = new Store(join(directory, 'orchestrator.sqlite'))
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

const links = (channel: ChannelRef) => ({ url: `https://example.test/${channel.source}`, label: { zh: channel.source, en: channel.source } })
/** The panel's kinds over the settings the Store holds. */
const registry = (kinds: readonly Parameters<SourceRegistry['register']>[0][] = [githubKind, wecomKind]) => {
  const sources = new SourceRegistry(() => store.settings())
  for (const kind of kinds) sources.register(kind)
  return sources
}
const wecom = (agentId: string) => ({ kind: 'wecom', enabled: true, config: { corpId: 'corp', corpSecret: 'secret', agentId } })
type Rows = ReturnType<typeof sourcesStatus>
const row = (rows: Rows, id: string) => {
  const found = rows.find(item => item.id === id)
  expect(found, `a row for ${id}`).toBeDefined()
  return found!
}
const part = (rows: Rows, id: string, name: string) => {
  const found = row(rows, id).health.find(item => item.name === name)
  expect(found, `the ${name} health of ${id}`).toBeDefined()
  return found!
}

it('shows one row per instance: two WeCom rows with different ids read their own health, and GitHub reads its own name', () => {
  store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: {} },
    'wecom-ops': wecom('1'), 'wecom-hr': wecom('2') } }))
  const health: Record<string, Health> = {
    github: { state: 'ready', detail: 'github is listening' },
    // Named instances report under `<instance>:<name>`; the default GitHub instance under its own name (`github`).
    'wecom-ops:wecom': { state: 'error', detail: 'ops is down' },
    'wecom-hr:wecom': { state: 'ready', detail: 'hr is listening' },
  }
  const sources = registry()
  const host = { store, sources, links }
  const rows = sourcesStatus(host, health, {})

  // GitHub first (its kind name sorts before wecom), then the two WeCom instances by instance id.
  expect(rows.map(item => item.id)).toEqual(['github', 'wecom-hr', 'wecom-ops'])
  const view = settingsView(store, sources, health, {}, '/tmp/state')
  // Both WeCom rows are one kind with two ids; the settings row exposes the kind, the status row is keyed by id.
  expect(view.sources.map(item => [item.id, item.kind])).toEqual([
    ['github', 'github'], ['wecom-hr', 'wecom'], ['wecom-ops', 'wecom']])
  expect(sources.instances().map(item => [item.id, item.kind])).toEqual([
    ['github', 'github'], ['wecom-hr', 'wecom'], ['wecom-ops', 'wecom']])
  expect(view.sources.filter(item => item.kind === 'wecom').map(item => item.id).sort()).toEqual(['wecom-hr', 'wecom-ops'])

  // The named instance reads `<instance>:<kind>`; the default instance reads its own name (which is its kind).
  expect(part(rows, 'wecom-ops', 'wecom')).toEqual({ name: 'wecom', state: 'error', detail: 'ops is down' })
  expect(part(rows, 'wecom-hr', 'wecom')).toEqual({ name: 'wecom', state: 'ready', detail: 'hr is listening' })
  expect(part(rows, 'github', 'github')).toEqual({ name: 'github', state: 'ready', detail: 'github is listening' })
  // The two WeCom rows do not see each other's entry, and GitHub never sees a `wecom` entry.
  expect(part(rows, 'wecom-ops', 'wecom').detail).not.toBe(part(rows, 'wecom-hr', 'wecom').detail)
  expect(row(rows, 'github').health.map(item => item.name)).toEqual(['github'])
  expect(row(rows, 'wecom-ops').health.map(item => item.name)).toEqual(['wecom', 'history'])
  // Restart-sensitive fields are looked up by kind, so both WeCom instances share the kind's (empty) list.
  expect(view.sources.find(item => item.id === 'github')!.restarts).toEqual(SETUP_FIELDS['github'])
  expect(view.sources.filter(item => item.kind === 'wecom').map(item => item.restarts)).toEqual([[], []])
})

it('drops the deleted instance: no orphan row and no leftover health reference', () => {
  store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: {} },
    'wecom-ops': wecom('1'), 'wecom-hr': wecom('2') } }))
  const health: Record<string, Health> = {
    github: { state: 'ready', detail: 'github is listening' },
    'wecom-ops:wecom': { state: 'ready', detail: 'ops is listening' },
    'wecom-hr:wecom': { state: 'error', detail: 'hr is down' },
  }
  // Deleting a row in the panel is a settings save without that instance.
  store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: {} }, 'wecom-ops': wecom('1') } }))
  const sources = registry()
  const host = { store, sources, links }
  const rows = sourcesStatus(host, health, {})

  expect(rows.map(item => item.id)).toEqual(['github', 'wecom-ops'])
  expect(rows.some(item => item.id === 'wecom-hr')).toBe(false)
  expect(sources.instances().map(item => item.id)).toEqual(['github', 'wecom-ops'])
  // The deleted instance's entry may still sit on the board, but no row reads it any more.
  expect(rows.every(item => item.health.every(entry => entry.detail !== 'hr is down'))).toBe(true)
  expect(part(rows, 'wecom-ops', 'wecom').detail).toBe('ops is listening')
  expect(settingsView(store, sources, health, {}, '/tmp/state').sources.map(item => item.id)).toEqual(['github', 'wecom-ops'])
})

it('starts from an old settings file: one row whose id is its kind, and a setup problem matched by kind', () => {
  // A pre-multi-instance file: no `kind` on the stored instance, and only the GitHub kind is installed.
  store.saveSettings(SettingsSchema.parse({ sources: { github: { enabled: true, config: {} } } }))
  const problem = new SetupError('agentCliUnset').problem
  const setup: SetupState = { problem }
  const sources = registry([githubKind])
  const host = { store, sources, links }
  const health: Record<string, Health> = { github: { state: 'ready', detail: 'github is listening' } }
  const rows = sourcesStatus(host, health, setup)

  expect(rows.map(item => [item.id, item.health.map(entry => entry.name)])).toEqual([['github', ['github']]])
  expect(sources.instances().map(item => [item.id, item.kind])).toEqual([['github', 'github']])
  expect(settingsView(store, sources, {}, setup, '/tmp/state').sources.map(item => [item.id, item.kind]))
    .toEqual([['github', 'github']])
  // The problem's place is the kind, not the instance id; the row finds it and reports the error.
  expect(problem.place).toBe('github')
  expect(row(rows, 'github').problem).toEqual(problem)
  expect(row(rows, 'github').state).toBe('error')
})
