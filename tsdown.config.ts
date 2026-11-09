import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
// The client bundle's module id must be the package name: DSH keys the boot entry and the factory registration by it, so a
// stale literal breaks activation (and, with an old copy still installed, registers the same factory twice).
const name = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { name: string }).name
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts',
    'weixin-watch': 'src/sources/weixin-watch.ts', 'gitlab-watch': 'src/sources/gitlab-watch.ts', 'projex-watch': 'src/sources/projex-watch.ts',
    'dingtalk-watch': 'src/sources/dingtalk-watch.ts', 'wecom-watch': 'src/sources/wecom-watch.ts' }, outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true, deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js', banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`, footer: 'return module.exports; } });', intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
