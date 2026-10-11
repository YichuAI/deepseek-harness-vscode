/**
 * ReviewStore — owns ReviewTransaction lifecycle.
 *
 * Created from tool/call + tool/result pairs when the tool is write or edit.
 * The store is the single source of truth for review state; the controller
 * reads from here and the materializer writes filesystem changes on reject.
 *
 * Data extraction priority (goal.md §4):
 *   1. tool/result.meta.diffs       ← most authoritative
 *   2. tool/call.arguments          ← fallback (write new file)
 */

import type { CallId, SessionId } from '../harness/protocol.ts'
import type { ReviewChangeListener, ReviewFile, ReviewHunk, ReviewState, ReviewSummary, ReviewTransaction } from './types.ts'

let reviewCounter = 0

export interface CreateReviewInput {
  sessionId: SessionId
  callId: CallId
  toolName: string
  /** Raw arguments JSON from tool/call. */
  arguments: string
  /** tool/result.meta (may contain diffs). */
  resultMeta?: unknown
}

export class ReviewStore {
  private reviews = new Map<string, ReviewTransaction>()
  private byCallId = new Map<CallId, string>()
  private listeners = new Set<ReviewChangeListener>()

  onReviewChange(listener: ReviewChangeListener): { dispose: () => void } {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  private notify(review: ReviewTransaction): void {
    for (const l of this.listeners) {
      try { l(review) } catch { /* listener errors must not break store */ }
    }
  }

  /** Attempt to create a review from a completed write/edit tool.
   *  Returns the review id if a reviewable mutation was found, undefined otherwise. */
  createFromToolResult(input: CreateReviewInput): string | undefined {
    const { sessionId, callId, toolName, arguments: argsRaw, resultMeta } = input
    if (toolName !== 'write' && toolName !== 'edit' && toolName !== 'write_file' && toolName !== 'edit_file') {
      return undefined
    }

    // Already have a review for this callId? Skip (idempotent).
    const existing = this.byCallId.get(callId)
    if (existing) return existing

    const files = extractFilesFromMeta(resultMeta, argsRaw, toolName)
    if (files.length === 0) return undefined

    const id = `review-${++reviewCounter}`
    const review: ReviewTransaction = {
      id,
      sessionId,
      callId,
      toolName: toolName === 'edit' || toolName === 'edit_file' ? 'edit' : 'write',
      files,
      state: 'pending',
      createdAt: Date.now(),
    }
    this.reviews.set(id, review)
    this.byCallId.set(callId, id)
    this.notify(review)
    return id
  }

  getById(id: string): ReviewTransaction | undefined {
    return this.reviews.get(id)
  }

  getByCallId(callId: CallId): ReviewTransaction | undefined {
    const id = this.byCallId.get(callId)
    return id ? this.reviews.get(id) : undefined
  }

  /** All reviews for a session, newest first. */
  forSession(sessionId: SessionId): ReviewTransaction[] {
    const out: ReviewTransaction[] = []
    for (const r of this.reviews.values()) {
      if (r.sessionId === sessionId) out.push(r)
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  setFileState(reviewId: string, filePath: string, state: ReviewState): void {
    const review = this.reviews.get(reviewId)
    if (!review) return
    const file = review.files.find(f => f.path === filePath)
    if (!file) return
    file.state = state
    // The file moved on from being conflicted, so the explanation is stale.
    if (state !== 'conflicted') delete file.conflictReason
    if (state !== 'partial') {
      for (const h of file.hunks) {
        h.state = state === 'accepted' ? 'accepted' : state === 'rejected' ? 'rejected' : 'pending'
      }
    }
    recomputeReviewState(review)
    this.notify(review)
  }

  setHunkState(reviewId: string, filePath: string, hunkId: string, state: 'accepted' | 'rejected'): void {
    const review = this.reviews.get(reviewId)
    if (!review) return
    const file = review.files.find(f => f.path === filePath)
    if (!file) return
    const hunk = file.hunks.find(h => h.id === hunkId)
    if (!hunk) return
    hunk.state = state
    recomputeFileState(file)
    recomputeReviewState(review)
    this.notify(review)
  }

  markConflicted(reviewId: string, filePath: string, reason: string): void {
    const review = this.reviews.get(reviewId)
    if (!review) return
    const file = review.files.find(f => f.path === filePath)
    if (!file) return
    file.state = 'conflicted'
    // Kept, not just counted: the UI has to be able to explain the refusal.
    file.conflictReason = reason
    recomputeReviewState(review)
    this.notify(review)
  }

  summaries(sessionId?: SessionId): ReviewSummary[] {
    const reviews = sessionId ? this.forSession(sessionId) : [...this.reviews.values()]
    return reviews.map(r => ({
      id: r.id,
      callId: r.callId,
      toolName: r.toolName,
      state: r.state,
      createdAt: r.createdAt,
      files: r.files.map(f => ({
        path: f.path,
        state: f.state,
        ...(f.conflictReason !== undefined ? { conflictReason: f.conflictReason } : {}),
        addedLines: countAdded(f),
        removedLines: countRemoved(f),
        hunks: f.hunks.map(h => ({ id: h.id, state: h.state })),
      })),
    }))
  }

  clearSession(sessionId: SessionId): void {
    for (const [id, r] of this.reviews) {
      if (r.sessionId === sessionId) {
        this.reviews.delete(id)
        this.byCallId.delete(r.callId)
      }
    }
  }
}

// ─── file extraction from meta/arguments ───────────────────────────────────

function extractFilesFromMeta(meta: unknown, argsRaw: string, toolName: string): ReviewFile[] {
  const args = safeParse(argsRaw)
  const metaObj = (meta && typeof meta === 'object') ? meta as Record<string, unknown> : undefined

  // 1. Try tool/result.meta.diffs — most authoritative
  const diffs = metaObj?.diffs
  if (Array.isArray(diffs) && diffs.length > 0) {
    const files: ReviewFile[] = []
    for (const d of diffs) {
      const f = extractFileFromDiff(d)
      if (f) files.push(f)
    }
    if (files.length > 0) return files
  }

  // 2. Fallback: build from tool/call arguments
  if (args) {
    const path = strArg(args, 'path') ?? strArg(args, 'file')
    if (path) {
      if (toolName === 'write' || toolName === 'write_file') {
        const content = strArg(args, 'content') ?? ''
        return [makeFile(path, null, content)]
      }
      if (toolName === 'edit' || toolName === 'edit_file') {
        const oldStr = strArg(args, 'oldText') ?? strArg(args, 'oldString') ?? strArg(args, 'old_str') ?? ''
        const newStr = strArg(args, 'newText') ?? strArg(args, 'newString') ?? strArg(args, 'new_str') ?? ''
        return [makeFile(path, null, null, [
          { id: 'h0', oldText: oldStr || null, newText: newStr, state: 'pending' },
        ])]
      }
    }
  }

  return []
}

function extractFileFromDiff(d: unknown): ReviewFile | undefined {
  if (!d || typeof d !== 'object') return undefined
  const obj = d as Record<string, unknown>
  const path = strVal(obj.path) ?? strVal(obj.filePath) ?? strVal(obj.file)
  if (!path) return undefined

  const before = strVal(obj.before) ?? strVal(obj.oldContent) ?? strVal(obj.oldText) ?? null
  const after = strVal(obj.after) ?? strVal(obj.newContent) ?? strVal(obj.newText) ?? null

  // If the diff has hunks, use them; otherwise synthesize one
  const rawHunks = Array.isArray(obj.hunks) ? obj.hunks : undefined
  let hunks: ReviewHunk[]

  if (rawHunks && rawHunks.length > 0) {
    hunks = rawHunks.map((h, i) => {
      const ho = (h && typeof h === 'object') ? h as Record<string, unknown> : {}
      return {
        id: `h${i}`,
        oldText: strVal(ho.oldText) ?? strVal(ho.old) ?? null,
        newText: strVal(ho.newText) ?? strVal(ho.new) ?? '',
        state: 'pending' as const,
      }
    })
  } else {
    hunks = [{
      id: 'h0',
      oldText: before,
      newText: after ?? '',
      state: 'pending',
    }]
  }

  return { path, beforeText: before, afterText: after, hunks, state: 'pending' }
}

function makeFile(
  path: string,
  beforeText: string | null,
  afterText: string | null,
  hunks?: ReviewHunk[],
): ReviewFile {
  return {
    path,
    beforeText,
    afterText,
    hunks: hunks ?? [{
      id: 'h0',
      oldText: beforeText,
      newText: afterText ?? '',
      state: 'pending',
    }],
    state: 'pending',
  }
}

// ─── state recomputation ────────────────────────────────────────────────────

function recomputeFileState(file: ReviewFile): void {
  if (file.hunks.length === 0) {
    file.state = 'pending'
    return
  }
  const allAccepted = file.hunks.every(h => h.state === 'accepted')
  const allRejected = file.hunks.every(h => h.state === 'rejected')
  if (allAccepted) file.state = 'accepted'
  else if (allRejected) file.state = 'rejected'
  else if (file.hunks.some(h => h.state !== 'pending')) file.state = 'partial'
  else file.state = 'pending'
}

function recomputeReviewState(review: ReviewTransaction): void {
  if (review.files.length === 0) {
    review.state = 'pending'
    return
  }
  const allAccepted = review.files.every(f => f.state === 'accepted')
  const allRejected = review.files.every(f => f.state === 'rejected')
  if (allAccepted) review.state = 'accepted'
  else if (allRejected) review.state = 'rejected'
  else if (review.files.some(f => f.state === 'conflicted')) review.state = 'conflicted'
  else if (review.files.some(f => f.state !== 'pending')) review.state = 'partial'
  else review.state = 'pending'
}

// ─── line counters ───────────────────────────────────────────────────────────

function countAdded(file: ReviewFile): number {
  return file.hunks.reduce((n, h) => n + lineCount(h.newText), 0)
}

function countRemoved(file: ReviewFile): number {
  return file.hunks.reduce((n, h) => n + (h.oldText ? lineCount(h.oldText) : 0), 0)
}

function lineCount(s: string): number {
  if (!s) return 0
  const n = s.split('\n').length
  // Don't count trailing newline as an extra line
  return s.endsWith('\n') ? n - 1 : n
}

// ─── small helpers ───────────────────────────────────────────────────────────

function safeParse(raw: string): Record<string, unknown> | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) as Record<string, unknown> } catch { return undefined }
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  return strVal(args[key])
}

function strVal(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
