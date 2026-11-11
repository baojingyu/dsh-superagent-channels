/** Resolves packaged asset paths from either the source tree or the compiled lib/ output. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Package names this bundle may be installed under: the fork's own name and the published channels name. */
const PACKAGE_NAMES = ['dsh-superagent', 'dsh-superagent-channels']
let cached: string | undefined
export function packageRoot(): string {
  if (cached) return cached
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      try { if (PACKAGE_NAMES.includes((JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name ?? '')) return cached = directory }
      catch { /* A foreign package.json on the way up is not this package. */ }
    }
    directory = dirname(directory)
  }
  throw new Error('dsh-superagent package root not found (expected dsh-superagent or dsh-superagent-channels)')
}
export const packagePath = (...parts: string[]): string => join(packageRoot(), ...parts)
