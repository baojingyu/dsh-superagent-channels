/** The weixin sidecar bridge client: endpoint coverage, bearer-token hygiene, timeout, idempotency, and event normalization, all against an injected fetch stub. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridgeClient } from '../src/sources/chat/weixin/bridge.ts'
import { withPlatform } from './fixtures/platform.ts'

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

  it('maps the backend capability report, and leaves it absent for a sidecar that does not report one', async () => {
    const capable = stubFetch({ '/health': () => reply({ ok: true, available: true,
      capabilities: { mentions: 'markup', members: 'observed', media: false } }) })
    await expect(client(capable.fetchFn).health()).resolves
      .toMatchObject({ capabilities: { mentions: 'markup', members: 'observed', media: false } })

    // A partial report is read as capable in the fields it omits, so a backend need only name what it cannot do.
    const partial = stubFetch({ '/health': () => reply({ ok: true, available: true, capabilities: { mentions: 'none' } }) })
    await expect(client(partial.fetchFn).health()).resolves
      .toMatchObject({ capabilities: { mentions: 'none', members: 'full', media: true } })

    // A sidecar written before the report grew its states sends booleans; `true` is the best a field can be, so a first
    // generation sidecar keeps working instead of losing every capability it did have.
    const firstGeneration = stubFetch({ '/health': () => reply({ ok: true, available: true,
      capabilities: { mentions: true, members: false, media: true } }) })
    await expect(client(firstGeneration.fetchFn).health()).resolves
      .toMatchObject({ capabilities: { mentions: 'structured', members: 'none', media: true } })

    // "Did not report" stays undefined: an older sidecar must not look like a backend that claimed every capability.
    const older = stubFetch({ '/health': () => reply({ ok: true, available: true }) })
    expect((await client(older.fetchFn).health()).capabilities).toBeUndefined()
  })

  it('pushes the listen set and maps what the backend confirmed, changed, and could not resolve', async () => {
    const { fetchFn, seen } = stubFetch({
      '/listen': () => reply({
        listening: [{ id: 'wxname_aa', name: '研发-交付群' }, { id: '', name: 'ignored' }],
        added: ['研发-交付群', 7], removed: [], failed: [{ room: 'wxname_bb', detail: 'no such chat' }, { room: '' }],
      }),
    })
    await expect(client(fetchFn).listen!(['wxname_aa', 'wxname_bb'])).resolves.toEqual({
      listening: [{ id: 'wxname_aa', name: '研发-交付群' }],
      added: ['研发-交付群'], removed: [], failed: [{ room: 'wxname_bb', detail: 'no such chat' }],
    })
    // The set is replaced rather than merged, so the body is the whole configuration every time.
    expect(seen[0]!.body).toEqual({ rooms: ['wxname_aa', 'wxname_bb'] })
  })

  it('reports an unusable backend on /listen as a failure rather than an empty set', async () => {
    const { fetchFn } = stubFetch({ '/listen': () => reply({ error: 'unavailable' }, 502) })
    await expect(client(fetchFn).listen!(['wxname_aa'])).rejects.toThrow(/POST \/listen failed with 502/)
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

  it('carries the backend\'s own reason into the message, so a panel shows why and not only that', async () => {
    // The bridge answers 502 with `detail` holding the real cause, such as an unattachable client. Losing it turns a
    // precise "your WeChat client is not signed in" into a useless "unavailable".
    const { fetchFn } = stubFetch({
      '/rooms': () => reply({ error: 'unavailable', detail: 'attach failed: no signed-in main window found\nretrying every 30s' }, 502),
    })
    const error = await client(fetchFn).rooms().catch((reason: unknown) => reason)
    expect((error as Error).message).toContain('502')
    expect((error as Error).message).toContain('no signed-in main window found')
    // One line only: the panel has a toast, not a log viewer.
    expect((error as Error).message).not.toContain('\n')
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
    // Windows synthesizes `st.mode` (0o666 for any writable file) and cannot tell 0644 from 0600, so the owner-only rule is
    // judged as the POSIX rule it is; the file's real mode there is 0o666, which is what the stubbed branch refuses.
    await withPlatform('linux', async () => {
      // The message names the mode that was found, so an operator sees "not 666" and knows the file was made writable.
      await expect(client(loose.fetchFn).health()).rejects.toThrow(/mode 0600, not \d{3}: /)
    })
    expect(loose.seen).toEqual([])

    rmSync(tokenFile)
    const missing = stubFetch({})
    await expect(client(missing.fetchFn).health()).rejects.toThrow(/is missing/)
    expect(missing.seen).toEqual([])
  })
})

describe('bridge.media byte cap', () => {
  /** A body produced chunk by chunk, so a reader that stops at the cap is distinguishable from one that buffers it all. */
  function chunked(count: number, size: number): { body: ReadableStream<Uint8Array>; served: () => number } {
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= count) { controller.close(); return }
        sent += 1
        controller.enqueue(new Uint8Array(size))
      },
    })
    return { body, served: () => sent * size }
  }

  it('refuses a declared length over the cap without reading the body at all', async () => {
    const { body, served } = chunked(5, 400)
    const { fetchFn } = stubFetch({ '/media/m1': () => new Response(body, { status: 200,
      headers: { 'content-type': 'image/png', 'content-length': '5000' } }) })
    await expect(client(fetchFn).media!('m1', 1_000)).rejects.toThrow(/declared 5000 bytes .* over the 1000-byte limit/)
    // The refusal comes from the header, so the 2 000-byte body is never consumed (a stream may have one chunk in flight).
    expect(served()).toBeLessThan(2_000)
  })

  it('cancels the stream as soon as the running total passes the cap, instead of buffering the image', async () => {
    const { body, served } = chunked(5, 400)
    const { fetchFn } = stubFetch({ '/media/m1': () => new Response(body, { status: 200, headers: { 'content-type': 'image/png' } }) })
    await expect(client(fetchFn).media!('m1', 1_000)).rejects.toThrow(/over the 1000-byte limit/)
    // Five 400-byte chunks are 2 000 bytes; the reader stops at the third, so the rest are never produced.
    expect(served()).toBeLessThan(2_000)
  })

  it('returns the bytes of an image that fits the cap, and keeps the served media type', async () => {
    const { body } = chunked(2, 300)
    const { fetchFn } = stubFetch({ '/media/m1': () => new Response(body, { status: 200, headers: { 'content-type': 'IMAGE/PNG' } }) })
    const image = await client(fetchFn).media!('m1', 1_000)
    expect(image.bytes.byteLength).toBe(600)
    expect(image.mime).toBe('image/png')
  })
})
