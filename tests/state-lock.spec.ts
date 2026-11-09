/** The state lock: free means taken; a lock whose holder is gone is taken over; a held one is refused with a remedy. */
import { mkdirSync, mkdtempSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireStateLock } from '../src/app/lock.ts'

const noop = () => {}
const directoryOf = () => {
  const directory = join(mkdtempSync(join(tmpdir(), 'dsh-lock-')), 'state')
  mkdirSync(directory, { recursive: true })
  return directory
}

describe('acquireStateLock', () => {
  it('takes a free state directory, refuses while it is held, and frees it on release', () => {
    const directory = directoryOf()
    const release = acquireStateLock(directory, noop)
    expect(() => acquireStateLock(directory, noop)).toThrow(/another dsh-superagent is using/)
    release()
    // Free again afterwards, so a restart can take it.
    acquireStateLock(directory, noop)()
  })

  it('takes over a lock whose holder is gone, so a restart does not leave the plugin unapplied', () => {
    const directory = directoryOf()
    // What a killed process leaves: the lock directory, with a timestamp nobody refreshes any more. Ten seconds is the
    // stale window; the incident that prompted this was a lock twenty-six seconds old that was still refused.
    mkdirSync(`${directory}.lock`)
    const longAgo = (Date.now() - 60_000) / 1000
    utimesSync(`${directory}.lock`, longAgo, longAgo)
    const release = acquireStateLock(directory, noop)
    release()
  })
})
