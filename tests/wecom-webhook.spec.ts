/** The WeCom callback handler and adapter: XML parsing, the GET verification, signed POST events, dedupe and a cached token. */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DeliveredRing } from '../src/sources/chat/dedupe.ts'
import { createWecomSender, parseXml } from '../src/sources/chat/wecom/adapter.ts'
import { encrypt, signatureOf } from '../src/sources/chat/wecom/crypto.ts'
import { handleWebhook, type WecomWebhookConfig } from '../src/sources/chat/wecom/webhook.ts'
import { withPlatform } from './fixtures/platform.ts'

const KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
const CORP = 'ww1234567890abcdef'
const TIMESTAMP = '1409659589'
const NONCE = '1234567890'
const CONFIG: WecomWebhookConfig = { token: 'QDG6eK', encodingAesKey: KEY, corpId: CORP, instance: 'wecom-ops' }

const innerXml = (fields: { from: string; text: string; msgId: string; chatId?: string }): string => `<xml>
  <ToUserName><![CDATA[${CORP}]]></ToUserName>
  <FromUserName><![CDATA[${fields.from}]]></FromUserName>
  <CreateTime>1348831860</CreateTime>
  <MsgType><![CDATA[text]]></MsgType>
  <Content><![CDATA[${fields.text}]]></Content>
  <MsgId>${fields.msgId}</MsgId>
  <AgentID>100001</AgentID>
  ${fields.chatId ? `<ChatId><![CDATA[${fields.chatId}]]></ChatId>` : ''}
</xml>`

/** A signed POST: the body carries the encrypted inner XML, and the query carries its signature. */
function signed(fields: { from: string; text: string; msgId: string; chatId?: string }) {
  const encrypted = encrypt(innerXml(fields), KEY, CORP)
  return {
    query: { msg_signature: signatureOf(CONFIG.token, TIMESTAMP, NONCE, encrypted), timestamp: TIMESTAMP, nonce: NONCE },
    body: `<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><Encrypt><![CDATA[${encrypted}]]></Encrypt><AgentID>100001</AgentID></xml>`,
  }
}

it('parses a text callback and an image callback into a ChatEvent, and returns null for the rest', () => {
  const direct = parseXml(`<xml><ToUserName><![CDATA[${CORP}]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName>
    <CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好 &amp; hello]]></Content>
    <MsgId>1234567890123456</MsgId><AgentID>100001</AgentID></xml>`)
  expect(direct).toMatchObject({ nativeId: '1234567890123456', chatId: 'zhangsan', direct: true, threadRoot: 'zhangsan',
    sender: { id: 'zhangsan', bot: false }, text: '你好 & hello', agentId: '100001', at: new Date(1348831860 * 1000).toISOString() })
  const group = parseXml(`<xml><FromUserName><![CDATA[zhangsan]]></FromUserName><ChatId><![CDATA[wrOgQhDgAAMYQiS5ol9G7gK9JV]]></ChatId>
    <MsgType>text</MsgType><Content>hi</Content><MsgId>42</MsgId></xml>`)
  expect(group).toMatchObject({ nativeId: '42', chatId: 'wrOgQhDgAAMYQiS5ol9G7gK9JV', direct: false, threadRoot: 'wrOgQhDgAAMYQiS5ol9G7gK9JV', text: 'hi' })
  // An image callback names its bytes by MediaId and carries no text; the media API downloads them later.
  const image = parseXml(`<xml><FromUserName><![CDATA[u]]></FromUserName><CreateTime>1</CreateTime><MsgType><![CDATA[image]]></MsgType>
    <MediaId><![CDATA[MEDIA-1]]></MediaId><MsgId>7</MsgId></xml>`)
  expect(image).toMatchObject({ nativeId: '7', text: '', media: [{ id: 'MEDIA-1', kind: 'image' }] })
  // An image without a MediaId has no bytes to name, and an event or voice note is not carried at all.
  expect(parseXml(`<xml><MsgType><![CDATA[image]]></MsgType><MsgId>1</MsgId><FromUserName>u</FromUserName></xml>`)).toBeNull()
  expect(parseXml(`<xml><MsgType>event</MsgType><Event>enter_agent</Event></xml>`)).toBeNull()
})

it('answers the URL verification with the decrypted echostr only when its signature checks out', () => {
  const echostr = encrypt('1616140317555161061', KEY, CORP)
  const good = handleWebhook({ query: { msg_signature: signatureOf(CONFIG.token, TIMESTAMP, NONCE, echostr), timestamp: TIMESTAMP, nonce: NONCE, echostr } }, CONFIG)
  expect(good).toEqual({ ok: true, events: [], reply: '1616140317555161061' })
  const bad = handleWebhook({ query: { msg_signature: '0'.repeat(40), timestamp: TIMESTAMP, nonce: NONCE, echostr } }, CONFIG)
  expect(bad).toEqual({ ok: false, events: [] })
})

it('turns a signed message into one event, drops its redelivery, and never yields an event on a bad signature', () => {
  const ring = new DeliveredRing()
  const request = signed({ from: 'zhangsan', text: 'hello', msgId: '99' })
  const first = handleWebhook(request, CONFIG, ring)
  expect(first.ok).toBe(true)
  expect(first.events).toHaveLength(1)
  expect(first.events[0]).toMatchObject({ nativeId: '99', chatId: 'zhangsan', text: 'hello', direct: true })
  expect(typeof first.reply).toBe('string')
  // The platform's retry of the same message yields no event and no failure.
  expect(handleWebhook(request, CONFIG, ring)).toMatchObject({ ok: true, events: [] })
  // A forged signature is refused and produces nothing at all.
  const forged = { ...request, query: { ...request.query, msg_signature: 'f'.repeat(40) } }
  expect(handleWebhook(forged, CONFIG)).toEqual({ ok: false, events: [] })
  // A missing query or body is refused the same way.
  expect(handleWebhook({ query: { timestamp: TIMESTAMP, nonce: NONCE }, body: request.body }, CONFIG)).toEqual({ ok: false, events: [] })
  expect(handleWebhook({ query: request.query }, CONFIG)).toEqual({ ok: false, events: [] })
})

describe('WeCom sender', () => {
  it('caches the access token across sends and posts text to /cgi-bin/message/send', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/cgi-bin/gettoken')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 7200 }), { status: 200 })
      const body = JSON.parse(String(init?.body)) as { touser?: string }
      if (body.touser === 'gone-user') return new Response(JSON.stringify({ errcode: 81013, errmsg: 'user not found' }), { status: 200 })
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
    }) as unknown as typeof fetch
    const sender = createWecomSender({ fetchFn, now: () => 1_000 })
    const config = { corpId: 'ww1', corpSecret: 'secret', agentId: 100001 }
    expect(await sender.sendMessage(config, { touser: 'zhangsan' }, 'hi')).toBe('sent')
    expect(await sender.sendMessage(config, { touser: 'lisi' }, 'again')).toBe('sent')
    expect(await sender.sendMessage(config, { touser: 'gone-user' }, 'x')).toBe('gone')
    expect(calls.filter(call => call.url.includes('/cgi-bin/gettoken'))).toHaveLength(1)
    expect(calls.filter(call => call.url.includes('/cgi-bin/message/send'))).toHaveLength(3)
    const send = calls.find(call => call.url.includes('/cgi-bin/message/send'))!
    expect(send.url).toContain('access_token=tok-1')
    expect(JSON.parse(String(send.init?.body))).toMatchObject({ touser: 'zhangsan', msgtype: 'text', agentid: 100001, text: { content: 'hi' } })
  })

  it('fails loudly when the token request is refused, without keeping a token', async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }), { status: 200 })) as unknown as typeof fetch
    const sender = createWecomSender({ fetchFn })
    await expect(sender.sendMessage({ corpId: 'c', corpSecret: 's', agentId: 1 }, { touser: 'u' }, 'x')).rejects.toThrow(/40013/)
    const down = (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch
    await expect(createWecomSender({ fetchFn: down }).accessToken({ corpId: 'c', corpSecret: 's', agentId: 1 })).rejects.toThrow(/HTTP 500/)
  })

  it('sends to a group chat by chatid', async () => {
    const bodies: unknown[] = []
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/cgi-bin/gettoken')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await createWecomSender({ fetchFn }).sendMessage({ corpId: 'c', corpSecret: 's', agentId: 1 }, { chatid: 'wr1' }, 'hi')).toBe('sent')
    expect(bodies).toEqual([{ chatid: 'wr1', msgtype: 'text', agentid: 1, text: { content: 'hi' } }])
  })
})

describe('WeCom users', () => {
  it('lists a department\'s users for the Policy pickers, and names a JSON error', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('/cgi-bin/gettoken')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 7200 }), { status: 200 })
      expect(url).toContain('/cgi-bin/user/simplelist')
      expect(url).toContain('department_id=7')
      return new Response(JSON.stringify({ errcode: 0, userlist: [{ userid: 'zhangsan', name: '张三' }, { userid: 'lisi' }] }), { status: 200 })
    }) as unknown as typeof fetch
    expect(await createWecomSender({ fetchFn }).users({ corpId: 'ww1', corpSecret: 's', agentId: 1 }, '7'))
      .toEqual([{ id: 'zhangsan', name: '张三' }, { id: 'lisi' }])
    const refused = (async () => new Response(JSON.stringify({ errcode: 60011, errmsg: 'no privilege' }), { status: 200 })) as unknown as typeof fetch
    await expect(createWecomSender({ fetchFn: refused }).users({ corpId: 'ww1', corpSecret: 's', agentId: 1 }, '1'))
      .rejects.toThrow(/errcode 60011.*no privilege/)
  })
})

describe('WeCom secret files', () => {
  const file = (dir: string, name: string, value: string, mode = 0o600): string => {
    const path = join(dir, name)
    writeFileSync(path, value)
    chmodSync(path, mode)
    return path
  }

  it('reads the application secret from its 0600 file ahead of the inline value, and falls back when the file is absent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-secret-'))
    try {
      const urls: string[] = []
      const fetchFn = (async (input: string | URL | Request) => {
        const url = String(input)
        urls.push(url)
        if (url.includes('/cgi-bin/gettoken')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 7200 }), { status: 200 })
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
      }) as unknown as typeof fetch
      const sender = createWecomSender({ fetchFn })
      await sender.sendMessage({ corpId: 'ww1', corpSecret: 'inline-secret', agentId: 1, tokenFile: file(dir, 'secret', 'file-secret') }, { touser: 'u' }, 'hi')
      const tokenUrl = urls.find(url => url.includes('/cgi-bin/gettoken'))!
      expect(tokenUrl).toContain('corpsecret=file-secret')
      expect(tokenUrl).not.toContain('inline-secret')
      // A named but not yet existing file falls back to the inline secret.
      const fallback = createWecomSender({ fetchFn })
      await fallback.sendMessage({ corpId: 'ww2', corpSecret: 'inline-2', agentId: 1, tokenFile: join(dir, 'absent') }, { touser: 'u' }, 'hi')
      expect(urls.filter(url => url.includes('/cgi-bin/gettoken')).at(-1)).toContain('corpsecret=inline-2')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses a secret file that is not 0600, before any request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-secret-'))
    try {
      let calls = 0
      const fetchFn = (async () => { calls++; return new Response('{}', { status: 200 }) }) as unknown as typeof fetch
      // Windows synthesizes `st.mode` (0o666 for any writable file) and cannot tell 0644 from 0600, so the owner-only rule is
      // judged as the POSIX rule it is; the file's real mode there is 0o666, which is what the stubbed branch refuses.
      await withPlatform('linux', () => expect(createWecomSender({ fetchFn }).sendMessage(
        { corpId: 'ww1', corpSecret: 'inline', agentId: 1, tokenFile: file(dir, 'secret', 'file-secret', 0o644) }, { touser: 'u' }, 'hi'))
        .rejects.toThrow(/0600/))
      expect(calls).toBe(0)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('decrypts a callback with the EncodingAESKey in its 0600 file, and yields no event on a misconfigured key file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wecom-aes-'))
    try {
      const echostr = encrypt('1616140317555161061', KEY, CORP)
      const query = { msg_signature: signatureOf(CONFIG.token, TIMESTAMP, NONCE, echostr), timestamp: TIMESTAMP, nonce: NONCE, echostr }
      const good = handleWebhook({ query }, { ...CONFIG, encodingAesKey: '', encodingAesKeyFile: file(dir, 'aes', KEY) })
      expect(good).toEqual({ ok: true, events: [], reply: '1616140317555161061' })
      // The same POSIX rule as above: a key file whose mode is not 0600 yields no event where the bits are real.
      const bad = await withPlatform('linux', () => handleWebhook({ query },
        { ...CONFIG, encodingAesKey: '', encodingAesKeyFile: file(dir, 'aes-644', KEY, 0o644) }))
      expect(bad).toEqual({ ok: false, events: [] })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
