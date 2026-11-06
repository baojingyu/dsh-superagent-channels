/** Registry of installed Source kinds, their configured instances, and the Engine's SourceScope implementation. */
import type { ChannelRef, OutboundMessage, ScopeResult, SourceScope, Trigger } from '../core/index.ts'
import type { Commands } from '../infra/commands.ts'
import { HealthBoard, type HealthEntry } from '../infra/health.ts'
import { AdmissionTableSchema, type Settings } from '../policy.ts'
import { healthEntry } from './host.ts'
import { kindOf } from './instance.ts'
import type { ChannelHost, ChannelLink, ChannelLinks, SourceInstance, SourceKind, TriggerContext, VariableSpec } from './kind.ts'

/** Health entries claimed on behalf of named instances of one kind: instance ID → declared name → entry. */
type InstanceClaims = Map<string, Map<string, HealthEntry>>

/**
 * Manages registered SourceKind plugins, validates their instance and policy configurations, and implements SourceScope for the Engine.
 * Claims each registered kind's health entries on HealthBoard and mediates access to source channels, links, environment variables, and thread context readers for Runtime, Settings, Outbox, and MasterAssessor.
 * A kind may have many instances: an instance is identified by its settings key, and `kindOf` names the kind it belongs to.
 */
export class SourceRegistry implements SourceScope {
  private readonly kinds = new Map<string, SourceKind>()
  /** The default instances' health entries, by the name the kind declares (a kind's default instance's ID is the kind). */
  private readonly health = new Map<string, HealthEntry>()
  /** Named instances' health entries, claimed on first use: kind → instance ID → declared name → entry. */
  private readonly instanceClaims = new Map<string, InstanceClaims>()
  constructor(private readonly settings: () => Settings, private readonly board: Pick<HealthBoard, 'claim'> = new HealthBoard(),
    private readonly registered: (kind: SourceKind) => () => void = () => () => {}) {}

  /**
   * Registers a SourceKind, claims its health entries for its default instance on HealthBoard (rejecting `sync:` prefixes
   * owned by Settings), and returns an unregister disposer that releases them together with its other instances' entries.
   */
  register<C extends Record<string, unknown>>(kind: SourceKind<C>): () => void {
    if (this.kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
    const refused = (name: string) => new Error(`Source kind ${kind.kind} declares the health entry ${name}, which another part reports`)
    const synced = kind.health.find(name => name.startsWith('sync:'))
    if (synced) throw refused(synced)
    const entries = new Map<string, HealthEntry>()
    const claimed: InstanceClaims = new Map()
    const release = () => {
      for (const [name, entry] of entries) { entry.release(); this.health.delete(name) }
      for (const held of claimed.values()) for (const entry of held.values()) entry.release()
      this.instanceClaims.delete(kind.kind)
    }
    for (const name of kind.health) {
      try { entries.set(name, this.board.claim(name, { state: 'starting', detail: '' })) }
      catch { release(); throw refused(name) }
    }
    for (const [name, entry] of entries) this.health.set(name, entry)
    this.instanceClaims.set(kind.kind, claimed)
    this.kinds.set(kind.kind, kind as unknown as SourceKind)
    const unregistered = this.registered(kind as unknown as SourceKind)
    return () => { this.kinds.delete(kind.kind); release(); unregistered() }
  }
  /**
   * Returns the health entries of one instance of `kind`, by the name its kind declares. An instance whose ID is its kind
   * reports through the entries claimed at registration; any other instance claims its own `<instance>:<name>` entries on
   * first use, so two instances of one kind report separately. A Source context writes through the entries it received
   * when built, so reports sent after that registration ended do nothing even if the kind registers again.
   */
  healthEntries(instance: string, names: readonly string[], kind = instance): Map<string, HealthEntry> {
    if (instance === kind) return new Map(names.flatMap(name => { const entry = this.health.get(name); return entry ? [[name, entry] as const] : [] }))
    const registered = this.instanceClaims.get(kind)
    if (!registered) return new Map()
    const claimed = registered.get(instance) ?? new Map<string, HealthEntry>()
    registered.set(instance, claimed)
    return new Map(names.flatMap(name => {
      let entry = claimed.get(name)
      if (!entry) {
        try { entry = this.board.claim(healthEntry(instance, name), { state: 'starting', detail: '' }) }
        catch { return [] }
        claimed.set(name, entry)
      }
      return [[name, entry] as const]
    }))
  }
  kind(id: string): SourceKind | undefined { return this.kinds.get(id) }
  /** Every instance of every registered kind ordered by ID, followed by stored instances whose kind is not installed (with their config kept as stored). */
  instances(settings = this.settings()): (SourceInstance & { installed: boolean })[] {
    const stored = Object.entries(settings.sources)
    const installed = [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => {
      const own = stored.filter(([id, value]) => kindOf(value, id) === kind.kind)
      return own.length
        ? own.map(([id, value]) => ({ ...this.resolve(kind, id, value), installed: true })).sort((a, b) => a.id.localeCompare(b.id))
        : [{ ...this.resolve(kind, kind.kind, undefined), installed: true }]
    })
    const orphaned = stored.filter(([id, value]) => !this.kinds.has(kindOf(value, id)))
      .map(([id, value]) => ({ id, kind: kindOf(value, id), enabled: value.enabled, config: value.config, installed: false }))
    return [...installed, ...orphaned]
  }
  instance<C extends Record<string, unknown>>(id: string, settings = this.settings()): SourceInstance<C> | undefined {
    const kind = this.kinds.get(kindOf(settings.sources[id], id))
    return kind ? this.resolve(kind, id, settings.sources[id]) as SourceInstance<C> : undefined
  }
  validate(id: string, value: { enabled: boolean; config: unknown }): { enabled: boolean; config: Record<string, unknown> } {
    const kind = this.kinds.get(kindOf(this.settings().sources[id], id))
    if (!kind) throw new Error(`Source kind not installed: ${id}`)
    return { enabled: value.enabled, config: kind.schema.parse(value.config) }
  }
  /** Validates each Source's part of a submitted Policy against its kind; policy parts for uninstalled Source kinds are kept as stored. */
  validatePolicy(parts: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown> & { allowed: { id: string; name?: string }[] }> {
    return Object.fromEntries(Object.entries(parts).map(([id, part]) => {
      const policy = this.kinds.get(kindOf(this.settings().sources[id], id))?.policy
      // `admission` is validated by the Policy's own schema (shared across all kinds), while the kind validates the rest of its part.
      const { admission, ...rest } = part
      return [id, policy ? { ...policy.schema.parse(rest), admission: AdmissionTableSchema.parse(admission ?? {}) } : part as Record<string, unknown> & { allowed: { id: string; name?: string }[] }]
    }))
  }
  policyPart(id: string, settings = this.settings()) {
    const policy = this.kinds.get(kindOf(settings.sources[id], id))?.policy
    if (!policy) return undefined
    const { admission, ...rest } = settings.policy.sources[id] ?? {}
    const parsed = policy.schema.safeParse(rest)
    return { ...parsed.success ? parsed.data : policy.schema.parse({}), admission: AdmissionTableSchema.safeParse(admission ?? {}).data ?? {} }
  }
  channelAllowed(channel: { source: string; address: Record<string, string> }, settings = this.settings()): boolean {
    const kind = this.kinds.get(kindOf(settings.sources[channel.source], channel.source))
    if (!kind) return false
    const instance = this.resolve(kind, channel.source, settings.sources[channel.source])
    return instance.enabled && (kind.channel?.allowed?.(channel.address, instance.config) ?? true)
  }
  /** Environment variable declarations for every installed kind, whether enabled or disabled. */
  declarations(): { kind: string; variables: readonly VariableSpec[] }[] {
    return [...this.kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)).flatMap(kind => kind.environment ? [{ kind: kind.kind, variables: kind.environment.variables }] : [])
  }
  environments(settings = this.settings()) {
    return this.instances(settings).flatMap(instance => {
      const kind = this.kinds.get(instance.kind)
      return kind?.environment && instance.enabled ? [{ kind, environment: kind.environment, config: instance.config }] : []
    })
  }
  /**
   * Sends a message idempotently through its instance's Channel kind; returns `'waiting'` while the kind is not installed, or
   * `'gone'` when the target (or a kind without channels) can never receive it. The channel receives the instance's own config.
   */
  async send(message: OutboundMessage, commands: Commands): Promise<'sent' | 'gone' | 'waiting'> {
    const id = message.channel.source
    const settings = this.settings()
    const kind = this.kinds.get(kindOf(settings.sources[id], id))
    if (!kind) return 'waiting'
    if (!kind.channel) return 'gone'
    const { config } = this.resolve(kind, id, settings.sources[id])
    const host: ChannelHost = { commands, deployment: commands.deployment, config, instance: id }
    return kind.channel.send(host, message)
  }
  link(channel: ChannelRef, links: ChannelLinks): ChannelLink {
    const settings = this.settings()
    const kind = this.kinds.get(kindOf(settings.sources[channel.source], channel.source))
    if (!kind?.channel) return { url: '', label: { zh: channel.source, en: channel.source } }
    const { config } = this.resolve(kind, channel.source, settings.sources[channel.source])
    return kind.channel.link(channel.address, links, config)
  }
  find(query: string): { threads: string[]; terms: string[] } {
    const found = [...this.kinds.values()].flatMap(kind => kind.find ? [kind.find(query)] : [])
    return { threads: [...new Set(found.flatMap(item => item.threads))], terms: [...new Set(found.flatMap(item => item.terms))] }
  }
  repliesTo(trigger: Trigger): string | undefined { return this.kinds.get(trigger.source)?.repliesTo?.(trigger) }
  threadContext(trigger: Trigger, settings = this.settings()): TriggerContext | undefined {
    const id = trigger.source
    const kind = this.kinds.get(kindOf(settings.sources[id], id))
    const context = kind?.threadContext
    if (!kind || !context) return undefined
    const { config } = this.resolve(kind, id, settings.sources[id])
    return {
      messageId: context.messageId(trigger),
      read: (commands, part, cursor) => context.read(commands, trigger, part, cursor, config),
      images: text => context.images?.(text) ?? [],
      image: async (agent, commands, message, key, stateDir, signal) => {
        if (!context.image) throw new Error(`The ${kind.kind} Source has no images`)
        return context.image(agent, commands, trigger, message, key, stateDir, signal)
      },
    }
  }
  scope(input: { source: string; meta: Record<string, unknown> }, settings = this.settings()): ScopeResult {
    const stored = settings.sources[input.source]
    const kind = this.kinds.get(kindOf(stored, input.source))
    // Without its kind plugin the stored scope cannot be evaluated, so a configured Source whose plugin is missing listens to nothing.
    if (!kind) return stored ? { listened: false, reason: 'source_not_installed' } : { listened: true, observed: false }
    const instance = this.resolve(kind, input.source, stored)
    if (!instance.enabled) return { listened: false, reason: 'source_disabled' }
    return kind.scope ? kind.scope({ meta: input.meta }, instance.config) : { listened: true, observed: false }
  }
  /** Falls back to schema defaults and disables the instance when stored configuration fails validation. */
  private resolve(kind: SourceKind, id: string, stored: { enabled: boolean; config: Record<string, unknown> } | undefined): SourceInstance {
    const parsed = kind.schema.safeParse(stored?.config ?? {})
    return { id, kind: kind.kind, enabled: parsed.success && (stored?.enabled ?? true), config: parsed.success ? parsed.data : kind.schema.parse({}) }
  }
}