/** Work-item thread context: the description as root, comments as the thread, and the item identity a reader resolves. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { itemMessage, noteMessage, workAddress, workMessageId, workThreadContext } from '../src/sources/work/context.ts'
import type { WorkAdapter, WorkItem, WorkNote } from '../src/sources/work/port.ts'
import { testDeployment } from './fixtures/deployment.ts'

const commands = (): Commands => new Commands(() => testDeployment(), {}, new AbortController().signal)
const item: WorkItem = { key: 'ab12', serial: 'ESFX-6228', category: 'bug', title: '登录失败', body: '按步骤复现即失败',
  author: { id: 'acc-777' }, assignee: { id: 'acc-1' }, status: { id: 's2', name: '处理中' },
  url: 'https://devops.aliyun.com/projex/project/proj-1/workitem/ESFX-6228',
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }
const notes: WorkNote[] = [
  { id: 'c1', body: '能给我个临时链接吗', author: { id: 'acc-777' }, at: '2026-11-02T01:00:00.000Z' },
  { id: 'c2', body: '已修，见 PR', author: { id: 'acc-1' }, at: '2026-11-02T02:00:00.000Z', self: true },
]
/** The Trigger of the item itself, the shape `workTrigger` builds from a polled work item. */
const itemTrigger = (overrides: Partial<Trigger> = {}): Trigger => ({
  id: 'projex-open:ab12', source: 'projex', threads: [{ source: 'projex', id: 'ab12' }],
  actor: { source: 'projex', id: 'acc-777' }, human: true, at: item.updatedAt, text: item.body, url: item.url,
  channel: { source: 'projex', thread: 'projex:ab12', address: { project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' } },
  meta: { category: 'bug', identifier: 'ab12', serial: 'ESFX-6228', status: item.status }, ...overrides })
/** The Trigger of one of the item's comments, the shape `noteTrigger` builds. */
const commentTrigger = (commentId = 'c1'): Trigger => itemTrigger({ id: `projex-note:${commentId}`, text: '能给我个临时链接吗',
  meta: { identifier: 'ab12', serial: 'ESFX-6228', kind: 'comment', commentId } })

interface Fake { adapter: WorkAdapter; reads: string[]; cursors: (string | undefined)[] }
/** A work adapter that answers with `item` and `comments`, recording how often the item was read. */
function fakeAdapter(options: { comments?: WorkNote[]; next?: string; failFirstRead?: boolean } = {}): Fake {
  const reads: string[] = []
  const cursors: (string | undefined)[] = []
  let failed = false
  const adapter: WorkAdapter = {
    host: 'projex',
    listWorkItems: async () => ({ items: [] }),
    readWorkItem: async (_commands, project, key) => {
      if (options.failFirstRead && !failed) { failed = true; throw new Error('HTTP 500 from the item detail endpoint') }
      reads.push(`${project}/${key}`)
      return item
    },
    listNotes: async (_commands, _project, _key, cursor) => {
      cursors.push(cursor)
      // The host pages only while it has more to give: the first page carries `next`, the second ends the thread.
      return { notes: options.comments ?? notes, ...options.next && !cursor ? { next: options.next } : {} }
    },
    postNote: async () => 'sent',
    page: () => '',
  }
  return { adapter, reads, cursors }
}
const config = { project: 'proj-1' }

describe('work item context address and id', () => {
  it('reads the item address from the channel the poll wrote, falling back to the configuration', () => {
    expect(workAddress(itemTrigger())).toEqual({ project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' })
    expect(workAddress(itemTrigger({ channel: undefined }), config)).toEqual({ project: 'proj-1', key: 'ab12', serial: 'ESFX-6228' })
    expect(workAddress({ ...itemTrigger(), channel: { source: 'projex', thread: 't', address: {} }, meta: { identifier: 'x1' } }, config))
      .toEqual({ project: 'proj-1', key: 'x1', serial: 'x1' })
  })
  it('places a comment by its comment id and the item by its own key', () => {
    expect(workMessageId(commentTrigger('c9'))).toBe('c9')
    expect(workMessageId(itemTrigger())).toBe('ab12')
  })
})

describe('work item context messages', () => {
  it('renders the description with the serial and title people search for', () => {
    expect(itemMessage(item)).toMatchObject({ id: 'ab12', from: 'acc-777', at: item.createdAt,
      text: '[ESFX-6228] 登录失败\n\n按步骤复现即失败' })
    // An item with no description still carries its title, and no text is invented for it.
    expect(itemMessage({ ...item, body: '' }).text).toBe('[ESFX-6228] 登录失败')
  })
  it('marks the agent\'s own comment as a bot message, so it never reads as a person\'s request', () => {
    expect(noteMessage(notes[0]!, item)).toMatchObject({ id: 'c1', from: 'acc-777', text: '能给我个临时链接吗',
      url: `${item.url}#comment-c1` })
    expect(noteMessage(notes[1]!, item).bot).toBe(true)
    expect(noteMessage(notes[0]!, item).bot).toBeUndefined()
  })
})

describe('workThreadContext reads', () => {
  it('serves the description as the root message, with the item facts beside it', async () => {
    const { adapter } = fakeAdapter()
    const part = await workThreadContext(() => adapter).read(commands(), commentTrigger(), 'root', undefined, config)
    expect(part.messages).toHaveLength(1)
    expect(part.messages[0]).toMatchObject({ id: 'ab12', text: '[ESFX-6228] 登录失败\n\n按步骤复现即失败' })
    expect(part.body).toMatchObject({ serial: 'ESFX-6228', category: 'bug', status: '处理中', assignee: 'acc-1' })
  })
  it('serves the description first and then the comments in order, which is what an assessment of a comment needs', async () => {
    const { adapter, cursors } = fakeAdapter()
    const part = await workThreadContext(() => adapter).read(commands(), commentTrigger('c1'), 'thread', undefined, config)
    expect(part.messages.map(message => message.id)).toEqual(['ab12', 'c1', 'c2'])
    expect(part.status).toBe('work_item')
    expect(cursors).toEqual([undefined])
  })
  it('continues a paged thread without repeating the description', async () => {
    const { adapter } = fakeAdapter({ next: '2' })
    const context = workThreadContext(() => adapter)
    const first = await context.read(commands(), itemTrigger(), 'thread', undefined, config)
    expect(first.next).toBe('2')
    const second = await context.read(commands(), itemTrigger(), 'thread', '2', config)
    expect(second.messages.map(message => message.id)).toEqual(['c1', 'c2'])
    expect(second.next).toBeUndefined()
  })
  it('reads the item once across the pages of one conversation', async () => {
    const { adapter, reads } = fakeAdapter({ next: '2' })
    const context = workThreadContext(() => adapter)
    await context.read(commands(), itemTrigger(), 'thread', undefined, config)
    await context.read(commands(), itemTrigger(), 'thread', '2', config)
    expect(reads).toEqual(['proj-1/ab12'])
  })
  it('does not remember a failed item read, so the next page retries it', async () => {
    const { adapter, reads } = fakeAdapter({ failFirstRead: true })
    const context = workThreadContext(() => adapter)
    await expect(context.read(commands(), itemTrigger(), 'root', undefined, config)).rejects.toThrow(/HTTP 500/)
    await expect(context.read(commands(), itemTrigger(), 'root', undefined, config)).resolves.toBeDefined()
    expect(reads).toEqual(['proj-1/ab12'])
  })
  it('answers the description as a comment\'s parent and nothing as the item\'s own parent', async () => {
    const { adapter } = fakeAdapter()
    const context = workThreadContext(() => adapter)
    const parent = await context.read(commands(), commentTrigger('c1'), 'parent', undefined, config)
    expect(parent.messages.map(message => message.id)).toEqual(['ab12'])
    const none = await context.read(commands(), itemTrigger(), 'parent', undefined, config)
    expect(none.messages).toEqual([])
  })
  it('refuses to read a thread when the instance binds no adapter, and one that names no item', async () => {
    const unbound = workThreadContext(() => undefined)
    await expect(unbound.read(commands(), itemTrigger(), 'thread', undefined, config)).rejects.toThrow(/not configured/)
    const { adapter } = fakeAdapter()
    const noItem = { ...itemTrigger(), channel: undefined, meta: {} } as Trigger
    await expect(workThreadContext(() => adapter).read(commands(), noItem, 'thread', undefined, {})).rejects.toThrow(/names no work item/)
  })
})

describe('workThreadContext images', () => {
  const key = `${'d'.repeat(64)}.png`
  const directory = join(tmpdir(), 'work-context-images')
  const agent = (): Agent => {
    const value = { imageLimits: { maxImageBytes: 1024 },
      saveImage: async (input: unknown) => ({ id: 'att-1', ...(input as Record<string, unknown>) }) }
    return { ctx: { get: (name: string) => name === 'attachments' ? value : undefined } } as unknown as Agent
  }
  afterAll(async () => { await rm(directory, { recursive: true, force: true }) })
  it('lists the archived images a Trigger\'s text names and reads one back as an attachment', async () => {
    const { adapter } = fakeAdapter()
    const context = workThreadContext(() => adapter)
    expect(context.images!(`body\n[图片附件 shot: projex-image:${key}]`)).toEqual([key])
    await mkdir(join(directory, 'projex-images'), { recursive: true })
    await writeFile(join(directory, 'projex-images', key), new Uint8Array([7, 7, 7]))
    await expect(context.image!(agent(), commands(), itemTrigger(), { id: 'ab12', text: '' }, key, directory,
      new AbortController().signal)).resolves.toMatchObject({ id: 'att-1', name: key })
  })
})
