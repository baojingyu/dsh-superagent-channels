/** GitLab source plugin entry: registers the kind bound to the instance's adapter and polls its merge requests, notes, and CI. */
import type { Context } from '@deepseek-ai/cordis'
import { createHostingApi } from '../infra/hosting-api.ts'
import { createGitlabAdapter } from './hosting/gitlab/adapter.ts'
import { gitlabKind, type GitlabKindConfig } from './hosting/gitlab/kind.ts'
import { hostingKind } from './hosting/kind.ts'
import { pollHosting, type HostingRound } from './hosting/stream.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'
import type { SourceRegistry } from './registry.ts'

export const kind = gitlabKind
export const name = 'dsh-superagent-multi-channel-gitlab'
export const inject = ['orchestrator']

/** The kind whose note channel posts through an adapter bound to `config`; without one, the kind's unbound adapter reports it. */
function kindFor(config: GitlabKindConfig | undefined): SourceKind<GitlabKindConfig> {
  if (!config?.hostUrl) return gitlabKind
  try {
    const api = createHostingApi({ baseUrl: config.hostUrl, tokenFile: config.tokenFile, projectWhitelist: [config.project] })
    const bound = hostingKind<GitlabKindConfig>(createGitlabAdapter(api),
      { host: gitlabKind.kind, title: gitlabKind.title, description: gitlabKind.description })
    // Identity, schema, fields, scope, and environment stay the kind's; only the channel is bound to this instance's adapter.
    return { ...gitlabKind, channel: bound.channel }
  } catch {
    // An unusable instance URL must not keep the plugin from loading; a send reports the unbound adapter instead.
    return gitlabKind
  }
}

/** The configuration of this kind's stored instance; the kind is not registered yet, so it is read as a stored entry. */
function configured(sources: SourceRegistry): GitlabKindConfig | undefined {
  return sources.instances().find(instance => instance.kind === gitlabKind.kind)?.config as GitlabKindConfig | undefined
}

/** One polling round: the instance's adapter for its current configuration, then a watermark scan of changes, notes, and CI. */
async function pollRound(ctx: SourceContext, config: GitlabKindConfig, signal: AbortSignal): Promise<HostingRound> {
  if (!config.hostUrl) return { scanned: 0, received: 0, overflow: 0 }
  const api = createHostingApi({ baseUrl: config.hostUrl, tokenFile: config.tokenFile, projectWhitelist: [config.project] })
  return pollHosting(ctx, createGitlabAdapter<GitlabKindConfig>(api), { instance: gitlabKind.kind, maxTrackedChanges: 50 }, signal)
}

/** Polls one GitLab instance every `pollSeconds`; an off or unconfigured Source stays quiet instead of erroring. */
async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  if (!ctx.configured()) { ctx.report(gitlabKind.kind, health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabKindConfig>(gitlabKind.kind)
    if (!config) ctx.report(gitlabKind.kind, health('paused', 'sourceOff'))
    else {
      try {
        const round = await pollRound(ctx, config, signal)
        if (!signal.aborted) {
          ctx.report(gitlabKind.kind, { state: 'ready', detail: `${round.received} triggers; next poll ≥ ${config.pollSeconds ?? 60}s`,
            at: new Date().toISOString() })
        }
      } catch (error) { if (!signal.aborted) ctx.report(gitlabKind.kind, { state: 'error', detail: String(error) }) }
    }
    // A stopped loop must not sleep a whole interval, so the pause resolves on abort.
    await pause((ctx.config<GitlabKindConfig>(gitlabKind.kind)?.pollSeconds ?? 60) * 1000, signal)
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kindFor(configured(ctx.orchestrator.sources))), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    // Unhandled rejections terminate the DSH process, so a failure escaping the polling loop is reported as source health instead.
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(gitlabKind.kind, { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  }, 'gitlab: polling loop')
}