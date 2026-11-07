/** The weixin sidecar bridge client: endpoint coverage, bearer-token hygiene, timeout, idempotency, and event normalization, all against an injected fetch stub. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridgeClient } from '../src/sources/chat/weixin/bridge.ts'

const BASE_URL = 'http://127.0.0.1:8787'
type Route = (url: URL, init: RequestInit) => Response | Promise<Response>
interface Seen { path: string; url: string; headers: Record<string, string>; body: unknown }

let directory: string
let tokenFile: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'weixin-bridge-'))
  tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'secret\n', { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** A fetch stub that records every request and answers it from `routes`, so no test reaches the network. */
function stubFetch(routes: Record<string, Route>) {
  const seen: Seen[] = []
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    seen.push({ path: url.pathname, url: url.toString(), headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    const route = routes[url.pathname]
    if (!route) throw new Error(`unexpected request: ${url.pathname}`)
    return route(url, init)
  }) as unknown as typeof fetch
  return { fetchFn, seen }
}
const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const client = (fetchFn: typeof fetch, timeoutMs?: number) =>
  createBridgeClient({ baseUrl: BASE_URL, tokenFile, fetchFn, ...(timeoutMs === undefined ? {} : { timeoutMs }) })

describe('createBridgeClient', () => {
  it('sends the bearer token and maps /health, /status, /rooms, and /members', async () => {
    const { fetchFn, seen } = stubFetch({
      '/health': () => reply({ ok: true, available: true, version: '0.1.0', sidecar: '1', backend: 'wxauto', detail: '', uptimeSec: 42 }),
      '/status': () => reply({ loggedIn: true, wxid: 'wxid_self', name: '智能助手', backend: 'wxauto', available: true, lastEventAt: '2026-11-06T04:02:10Z' }),
      '/rooms': () => reply({ rooms: [{ id: 'chatroom_abc', name: '研发-交付群' }, { id: '', name: 'ignored' }] }),
      '/members': url => reply({ room: url.searchParams.get('room'), members: [{ id: 'wxid_alice', name: '阿黎' }, { id: '', name: 'ignored' }] }),
    })
    const bridge = client(fetchFn)
    await expect(bridge.health()).resolves.toEqual({ ok: true, available: true, version: '0.1.0', sidecar: '1', backend: 'wxauto', uptimeSec: 42 })
    await expect(bridge.status()).resolves.toEqual({ loggedIn: true, wxid: 'wxid_self', name: '智能助手', backend: 'wxauto', available: true, lastEventAt: '2026-11-06T04:02:10Z' })
    await expect(bridge.rooms()).resolves.toEqual([{ id: 'chatroom_abc', name: '研发-交付群' }])
    await expect(bridge.members('chatroom_abc')).resolves.toEqual([{ id: 'wxid_alice', name: '阿黎' }])
    expect(seen.map(call => call.path)).toEqual(['/health', '/status', '/rooms', '/members'])
    expect(seen.every(call => call.headers.Authorization === 'Bearer secret')).toBe(true)
    expect(seen[3]!.url).toContain('room=chatroom_abc')
  })

  it('reports an unavailable backend from /health instead of pretending it is ready', async () => {
    const { fetchFn } = stubFetch({ '/health': () => reply({ ok: false, available: false, detail: 'wxauto not importable: no module' }) })
    await expect(client(fetchFn).health()).resolves.toEqual({ ok: false, available: false, detail: 'wxauto not importable: no module' })
  })

  it('maps /messages into ChatEvents, computing mentionsAgent from the structured ats list of the account', async () => {
    const { fetchFn, seen } = stubFetch({
      '/status': () => reply({ loggedIn: true, wxid: 'wxid_self', name: '助手' }),
      '/messages': () => reply({ events: [
        { nativeId: 'm1', room: 'chatroom_abc', sender: { id: 'wxid_alice', name: '阿黎' }, text: '@助手 把 timeout 改成 3s',
          at: '2026-11-06T04:01:02Z', ats: ['wxid_self'], quoteId: 'm0', mentionsMe: false, own: false },
        { nativeId: 'm2', room: '', sender: { id: 'wxid_bob' }, text: 'hi', at: '2026-11-06T04:02:00Z', ats: [], quoteId: '', own: true },
      ], next: '7' }),
    })
    const page = await client(fetchFn).messages('chatroom_abc', '3', 250)
    expect(page.next).toBe('7')
    expect(page.events).toEqual([
      { nativeId: 'm1', chatId: 'chatroom_abc', direct: false, threadRoot: 'chatroom_abc', parentId: 'm0',
        sender: { id: 'wxid_alice', name: '阿黎', bot: false }, text: '@助手 把 timeout 改成 3s', at: '2026-11-06T04:01:02Z',
        mentionsAgent: true, ats: ['wxid_self'] },
      { nativeId: 'm2', chatId: '', direct: true, threadRoot: 'wxid_bob', sender: { id: 'wxid_bob', bot: false }, text: 'hi',
        at: '2026-11-06T04:02:00Z', ownMessage: true, mentionsAgent: false, ats: [] },
    ])
    // The page size is clamped to the contract's maximum, and the cursor travels as a query parameter.
    expect(seen.find(call => call.path === '/messages')!.url).toContain('limit=200')
    expect(seen.find(call => call.path === '/messages')!.url).toContain('cursor=3')
  })

  it('reads the account identity at most once a minute when mapping messages', async () => {
    let statusCalls = 0
    const { fetchFn } = stubFetch({
      '/status': () => { statusCalls += 1; return reply({ loggedIn: true, wxid: 'wxid_self', name: '助手' }) },
      '/messages': () => reply({ events: [], next: '' }),
    })
    const bridge = client(fetchFn)
    await bridge.messages('room')
    await bridge.messages('room')
    expect(statusCalls).toBe(1)
  })

  it('throws unauthorized when the bridge answers 401', async () => {
    const direct = stubFetch({ '/status': () => reply({ error: 'unauthorized' }, 401) })
    await expect(client(direct.fetchFn).status()).rejects.toThrow('unauthorized')
    const page = stubFetch({
      '/status': () => reply({ loggedIn: true, wxid: 'wxid_self' }),
      '/messages': () => reply({ error: 'unauthorized' }, 401),
    })
    await expect(client(page.fetchFn).messages('room')).rejects.toThrow('unauthorized')
  })

  it("returns 'gone' when /send answers 409 gone, without retrying", async () => {
    const { fetchFn, seen } = stubFetch({ '/send': () => reply({ error: 'gone' }, 409) })
    await expect(client(fetchFn).send({ room: 'chatroom_abc', wxid: 'wxid_alice', text: 'hi' })).resolves.toBe('gone')
    expect(seen).toHaveLength(1)
  })

  it('marks a 502 as a retryable error', async () => {
    const { fetchFn } = stubFetch({ '/send': () => reply({ error: 'sendFailed', detail: 'bridge offline' }, 502) })
    const error = await client(fetchFn).send({ room: 'chatroom_abc', wxid: 'wxid_alice', text: 'hi' }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('502')
    expect((error as Error).message).toContain('sendFailed')
    expect((error as Error & { retryable?: boolean }).retryable).toBe(true)
  })

  it('throws when the bridge does not answer within its timeout', async () => {
    const fetchFn = ((_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
    })) as unknown as typeof fetch
    await expect(client(fetchFn, 10).health()).rejects.toThrow(/did not answer .* within 10ms/)
  })

  it('passes the Idempotency-Key and the JSON body through /send', async () => {
    const { fetchFn, seen } = stubFetch({ '/send': () => reply({ msgId: 'srv-1', deduped: false }) })
    await expect(client(fetchFn).send({ room: 'chatroom_abc', wxid: 'wxid_alice', text: '已修复，见 MR !37', quoteId: 'm1', idempotencyKey: 'out-1' }))
      .resolves.toEqual({ msgId: 'srv-1', deduped: false })
    expect(seen[0]!.headers['Idempotency-Key']).toBe('out-1')
    expect(seen[0]!.headers['content-type']).toBe('application/json')
    expect(seen[0]!.body).toEqual({ room: 'chatroom_abc', wxid: 'wxid_alice', text: '已修复，见 MR !37', quoteId: 'm1' })
  })

  it('refuses a token file that others can read and one that is missing, before any request', async () => {
    chmodSync(tokenFile, 0o644)
    const loose = stubFetch({})
    await expect(client(loose.fetchFn).health()).rejects.toThrow(/mode 0600/)
    expect(loose.seen).toEqual([])

    rmSync(tokenFile)
    const missing = stubFetch({})
    await expect(client(missing.fetchFn).health()).rejects.toThrow(/is missing/)
    expect(missing.seen).toEqual([])
  })
})