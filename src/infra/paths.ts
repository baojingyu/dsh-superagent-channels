/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The names this package may be installed under. */
const PACKAGE_NAMES = ['dsh-superagent-channels', 'dsh-superagent']
let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      // The published package is `dsh-superagent-channels`; a checkout installed before the rename still says `dsh-superagent`,
      // and both must resolve so an existing deployment keeps working.
      try { if (PACKAGE_NAMES.includes((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ?? '')) return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent-channels package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
