/**
 * Live contract test of the weixin bridge client against a **real** wxauto-bridge sidecar process.
 *
 * The sidecar is the same Python file that runs next to a Windows WeChat client; with `--backend fake` it serves
 * deterministic data on any OS, which is what makes this the one real cross-process integration the weixin plan can prove
 * here (no WeChat client, no real account). It runs only with `LIVE=1`; the default suite skips the whole file and starts
 * no process. Everything asserted below comes over HTTP from the child process: the six endpoints, the structured `ats`
 * list, idempotent sends, bearer auth, and the 0600 token-file enforcement.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createBridgeClient } from '../../src/sources/chat/weixin/bridge.ts'
import type { BridgeClient } from '../../src/sources/chat/weixin/bridge.ts'
import { withPlatform } from '../fixtures/platform.ts'

const LIVE = process.env.LIVE === '1'
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SIDECAR = resolve(REPO, '..', 'open-dsh-superagent-ext', 'sidecar', 'wxauto-bridge', 'server.py')
/**
 * The interpreter that starts the sidecar. On Windows `python3` is the Microsoft Store alias, which fails instead of
 * running anything, while the installed interpreter is `python`; `PYTHON` overrides both when the box differs.
 */
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
/** The fake backend's own account, fixed by server.py; group @-detection is judged against it. */
const SELF_WXID = 'wxid_fake_self'
const ROOM = 'chatroom_fake_dev'
/** A fresh random token per run; it must never be printed, so every log line is redacted through `redact`. */
const TOKEN = `live-token-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
const HEALTH_TIMEOUT_MS = 10_000
const TEST_TIMEOUT_MS = 30_000

/** Removes the bearer token from any text that is about to be printed. */
const redact = (value: string): string => value.split(TOKEN).join('<redacted>')
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Whether the child is still accepting connections on `port` (used to prove no listener is left behind). */
function isPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve_ => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve_(true) })
    socket.setTimeout(500, () => { socket.destroy(); resolve_(false) })
    socket.on('error', () => { socket.destroy(); resolve_(false) })
  })
}

/** Polls `/health` with exponential backoff until the sidecar answers or `capMs` elapses. */
async function waitForHealth(baseUrl: string, capMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + capMs
  let delay = 50
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
        signal: AbortSignal.timeout(1_000),
      })
      if (response.ok && (await response.json() as { ok?: boolean }).ok === true) return true
    } catch { /* the port is not listening yet */ }
    await new Promise(resolve_ => setTimeout(resolve_, delay))
    delay = Math.min(delay * 2, 1_000)
  }
  return false
}

describe.skipIf(process.env.LIVE !== '1')('weixin bridge against the real wxauto-bridge sidecar', () => {
  let child: ChildProcess | undefined
  let port = 0
  let directory = ''
  let tokenFile = ''
  let baseUrl = ''
  let client: BridgeClient
  let stderr = ''

  /** Stops the child: SIGTERM, then SIGKILL when it lingers, always waiting for the exit. */
  async function stopSidecar(): Promise<void> {
    const proc = child
    child = undefined
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
    await new Promise<void>(resolve_ => {
      const escalate = setTimeout(() => {
        try { proc.kill('SIGKILL') } catch { /* already gone */ }
        resolve_()
      }, 5_000)
      proc.once('exit', () => { clearTimeout(escalate); resolve_() })
      try { proc.kill('SIGTERM') } catch { clearTimeout(escalate); resolve_() }
    })
  }

  /** Starts the sidecar on a random port in 18000-19000, retrying up to three ports when the bind fails. */
  async function startSidecar(): Promise<number> {
    const tried: number[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = 18_000 + Math.floor(Math.random() * 1_000)
      tried.push(candidate)
      stderr = ''
      const proc = spawn(PYTHON, [SIDECAR, '--backend', 'fake', '--port', String(candidate), '--token', TOKEN],
        { stdio: ['ignore', 'pipe', 'pipe'] })
      child = proc
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        if (stderr.length > 100_000) stderr = stderr.slice(-50_000)
      })
      if (await waitForHealth(`http://127.0.0.1:${candidate}`, 3_000)) return candidate
      await stopSidecar()
    }
    throw new Error(`the sidecar did not become healthy on any of the ports ${tried.join(', ')}`)
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'weixin-bridge-live-'))
    tokenFile = join(directory, 'bridge.token')
    writeFileSync(tokenFile, `${TOKEN}\n`)
    chmodSync(tokenFile, 0o600)
    port = await startSidecar()
    baseUrl = `http://127.0.0.1:${port}`
    client = createBridgeClient({ baseUrl, tokenFile })
  }, TEST_TIMEOUT_MS)

  afterAll(async () => {
    await stopSidecar()
    let closed = false
    for (let attempt = 0; attempt < 10 && !closed; attempt += 1) {
      closed = !(await isPortOpen(port))
      if (!closed) await new Promise(resolve_ => setTimeout(resolve_, 200))
    }
    // stderr is the sidecar's own diagnostics (it prints "token=set", never the value); print the tail for triage.
    process.stdout.write(`[weixin-bridge.live] sidecar stderr tail:\n${redact(stderr.slice(-2_000)) || '(empty)'}\n`)
    if (directory) rmSync(directory, { recursive: true, force: true })
    expect(closed, `the sidecar still listens on 127.0.0.1:${port} after cleanup`).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('reports health and the fake backend identity', async () => {
    await expect(client.health()).resolves.toMatchObject({ ok: true, available: true, backend: 'fake', sidecar: '1' })
    await expect(client.status()).resolves.toMatchObject({
      loggedIn: true, wxid: SELF_WXID, name: '智能助手', backend: 'fake', available: true,
    })
  })

  it('lists the rooms and their members', async () => {
    const rooms = await client.rooms()
    expect(rooms.map(room => room.id)).toContain(ROOM)
    expect(rooms.find(room => room.id === ROOM)?.name).toBe('研发-交付群')

    const members = await client.members(ROOM)
    expect(members).toContainEqual({ id: SELF_WXID, name: '智能助手' })
    expect(members).toContainEqual({ id: 'wxid_alice', name: '阿黎' })
    await expect(client.members('chatroom_missing')).resolves.toEqual([])
  })

  it('maps the sidecar messages into ChatEvents, keeping ats verbatim and deriving mentionsAgent from it', async () => {
    const status = await client.status()
    const page = await client.messages(ROOM, undefined, 50)
    expect(page.next).toBe('4')
    expect(page.events.map(event => event.nativeId)).toEqual(['m1', 'm2', 'm3', 'm4'])

    const [first, second, third, fourth] = page.events
    expect(first).toMatchObject({
      nativeId: 'm1', chatId: ROOM, direct: false, threadRoot: ROOM,
      sender: { id: 'wxid_alice', name: '阿黎', bot: false },
      text: '@智能助手 把 timeout 改成 3s', at: '2026-11-06T04:01:02Z',
      mentionsAgent: true, ats: [SELF_WXID],
    })
    expect(second).toMatchObject({ nativeId: 'm2', ats: [], mentionsAgent: false })
    expect(third).toMatchObject({ nativeId: 'm3', ownMessage: true, ats: [], mentionsAgent: false })
    // The sidecar lists an image message's downloadable images per event, in the `<nativeId>#<index>` scheme.
    expect(fourth).toMatchObject({ nativeId: 'm4', text: '[图片]', ats: [], mentionsAgent: false })
    expect(fourth!.media).toEqual([{ id: 'm4#0', kind: 'image' }])
    // The contract's rule, checked against every event as served by the real sidecar.
    for (const event of page.events) expect(event.mentionsAgent).toBe((event.ats ?? []).includes(status.wxid))

    // Cursor paging reads on from the previous page's `next`.
    const tail = await client.messages(ROOM, page.next, 50)
    expect(tail.events.map(event => event.nativeId)).toEqual([])
    expect(tail.next).toBe('4')
  }, TEST_TIMEOUT_MS)

  it('sends idempotently: the same Idempotency-Key answers deduped:true with the same msgId', async () => {
    const outbound = { room: ROOM, wxid: 'wxid_alice', text: 'live 联调：请把 timeout 改成 3s', quoteId: 'm1', idempotencyKey: 'live-key-1' }
    const first = await client.send(outbound)
    expect(first).not.toBe('gone')
    if (first === 'gone') throw new Error('the sidecar refused a message it should accept')
    expect(first.msgId).toMatch(/^fake_[0-9a-f]{10}$/)
    expect(first.deduped).toBe(false)

    const again = await client.send(outbound)
    expect(again).toEqual({ msgId: first.msgId, deduped: true })
  }, TEST_TIMEOUT_MS)

  it('downloads one message image from the real sidecar as PNG bytes', async () => {
    // The ID comes from the image event's media list; its `#` is percent-encoded on the wire and decoded by the sidecar.
    const image = await client.media!('m4#0')
    expect(image.mime).toBe('image/png')
    expect(image.bytes.byteLength).toBeGreaterThan(8)
    // The fake backend serves a 1x1 PNG; its magic bytes are what the reader sniffs before committing an attachment.
    expect([...image.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }, TEST_TIMEOUT_MS)

  it('pushes the listen set to the real sidecar, which answers what it watches and what it cannot resolve', async () => {
    // The fake backend's dataset is fixed, so a chat it already serves needs no add and an unknown one is reported rather
    // than invented. Both answer 200: a chat that could not be resolved is a fact about the configuration, not a failed call.
    await expect(client.listen!([ROOM])).resolves.toEqual({
      listening: [{ id: ROOM, name: '研发-交付群' }], added: [], removed: [], failed: [],
    })
    const unknown = await client.listen!(['chatroom_missing'])
    expect(unknown.listening).toEqual([])
    expect(unknown.failed.map(entry => entry.room)).toEqual(['chatroom_missing'])
    // The set is replaced, so an empty configuration stops watching everything.
    await expect(client.listen!([])).resolves.toEqual({ listening: [], added: [], removed: [], failed: [] })
  }, TEST_TIMEOUT_MS)

  it('rejects a wrong bearer token as unauthorized', async () => {
    const wrongFile = join(directory, 'wrong.token')
    writeFileSync(wrongFile, 'not-the-sidecar-token\n')
    chmodSync(wrongFile, 0o600)
    const wrong = createBridgeClient({ baseUrl, tokenFile: wrongFile })
    await expect(wrong.health()).rejects.toThrow('unauthorized')
  }, TEST_TIMEOUT_MS)

  it('refuses a token file that is not 0600 before sending any request', async () => {
    const looseFile = join(directory, 'loose.token')
    writeFileSync(looseFile, `${TOKEN}\n`)
    chmodSync(looseFile, 0o644)
    let calls = 0
    const counting = (async () => { calls += 1; throw new Error('must not fetch') }) as unknown as typeof fetch
    const loose = createBridgeClient({ baseUrl, tokenFile: looseFile, fetchFn: counting })
    // Windows synthesizes `st.mode` (0o666 for any writable file) and cannot tell 0644 from 0600, so the owner-only rule is
    // judged as the POSIX rule it is: the platform is stubbed for this assertion, and the file's real mode is 0o666 there.
    await withPlatform('linux', async () => {
      await expect(loose.health()).rejects.toThrow(/mode 0600/)
    })
    expect(calls).toBe(0)
  })

  it('leaves no listener behind once the sidecar is stopped', async () => {
    await stopSidecar()
    expect(await isPortOpen(port)).toBe(false)
  }, TEST_TIMEOUT_MS)
})