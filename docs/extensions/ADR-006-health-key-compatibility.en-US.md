# ADR-006 Health entry key compatibility: the default instance keeps its bare name

> Language: [English](ADR-006-health-key-compatibility.en-US.md) · [中文](ADR-006-health-key-compatibility.md)

- **Status**: Accepted (2026-11-06, confirmed during P0 implementation)
- **Decision scope**: the key shape of health entries in `SourceRegistry.healthEntries` / `sourceContextOf` / `views/sources.ts`
- **Related**: design document §6.6, §4.3; P0 delivery ticket §1.5; implementation task t3

## 1. Background

Design document §6.6/§4.3 requires that "health entries are always named `instance:entry`": one kind can have multiple instances, and only by splicing the instance ID into the key can two instances of the same kind each report their own health without conflicting. The original plan in P0 ticket §1.5 and §4 risk table R2 also says "the key is always `instance:entry`".

But P0's hard constraint is "zero behaviour change": settings in the old database, old panels, and existing ops scripts all read health entries by the bare names `github` / `feishu` / `history`. If everything were changed to `github:github`, the old panel would instantly be unable to read health after an upgrade, and rolling back to the old version would also be unable to read the new-shape keys.

## 2. Decision

- **The default instance (`id === kind`, such as `github`, `feishu`) keeps the bare-name entry claimed at registration**: `github`, `feishu`, `history`.
- **A named instance (`id !== kind`, such as `github-2`) lazily claims `${instance}:${entry}`**: `github-2:github`.
- Reasons:
  1. Old databases and old panels read with zero change; an upgrade needs to migrate no persisted data;
  2. Rollback is safe — the old version can still read the default instance's health by bare name;
  3. Named instances are a new concept with no historical baggage, so they adopt the canonical form directly.

## 3. Consequences

- **The key shape is asymmetric**: the default instance of a kind is `github`, while the second instance is `github-2:github`. Every new reader must know this rule.
- **views reads must "look at the bare name first, then the prefix"**: `entryOf` in `views/sources.ts` uses `instance.id === instance.kind ? name : healthEntry(instance.id, name)`; `sourceContextOf` passes `kind.id ?? kind.kind` to `healthEntries`, and `healthEntries` uses the registration-time bare-name entry when `instance === kind`, otherwise it lazily claims the prefixed entry.
- **Do not "unify it while you are at it"**: changing the default instance to `github:github` as well would immediately break the old panel and rollback compatibility, and is a migration that needs separate review.
- **Migration steps if unification is wanted in future**:
  1. New code double-writes and double-reads first: maintain both the bare-name and the `${instance}:${entry}` keys;
  2. Panels and views switch to the prefixed form first, keeping the bare name for one version as a fallback;
  3. Health is runtime in-memory state and is not persisted itself, so the persistence layer usually needs no change; if monitoring/scripts store snapshots separately, their read paths must be changed in step;
  4. After observing one release cycle with no anomalies, delete the bare-name branch.
- **Risk**: during double-writing the two keys may be briefly inconsistent (old code only writes the bare name), so they must be updated together in the same report; if external consumers read the bare name directly, alerts are silently lost during the migration.

## 4. Acceptance (both sides covered by tests)

- `tests/kv-instances.spec.ts`: covers the **key generation side** — `healthEntry('wecom-hr','wecom') === 'wecom-hr:wecom'`, its difference from `wecom-ops`, and the new KV families keying per instance.
- `tests/registry-instances.spec.ts`: covers the **claim/report side** — two named instances (`wecom-ops`/`wecom-hr`) each claim `${id}:wecom` without overwriting each other, `report` still only allows entries declared by the kind; old `github` settings resolve by bare name to the default instance (the `id === kind` side is guarded by case 2 of that file).
