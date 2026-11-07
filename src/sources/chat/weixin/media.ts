/** Downloads WeChat message images from the sidecar and commits them as model-visible attachments. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ChatMedia } from '../port.ts'

/** The narrow client surface a media read needs: one image's bytes by its backend ID. */
export interface BridgeMediaSource { media(id: string): Promise<{ bytes: Uint8Array; mime: string }> }

/** `\x89PNG\r\n\x1a\n`, the only header a PNG may have. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
/** A JPEG always starts with its start-of-image marker. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const
/** `GIF8`, completed by the version characters checked below. */
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const
/** A WebP is a RIFF container whose form type at offset 8 is `WEBP`. */
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const
const EXTENSIONS: Record<ImageMediaType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value)

/**
 * Identifies the image format from its magic bytes, never from a declared Content-Type or file extension: a text payload
 * labelled `image/png` must not be stored as an image.
 */
export function sniffImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png'
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg'
  // "GIF87a" and "GIF89a": the 4-byte prefix plus a version digit and the trailer character.
  if (startsWith(bytes, GIF_SIGNATURE) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif'
  if (startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes.subarray(8), WEBP_SIGNATURE)) return 'image/webp'
  return undefined
}

/**
 * The one definition of the in-text image marker: `[image:<id>]`. The thread reader appends a marker to a message's text for
 * each image it carries, and `images` finds them again with this same regular expression, so the format has a single source.
 */
const IMAGE_MARKER = /\[image:([^\]\s]+)\]/g
/** Renders the marker that the thread reader appends and `images` extracts. */
export const imageMarker = (id: string): string => `[image:${id}]`
/** IDs of the message's images, as named by the markers in its text. */
export function imageIds(text: string): string[] {
  IMAGE_MARKER.lastIndex = 0
  return [...new Set([...text.matchAll(IMAGE_MARKER)].map(match => match[1]!).filter(id => id !== ''))]
}

/** A display name that carries no path information and is stable for one message image. */
const attachmentName = (messageId: string, mediaId: string, mediaType: ImageMediaType): string =>
  `${messageId}-${mediaId}.${EXTENSIONS[mediaType]}`.replace(/[^\w.-]+/g, '_')

/**
 * Downloads one WeChat message image and commits it as an attachment the assessment model can see. The bytes are sniffed for
 * PNG/JPEG/WebP/GIF rather than trusted from the sidecar's Content-Type, must fit the deployment's `maxImageBytes`, and must
 * be a format the deployment accepts; anything else is refused before `saveImage`, so it never reaches storage. `stateDir` is
 * accepted for the shared reader signature: these bytes go straight into the attachment store and never touch the disk here.
 */
export async function readWeixinImage(agent: Agent, client: BridgeMediaSource, ref: ChatMedia, messageId: string, stateDir: string,
  signal: AbortSignal): Promise<ImageAttachmentRef> {
  signal.throwIfAborted()
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const download = await client.media(ref.id)
  signal.throwIfAborted()
  const mediaType = sniffImageMediaType(download.bytes)
  if (!mediaType) throw new Error(`The image ${ref.id} of message ${messageId} is not a PNG/JPEG/WebP/GIF image`)
  const limit = attachments.imageLimits.maxImageBytes
  if (download.bytes.byteLength > limit) {
    throw new Error(`The image ${ref.id} of message ${messageId} is ${download.bytes.byteLength} bytes, over the ${limit}-byte limit`)
  }
  if (!attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`This deployment does not accept ${mediaType} images`)
  signal.throwIfAborted()
  const image = await attachments.saveImage({ data: download.bytes, mediaType, name: attachmentName(messageId, ref.id, mediaType) })
  signal.throwIfAborted()
  return image
}