import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter, dirname, isAbsolute, sep } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { Config, defaultStateDir, executable, machineOf, resolveDeployment, resolveFeishuBot, workerProbe, type Machine, type Probe } from '../src/deployment.ts'
import { withoutDirectory } from '../src/infra/environment.ts'
import { gitEnv } from './fixtures/git.ts'

const exec = promisify(execFile)
let dir: string
let path: string
/** The line every fake CLI starts with: the arguments the product passed, joined the way a shell's `"$*"` joins them. */
const SAID = "const said = process.argv.slice(2).join(' ')"
/** A statement that prints `value` the way a CLI prints JSON on one line. */
const say = (value: unknown): string => `console.log(JSON.stringify(${JSON.stringify(value)}))`
/** Writes a fake CLI and returns its path. The body is a Node script, not a `#!` script: Windows starts PE images only. */
const program = (file: string, body = ''): string => { writeFileSync(file, body); chmodSync(file, 0o755); return file }
/** Fake gh CLI signed in as `login` with configurable push access to acme/widgets (including its former name acme/gadgets). */
const gh = (file: string, login: string, push = true): string => program(file, [SAID,
  `if (said === 'api user') ${say({ login, id: 7 })}`,
  `else if (said.startsWith('api repos/acme/') && said.endsWith(' --jq {name: .full_name, push: .permissions.push}')) ${say({ name: 'acme/widgets', push })}`,
  'else process.exit(1)'].join('\n'))
/** Fake lark-cli script body returning canned auth, strict-mode, and bot info responses. */
const lark = (status: object, mode = 'bot', bot: object = { bot: { open_id: 'ou_bot', app_name: 'Widgets Bot' }, code: 0 }): string =>
  [SAID, `if (said === 'auth status') ${say(status)}`,
    `else if (said === 'config strict-mode') console.log(${JSON.stringify(`strict-mode: ${mode} (source: profile)`)})`,
    `else if (said === 'api GET /open-apis/bot/v3/info --as bot --format ndjson') ${say(bot)}`].join('\n')
const minimal = (overrides: Record<string, unknown> = {}) => ({ stateDir: join(dir, 'state'), ...overrides })
const machine = (overrides: Partial<Machine> = {}): Machine => ({ ...machineOf(Config(minimal())), ...overrides })
/**
 * Runs commands like worker shells do, but locally: the stand-ins first on PATH, then the system's git. Each stand-in is
 * a Node script, so it starts through `process.execPath` on every platform; Windows would refuse a `#!` script with
 * ENOENT, and a `.cmd` shim with EINVAL unless a shell wrapped it.
 */
const probe: Probe = async (argv, env) => (await exec(process.execPath, [argv[0]!, ...argv.slice(1)], { env: { PATH: path, HOME: dir, ...env } })).stdout
const setupError = (place: string, code: string, values: Record<string, unknown> = {}) => expect.objectContaining({ place, code, values: expect.objectContaining(values) })

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'deployment-'))
  mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'state', 'worker-bin'), { recursive: true }); mkdirSync(join(dir, 'widgets', 'src'), { recursive: true })
  // The second stand-in entry keeps its trailing separator, and the last one stands for a directory of real programs.
  const system = process.platform === 'win32' ? [dirname(process.execPath)] : ['/usr/bin', '/bin']
  path = [join(dir, 'state-link', 'worker-bin'), `${join(dir, 'state', 'worker-bin')}${sep}`, join(dir, 'bin'), ...system].join(delimiter)
  gh(join(dir, 'bin', 'gh'), 'Agent-Bot')
  program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', brand: 'lark', identities: { bot: { status: 'ready' } } }))
  // Stale worker shims with the same binary name must be skipped regardless of PATH normalization or symlinks.
  program(join(dir, 'state', 'worker-bin', 'gh'))
  symlinkSync(join(dir, 'state'), join(dir, 'state-link'))
  await exec('git', ['init', '-q', join(dir, 'widgets')], { env: gitEnv() })
  await exec('git', ['-C', join(dir, 'widgets'), 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { env: gitEnv() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

// Setup spawns CLI subprocesses that can take several seconds when tests run in parallel.
vi.setConfig({ testTimeout: 30_000 })

describe('configuration schema', () => {
  it('defaults the state directory and reads the editable fields through references', () => {
    // An installation that names no directory still runs: it adopts an existing legacy directory when there is one, so a
    // switch from the pre-2.3 entry keeps every setting and ticket, and otherwise uses this plugin's own directory.
    expect(machineOf(Config({})).stateDir).toBe(defaultStateDir())
    expect(isAbsolute(machineOf(Config({})).stateDir)).toBe(true)
    const read = machineOf(Config({ stateDir: join(dir, 'state') }))
    // Limits are volatile references that the loader updates in place and callers read when used.
    expect({ ...read, promptMaxChars: read.promptMaxChars.get(), admissionContextMaxPages: read.admissionContextMaxPages.get(),
      admissionContextTimeoutMs: read.admissionContextTimeoutMs.get() })
      .toEqual({ stateDir: join(dir, 'state'), promptMaxChars: 100000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15000 })
    expect(() => Config(minimal({ stateDir: 'relative/dir' }))).toThrow()
    expect(() => Config(minimal({ stateDir: '~/dir' }))).toThrow()
    // A drive-relative path names no drive, so it is as relative on Windows as a bare path is on POSIX.
    expect(() => Config(minimal({ stateDir: 'C:state' }))).toThrow()
    // A rooted path with a leading `/` is absolute on both platforms: Node's `path.win32.isAbsolute('/srv/state')` is
    // true, and `resolve` places it on the current drive. Rejecting it would be stricter than Node itself.
    expect(machineOf(Config(minimal({ stateDir: '/srv/state' }))).stateDir).toBe('/srv/state')
    // The absolute form of the platform this test runs on is accepted, including a UNC share on Windows.
    const rooted = process.platform === 'win32' ? '\\\\server\\share\\state' : '/srv/state'
    expect(machineOf(Config(minimal({ stateDir: rooted }))).stateDir).toBe(rooted)
  })
  it('names keys the configuration does not define, and where the values of older keys live now', () => {
    const raw = minimal({ repository: 'acme/widgets', repositoryPath: '/srv/widgets', blockedCommands: [], author: { name: 'Alice' }, extra: 1 })
    expect(() => machineOf(Config(raw))).toThrow('keys it does not use: repository (now on the GitHub Source), repositoryPath (now in the prepare command of the Execution settings), blockedCommands (now in the Execution settings), author (now prompt text), extra;')
  })
})

describe('worker probe', () => {
  /** A subprocess service that records each spawn and answers with fixed output, so the probe's own contract can be asserted. */
  const recording = (): { runtime: SubprocessRuntime; spawns: SubprocessSpawnSpec[] } => {
    const spawns: SubprocessSpawnSpec[] = []
    const spawn = (spec: SubprocessSpawnSpec) => {
      spawns.push(spec)
      const reader = (text: string) => ({ readFrom: () => ({ text }) })
      return { done: Promise.resolve({ exitCode: 0 }), collected: { stdout: reader('ok'), stderr: reader('') } }
    }
    return { runtime: { spawn } as unknown as SubprocessRuntime, spawns }
  }
  it('passes the worker PATH and the per-command environment to the command itself, not through an `env` command', async () => {
    const { runtime, spawns } = recording()
    const probe = workerProbe(runtime, join(dir, 'state'), dir, new AbortController().signal)
    expect(await probe(['gh', 'api', 'user'], { LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1' })).toBe('ok')
    // Windows has no `env` command, so the environment travels as the spawn option on every platform.
    expect(spawns[0]!.argv).toEqual(['gh', 'api', 'user'])
    // PATH is replaced by the worker's own, not appended to the host's: a stale shim must stay out of reach.
    expect(spawns[0]!.env).toMatchObject({ LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
      PATH: withoutDirectory(process.env.PATH ?? '', join(dir, 'state', 'worker-bin')) })
    expect(spawns[0]!.cwd).toBe(dir)
  })
})

describe('setup', () => {
  it('reads the repository from the GitHub Source and the accounts from their CLIs, skipping the worker shims', async () => {
    const deployment = await resolveDeployment(machine(), { repository: 'acme/widgets', cli: 'gh' }, probe, path)
    expect(deployment).toMatchObject({ repository: 'acme/widgets', github: { cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' } })
    expect(deployment.github).toEqual({ cli: join(dir, 'bin', 'gh'), login: 'Agent-Bot', noreply: '7+Agent-Bot@users.noreply.github.com' })
    expect(deployment).not.toHaveProperty('feishu')
    // A renamed repository is still resolved by its old name; notifications carry GitHub's current full_name.
    expect((await resolveDeployment(machine(), { repository: 'acme/gadgets', cli: 'gh' }, probe, path)).repository).toBe('acme/widgets')
  })
  it('names what setup needs and where it is set', async () => {
    const needs = (place: string, code: string, values: Record<string, unknown>, github: unknown) =>
      expect(resolveDeployment(machine(), github, probe, path)).rejects.toEqual(setupError(place, code, values))
    const repository = 'acme/widgets'
    await needs('github', 'repositoryUnset', {}, { cli: 'gh' })
    await needs('github', 'agentCliUnset', {}, { repository })
    await needs('github', 'agentCliMissing', { output: `${join(dir, 'missing')} is not an executable file` }, { repository, cli: join(dir, 'missing') })
    await needs('github', 'agentCliMissing', { output: 'bin/gh must be a command name or an absolute path' }, { repository, cli: 'bin/gh' })
    await needs('github', 'agentCliSignedOut', {}, { repository, cli: program(join(dir, 'bin', 'gh-broken'), 'process.exit(1)') })
    await needs('github', 'repositoryReadOnly', { account: 'Agent-Bot', repository: 'acme/widgets' }, { repository, cli: gh(join(dir, 'bin', 'gh-reader'), 'Agent-Bot', false) })
    // Signed in, but the account cannot read the repository, or the CLI names no account.
    const unreadable = program(join(dir, 'bin', 'gh-outsider'),
      [SAID, `if (said === 'api user') ${say({ login: 'Agent-Bot', id: 7 })}`,
        `else { console.error('HTTP 404'); process.exit(1) }`].join('\n'))
    const output = expect.stringContaining('HTTP 404') as unknown
    await needs('github', 'repositoryUnreadable', { account: 'Agent-Bot', repository: 'acme/widgets', output }, { repository, cli: unreadable })
    await needs('github', 'agentCliNoAccount', {}, { repository, cli: program(join(dir, 'bin', 'gh-anonymous'), 'console.log("{}")') })
    expect(() => executable('nothing-here', join(dir, 'bin'))).toThrow('nothing-here is not an executable file on PATH')
  })
  it('reads the Feishu bot from a bot-only lark-cli, or finds none when the Feishu Source names no CLI', async () => {
    expect(await resolveFeishuBot(machine(), {}, probe, path)).toBeUndefined()
    expect(await resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).toEqual({ cli: join(dir, 'bin', 'lark-cli'), appId: 'cli_bot', brand: 'lark', botId: 'ou_bot', name: 'Widgets Bot' })
    const refuses = async (code: string, values: Record<string, unknown> = {}) => expect(resolveFeishuBot(machine(), { cli: 'lark-cli' }, probe, path)).rejects.toEqual(setupError('feishu', code, values))
    program(join(dir, 'bin', 'lark-cli'), lark({ identities: { bot: { status: 'ready' } } }))
    await refuses('feishuNoApp')
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'missing' } } }))
    await refuses('feishuBotNotReady', { app: 'cli_bot', status: 'missing' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'off'))
    await refuses('feishuUserIdentity', { mode: 'off' })
    program(join(dir, 'bin', 'lark-cli'), lark({ appId: 'cli_bot', identities: { bot: { status: 'ready' } } }, 'bot', { code: 0, data: {} }))
    await refuses('feishuNoBot')
    program(join(dir, 'bin', 'lark-cli'), 'console.error("not configured"); process.exit(1)')
    await refuses('feishuCliFailed', { output: expect.stringContaining('not configured') })
  })
})
