/** The state directory's lock: one dsh-superagent per state tree, and a restart must not lose that. */
import { lockSync } from 'proper-lockfile'

/**
 * How long a lock may look untouched before another process may take it. Its holder refreshes the timestamp every half of
 * this, so a live instance is never mistaken for a dead one, and a restart does not have to wait half a minute to hear that
 * the previous process is gone.
 *
 * It was thirty seconds, and that is exactly what broke the restart of 09 Nov 08:49: the previous instance was killed while
 * holding the lock at 08:49:53, the new one asked at 08:50:19 - twenty-six seconds later, inside the window - was told "Lock
 * file is already being held", and never asked again. The plugin therefore never applied, every Source sat
 * `pending (waiting for service: orchestrator)`, and the panel reported the plugin as not responding while nothing held the
 * lock at all.
 */
export const LOCK_STALE_MS = 10_000

/**
 * Take the lock, or explain who to look for.
 *
 * No wait loop on purpose: `proper-lockfile`'s sync API refuses `retries`, and a blocking wait in the plugin's constructor
 * would freeze the host *and* stop the refresh timers that make a live lock distinguishable from a dead one.
 */
export function acquireStateLock(directory: string, onCompromised: (error: Error) => void): () => void {
  try {
    return lockSync(directory, { stale: LOCK_STALE_MS, onCompromised })
  } catch (error) {
    throw new Error(`another dsh-superagent is using ${directory} (${String(error)}); `
      + `close the other instance, or delete ${directory}.lock if none is running`)
  }
}
