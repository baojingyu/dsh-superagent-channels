/** DingTalk adapter and stream: callback parsing, sessionWebhook/oapi sending, and abortable injected streams — all offline. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Health } from '../src/sources/host.ts'
import type { ChatEvent } from '../src/sources/chat/port.ts'
import { parseStreamEvent, sendMessage } from '../src/sources/chat/dingtalk/adapter.ts'
import { createLongPollingStream, startStream } from '../src/sources/chat/dingtalk/stream.ts'

const config = { clientId: 'app-key', clientSecret: 'app-secret', robotCode: 'robot-1' }
const at = 1_760_000_000_000
const groupCallback = {
  msgId: 'msg-1', msgtype: 'text', conversationId: 'cid-group', conversationType: '2',
  senderId: 'sender-x', senderStaffId: 'staff-alice', senderNick: '阿黎', robotCode: 'robot-1', createAt: at,
  text: { content: '@机器人 把 timeout 改成 3s' },
  atUsers: [{ dingtalkId: 'dd-1', staffId: 'staff-self' }, { dingtalkId: 'dd-2', staffId: '' }],
  isInAtList: true,
  sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=abc',
  sessionWebhookExpiredTime: at + 600_000,
}
const webhookAddress = { conversationId: 'cid-group', sessionWebhook: groupCallback.sessionWebhook }
const MARK = '\u2063'

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>
interface Seen { path: string; url: string; headers: Record<string, string>; body: unknown }

/** A fetch stub that records every request and answers it from `routes`, so no test reaches the network. */
function stubFetch(route: Route) {
  const seen: Seen[] = []
  const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input))
    seen.push({ path: url.pathname, url: url.toString(), headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined })
    return route(url, init)
  }) as unknown as typeof fetch
  return { fetchFn, seen }
}
const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('parseStreamEvent', () => {
  it('parses a group message that mentions the bot, with the structured ats staffIds', () => {
    const event = parseStreamEvent(groupCallback, { robotCode: 'robot-1', staffId: 'staff-self' })!
    expect(event).toMatchObject({
      nativeId: 'msg-1', chatId: 'cid-group', direct: false, threadRoot: 'cid-group',
      sender: { id: 'staff-alice', name: '阿黎', bot: false },
      text: '@机器人 把 timeout 改成 3s', at: new Date(at).toISOString(), mentionsAgent: true, ats: ['staff-self'],
    })
    expect(event.ownMessage).toBe(false)
    expect(event.parentId).toBeUndefined()
  })

  it('parses a direct message from its conversation type, with the peer as the thread root', () => {
    const event = parseStreamEvent({ ...groupCallback, msgId: 'msg-2', conversationType: '1', conversationId: '', senderStaffId: 'staff-bob', atUsers: [], isInAtList: false })!
    expect(event).toMatchObject({ chatId: '', direct: true, threadRoot: 'staff-bob', mentionsAgent: false, ats: [] })
  })

  it('reads a markdown body, and refuses other message types, senders the callback lost, or messages without a time', () => {
    expect(parseStreamEvent({ ...groupCallback, msgtype: 'markdown', markdown: { title: 't', text: '**已修复**' } })!.text).toBe('**已修复**')
    expect(parseStreamEvent({ ...groupCallback, msgtype: 'picture' })).toBeNull()
    expect(parseStreamEvent({ ...groupCallback, msgtype: 'file' })).toBeNull()
    expect(parseStreamEvent({ ...groupCallback, senderStaffId: '', senderId: '' })).toBeNull()
    expect(parseStreamEvent({ ...groupCallback, createAt: undefined })).toBeNull()
  })

  it('marks a message the robot sent itself as own, from the sender and robot identity it can see', () => {
    expect(parseStreamEvent({ ...groupCallback, senderStaffId: 'robot-1', senderId: '$bot' })!.ownMessage).toBe(true)
    expect(parseStreamEvent(groupCallback)!.ownMessage).toBe(false)
    // Without a robot code on either side, an own message cannot be told apart and stays false.
    expect(parseStreamEvent({ ...groupCallback, robotCode: undefined })!.ownMessage).toBe(false)
  })
})

describe('sendMessage', () => {
  it('sends through the sessionWebhook the message carried, with the in-band idempotency marker', async () => {
    const { fetchFn, seen } = stubFetch(() => reply({ errcode: 0, errmsg: 'ok' }))
    await expect(sendMessage({ fetchFn }, config, webhookAddress, '已修复', 'out-1')).resolves.toBe('sent')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(webhookAddress.sessionWebhook)
    expect(seen[0]!.headers['Idempotency-Key']).toBe('out-1')
    expect(seen[0]!.body).toEqual({ msgtype: 'text', text: { content: `已修复${MARK}out-1` }, robotCode: 'robot-1' })
  })

  it('falls back to the oapi robot API, caches the access token, and still carries the key', async () => {
    const { fetchFn, seen } = stubFetch(url => url.pathname === '/gettoken'
      ? reply({ errcode: 0, errmsg: 'ok', access_token: 'tk-1', expires_in: 7200 })
      : reply({ errcode: 0, errmsg: 'ok' }))
    const oapiConfig = { clientId: 'app-oapi', clientSecret: 'secret-oapi', robotCode: 'robot-oapi' }
    await expect(sendMessage({ fetchFn }, oapiConfig, { conversationId: 'cid-1' }, 'hi', 'out-2')).resolves.toBe('sent')
    expect(seen.map(call => call.path)).toEqual(['/gettoken', '/robot/send'])
    expect(seen[0]!.url).toContain('appkey=app-oapi')
    expect(seen[1]!.url).toContain('access_token=tk-1')
    expect(seen[1]!.headers['Idempotency-Key']).toBe('out-2')
    expect(seen[1]!.body).toEqual({ robotCode: 'robot-oapi', msgtype: 'text', text: { content: `hi${MARK}out-2` } })

    await expect(sendMessage({ fetchFn }, oapiConfig, { conversationId: 'cid-1' }, 'again', 'out-3')).resolves.toBe('sent')
    expect(seen.filter(call => call.path === '/gettoken')).toHaveLength(1)
  })

  it('ignores an expired sessionWebhook and uses the oapi path instead', async () => {
    const { fetchFn, seen } = stubFetch(url => url.pathname === '/gettoken'
      ? reply({ errcode: 0, errmsg: 'ok', access_token: 'tk-2', expires_in: 7200 })
      : reply({ errcode: 0, errmsg: 'ok' }))
    const expiredConfig = { clientId: 'app-expired', clientSecret: 'secret-expired', robotCode: 'robot-1' }
    await expect(sendMessage({ fetchFn }, expiredConfig, { conversationId: 'cid-1', sessionWebhook: 'https://x/session', sessionWebhookExpiredTime: 1 }, 'hi', 'out-4')).resolves.toBe('sent')
    expect(seen.map(call => call.path)).toEqual(['/gettoken', '/robot/send'])
  })

  it('reports a gone address as gone, and a server failure as a retryable error', async () => {
    const gone = stubFetch(() => reply({ errcode: 300001, errmsg: 'token is not exist' }))
    await expect(sendMessage({ fetchFn: gone.fetchFn }, config, webhookAddress, 'hi', 'out-5')).resolves.toBe('gone')

    const goneChat = stubFetch(() => reply({ errcode: 310000, errmsg: 'bot is not in the chat' }))
    await expect(sendMessage({ fetchFn: goneChat.fetchFn }, config, webhookAddress, 'hi', 'out-6')).resolves.toBe('gone')

    const broken = stubFetch(() => reply({ errcode: 500, errmsg: 'boom' }, 500))
    const error = await sendMessage({ fetchFn: broken.fetchFn }, config, webhookAddress, 'hi', 'out-7').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('500')
    expect((error as Error & { retryable?: boolean }).retryable).toBe(true)
  })
})

describe('startStream', () => {
  it('hands every injected callback to the handler and stops on abort', async () => {
    const controller = new AbortController()
    const events: ChatEvent[] = []
    const reports: Health[] = []
    const raw: unknown[] = [groupCallback, { ...groupCallback, msgId: 'msg-2' }]
    let index = 0
    const connect = (): AsyncIterable<unknown> => {
      const iterator: AsyncIterableIterator<unknown> = {
        [Symbol.asyncIterator]() { return iterator },
        next() {
          if (index < raw.length) { const value = raw[index]; index += 1; return Promise.resolve({ value, done: false }) }
          return new Promise<IteratorResult<unknown>>(() => { /* waits until the stream is aborted */ })
        },
        return() { return Promise.resolve({ value: undefined, done: true }) },
      }
      return iterator
    }
    await startStream({ connect, signal: controller.signal, report: health => reports.push(health),
      handler: event => { events.push(event); controller.abort() } })
    expect(events).toHaveLength(1)
    expect(events[0]!.nativeId).toBe('msg-1')
    expect(reports[0]!.state).toBe('starting')
    expect(reports.at(-1)!.state).toBe('paused')
  })

  it('reports a malformed callback as an error state instead of throwing', async () => {
    const controller = new AbortController()
    const events: ChatEvent[] = []
    const reports: Health[] = []
    const raw: unknown[] = [{ bad: true }, groupCallback]
    async function* source() { for (const value of raw) yield value }
    const parse = (value: unknown): ChatEvent | null => {
      if (typeof value === 'object' && value !== null && 'bad' in value) throw new Error('unreadable callback')
      return parseStreamEvent(value)
    }
    await startStream({ connect: () => source(), signal: controller.signal, parse, report: health => reports.push(health), handler: event => events.push(event) })
    expect(events.map(event => event.nativeId)).toEqual(['msg-1'])
    expect(reports.some(health => health.state === 'error' && health.detail === 'unreadable callback')).toBe(true)
    expect(reports.at(-1)!.state).toBe('paused')
  })
})

describe('createLongPollingStream', () => {
  it('reconnects the injected connector and yields across connections until aborted', async () => {
    const controller = new AbortController()
    let attempt = 0
    const stream = createLongPollingStream(() => {
      attempt += 1
      const values = attempt === 1 ? ['a'] : ['b']
      return (async function* () { for (const value of values) yield value })()
    }, { retryMs: 0, signal: controller.signal })
    const seen: unknown[] = []
    for await (const value of stream) {
      seen.push(value)
      if (seen.length === 2) { controller.abort(); break }
    }
    expect(seen).toEqual(['a', 'b'])
  })

  it('aborts the reconnect wait immediately and leaves no timer behind', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const stream = createLongPollingStream(() => (async function* () { yield 'a' })(), { retryMs: 60_000, signal: controller.signal })
      const iterator = stream[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toEqual({ value: 'a', done: false })
      // Drive the generator through the end of its first connection into the reconnect wait.
      const pending = iterator.next()
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
      expect(vi.getTimerCount()).toBe(1)
      const startedAt = Date.now()
      controller.abort()
      await expect(pending).resolves.toEqual({ value: undefined, done: true })
      // The fake clock proves it did not sit out the 60s retry, and the timer was cleared rather than left pending.
      expect(Date.now() - startedAt).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
describe('sendMessage secret files', () => {
  const file = (dir: string, name: string, value: string, mode = 0o600): string => {
    const path = join(dir, name)
    writeFileSync(path, value)
    chmodSync(path, mode)
    return path
  }
  const oapi = (dir: string, secret: string, mode = 0o600) =>
    ({ clientId: 'app-key', clientSecret: 'inline-secret', robotCode: 'robot-1', tokenFile: file(dir, secret, 'file-secret', mode) })

  it('reads the app secret from its 0600 file ahead of the inline value, and falls back when the file is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-secret-'))
    try {
      const { fetchFn, seen } = stubFetch(url => url.pathname === '/gettoken'
        ? reply({ errcode: 0, access_token: 'tok' })
        : reply({ errcode: 0, errmsg: 'ok' }))
      await expect(sendMessage({ fetchFn }, oapi(dir, 'file-secret'), { conversationId: 'cid-1' }, 'hi', 'out-a')).resolves.toBe('sent')
      const tokenUrl = seen.find(call => call.path === '/gettoken')!.url
      expect(tokenUrl).toContain('appsecret=file-secret')
      expect(tokenUrl).not.toContain('inline-secret')
      const missing = { ...oapi(dir, 'unused'), tokenFile: join(dir, 'absent') }
      await expect(sendMessage({ fetchFn }, missing, { conversationId: 'cid-2' }, 'hi', 'out-b')).resolves.toBe('sent')
      expect(seen.filter(call => call.path === '/gettoken').at(-1)!.url).toContain('appsecret=inline-secret')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses a secret file that is not 0600, before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dingtalk-secret-'))
    try {
      let calls = 0
      const fetchFn = (async () => { calls++; return reply({ errcode: 0 }) }) as unknown as typeof fetch
      await expect(sendMessage({ fetchFn }, oapi(dir, 'file-secret', 0o644), { conversationId: 'cid-1' }, 'hi', 'out-c')).rejects.toThrow(/0600/)
      expect(calls).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
