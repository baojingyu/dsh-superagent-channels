/**
 * The work-item revisions this process wrote, so a poll does not read them back as new requests.
 *
 * A work item's Trigger ID is derived from its modification time (`workTrigger`), and writing a comment or a status bumps that
 * time - so every comment the agent posts and every status it writes comes back as a brand-new Trigger. Measured on ESFX-6228:
 * one work item, two Triggers, the second six minutes after the first and caused by the agent's own write-back, which started a
 * second Assignment on a ticket that had already ended.
 *
 * Content comparison cannot replace this: a person commenting on an item also bumps its modification time, and a person's
 * comment is a legitimate reason to look again. What has to be excluded is what *we* wrote, which is knowledge only the writer
 * has - hence a ledger, not a fingerprint.
 */
const MAX_ENTRIES = 512
/** A day is far longer than any poll interval, and keeps the map from growing without bound. */
const TTL_MS = 24 * 60 * 60 * 1000

/** `${host}:${scope}:${key}@${updatedAt}` → when it was recorded. */
const written = new Map<string, number>()

const entryOf = (host: string, scope: string, key: string, updatedAt: string): string =>
  `${host}:${scope}:${key}@${updatedAt}`

/**
 * Record that this process wrote `key` at `updatedAt`, so a later listing of the same revision is not handed over as a request.
 * Called by an adapter right after its own write, with the revision the write produced.
 */
export function rememberSelfWrite(host: string, scope: string, key: string, updatedAt: string): void {
  if (!key || !updatedAt) return
  const now = Date.now()
  for (const [entry, at] of written) if (now - at > TTL_MS) written.delete(entry)
  written.set(entryOf(host, scope, key, updatedAt), now)
  while (written.size > MAX_ENTRIES) {
    const oldest = written.keys().next()
    if (oldest.done) break
    written.delete(oldest.value)
  }
}

/** Whether `key` at `updatedAt` is a revision this process wrote itself. */
export function isSelfWrite(host: string, scope: string, key: string, updatedAt: string): boolean {
  if (!key || !updatedAt) return false
  const at = written.get(entryOf(host, scope, key, updatedAt))
  if (at === undefined) return false
  if (Date.now() - at > TTL_MS) {
    written.delete(entryOf(host, scope, key, updatedAt))
    return false
  }
  return true
}

/** Forgets every recorded write; for tests, which must not leak state between cases. */
export function forgetSelfWrites(): void { written.clear() }

/** How many revisions are currently remembered; for a test that checks the ledger stays bounded. */
export function selfWriteCount(): number { return written.size }
