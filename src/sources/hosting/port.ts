/**
 * Host-independent port of a code-hosting adapter (GitLab, Codeup, and later hosts): change requests, notes, and CI,
 * normalized to one vocabulary — change requests, notes and CI, the terms §5.3 of the extension design fixed — before any vendor call exists.
 * This module is types only; a host implementation lives with the kind that owns it.
 */
import type { Commands } from '../../infra/commands.ts'
import type { CiSnapshot } from '../github-read.ts'

/**
 * A change request (GitHub pull request, GitLab merge request, Codeup change request) in host-independent form;
 * `number` is the host-local number the adapter accepts back (`iid`, `localId`, `number`).
 */
export interface ChangeRequest {
  number: number
  title: string
  body: string
  author: string
  authorIsBot: boolean
  url: string
  /** `closed` once the change can no longer be updated; `merged` is kept apart because hosts spell it differently. */
  state: 'open' | 'closed'
  merged: boolean
  draft?: boolean
  head: { ref: string; sha: string; project?: string }
  base: { ref: string }
  createdAt: string
  updatedAt: string
}

/** One note on a change request: a conversation comment, an inline code comment, or a review verdict. */
export interface ChangeNote {
  id: string
  body: string
  author: string
  authorIsBot: boolean
  at: string
  updatedAt?: string
  url?: string
  kind: 'conversation' | 'inline' | 'review'
  /** The review verdict (`approve`, `request_changes`, `comment`) when the host carries one. */
  decision?: string
  path?: string
  line?: number
  /** The note this one replies to, within an inline review thread. */
  replyTo?: string
  diffHunk?: string
}

/** Where an outbound message goes inside the host: the repository, the change request, and optionally one of its notes. */
export interface HostAddress { project: string; number: number; isChange: boolean; note?: string }

/** A page of change requests with the host's cursor for the next page. */
export interface ChangePage { changes: ChangeRequest[]; next?: string }

/** A page of notes with the host's cursor for the next page. */
export interface NotePage { notes: ChangeNote[]; next?: string }

/**
 * What a hosting kind delegates to one host implementation: page URLs for links, a watermark scan of change requests,
 * reads of a single change and its notes, and idempotent note posting. `C` is the kind's configuration type, which an
 * implementation closes over when it is built for one Source instance; `ci` is optional because a host may run no checks.
 */
export interface HostAdapter<C extends Record<string, unknown>> {
  /** Host name: the Source's health entry and the namespace of its Trigger IDs. */
  readonly host: string
  /** The browser URL of a change request. */
  page(project: string, number: number): string
  /** Lists change requests updated since `since` (a local watermark; the host may not filter by it). */
  listChanges(commands: Commands, project: string, since: string, signal?: AbortSignal): Promise<ChangePage>
  /** Reads one change request by its host-local number. */
  readChange(commands: Commands, project: string, number: number, signal?: AbortSignal): Promise<ChangeRequest>
  /** Reads the notes of `change` after the local watermark `cursor`, first page when omitted. */
  readNotes(commands: Commands, change: ChangeRequest, cursor: string | undefined, signal?: AbortSignal): Promise<NotePage>
  /**
   * Posts `text`, with the hidden `marker` embedded, as a conversation note;
   * `'gone'` when the change no longer accepts notes and the message is dropped rather than retried.
   */
  postNote(commands: Commands, change: ChangeRequest, text: string, marker: string): Promise<'sent' | 'gone'>
  /** Reads CI for the change's head in GitHub's `CiSnapshot` shape; omitted, or `undefined`, for a host without checks. */
  ci?(commands: Commands, change: ChangeRequest, signal?: AbortSignal): Promise<CiSnapshot | undefined>
}