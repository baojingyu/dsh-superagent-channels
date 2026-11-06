/** Host-independent work-item (Projex-style) port: normalized items, notes, and the adapter a work kind builds on. */
import type { Commands } from '../../infra/commands.ts'

/** A person on a work host; `bot` marks an automated account, which never authorizes work on its own. */
export interface Person { id: string; name?: string; bot?: boolean }

/** Normalized category of a work item: everything is shared except the admission row the category selects. */
export type WorkCategory = 'requirement' | 'bug' | 'task' | 'risk' | 'topic' | 'request'

/**
 * One work item normalized to a host-independent shape.
 * `assignee` and `status` are the structured basis for "assigned to me", which chat threads lack; `status.stage`
 * is the host's stage identifier because status names and ids are customized per project.
 */
export interface WorkItem {
  /** Stable ID inside the host: Projex `identifier`, GitLab `id`. */
  key: string
  /** Human-readable number: Projex `serialNumber` (`ABCD-1`), GitHub `#12`. */
  serial: string
  category: WorkCategory
  title: string
  body: string
  author: Person
  /** Person the item is assigned to; the structured basis for "assigned to the agent". */
  assignee?: Person
  /** Current status; `stage` is the host's normalized stage identifier, never a hardcoded status name. */
  status: { id: string; name: string; stage?: string }
  url: string
  createdAt: string
  updatedAt: string
  parent?: string
  sprint?: string
  doneAt?: string
}

/** One comment on a work item. */
export interface WorkNote { id: string; body: string; author: Person; at: string; updatedAt?: string }

/** One page of a work-item listing; `next` continues the listing and its absence ends it. */
export interface WorkItemPage { items: WorkItem[]; next?: string }

/** One page of comments on a work item. */
export interface WorkNotePage { notes: WorkNote[]; next?: string }

/**
 * Adapter of a work host (Projex, GitLab Issues, or GitHub Issues).
 * Reads are listed and paged; the only write the work kind needs is a comment carrying an idempotency marker.
 * State write-back stays optional because work items are read-only by default: the agent delivers in comments.
 */
export interface WorkAdapter<C extends Record<string, unknown> = Record<string, unknown>> {
  /** Host this adapter speaks for, such as `projex`; the work kind's health entry defaults to it. */
  readonly host: string
  /** Items modified since `since` (a local watermark) within the requested categories. */
  listWorkItems(commands: Commands, project: string, since: string, categories: readonly string[],
    signal?: AbortSignal): Promise<WorkItemPage>
  readWorkItem(commands: Commands, project: string, key: string, signal?: AbortSignal): Promise<WorkItem>
  /** Comments of one item; `cursor` omits the first page. */
  listNotes(commands: Commands, project: string, key: string, cursor: string | undefined): Promise<WorkNotePage>
  /** Posts a comment carrying `marker`; returns `'gone'` when the item no longer accepts comments. */
  postNote(commands: Commands, item: WorkItem, text: string, marker: string): Promise<'sent' | 'gone'>
  /** Optional status write-back; absent means the host stays read-only for this kind. */
  setStatus?(commands: Commands, item: WorkItem, stage: string, signal?: AbortSignal): Promise<void>
  /** Web page of one item, used by the channel's link. */
  page(project: string, key: string): string
}