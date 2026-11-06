/** Projex source plugin entry: registers the kind bound to the instance's adapter and polls its work items on a timer. */
import type { Context } from '@deepseek-ai/cordis'
import { health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { createProjexAdapter } from './work/projex/adapter.ts'
import { projexKind, type ProjexKindConfig } from './work/projex/kind.ts'
import { workKind } from './work/kind.ts'
import { pollWorkItems } from './work/stream.ts'
import type { SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'

export const kind = projexKind
export const name = 'dsh-superagent-projex'
export const inject = ['orchestrator']

/** Health entry this kind reports through; its instance prefix is added by the registry. */
const HEALTH_ENTRY = projexKind.health[0] ?? projexKind.kind

/** The kind whose comment channel posts through an adapter bound to `config`; without one, the kind's unbound adapter reports it. */
function kindFor(config: ProjexKindConfig | undefined): SourceKind<ProjexKindConfig> {
  if (!config?.organizationId) return projexKind
  try {
    const adapter = createProjexAdapter({ organization: config.organizationId, tokenFile: config.tokenFile, writeBack: config.writeBack })
    const bound = workKind<ProjexKindConfig>(adapter,
      { kind: projexKind.kind, host: projexKind.kind, title: projexKind.title, description: projexKind.description, provider: true })
    // Identity, schema, fields, scope, and environment stay the kind's; only the channel is bound to this instance's adapter.
    return { ...projexKind, channel: bound.channel }
  } catch {
    // A binding failure must not keep the plugin from loading; a send reports the unbound adapter instead.
    return projexKind
  }
}

/** The configuration of this kind's stored instance; the kind is not registered yet, so it is read as a stored entry. */
function configured(sources: SourceRegistry): ProjexKindConfig | undefined {
  try {
    return sources.instances().find(instance => instance.kind === projexKind.kind)?.config as ProjexKindConfig | undefined
  } catch {
    // A kind whose schema requires fields throws from `instances()` until defaults exist; that just means "not set up".
    return undefined
  }
}

/** Enabled Projex instances to poll; an unconfigured kind has none, and that must not fail the plugin. */
function instancesOf(ctx: Context): string[] {
  try {
    return ctx.orchestrator.sources.instances()
      .filter(instance => instance.kind === projexKind.kind && instance.enabled)
      .map(instance => instance.id)
  } catch {
    return []
  }
}

/** The Source context of one instance, so its health entries are keyed by the instance id. */
function contextOf(ctx: Context, instance: string): SourceContext {
  const kind = { kind: projexKind.kind, id: instance, health: projexKind.health }
  return ctx.orchestrator.context(kind as unknown as { kind: string; health: readonly string[] })
}

/** Polls one instance: quiet while it is off or not configured, and any failure becomes that instance's error health. */
async function watch(source: SourceContext, instance: string, signal: AbortSignal): Promise<void> {
  await source.ready
  while (!signal.aborted) {
    const config = source.config<ProjexKindConfig>(instance)
    if (!config?.project) {
      if (!signal.aborted) source.report(HEALTH_ENTRY, health('paused', 'sourceOff'))
    } else {
      try {
        const adapter = createProjexAdapter({ organization: config.organizationId, tokenFile: config.tokenFile, writeBack: config.writeBack })
        const result = await pollWorkItems(source, adapter,
          { instance, project: config.project, categories: config.categories }, signal)
        if (!signal.aborted) {
          source.report(HEALTH_ENTRY, result.errors.length
            ? { state: 'error', detail: result.errors.join('; ') }
            : { state: 'ready', detail: `${result.received} work items; next poll ≥ ${config.pollSeconds ?? 60}s`,
              at: new Date().toISOString() })
        }
      } catch (error) {
        if (!signal.aborted) source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
      }
    }
    await pause((source.config<ProjexKindConfig>(instance)?.pollSeconds ?? 60) * 1000, signal)
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kindFor(configured(ctx.orchestrator.sources))), 'projex: source kind')
  ctx.effect(() => {
    const controller = new AbortController()
    // One controlled loop per enabled instance; a fresh settings load restarts the plugin and this effect with it.
    const running = Promise.all(instancesOf(ctx).map(instance => {
      const source = contextOf(ctx, instance)
      // A failure escaping the loop would terminate DSH, so it is reported as source health instead.
      return watch(source, instance, controller.signal)
        .catch((error: unknown) => { source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) }) })
    }))
    return async () => { controller.abort(); await running }
  }, 'projex: work polling')
}