/**
 * A `process.platform` stub for the tests that assert a POSIX-only rule.
 *
 * The owner-only check on a secret file is a POSIX rule: Windows synthesizes `st.mode` (`0o666` for any writable file) and
 * cannot tell `0644` from `0600`, so a rule that is asserted by its behaviour has to be judged against the branch that
 * implements it. Stubbing the platform runs that branch on every machine, which is why these tests are not skipped on
 * Windows; the descriptor the process started with is restored afterwards, so no other test in the same worker sees it.
 */

/** Runs `body` with `process.platform` reporting `value`, then restores the descriptor this process had. */
export async function withPlatform<T>(value: NodeJS.Platform, body: () => Promise<T> | T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  try {
    return await body()
  } finally {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor)
  }
}
