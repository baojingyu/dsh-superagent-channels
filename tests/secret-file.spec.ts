/**
 * The shared secret-file reader: the owner-only rule on the platforms whose `st.mode` carries it, and the structural
 * checks that carry it on Windows, where Node synthesizes the mode and never reflects the ACL. The platform is stubbed
 * rather than the file's permissions, so the same assertion runs on every machine.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSecretFile, requireOwnerOnly } from '../src/infra/secret-file.ts'
import { withPlatform } from './fixtures/platform.ts'

/** The platform this worker started with, so a stub that leaks is caught instead of being reported as a later failure. */
const ORIGINAL = process.platform
/** How a reader names the file in its messages; the sentence around it is the shared helper's. */
const WHAT = 'The secret file'
let directory: string
let tokenFile: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'secret-file-'))
  tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'secret\n')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

describe('requireOwnerOnly', () => {
  it('refuses any mode other than 0600 where the POSIX bits are real, naming the mode it found', async () => {
    await withPlatform('linux', () => {
      // The actual mode is the diagnosis: "not 644" says the file is group/world readable, "must be 0600" does not.
      expect(() => requireOwnerOnly(0o644, tokenFile, WHAT)).toThrow(/must have mode 0600, not 644/)
      expect(() => requireOwnerOnly(0o640, tokenFile, WHAT)).toThrow(/not 640/)
      expect(() => requireOwnerOnly(0o666, tokenFile, WHAT)).toThrow(/not 666/)
      // The message names the file, so a misconfigured deployment says which one to fix.
      expect(() => requireOwnerOnly(0o644, tokenFile, WHAT)).toThrow(tokenFile)
      expect(() => requireOwnerOnly(0o644, tokenFile, 'Yunxiao token file')).toThrow(/^Yunxiao token file must have mode 0600/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('accepts 0600 and ignores the file-type bits where the POSIX bits are real', async () => {
    await withPlatform('linux', () => {
      expect(() => requireOwnerOnly(0o600, tokenFile, WHAT)).not.toThrow()
      expect(() => requireOwnerOnly(0o100600, tokenFile, WHAT)).not.toThrow()
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('accepts the synthesized 0666 mode on Windows, where the bits carry no ACL information', async () => {
    await withPlatform('win32', () => {
      expect(() => requireOwnerOnly(0o666, tokenFile, WHAT)).not.toThrow()
      // A read-only file is synthesized as 0444; it is equally meaningless, and equally accepted.
      expect(() => requireOwnerOnly(0o444, tokenFile, WHAT)).not.toThrow()
    })
    expect(process.platform).toBe(ORIGINAL)
  })
})

describe('readSecretFile', () => {
  it('reads and trims the file on Windows, where only the structural checks apply', async () => {
    await withPlatform('win32', () => {
      expect(readSecretFile(tokenFile, 'bridge token file')).toBe('secret')
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('still refuses a missing file on Windows, with the hint that says what to write there', async () => {
    const missing = join(directory, 'absent')
    await withPlatform('win32', () => {
      expect(() => readSecretFile(missing, 'bridge token file')).toThrow(/bridge token file .* is missing/)
      // A first-time operator only has this sentence: what the file holds and how it must be protected.
      expect(() => readSecretFile(missing, 'bridge token file')).toThrow(/write the token there and keep it owner-only \(0600/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('still refuses an empty file on Windows', async () => {
    const empty = join(directory, 'empty')
    writeFileSync(empty, '\n')
    await withPlatform('win32', () => {
      expect(() => readSecretFile(empty, 'bridge token file')).toThrow(/bridge token file .* is empty/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('still refuses a directory on Windows', async () => {
    const nested = join(directory, 'nested')
    mkdirSync(nested)
    await withPlatform('win32', () => {
      expect(() => readSecretFile(nested, 'bridge token file')).toThrow(/bridge token file .* is not a regular file/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })

  it('refuses the file the POSIX rule refuses, whichever platform the test runs on', async () => {
    // The file was created with the process's default mode, which is never 0600: 0666 on Windows, 0644 under a POSIX umask.
    await withPlatform('linux', () => {
      expect(() => readSecretFile(tokenFile, 'hosting token file')).toThrow(/The hosting token file must have mode 0600, not \d{3}/)
    })
    expect(process.platform).toBe(ORIGINAL)
  })
})
