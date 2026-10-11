/**
 * ReviewController — orchestrates the review lifecycle.
 *
 * This is the only module that touches BOTH the ReviewStore (state) and the
 * ReviewMaterializer (filesystem). It receives actions from the webview
 * (accept/reject/openDiff) and tool completion events from the conversation
 * model, then coordinates the response.
 *
 * Dependency direction (goal.md §19):
 *   View → AppController → ReviewController → VS Code API
 */

import * as vscode from 'vscode'
import type * as vscodeType from 'vscode'
import { ReviewMaterializer, type MaterializeResult } from './materializer.ts'
import { ReviewStore, type CreateReviewInput } from './store.ts'
import { openDiffEditor } from './virtualDocument.ts'
import type { CallId, SessionId } from '../harness/protocol.ts'
import type { ReviewChangeListener, ReviewSummary } from './types.ts'

export interface ReviewControllerDeps {
  workspace: typeof vscodeType.workspace
  onChange: () => void
  notifyError: (msg: string) => void
  /** Used by the aggregate revert report, which is not a failure. */
  notifyInfo: (msg: string) => void
  log: { info: (m: string) => void; error: (m: string) => void }
}

export class ReviewController {
  readonly store: ReviewStore
  private readonly materializer: ReviewMaterializer
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly d: ReviewControllerDeps) {
    this.store = new ReviewStore()
    this.materializer = new ReviewMaterializer(d.workspace)
    this.disposables.push(
      this.store.onReviewChange(() => d.onChange()),
    )
  }

  /** Called when a tool/call + tool/result pair completes. Creates a review if applicable. */
  onToolCompleted(input: CreateReviewInput): string | undefined {
    return this.store.createFromToolResult(input)
  }

  /** Open native VS Code diff for a file in a review. */
  async openDiff(reviewId: string, filePath: string): Promise<void> {
    const review = this.store.getById(reviewId)
    if (!review) return
    const file = review.files.find(f => f.path === filePath)
    if (!file) return
    const label = relativeLabel(filePath)
    try {
      await openDiffEditor(reviewId, filePath, label)
    } catch (e) {
      this.d.notifyError(`Failed to open diff: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /**
   * Reverse the applied change.
   *
   * There is no `accept*` counterpart any more. A mutation reaches disk before
   * a review can be built from its result, so "accept" could only ever mark a
   * fact as acknowledged — a button that did nothing but imply the change had
   * been waiting for permission. See the `WebviewAction` union.
   */
  async rejectFile(reviewId: string, filePath: string): Promise<void> {
    const result = await this.revertOne(reviewId, filePath)
    if (result === undefined) return
    if (!result.ok) this.d.notifyError(result.message)
  }

  /**
   * Revert every file in a review, reporting once.
   *
   * One notification instead of one per file. A turn touching twelve files where
   * the user has since edited three used to produce twelve toasts, and the three
   * that carried information scrolled away among the nine that said "done". The
   * refusals are also *not* errors in the ordinary sense: declining to write is
   * the guard doing its job, which is why the wording says so and the count is
   * unambiguous about what it did and did not touch.
   */
  async rejectAll(reviewId: string): Promise<void> {
    const review = this.store.getById(reviewId)
    if (!review) return

    let reverted = 0
    const refused: string[] = []
    for (const f of review.files) {
      const result = await this.revertOne(reviewId, f.path)
      if (result === undefined) continue
      if (result.ok) reverted++
      else refused.push(relativeLabel(f.path))
    }

    if (refused.length === 0) {
      this.d.notifyInfo(`Reverted ${String(reverted)} file(s).`)
      return
    }
    const kept = refused.length === 1 ? refused[0]! : `${String(refused.length)} files`
    this.d.notifyError(
      reverted === 0
        ? `Nothing reverted — ${kept} changed since this turn. Your edits were kept; the card shows why.`
        : `Reverted ${String(reverted)} file(s). Left ${kept} alone — changed since this turn.`,
    )
  }

  /** Reject a single hunk. */
  async rejectHunk(reviewId: string, filePath: string, hunkId: string): Promise<void> {
    const review = this.store.getById(reviewId)
    if (!review) return
    const file = review.files.find(f => f.path === filePath)
    if (!file) return
    const hunk = file.hunks.find(h => h.id === hunkId)
    if (!hunk) return

    const result = await this.materializer.rejectHunk(review, file, hunk)
    if (result.ok) {
      this.store.setHunkState(reviewId, filePath, hunkId, 'rejected')
      this.d.log.info(`Review ${reviewId}: rejected hunk ${hunkId} in ${filePath}`)
    } else {
      this.store.markConflicted(reviewId, filePath, result.message)
      this.d.notifyError(result.message)
    }
  }

  /**
   * The one place a revert actually happens, with no notification of its own.
   *
   * Returns `undefined` when there is nothing to act on, so callers can tell
   * "no such file" apart from "refused" — the aggregate report needs that
   * distinction to not claim credit for a revert it never attempted.
   */
  private async revertOne(reviewId: string, filePath: string): Promise<MaterializeResult | undefined> {
    const review = this.store.getById(reviewId)
    if (!review) return undefined
    const file = review.files.find(f => f.path === filePath)
    if (!file) return undefined

    const result = await this.materializer.rejectFile(review, file)
    if (result.ok) {
      this.store.setFileState(reviewId, filePath, 'rejected')
      this.d.log.info(`Review ${reviewId}: reverted ${filePath}`)
    } else {
      this.store.markConflicted(reviewId, filePath, result.message)
      this.d.log.error(`Review ${reviewId}: refused to revert ${filePath} (${result.reason}) — ${result.message}`)
    }
    return result
  }

  summaries(sessionId?: SessionId): ReviewSummary[] {
    return this.store.summaries(sessionId)
  }

  dispose(): void {
    for (const d of this.disposables) { try { d.dispose() } catch { /* noop */ } }
  }
}

function relativeLabel(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts.slice(-2).join('/')
}
