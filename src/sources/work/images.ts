/** Work-item image collection: parse inline image references, archive bytes locally by sha256, and serve them to readers. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'

/** Prefix of the marker appended to a Trigger's text for every archived image; `imageKeys` extracts what follows it. */
export const IMAGE_PREFIX = 'projex-image:'
/** Subdirectory of the deployment's state directory that holds archived work-item images. */
export const IMAGE_DIR = 'projex-images'
/** Default per-image byte cap for the eager archive; the attachment service may impose a stricter one when reading. */
export const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MEDIA: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}
/** One image a work item or comment embeds, named by the host's file id. */
export interface WorkImageRef { key: string; url?: string; name?: string }
/** Host metadata of one image file; `url` is a short-lived download URL. */
export interface WorkImageFile { name: string; suffix: string; size: number; url: string }
/** One image already written under the state directory. */
export interface ArchivedImage { key: string; name: string; mediaType: ImageMediaType; bytes: number; path: string }
/** An image that could not be collected; the text Trigger still goes out with this reason recorded. */
export interface ImageFailure { fileKey: string; reason: string }

/** The HTML of a rich-text payload: a JSON object string carrying `htmlValue`, else the string itself. */
function htmlOf(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed.startsWith('{')) return value
  try {
    const parsed = JSON.parse(trimmed) as { htmlValue?: unknown }
    return typeof parsed.htmlValue === 'string' ? parsed.htmlValue : value
  } catch { return value }
}

/** The jsonML of a rich-text payload, as a compact string, for images some editors keep only there. */
function jsonMLOf(value: unknown): string {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return ''
  try {
    const parsed = JSON.parse(value) as { jsonMLValue?: unknown }
    return parsed.jsonMLValue === undefined ? '' : JSON.stringify(parsed.jsonMLValue)
  } catch { return '' }
}

/**
 * Every image a rich-text payload embeds. The primary form is the editor's `<img src="…fileIdentifier=…">`; a jsonML
 * fallback covers payloads whose HTML omits the image node. Non-image file links are filtered later by suffix.
 */
export function imageRefs(value: unknown): WorkImageRef[] {
  const found = new Map<string, WorkImageRef>()
  const html = htmlOf(value)
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc="([^"]*fileIdentifier=([A-Za-z0-9_-]+)[^"]*)"([^>]*)>/g)) {
    const src = match[1] ?? ''
    const id = match[2] ?? ''
    const alt = /alt="([^"]*)"/.exec(match[3] ?? '')?.[1]
    if (id && !found.has(id)) found.set(id, { key: id, url: src, ...alt ? { name: alt } : {} })
  }
  if (found.size === 0) {
    const jsonML = jsonMLOf(value)
    for (const match of jsonML.matchAll(/fileIdentifier=([A-Za-z0-9_-]{8,})/g)) {
      const id = match[1]!
      if (!found.has(id)) found.set(id, { key: id })
    }
  }
  return [...found.values()]
}

/** Image keys named by `IMAGE_PREFIX` markers in a Trigger's text; each key is `<sha256>.<ext>` under `IMAGE_DIR`. */
export function workImageKeys(text: string): string[] {
  return [...new Set([...text.matchAll(/\bprojex-image:([0-9a-f]{64}\.[a-z0-9]{2,5})\b/g)].map(match => match[1]!))]
}

/** Appends a readable marker and its local path for every archived image, and one line per failed image. */
export function appendImageMarkers(text: string, images: readonly ArchivedImage[], failures: readonly ImageFailure[] = []): string {
  let out = text
  for (const image of images) out += `\n\n[图片附件 ${image.name}: ${IMAGE_PREFIX}${image.key}]\n本地路径: ${image.path}`
  for (const failure of failures) out += `\n\n[图片未能采集: fileIdentifier=${failure.fileKey} 原因: ${failure.reason}]`
  return out
}

/** The extension of a file name, lowercased without the dot. */
function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export interface ArchiveImagesOptions {
  refs: readonly WorkImageRef[]
  stateDir: string
  maxBytes?: number
  /** Reads one image's host metadata, including the short-lived download URL. */
  metadata(ref: WorkImageRef, signal?: AbortSignal): Promise<WorkImageFile>
  fetchFn?: typeof fetch
  signal?: AbortSignal
}

/**
 * Archives every referenced image under `<stateDir>/projex-images/<sha256>.<ext>`, deduplicating by content hash. A
 * failure for one image is recorded and never blocks the others: the text Trigger still goes out.
 */
export async function archiveWorkImages(options: ArchiveImagesOptions): Promise<{ images: ArchivedImage[]; failures: ImageFailure[] }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const fetchFn = options.fetchFn ?? fetch
  const directory = join(options.stateDir, IMAGE_DIR)
  await mkdir(directory, { recursive: true })
  const byKey = new Map<string, ArchivedImage>()
  const failures: ImageFailure[] = []
  for (const ref of options.refs) {
    try {
      const meta = await options.metadata(ref, options.signal)
      const ext = (meta.suffix || extOf(meta.name)).toLowerCase().replace(/^\./, '')
      const mediaType = MEDIA[ext]
      if (!mediaType) throw new Error(`unsupported image type: ${meta.suffix || meta.name || 'unknown'}`)
      if (meta.size > maxBytes) throw new Error(`image is ${meta.size} bytes, over the ${maxBytes}-byte cap`)
      if (!meta.url) throw new Error('the host returned no download URL')
      const response = await fetchFn(meta.url, { ...(options.signal ? { signal: options.signal } : {}) })
      if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`)
      const data = new Uint8Array(await response.arrayBuffer())
      if (data.byteLength === 0) throw new Error('the downloaded image is empty')
      if (data.byteLength > maxBytes) throw new Error(`the downloaded image is ${data.byteLength} bytes, over the ${maxBytes}-byte cap`)
      const digest = createHash('sha256').update(data).digest('hex')
      const key = `${digest}.${ext}`
      const path = join(directory, key)
      let exists = false
      try { exists = (await stat(path)).isFile() } catch { exists = false }
      if (!exists) await writeFile(path, data, { mode: 0o600 })
      byKey.set(key, { key, name: meta.name || key, mediaType, bytes: data.byteLength, path })
    } catch (error) {
      failures.push({ fileKey: ref.key, reason: String((error as Error)?.message ?? error).slice(0, 200) })
    }
  }
  return { images: [...byKey.values()], failures }
}

const ARCHIVED_KEY = /^[0-9a-f]{64}\.[a-z0-9]{2,5}$/

/**
 * Reads one archived image back as a model-visible attachment for a reader (`orchestrator_eval_read` image, or the
 * Executor's `read_image` on the local path). Only keys naming an archived file are accepted.
 */
export async function readArchivedImage(agent: Agent, key: string, stateDir: string, signal: AbortSignal): Promise<ImageAttachmentRef> {
  if (!ARCHIVED_KEY.test(key)) throw new Error('Choose an image key this Trigger listed')
  const mediaType = MEDIA[key.slice(key.lastIndexOf('.') + 1)]
  if (!mediaType) throw new Error('The archived file is not a supported PNG/JPEG/WebP/GIF image')
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const path = join(stateDir, IMAGE_DIR, key)
  const file = await stat(path).catch(() => undefined)
  if (!file?.isFile()) throw new Error('The archived image is missing from the local state directory')
  if (file.size > attachments.imageLimits.maxImageBytes) throw new Error('The image exceeds the deployment byte limit')
  const data = await readFile(path, { signal })
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data, mediaType, name: key })
  signal.throwIfAborted()
  return image
}
