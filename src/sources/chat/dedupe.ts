/** Transport-level dedupe ring: absorbs SDK re-delivery and platform webhook retries before an event reaches the domain. */

/**
 * Remembers recently delivered messages per instance, keyed `${instance}|${nativeId}`, with a bounded capacity and a TTL, so a
 * backend that redelivers an event (reconnect, webhook retry) is not delivered twice. The domain's own Trigger ID and the
 * outbound receipt remain the authoritative dedupe layers; this ring only spares the work before them. Expired entries are
 * purged lazily on access, and the oldest entries are evicted once `capacity` is exceeded.
 */
export class DeliveredRing {
  /** Insertion order is first-seen order, so the earliest entry is also the one expiring first. */
  private readonly seen = new Map<string, number>()
  constructor(private readonly capacity = 2000, private readonly ttlMs = 600_000,
    private readonly now: () => number = () => Date.now()) {}

  /**
   * Records a delivery of `nativeId` by `instance` and returns whether it had already been delivered within the TTL (a
   * duplicate that must not be delivered again). A duplicate does not extend the TTL of the original delivery.
   */
  check(instance: string, nativeId: string): boolean {
    const id = `${instance}|${nativeId}`
    const at = this.now()
    this.purge(at)
    const deliveredAt = this.seen.get(id)
    if (deliveredAt !== undefined) return true
    this.seen.set(id, at)
    this.trim()
    return false
  }

  /** Drops the entries whose TTL elapsed; insertion order lets the scan stop at the first live entry. */
  private purge(at: number): void {
    for (const [id, deliveredAt] of this.seen) {
      if (at - deliveredAt < this.ttlMs) break
      this.seen.delete(id)
    }
  }

  /** Evicts the oldest entries once the ring holds more than its capacity. */
  private trim(): void {
    while (this.seen.size > this.capacity) {
      const oldest = this.seen.keys().next()
      if (oldest.done) return
      this.seen.delete(oldest.value)
    }
  }
}