/** Work-item images: reference parsing, sha256 de-duplication, bounded archive with degradation, and attachment reads. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendImageMarkers, archiveWorkImages, imageRefs, readArchivedImage, workImageKeys }
  from '../src/sources/work/images.ts'

const fileUrl = (id: string): string => `https://devops.aliyun.com/projex/api/workitem/file/url?fileIdentifier=${id}`

describe('work item image references', () => {
  it('reads <img src=fileIdentifier> out of a RICHTEXT description and keeps alt text', () => {
    const description = JSON.stringify({ htmlValue: `<p>x</p><img src="${fileUrl('abc123DEF')}" alt="screenshot one" style="width:10px">`,
      jsonMLValue: ['root', {}] })
    expect(imageRefs(description)).toEqual([{ key: 'abc123DEF', url: fileUrl('abc123DEF'), name: 'screenshot one' }])
  })

  it('falls back to the jsonML when the HTML carries no <img>, and de-duplicates a repeated file id', () => {
    const description = JSON.stringify({ htmlValue: '<p>no images here</p>',
      jsonMLValue: ['root', {}, ['image', { src: fileUrl('jsonMLid1') }], ['image', { src: fileUrl('jsonMLid1') }]] })
    expect(imageRefs(description).map(ref => ref.key)).toEqual(['jsonMLid1'])
  })

  it('returns nothing for plain text or an image-free rich-text body', () => {
    expect(imageRefs('just words')).toEqual([])
    expect(imageRefs(JSON.stringify({ htmlValue: '<article><p>plain</p></article>' }))).toEqual([])
    expect(imageRefs(undefined)).toEqual([])
  })

  it('extracts archived keys and renders markers with the local path and a failure line', () => {
    const key = `${'a'.repeat(64)}.png`
    const text = `body\n[图片附件 shot: projex-image:${key}]`
    expect(workImageKeys(text)).toEqual([key])
    const marked = appendImageMarkers('body', [{ key, name: 'shot.png', mediaType: 'image/png', bytes: 3, path: '/s/projex-images/x.png' }],
      [{ fileKey: 'bad', reason: 'unsupported image type: pdf' }])
    expect(marked).toContain(`projex-image:${key}`)
    expect(marked).toContain('/s/projex-images/x.png')
    expect(marked).toContain('fileIdentifier=bad')
    expect(marked).toContain('unsupported image type: pdf')
  })
})

describe('archiveWorkImages', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'work-images-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const response = (data: Uint8Array, ok = true, status = 200): Response =>
    ({ ok, status, arrayBuffer: async () => data.slice().buffer }) as unknown as Response
  const metadata = (suffix = 'png', size = bytes.byteLength) => async (ref: { key: string }) =>
    ({ name: `image.${suffix}`, suffix, size, url: `https://oss.example/${ref.key}` })

  it('writes one sha256-named file, de-duplicating two references with identical bytes', async () => {
    const { images, failures } = await archiveWorkImages({ refs: [{ key: 'a' }, { key: 'b' }], stateDir: directory,
      metadata: metadata(), fetchFn: async () => response(bytes) })
    expect(failures).toEqual([])
    expect(images).toHaveLength(1)
    const expected = `${createHash('sha256').update(bytes).digest('hex')}.png`
    expect(images[0]).toMatchObject({ key: expected, mediaType: 'image/png', bytes: bytes.byteLength })
    expect(await readdir(join(directory, 'projex-images'))).toEqual([expected])
  })

  it('records an unsupported type, an over-cap image, and a failed download without throwing', async () => {
    const { images, failures } = await archiveWorkImages({ refs: [{ key: 'pdf' }, { key: 'big' }, { key: 'boom' }], stateDir: directory,
      maxBytes: 4,
      metadata: async ref => ref.key === 'pdf' ? { name: 'x.pdf', suffix: 'pdf', size: 10, url: 'u' }
        : ref.key === 'big' ? { name: 'x.png', suffix: 'png', size: 99, url: 'u' }
        : { name: 'x.png', suffix: 'png', size: 3, url: 'u' },
      fetchFn: async () => response(bytes, false, 500) })
    expect(images).toEqual([])
    expect(failures.map(f => f.fileKey)).toEqual(['pdf', 'big', 'boom'])
    expect(failures[0]!.reason).toMatch(/unsupported image type/)
    expect(failures[1]!.reason).toMatch(/over the 4-byte cap/)
    expect(failures[2]!.reason).toMatch(/HTTP 500/)
  })
})

describe('readArchivedImage', () => {
  let directory: string
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'work-images-read-')) })
  afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

  const agent = (): Agent => {
    const saved: unknown[] = []
    const value = { imageLimits: { maxImageBytes: 1024 }, saveImage: async (input: unknown) => { saved.push(input); return { id: 'att-1', ...(input as Record<string, unknown>) } } }
    return { ctx: { get: (name: string) => name === 'attachments' ? value : undefined }, saved } as unknown as Agent
  }

  it('reads an archived file back as an attachment', async () => {
    const key = `${'b'.repeat(64)}.png`
    await mkdir(join(directory, 'projex-images'), { recursive: true })
    await writeFile(join(directory, 'projex-images', key), new Uint8Array([9, 9, 9]))
    const attachment = await readArchivedImage(agent(), key, directory, new AbortController().signal)
    expect(attachment).toMatchObject({ id: 'att-1', name: key })
  })

  it('refuses a key that does not name an archived image, or one missing from the archive', async () => {
    await expect(readArchivedImage(agent(), 'not-a-key', directory, new AbortController().signal)).rejects.toThrow(/Choose an image key/)
    const missing = `${'c'.repeat(64)}.png`
    await expect(readArchivedImage(agent(), missing, directory, new AbortController().signal)).rejects.toThrow(/missing/)
  })
})
