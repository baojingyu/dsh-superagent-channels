/**
 * 契约自测：用**真实的** `src/sources/chat/weixin/bridge.ts` 客户端跑
 * `tests/live/weixin-bridge.live.spec.ts` 的全部断言，外加 spec 没覆盖的契约边界
 * （404/405/400/401、游标、limit、发送间隔、/media 零字节与百分号编码）。
 *
 * 注意：仓库里那条 live spec 已经是权威验收门（`LIVE=1 vitest run tests/live/weixin-bridge.live.spec.ts`）。
 * 本脚本用于不装 vitest / 想逐条看断言时的手工复核。
 *
 * 用法：node --experimental-strip-types --no-warnings live-contract.mjs
 * 环境变量：PYTHON_BIN（默认 python）、WXBRIDGE_SERVER、WXBRIDGE_BRIDGE
 */
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = process.env.WXBRIDGE_SERVER ?? resolve(HERE, '..', 'sidecar', 'wxauto-bridge', 'server.py')
const BRIDGE = process.env.WXBRIDGE_BRIDGE ?? 'file:///C:/dev/open-dsh-superagent/src/sources/chat/weixin/bridge.ts'
const PYTHON = process.env.PYTHON_BIN ?? (process.platform === 'win32' ? 'python' : 'python3')
const SELF_WXID = 'wxid_fake_self'
const ROOM = 'chatroom_fake_dev'
const TOKEN = `live-token-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
const { createBridgeClient } = await import(BRIDGE)

let passed = 0
let failed = 0
const failures = []
const redact = value => String(value).split(TOKEN).join('<redacted>')
const show = value => redact(JSON.stringify(value))

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  check(name, ok, ok ? '' : `expected ${show(expected)} got ${show(actual)}`)
}
function matchObject(name, actual, pattern) {
  const problems = []
  const walk = (a, p, at) => {
    if (p === null || typeof p !== 'object') {
      if (a !== p) problems.push(`${at || '(root)'}: expected ${show(p)} got ${show(a)}`)
      return
    }
    if (a === null || typeof a !== 'object') { problems.push(`${at}: expected object got ${show(a)}`); return }
    for (const key of Object.keys(p)) walk(a[key], p[key], at ? `${at}.${key}` : key)
  }
  walk(actual, pattern, '')
  check(name, problems.length === 0, problems.join('; '))
}
async function step(title, fn) {
  console.log(`\n${title}`)
  try { await fn() } catch (error) { check(`${title} 未抛异常`, false, redact(error?.stack ?? error)) }
}

function isPortOpen(port) {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); done(true) })
    socket.setTimeout(500, () => { socket.destroy(); done(false) })
    socket.on('error', () => { socket.destroy(); done(false) })
  })
}
async function waitForHealth(baseUrl, capMs = 10_000) {
  const deadline = Date.now() + capMs
  let delay = 50
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(1_000) })
      if (response.ok && (await response.json()).ok === true) return true
    } catch { /* not listening yet */ }
    await new Promise(r => setTimeout(r, delay))
    delay = Math.min(delay * 2, 1_000)
  }
  return false
}

let child
let stderr = ''
async function stopSidecar() {
  const proc = child
  child = undefined
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise(done => {
    const escalate = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} done() }, 5_000)
    proc.once('exit', () => { clearTimeout(escalate); done() })
    try { proc.kill('SIGTERM') } catch { clearTimeout(escalate); done() }
  })
}

const directory = mkdtempSync(join(tmpdir(), 'wxbridge-contract-'))
const tokenFile = join(directory, 'bridge.token')
writeFileSync(tokenFile, `${TOKEN}\n`)
chmodSync(tokenFile, 0o600)

let port = 0
let baseUrl = ''
for (let attempt = 0; attempt < 3 && !port; attempt += 1) {
  const candidate = 18_000 + Math.floor(Math.random() * 1_000)
  stderr = ''
  child = spawn(PYTHON, [SIDECAR, '--backend', 'fake', '--port', String(candidate), '--token', TOKEN], { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', chunk => { stderr += chunk.toString() })
  if (await waitForHealth(`http://127.0.0.1:${candidate}`, 3_000)) { port = candidate; baseUrl = `http://127.0.0.1:${candidate}` }
  else await stopSidecar()
}
if (!port) {
  console.log('FATAL: sidecar never became healthy\n' + redact(stderr.slice(-2000)))
  process.exit(1)
}
console.log(`sidecar on ${baseUrl} (pid ${child.pid})`)
const client = createBridgeClient({ baseUrl, tokenFile })
const auth = { Authorization: `Bearer ${TOKEN}` }
let status

try {
  await step('[0] 启动诊断', async () => {
    check('stderr prints token=set', stderr.includes('token=set'))
    check('stderr never prints the token', !stderr.includes(TOKEN))
    check('stderr prints the listen address', stderr.includes(`127.0.0.1:${port}`))
  })

  await step('[1] /health 与 /status', async () => {
    const health = await client.health()
    matchObject('health', health, { ok: true, available: true, backend: 'fake', sidecar: '1' })
    check('health.version is a non-empty string', typeof health.version === 'string' && health.version.length > 0, show(health.version))
    check('health.uptimeSec is an integer', Number.isInteger(health.uptimeSec) && health.uptimeSec >= 0, show(health.uptimeSec))
    // capabilities 尚未进 BridgeHealth（Node 侧待补），所以这里直接看原始响应。
    const rawHealth = await (await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()
    eq('health.capabilities (fake 三态)', rawHealth.capabilities, { mentions: 'structured', members: 'full', media: true })
    check('health 既有字段未被破坏', rawHealth.ok === true && rawHealth.sidecar === '1' && rawHealth.backend === 'fake')
    status = await client.status()
    matchObject('status', status, { loggedIn: true, wxid: SELF_WXID, name: '智能助手', backend: 'fake', available: true })
    check('status.lastEventAt is ISO8601 Z', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(status.lastEventAt ?? ''), show(status.lastEventAt))
  })

  await step('[2] /rooms 与 /members', async () => {
    const rooms = await client.rooms()
    check('rooms contains chatroom_fake_dev', rooms.some(r => r.id === ROOM), show(rooms))
    check('room name is 研发-交付群', rooms.find(r => r.id === ROOM)?.name === '研发-交付群')
    const members = await client.members(ROOM)
    check('members contains self', members.some(m => m.id === SELF_WXID && m.name === '智能助手'), show(members))
    check('members contains alice', members.some(m => m.id === 'wxid_alice' && m.name === '阿黎'))
    eq('unknown room yields []', await client.members('chatroom_missing'), [])
  })

  await step('[3] /messages 映射与 ats', async () => {
    const page = await client.messages(ROOM, undefined, 50)
    eq('next === "4"', page.next, '4')
    eq('nativeIds', page.events.map(e => e.nativeId), ['m1', 'm2', 'm3', 'm4'])
    const [first, second, third, fourth] = page.events
    matchObject('m1', first, {
      nativeId: 'm1', chatId: ROOM, direct: false, threadRoot: ROOM,
      sender: { id: 'wxid_alice', name: '阿黎', bot: false },
      text: '@智能助手 把 timeout 改成 3s', at: '2026-11-06T04:01:02Z', mentionsAgent: true, ats: [SELF_WXID],
    })
    matchObject('m2', second, { nativeId: 'm2', ats: [], mentionsAgent: false })
    matchObject('m3', third, { nativeId: 'm3', ownMessage: true, ats: [], mentionsAgent: false })
    matchObject('m4', fourth, { nativeId: 'm4', text: '[图片]', ats: [], mentionsAgent: false })
    eq('m4.media is exactly [{id,kind}]', fourth.media, [{ id: 'm4#0', kind: 'image' }])
    check('every event: mentionsAgent === ats.includes(wxid)', page.events.every(e => e.mentionsAgent === (e.ats ?? []).includes(status.wxid)))
    check('m1.at is ISO8601 Z', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(first.at), show(first.at))
    const tail = await client.messages(ROOM, page.next, 50)
    eq('cursor replay yields no events', tail.events.map(e => e.nativeId), [])
    eq('cursor replay keeps next', tail.next, '4')
    const limited = await client.messages(ROOM, undefined, 2)
    eq('limit=2 truncates', limited.events.map(e => e.nativeId), ['m1', 'm2'])
    eq('limit=2 next === "2"', limited.next, '2')
    const fromTwo = await client.messages(ROOM, '2', 50)
    eq('cursor "2" returns m3,m4', fromTwo.events.map(e => e.nativeId), ['m3', 'm4'])
    eq('cursor "2" next === "4"', fromTwo.next, '4')
  })

  await step('[4] POST /send 幂等与串行', async () => {
    const outbound = { room: ROOM, wxid: 'wxid_alice', text: 'live 联调：请把 timeout 改成 3s', quoteId: 'm1', idempotencyKey: 'live-key-1' }
    const started = Date.now()
    const sent = await client.send(outbound)
    const firstMs = Date.now() - started
    check('send is not gone', sent !== 'gone')
    if (sent !== 'gone') {
      check('msgId matches /^fake_[0-9a-f]{10}$/', /^fake_[0-9a-f]{10}$/.test(sent.msgId), show(sent.msgId))
      check('first send deduped:false', sent.deduped === false)
      const startedReplay = Date.now()
      const again = await client.send(outbound)
      const replayMs = Date.now() - startedReplay
      eq('replay returns same msgId + deduped:true', again, { msgId: sent.msgId, deduped: true })
      check('dedupe replay skips the 1s spacing', replayMs < 500, `${replayMs}ms`)
      const other = await client.send({ room: ROOM, wxid: 'wxid_alice', text: '不同 key', idempotencyKey: 'live-key-2' })
      check('different key → different msgId', other !== 'gone' && other.msgId !== sent.msgId)
      check('second real send was spaced ≥1s', Date.now() - started >= 1_000, `${Date.now() - started}ms since first send`)
      check('first send was immediate', firstMs < 500, `${firstMs}ms`)
    }
    eq('unknown room → gone (409)', await client.send({ room: 'chatroom_missing', wxid: 'wxid_alice', text: 'x' }), 'gone')
  })

  await step('[5] GET /media/<id>', async () => {
    const image = await client.media('m4#0')
    eq('media mime is image/png', image.mime, 'image/png')
    check('media bytes > 8', image.bytes.byteLength > 8, String(image.bytes.byteLength))
    eq('PNG magic', [...image.bytes.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let message = ''
    try { await client.media('nope#0') } catch (error) { message = error.message }
    eq('unknown media → gone (404)', message, 'gone')
    eq('unknown media status 404', (await fetch(`${baseUrl}/media/nope%230`, { headers: auth })).status, 404)
    const encoded = await fetch(`${baseUrl}/media/m4%230`, { headers: auth })
    eq('percent-encoded id decodes', encoded.status, 200)
    eq('media content-type', encoded.headers.get('content-type'), 'image/png')
    const body = new Uint8Array(await encoded.arrayBuffer())
    check('raw /media body is the same PNG', body.byteLength > 8 && body[0] === 0x89 && body[1] === 0x50)
  })

  await step('[6] 鉴权', async () => {
    const wrongFile = join(directory, 'wrong.token')
    writeFileSync(wrongFile, 'not-the-sidecar-token\n')
    chmodSync(wrongFile, 0o600)
    let message = ''
    try { await createBridgeClient({ baseUrl, tokenFile: wrongFile }).health() } catch (error) { message = error.message }
    eq('wrong token → unauthorized', message, 'unauthorized')
    const noAuth = await fetch(`${baseUrl}/health`)
    eq('missing header → 401', noAuth.status, 401)
    eq('401 body', await noAuth.json(), { error: 'unauthorized' })
    const looseFile = join(directory, 'loose.token')
    writeFileSync(looseFile, `${TOKEN}\n`)
    chmodSync(looseFile, 0o644)
    // 0644 的 token 文件：POSIX 上必须被拒（`readSecretFile` 的 owner-only 规则），Windows 上 Node 合成的
    // st.mode 分不出 0644/0600，规则被显式跳过（见 src/infra/secret-file.ts），因此这里只断言平台语义。
    let looseMessage = ''
    let calls = 0
    const counting = async () => { calls += 1; throw new Error('must not fetch') }
    try { await createBridgeClient({ baseUrl, tokenFile: looseFile, fetchFn: counting }).health() } catch (error) { looseMessage = error.message }
    if (process.platform === 'win32') {
      check('0644 token 文件在 Windows 上不被 mode 拒绝', !/mode 0600/.test(looseMessage), show(looseMessage))
      eq('Windows 上确实发了请求', calls, 1)
    } else {
      check('0644 token 文件在 POSIX 上被拒', /mode 0600/.test(looseMessage), show(looseMessage))
      eq('POSIX 上未发请求', calls, 0)
    }
  })

  await step('[7] 契约边界', async () => {
    eq('unknown path → 404', (await fetch(`${baseUrl}/nope`, { headers: auth })).status, 404)
    eq('GET /send → 405', (await fetch(`${baseUrl}/send`, { headers: auth })).status, 405)
    eq('POST /health → 405', (await fetch(`${baseUrl}/health`, { method: 'POST', headers: auth })).status, 405)
    eq('POST /send without body → 400', (await fetch(`${baseUrl}/send`, { method: 'POST', headers: auth })).status, 400)
    eq('/media with empty id → 404', (await fetch(`${baseUrl}/media/`, { headers: auth })).status, 404)
    const health = await fetch(`${baseUrl}/health`, { headers: auth })
    eq('health content-type is json', health.headers.get('content-type'), 'application/json; charset=utf-8')
  })

  await step('[8] 停机与端口释放', async () => {
    const pid = child.pid
    await stopSidecar()
    let closed = false
    for (let attempt = 0; attempt < 10 && !closed; attempt += 1) {
      closed = !(await isPortOpen(port))
      if (!closed) await new Promise(r => setTimeout(r, 200))
    }
    check(`port ${port} is free after SIGTERM (pid ${pid})`, closed)
    // Windows 上 Node 的 kill('SIGTERM') 走 TerminateProcess，收不到信号处理函数；优雅退出的实证在
    // verify/signal-check.py（CTRL_BREAK → SIGBREAK，真实进程 + 端口释放 + stopped 日志）。
    if (process.platform !== 'win32') check('graceful shutdown logged', /stopped|收到信号/.test(stderr), show(stderr.slice(-200)))
  })
} finally {
  await stopSidecar()
  rmSync(directory, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) {
  console.log('failures:\n' + failures.map(f => `  - ${redact(f)}`).join('\n'))
  process.exit(1)
}
