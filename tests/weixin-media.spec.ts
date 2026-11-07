/**
 * Weixin message images: the bridge's `/media` download, magic-byte sniffing, the attachment commit, and the thread reader
 * that serves an image to an assessment. Everything is local: the bridge's transport is an injected fetch stub and the
 * attachments service is provided on a real Cordis context, so no test reaches the network or writes to disk.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentLimits, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import type { ChatEvent } from '../src/sources/chat/port.ts'
import { createBridgeClient } from '../src/sources/chat/weixin/bridge.ts'
import type { BridgeClient } from '../src/sources/chat/weixin/bridge.ts'
import { imageIds, imageMarker, readWeixinImage, sniffImageMediaType } from '../src/sources/chat/weixin/media.ts'
import { triggerOf } from '../src/sources/weixin-watch.ts'
import { imageIds as threadImageIds, weixinThreadContext } from '../src/sources/chat/weixin/thread.ts'

/** Header-accurate fixtures: sniffing reads signatures only, never decodes pixels. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00])
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20])
const TEXT = new TextEncoder().encode('<html>definitely not an image</html>')
const LIMITS: ImageAttachmentLimits = { maxImageBytes: 1_000, maxImagesPerMessage: 4, maxMessageImageBytes: 4_000, maxImagePixels: 1_000_000,
  maxImageDimension: 4_096, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }

const BASE_URL = 'http://127.0.0.1:8787'
const commands = {} as Commands
let directory: string
let tokenFile: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'weixin-media-'))
  tokenFile = join(directory, 'token')
  writeFileSync(tokenFile, 'secret\n', { mode: 0o600 })
  chmodSync(tokenFile, 0o600)
})
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) })

const client = (fetchFn: typeof fetch) => createBridgeClient({ baseUrl: BASE_URL, tokenFile, fetchFn })
const bytesResponse = (body: Uint8Array, contentType?: string): Response =>
  // The DOM's BodyInit wants an ArrayBuffer-backed view; the stub only needs the bytes carried verbatim.
  new Response(body as unknown as BodyInit, { status: 200, ...(contentType ? { headers: { 'content-type': contentType } } : {}) })
const jsonResponse = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A real Cordis context with the attachment service the reader uses, plus the spy on its commit. */
function agentWith(limits: Partial<ImageAttachmentLimits> = {}): { agent: Agent; saveImage: ReturnType<typeof vi.fn>; ref: object } {
  const ref = { attachmentId: 'att-1', mediaType: 'image/png', bytes: PNG.byteLength, width: 1, height: 1 }
  const saveImage = vi.fn().mockResolvedValue(ref)
  const ctx = new Context()
  ctx.reflect.provide('attachments', { saveImage, imageLimits: { ...LIMITS, ...limits } })
  return { agent: { ctx } as unknown as Agent, saveImage, ref }
}

/** A bridge stub: records nothing, serves the fixtures the thread tests need. */
function fakeBridge(overrides: Partial<BridgeClient> = {}): BridgeClient {
  return {
    health: async () => ({ ok: true, available: true }),
    status: async () => ({ loggedIn: true, wxid: 'wxid_self', name: '智能助手' }),
    rooms: async () => [],
    members: async () => [],
    messages: async () => ({ events: [], next: '' }),
    send: async () => ({ msgId: 'm', deduped: false }),
    media: async () => ({ bytes: PNG, mime: 'image/png' }),
    ...overrides,
  }
}

const trigger = { id: 't1', source: 'weixin', threads: [{ source: 'weixin', id: 'room-1' }], actor: { source: 'weixin', id: 'wxid_alice' },
  human: true, at: '2026-11-06T04:01:02Z', text: '看下这张图', meta: { room: 'room-1', nativeId: 'm1', media: ['img_1'] } } as unknown as Trigger
const events: ChatEvent[] = [
  { nativeId: 'm1', chatId: 'room-1', direct: false, threadRoot: 'room-1', sender: { id: 'wxid_alice', name: '阿黎', bot: false },
    text: '看下这张图', at: '2026-11-06T04:01:02Z', ats: [], media: [{ id: 'img_1', kind: 'image', mime: 'image/png' }] },
  { nativeId: 'm2', chatId: 'room-1', direct: false, threadRoot: 'room-1', sender: { id: 'wxid_self', bot: false },
    text: '收到', at: '2026-11-06T04:02:00Z', ownMessage: true },
]
const signal = () => new AbortController().signal

describe('bridge.media', () => {
  it('downloads /media/<id> bytes with the bearer token and lowercases the served media type', async () => {
    const seen: { path: string; authorization: unknown }[] = []
    const fetchFn = (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(String(input))
      seen.push({ path: url.pathname, authorization: (init.headers as Record<string, string>).Authorization })
      return bytesResponse(PNG, 'image/png; charset=binary')
    }) as unknown as typeof fetch
    const media = await client(fetchFn).media!('m1')
    expect(seen).toEqual([{ path: '/media/m1', authorization: 'Bearer secret' }])
    expect(media.mime).toBe('image/png')
    expect([...media.bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it("answers 'gone' for 404 and refuses any non-image content type", async () => {
    const missing = client((async () => jsonResponse({ error: 'gone' }, 404)) as unknown as typeof fetch)
    await expect(missing.media!('m1')).rejects.toThrow('gone')
    const wrongType = client((async () => bytesResponse(TEXT, 'text/html')) as unknown as typeof fetch)
    await expect(wrongType.media!('m1')).rejects.toThrow(/not an image/)
    const untyped = client((async () => bytesResponse(PNG)) as unknown as typeof fetch)
    await expect(untyped.media!('m1')).rejects.toThrow(/no content type/)
  })

  it('treats a 501 (backend cannot download images) as a plain failure, not as bytes', async () => {
    const unsupported = client((async () => jsonResponse({ error: 'notImplemented' }, 501)) as unknown as typeof fetch)
    await expect(unsupported.media!('m1')).rejects.toThrow(/501/)
  })
})

describe('bridge message media', () => {
  it('maps per-message media into ChatEvent.media, and omits it when absent or not an image', async () => {
    const fetchFn = (async (input: string | URL | Request) => {
      const url = new URL(String(input))
      if (url.pathname === '/status') return jsonResponse({ loggedIn: true, wxid: 'wxid_self' }, 200)
      return jsonResponse({ events: [
        { nativeId: 'm1', room: 'room-1', sender: { id: 'wxid_alice' }, text: '图', at: '2026-11-06T04:01:02Z', ats: [],
          media: [{ id: 'm1#0', kind: 'image' }] },
        { nativeId: 'm2', room: 'room-1', sender: { id: 'wxid_alice' }, text: '无图', at: '2026-11-06T04:02:00Z', ats: [] },
        { nativeId: 'm3', room: 'room-1', sender: { id: 'wxid_alice' }, text: '别的', at: '2026-11-06T04:03:00Z', ats: [],
          media: [{ id: '', kind: 'image' }, { id: 'm3#0', kind: 'video' }] },
      ], next: '3' }, 200)
    }) as unknown as typeof fetch
    const page = await client(fetchFn).messages('room-1')
    expect(page.events[0]!.media).toEqual([{ id: 'm1#0', kind: 'image' }])
    expect(page.events[1]!.media).toBeUndefined()
    expect(page.events[2]!.media).toBeUndefined()
  })
})

describe('sniffImageMediaType', () => {
  it('identifies PNG/JPEG/WebP/GIF from their magic bytes', () => {
    expect(sniffImageMediaType(PNG)).toBe('image/png')
    expect(sniffImageMediaType(JPEG)).toBe('image/jpeg')
    expect(sniffImageMediaType(GIF)).toBe('image/gif')
    expect(sniffImageMediaType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x00]))).toBe('image/gif')
    expect(sniffImageMediaType(WEBP)).toBe('image/webp')
    // A RIFF container that is not WebP, and a text payload, are both refused.
    expect(sniffImageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]))).toBeUndefined()
    expect(sniffImageMediaType(TEXT)).toBeUndefined()
  })
})

describe('readWeixinImage', () => {
  it('commits the sniffed media type under a path-free name, ignoring the declared MIME', async () => {
    const { agent, saveImage, ref } = agentWith()
    const image = await readWeixinImage(agent, { media: async () => ({ bytes: PNG, mime: 'text/plain' }) },
      { id: 'img_1', kind: 'image', mime: 'text/plain' }, 'm1', directory, signal())
    expect(image).toEqual(ref)
    expect(saveImage).toHaveBeenCalledWith({ data: PNG, mediaType: 'image/png', name: 'm1-img_1.png' })
  })

  it('refuses a text payload that claims image/png, without committing anything', async () => {
    const { agent, saveImage } = agentWith()
    await expect(readWeixinImage(agent, { media: async () => ({ bytes: TEXT, mime: 'image/png' }) },
      { id: 'img_1', kind: 'image', mime: 'image/png' }, 'm1', directory, signal())).rejects.toThrow(/not a PNG/)
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('refuses bytes over the deployment limit and formats the deployment does not accept', async () => {
    const small = agentWith({ maxImageBytes: 4 })
    await expect(readWeixinImage(small.agent, { media: async () => ({ bytes: PNG, mime: 'image/png' }) },
      { id: 'img_1', kind: 'image' }, 'm1', directory, signal())).rejects.toThrow(/over the 4-byte limit/)
    expect(small.saveImage).not.toHaveBeenCalled()

    const pngOnly = agentWith({ mediaTypes: ['image/png'] })
    await expect(readWeixinImage(pngOnly.agent, { media: async () => ({ bytes: JPEG, mime: 'image/jpeg' }) },
      { id: 'img_2', kind: 'image' }, 'm1', directory, signal())).rejects.toThrow('does not accept image/jpeg')
    expect(pngOnly.saveImage).not.toHaveBeenCalled()
  })

  it('reports the download failure when the sidecar has no image for the message', async () => {
    const { agent, saveImage } = agentWith()
    await expect(readWeixinImage(agent, { media: async () => { throw new Error('gone') } },
      { id: 'img_9', kind: 'image' }, 'm9', directory, signal())).rejects.toThrow('gone')
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('refuses bytes over the message-level cap and hands that budget to the download', async () => {
    // The per-image cap is far larger than the per-message one, so only the message cap can refuse these bytes.
    const { agent, saveImage } = agentWith({ maxImageBytes: 10_000, maxMessageImageBytes: 1_000 })
    const big = new Uint8Array(1_500)
    big.set(PNG)
    const budgets: (number | undefined)[] = []
    await expect(readWeixinImage(agent, { media: async (_id, maxBytes) => { budgets.push(maxBytes); return { bytes: big, mime: 'image/png' } } },
      { id: 'img_1', kind: 'image' }, 'm1', directory, signal())).rejects.toThrow(/over the 1000-byte limit/)
    expect(budgets).toEqual([1_000])
    expect(saveImage).not.toHaveBeenCalled()
  })
})

describe('weixinThreadContext', () => {
  it('names the trigger message by its native ID and maps the chat page into ContextMessages', async () => {
    const context = weixinThreadContext(fakeBridge({ messages: async (room, cursor, limit) => {
      expect(room).toBe('room-1')
      expect(cursor).toBeUndefined()
      expect(limit).toBe(50)
      return { events, next: '3' }
    } }))
    expect(context.messageId(trigger)).toBe('m1')
    const part = await context.read(commands, trigger, 'thread', undefined, {})
    expect(part).toEqual({
      messages: [
        { id: 'm1', from: 'wxid_alice', at: '2026-11-06T04:01:02Z', text: '看下这张图 [image:img_1]' },
        { id: 'm2', from: 'wxid_self', at: '2026-11-06T04:02:00Z', text: '收到', bot: true },
      ],
      next: '3',
      body: { room: 'room-1', part: 'thread' },
      status: 'ok',
    })
    // The reader names the images inline; a message without media keeps its text untouched and yields no ids.
    expect(context.images!('看下这张图 [image:img_1]')).toEqual(['img_1'])
    expect(context.images!('看下这张图')).toEqual([])
    expect(part.messages[1]!.text).toBe('收到')
  })

  it('drops a marker the user typed into a message and keeps only the images the backend named', async () => {
    const typed = [{ ...events[0]!, text: '看下这张图 [image:evil]' }]
    const context = weixinThreadContext(fakeBridge({ messages: async () => ({ events: typed, next: '' }) }))
    const part = await context.read(commands, trigger, 'thread', undefined, {})
    expect(part.messages[0]!.text).toBe('看下这张图 [image:img_1]')
    expect(context.images!(part.messages[0]!.text)).toEqual(['img_1'])
  })

  it('falls back to the thread ID when the trigger carries no room, and pages with the cursor', async () => {
    const noRoom = { ...trigger, meta: { nativeId: 'm1' } } as unknown as Trigger
    const context = weixinThreadContext(fakeBridge({ messages: async (room, cursor) => {
      expect(room).toBe('room-1')
      expect(cursor).toBe('3')
      return { events: [], next: '' }
    } }))
    const part = await context.read(commands, noRoom, 'thread', '3', {})
    expect(part.messages).toEqual([])
    expect(part.next).toBeUndefined()
  })

  it('serves an image to the assessment through the bridge and the attachment store', async () => {
    const { agent, saveImage, ref } = agentWith()
    const asked: string[] = []
    const context = weixinThreadContext(fakeBridge({ media: async id => { asked.push(id); return { bytes: PNG, mime: 'image/png' } } }))
    const image = await context.image!(agent, commands, trigger, { id: 'm1', text: '看下这张图' }, 'img_1', directory, signal())
    expect(asked).toEqual(['img_1'])
    expect(image).toEqual(ref)
    expect(saveImage).toHaveBeenCalledWith({ data: PNG, mediaType: 'image/png', name: 'm1-img_1.png' })
  })

  it('needs a prior read when the client is built from configuration, and reports a client without /media', async () => {
    const { agent } = agentWith()
    const lazy = weixinThreadContext(() => fakeBridge())
    await expect(lazy.image!(agent, commands, trigger, { id: 'm1', text: 'x' }, 'img_1', directory, signal()))
      .rejects.toThrow('Read the thread before its images')
    await lazy.read(commands, trigger, 'thread', undefined, {})
    await expect(lazy.image!(agent, commands, trigger, { id: 'm1', text: 'x' }, 'img_1', directory, signal())).resolves.toBeDefined()

    const noMedia = weixinThreadContext({ ...fakeBridge(), media: undefined })
    await expect(noMedia.image!(agent, commands, trigger, { id: 'm1', text: 'x' }, 'img_1', directory, signal()))
      .rejects.toThrow('no /media endpoint')
  })

  it('refuses an image of a message that carries more images than the deployment accepts, before any download', async () => {
    const { agent, saveImage } = agentWith({ maxImagesPerMessage: 4 })
    const asked: string[] = []
    const crowded = { ...trigger, meta: { ...trigger.meta, media: ['img_1', 'img_2', 'img_3', 'img_4', 'img_5'] } } as unknown as Trigger
    const context = weixinThreadContext(fakeBridge({ media: async id => { asked.push(id); return { bytes: PNG, mime: 'image/png' } } }))
    await expect(context.image!(agent, commands, crowded, { id: 'm1', text: '五张图' }, 'img_1', directory, signal()))
      .rejects.toThrow(/carries 5 images, over the 4-image limit/)
    expect(asked).toEqual([])
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('refuses a marker the backend never named for the message, so typed text starts no request', async () => {
    const { agent, saveImage } = agentWith()
    const asked: string[] = []
    const context = weixinThreadContext(fakeBridge({ media: async id => { asked.push(id); return { bytes: PNG, mime: 'image/png' } } }))
    // The Trigger's own text is the raw message text: a marker typed into it must not become a download.
    await expect(context.image!(agent, commands, trigger, { id: 'm1', text: '看图 [image:evil]' }, 'evil', directory, signal()))
      .rejects.toThrow('The image evil is not one of the images of message m1')
    expect(asked).toEqual([])
    expect(saveImage).not.toHaveBeenCalled()
    // The ID the backend did name still reads.
    await expect(context.image!(agent, commands, trigger, { id: 'm1', text: '看图 [image:evil]' }, 'img_1', directory, signal()))
      .resolves.toBeDefined()
    expect(asked).toEqual(['img_1'])
  })

})

describe('image markers', () => {
  it('renders and extracts one marker per image, and ignores text without a complete marker', () => {
    expect(imageMarker('m1#0')).toBe('[image:m1#0]')
    expect(imageIds('看图 [image:m1#0] [image:m4#1]')).toEqual(['m1#0', 'm4#1'])
    expect(imageIds('[image:m1#0] 再看 [image:m1#0]')).toEqual(['m1#0'])   // one id is listed once
    expect(imageIds('no marker here')).toEqual([])
    expect(imageIds('[image:] [image:has space]')).toEqual([])
    // The thread reader re-exports the same function, so the reader and `images` cannot drift apart.
    expect(threadImageIds).toBe(imageIds)
  })

  it('walks one image from a bridge event to a committed attachment end to end', async () => {
    const { agent, saveImage, ref } = agentWith()
    const asked: string[] = []
    const bridge = fakeBridge({
      messages: async () => ({ events, next: '3' }),
      media: async id => { asked.push(id); return { bytes: PNG, mime: 'image/png' } },
    })
    // 1) A bridge event that carries media becomes a Trigger whose meta keeps the image IDs.
    const triggerWithImage = triggerOf(events[0]!, 'weixin')
    expect(triggerWithImage.meta.media).toEqual(['img_1'])
    expect(triggerOf(events[1]!, 'weixin').meta.media).toBeUndefined()

    // 2) Reading the thread names the image inline, and 3) images() hands the same ID back.
    const context = weixinThreadContext(bridge)
    const part = await context.read(commands, triggerWithImage, 'thread', undefined, {})
    const text = part.messages[0]!.text
    expect(text).toBe('看下这张图 [image:img_1]')
    expect(context.images!(text)).toEqual(['img_1'])

    // 4) The model's read downloads that ID and the reader commits it as an attachment.
    const image = await context.image!(agent, commands, triggerWithImage, { id: part.messages[0]!.id, text },
      context.images!(text)[0]!, directory, signal())
    expect(image).toEqual(ref)
    expect(asked).toEqual(['img_1'])
    expect(saveImage).toHaveBeenCalledWith({ data: PNG, mediaType: 'image/png', name: 'm1-img_1.png' })
  })
})
