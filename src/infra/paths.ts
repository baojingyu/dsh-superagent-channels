/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The names this package may be installed under: the current one, the name it shipped under before the rename, and the upstream name a checkout may still carry. */
const PACKAGE_NAMES = ['dsh-superagent-multi-channel', 'dsh-superagent-channels', 'dsh-superagent']
let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      // The published package is `dsh-superagent-multi-channel`; a deployment installed before the rename still says
      // `dsh-superagent-channels`, and a checkout of the upstream prototype says `dsh-superagent`. All must resolve so an
      // existing deployment keeps working across the rename.
      try { if (PACKAGE_NAMES.includes((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ?? '')) return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent-multi-channel package root not found')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
