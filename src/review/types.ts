/**
 * Review types — the core abstraction for Diff Review.
 *
 * A ReviewTransaction represents one tool mutation (write/edit) that Harness
 * has already applied to disk. The review UI allows the user to:
 *   - Accept = keep the applied change (mark accepted, no filesystem op)
 *   - Reject = revert the change (reverse patch via WorkspaceEdit)
 *
 * Data source priority (per goal.md §4):
 *   1. tool/result.meta.diffs  ← most authoritative
 *   2. tool/call arguments     ← fallback (new file: oldText=null, newText=args.content)
 *   3. workspace file           ← materialize/revert target
 *   4. Git                      ← NOT involved
 */

import type { CallId, SessionId } from '../harness/protocol.ts'

export type ReviewState =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'partial'
  | 'conflicted'

export type HunkState = 'pending' | 'accepted' | 'rejected'

export interface ReviewHunk {
  id: string
  /** Original text (null = new content, no prior version). */
  oldText: string | null
  /** New text after the tool mutation. */
  newText: string
  state: HunkState
}

export interface ReviewFile {
  /** Workspace-relative or absolute file path. */
  path: string
  /** Full file content before mutation (null = file did not exist). */
  beforeText: string | null
  /** Full file content after mutation (null = file was deleted). */
  afterText: string | null
  hunks: ReviewHunk[]
  state: ReviewState
  /**
   * Why a revert was refused, when one was.
   *
   * `markConflicted` used to set the state and drop the reason on the floor, so
   * the card could say "conflicted" and nothing else — which is a word that
   * tells you an undo did not happen without telling you anything about what to
   * do next. Cleared whenever the file leaves the conflicted state.
   */
  conflictReason?: string
}

export interface ReviewTransaction {
  id: string
  sessionId: SessionId
  callId: CallId
  /** Tool that produced this mutation — only 'write' and 'edit' in v1. */
  toolName: 'write' | 'edit'
  files: ReviewFile[]
  state: ReviewState
  /** Timestamp (ms) when the review was created. */
  createdAt: number
}

/** What the review card needs to know about one hunk — enough to name it. */
export interface ReviewHunkSummary {
  id: string
  state: HunkState
  addedLines: number
  removedLines: number
  /**
   * A one-line taste of the change, so a hunk button can say WHICH hunk.
   *
   * Truncated on purpose: this summary crosses into the webview on every state
   * push, and the full text is one click away in the diff editor. Without it the
   * card could only offer "undo change 2 of 3", which is a position rather than
   * an answer to "is this the one I want gone?".
   */
  preview: string
}

/** Opaque review summary for UI serialization (no large text blobs). */
export interface ReviewSummary {
  id: string
  callId: CallId
  toolName: string
  files: Array<{
    path: string
    state: ReviewState
    /**
     * Why this file could not be reverted. Present only while `state` is
     * `conflicted` — it is the message the materializer refused with.
     */
    conflictReason?: string
    addedLines: number
    removedLines: number
    hunks: ReviewHunkSummary[]
  }>
  state: ReviewState
  createdAt: number
}

/** Callback when a review transaction's state changes. */
export type ReviewChangeListener = (review: ReviewTransaction) => void
