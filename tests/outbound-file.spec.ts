/** The gate between a ticket's model and the machine's files: only its own directory, only sensible files. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { resolveTicketFile } from '../src/app/tools/executor.ts'

let root = ''
let outside = ''

beforeAll(() => {
  const base = mkdtempSync(join(tmpdir(), 'outbound-file-'))
  root = join(base, 'ticket')
  outside = join(base, 'outside.txt')
  mkdirSync(root)
  writeFileSync(join(root, 'chart.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(root, 'empty.txt'), '')
  writeFileSync(join(root, 'setup.exe'), 'MZ')
  writeFileSync(outside, 'secret')
  writeFileSync(join(root, 'big.bin'), Buffer.alloc(64))
  symlinkSync(outside, join(root, 'link.txt'))
})

afterAll(() => {
  if (root) rmSync(join(root, '..'), { recursive: true, force: true })
})

describe('resolveTicketFile', () => {
  it('reads a file inside the ticket directory, as base64 that keeps the name', () => {
    const file = resolveTicketFile(root, 'chart.png')
    expect(file.name).toBe('chart.png')
    expect(Buffer.from(file.data, 'base64')).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('refuses a path that climbs out, a symlink that leaves, an executable, an empty file, and an oversized one', () => {
    expect(() => resolveTicketFile(root, '../outside.txt')).toThrow(/outside this ticket/)
    expect(() => resolveTicketFile(root, 'link.txt')).toThrow(/outside this ticket/)
    expect(() => resolveTicketFile(root, 'setup.exe')).toThrow(/executables/)
    expect(() => resolveTicketFile(root, 'empty.txt')).toThrow(/empty/)
    expect(() => resolveTicketFile(root, 'big.bin', 32)).toThrow(/over the 32 cap/)
  })

  it('refuses when the ticket has no directory at all', () => {
    expect(() => resolveTicketFile(undefined, 'chart.png')).toThrow(/no execution directory/)
  })
})
