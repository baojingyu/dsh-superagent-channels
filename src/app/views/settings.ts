/** Settings view combining versioned configuration blocks, per-source forms and policy metadata, and execution environment details. */
import { SETUP_FIELDS } from '../../deployment.ts'
import { KV } from '../../kv.ts'
import { policyVersion, type Settings } from '../../policy.ts'
import { kindOf } from '../../sources/instance.ts'
import type { SourceRegistry } from '../../sources/registry.ts'
import { declaredVariables, executionRoot } from '../execution-environment.ts'
import type { Store } from '../store.ts'
import { problemOf, sourceHealth, type HealthMap, type SetupState } from './sources.ts'

/**
 * The Policy block of one Source instance: its own stored part when it has one, else its kind's part, so a named instance
 * (whose ID is not its kind) keeps the policy its kind declares. A default instance reads the part under its own name,
 * which is its kind.
 */
export function policyOf(settings: Settings, sources: SourceRegistry, id: string, health: HealthMap) {
  const kind = kindOf(settings.sources[id], id)
  const policy = sources.kind(kind)?.policy
  if (!policy) return {}
  const part = sources.policyPart(settings.policy.sources[id] ? id : kind)!
  const config = sources.instance(id)?.config ?? {}
  const sync = policy.sync && { label: policy.sync.label, ready: policy.sync.ready(part), health: health[`sync:${kind}`] }
  const warnings = policy.warnings?.(config, part) ?? []
  return { policy: { fields: policy.fields, explicit: policy.explicit, ...policy.rows ? { rows: policy.rows(config) } : {},
    ...warnings.length ? { warnings } : {}, ...sync
    ? { sync } : {} } }
}
/**
 * Builds the settings view by block (`{ value, revision }`), per-Source configuration and restart-sensitive fields,
 * and execution environment details (`stateDir` provides the default ticket working directory root).
 */
export function settingsView(store: Store, sources: SourceRegistry, health: HealthMap, setup: SetupState, stateDir: string) {
  const settings = store.settings()
  const block = <V>(name: 'policy' | 'eval' | 'executor', value: V) => ({ value, revision: store.blockRevision(name) })
  return {
    policyVersion: policyVersion(settings),
    blocks: { policy: block('policy', settings.policy), eval: block('eval', settings.eval), executor: block('executor',
      settings.executor) },
    sources: sources.instances(settings).map(instance => {
      const kind = sources.kind(instance.kind)
      const problem = problemOf(instance.kind, setup)
      const { id, title } = sourceHealth(sources, instance, health)
      return { id, kind: instance.kind, title, description: kind?.description ?? { zh: '', en: '' }, installed: instance.installed,
        value: { enabled: instance.enabled, config: instance.config }, revision: store.blockRevision(`source:${instance.id}`),
        restarts: SETUP_FIELDS[instance.kind] ?? [], fields: kind?.fields ?? [], facts: kind?.facts?.(setup.deployment) ?? {},
        labels: store.get(KV.sources.labels(instance.id)) ?? {}, ...problem ? { problem } : {}, ...policyOf(settings, sources, instance.id, health) }
    }),
    environment: { root: executionRoot(settings, stateDir), variables: declaredVariables(sources, settings) },
  }
}
export type SettingsView = ReturnType<typeof settingsView>
export type SourceSettingsView = SettingsView['sources'][number]
