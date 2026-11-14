/** Host-independent work-item (Projex-style) port: normalized items, notes, and the adapter a work kind builds on. */
import type { Commands } from '../../infra/commands.ts'
import type { WorkImageFile, WorkImageRef } from './images.ts'

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
  /** Images the description embeds, in document order; empty when the item has none. */
  images?: WorkImageRef[]
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
export interface WorkNote { id: string; body: string; author: Person; at: string; updatedAt?: string
  /** Images the comment embeds, in document order; empty when it has none. */
  images?: WorkImageRef[]
  /** True when the comment is the agent's own (it carries the idempotency marker postNote appended), never a person's. */
  self?: boolean }

/** One page of a work-item listing; `next` continues the listing and its absence ends it. */
export interface WorkItemPage { items: WorkItem[]; next?: string }

/** One page of comments on a work item. */
export interface WorkNotePage { notes: WorkNote[]; next?: string }

/** One uploaded file as a comment shows it: HTML for a RICHTEXT body, Markdown for a MARKDOWN one. */
export interface WorkAttachment { name: string; html: string; markdown: string }

/** One status a project's work-item workflow offers; `name` is what a person reads on the board. */
export interface WorkflowStatus { id: string; name: string; nameEn?: string }

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
  /** Posts a comment carrying `marker`; `attachments` are files already uploaded for this comment. */
  postNote(commands: Commands, item: WorkItem, text: string, marker: string, attachments?: readonly WorkAttachment[]): Promise<'sent' | 'gone'>
  /** Reads one embedded image's host metadata (name, suffix, size, short-lived URL); absent when the host has no files API. */
  readImageFile?(commands: Commands, project: string, key: string, image: WorkImageRef, signal?: AbortSignal): Promise<WorkImageFile>
  /**
   * The people who belong to the project, used to fill the Policy's member list instead of typing account ids by hand.
   * Absent when the host exposes no roster this adapter can read.
   */
  listMembers?(commands: Commands, project: string, signal?: AbortSignal): Promise<Person[]>
  /** The project's own status vocabulary, so a write-back status can be chosen by name instead of guessed. */
  listStatuses?(commands: Commands, project: string, categories: readonly string[], signal?: AbortSignal): Promise<WorkflowStatus[]>
  /**
   * Uploads one file to the item and returns how a comment should show it. Absent when the host cannot take attachments.
   */
  uploadFile?(commands: Commands, item: WorkItem, file: { name: string; data: string }, signal?: AbortSignal): Promise<WorkAttachment>
  /** Optional status write-back; absent means the host stays read-only for this kind. */
  setStatus?(commands: Commands, item: WorkItem, stage: string, signal?: AbortSignal): Promise<void>
  /** Web page of one item, used by the channel's link. */
  page(project: string, key: string): string
}