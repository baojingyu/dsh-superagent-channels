/**
 * The built client bundle's module id must be the package name.
 *
 * DSH keys both the boot entry and the factory registration by that id. A stale literal left the entry unactivated ("import failed"),
 * and with an old copy of the package still installed it registered the same factory twice. The banner reads the name from
 * package.json now; this test fails if the artifact drifts from it. It skips when the bundle has not been built yet.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
const bundle = join(root, 'lib', 'client.js')

describe('the built client bundle', () => {
  it('registers under the package name', () => {
    if (!existsSync(bundle)) return
    const head = readFileSync(bundle, 'utf8').slice(0, 400)
    const id = /id:\s*"([^"]+)"/.exec(head)?.[1]
    expect(id, 'client.js must register under the package name').toBe(pkg.name)
    // And the banner must derive it, not repeat a literal that the next rename would leave behind.
    const config = readFileSync(join(root, 'tsdown.config.ts'), 'utf8')
    expect(config).not.toContain('id: "dsh-superagent"')
    expect(config).toContain('JSON.stringify(name)')
  })
})
