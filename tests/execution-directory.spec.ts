/** The ticket directory root: an absolute path on either platform, refused when it is relative. */
import { describe, expect, it } from 'vitest'
import { ExecutorConfigSchema, isAbsoluteDirectory } from '../src/policy.ts'
import { ABSOLUTE_DIRECTORY } from '../src/client/execution.tsx'

/** What the browser does with `pattern`: a whole-value match, so the anchors are added here. */
const matchesPattern = (value: string) => new RegExp(`^(?:${ABSOLUTE_DIRECTORY})$`).test(value)

describe('ticket directory root', () => {
  it('accepts an absolute path on either platform, and empty for the default', () => {
    for (const directory of ['', '/srv/work', 'D:\\Welltivity-Projects', 'D:/Welltivity-Projects', '\\\\server\\share\\work']) {
      expect(isAbsoluteDirectory(directory), directory).toBe(true)
      expect(ExecutorConfigSchema.safeParse({ directory }).success, directory).toBe(true)
    }
  })

  it('refuses a relative path, which would put tickets somewhere nobody named', () => {
    for (const directory of ['work', '..\\work', './work', 'D:work']) {
      expect(isAbsoluteDirectory(directory), directory).toBe(false)
      expect(ExecutorConfigSchema.safeParse({ directory }).success, directory).toBe(false)
    }
  })

  it('lets the input accept what the schema accepts, so a Windows path is not rejected twice', () => {
    // The field carried `pattern="/.*"`, which refused every drive-letter path in the browser before the schema ever saw it.
    for (const directory of ['/srv/work', 'D:\\Welltivity-Projects', 'D:/Welltivity-Projects', '\\\\server\\share']) {
      expect(matchesPattern(directory), directory).toBe(true)
    }
    expect(matchesPattern('work')).toBe(false)
  })
})
