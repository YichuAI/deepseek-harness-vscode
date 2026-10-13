/**
 * Materializer — performs the actual filesystem operations for a revert.
 *
 * There is no "accept" counterpart any more: a mutation reaches disk before a
 * review can be built from its result, so accepting could only ever mark a fact
 * as acknowledged. Rejecting reverses the applied change:
 *   - existing file   : write `beforeText` back
 *   - new file        : delete it
 *   - one hunk        : reverse-patch just that hunk, leaving the rest alone
 *
 * Guards (goal.md §9–10):
 *   dirty editor — a VS Code editor holding unsaved changes blocks the write
 *   drift        — the file must still hold what this review expects
 *
 * The drift guard is the subtle one. "What this review expects" is NOT
 * `afterText`: once a hunk has been undone the file deliberately stops matching
 * it, and requiring a whole-file match made the second hunk of a turn
 * impossible to revert — the first undo poisoned every later one. The
 * expectation is therefore `afterText` with the already-undone hunks taken back
 * out, which is a function of the captured diff alone. That keeps the
 * materializer stateless (nothing has to remember what each write produced) and
 * keeps the guarantee that matters: a file the user has edited since the turn
 * still refuses.
 */

import * as crypto from 'node:crypto'
import * as vscode from 'vscode'
import { applyUndo, rebuild } from './patch.ts'
import type { ReviewFile, ReviewHunk, ReviewTransaction } from './types.ts'

export type MaterializeResult =
  | { ok: true }
  | {
    ok: false
    reason: 'stale' | 'dirty' | 'read-error' | 'write-error' | 'no-diff'
    message: string
  }

/** Just enough of a `Uri` for the filesystem calls below. */
export interface RevertUri {
  readonly fsPath: string
}

/**
 * The slice of the VS Code workspace API a revert uses.
 *
 * Spelled out rather than written as `typeof vscode.workspace` so that what this
 * class depends on is visible at a glance — and so that a test can hand it a
 * real filesystem without imitating forty methods it will never call. The e2e
 * suite reports against a real temp directory through exactly this shape.
 */
export interface RevertWorkspace {
  readonly textDocuments: ReadonlyArray<{ readonly fileName: string; readonly isDirty: boolean }>
  readonly fs: {
    readFile(uri: RevertUri): Thenable<Uint8Array>
    writeFile(uri: RevertUri, content: Uint8Array): Thenable<void>
    delete(uri: RevertUri, options?: unknown): Thenable<void>
  }
}

/** Reading a file and holding it to what a review expects. */
type Reconciled =
  | { ok: true; text: string; at: number | undefined }
  | { ok: false; reason: 'stale' | 'read-error'; message: string }

export class ReviewMaterializer {
  constructor(private readonly workspace: RevertWorkspace) {}

  /** Reject an entire file — back to `beforeText`, or delete it if this call created it. */
  async rejectFile(review: ReviewTransaction, file: ReviewFile): Promise<MaterializeResult> {
    const refuse = this.dirtyGuard(file)
    if (refuse !== undefined) return refuse

    // The tool deleted the file. There is no result left to hold it to, and the
    // only way back is the captured original — so no drift check is possible.
    const { afterText } = file
    if (afterText === null) {
      // Both sides missing means the review was built from a tool call alone,
      // with no captured text at all. There is nothing to write back and nothing
      // to look for, so say so: this used to fall through to the "new file"
      // branch and DELETE the file.
      if (file.beforeText === null) {
        return {
          ok: false,
          reason: 'no-diff',
          message: `${file.path} was recorded without its before/after text, so there is nothing to revert to.`,
        }
      }
      return this.writeFile(file.path, file.beforeText)
    }

    // Checked even for a created file: the delete below is a write, and a file
    // the user has touched since the turn is theirs.
    const reconciled = await this.reconcile(file, afterText, file.beforeText ?? '', undefined)
    if (!reconciled.ok) return reconciled

    if (file.beforeText === null) return this.deleteFile(file.path)
    return this.writeFile(file.path, file.beforeText)
  }

  /**
   * Reject a single hunk — reverse just that hunk.
   *
   * The granularity the file-level and turn-level buttons cannot offer: a call
   * that reformatted three functions and fixed one bug should let you keep the
   * fix and drop the reformat, without hand-editing the file back to prove it.
   */
  async rejectHunk(review: ReviewTransaction, file: ReviewFile, hunk: ReviewHunk): Promise<MaterializeResult> {
    const refuse = this.dirtyGuard(file)
    if (refuse !== undefined) return refuse

    // A file this call created, or one whose diff arrived with only one side,
    // has nothing to patch between — the honest undo is the whole file.
    const { beforeText, afterText } = file
    if (beforeText === null || afterText === null) return this.rejectFile(review, file)

    // Two clicks on one button are two requests, and the second arrives while
    // the first write is still in flight. The end state the caller asked for
    // already holds, so this is a no-op rather than a refusal — anything else
    // would paint a red "could not undo" on a hunk that is already undone.
    if (hunk.state === 'rejected') return { ok: true }

    const reconciled = await this.reconcile(file, afterText, beforeText, hunk.id)
    if (!reconciled.ok) return reconciled

    if (reconciled.at === undefined) {
      return {
        ok: false,
        reason: 'stale',
        message: `This change is no longer present in ${file.path} — nothing to undo.`,
      }
    }

    const { text, at } = reconciled
    return this.writeFile(file.path, applyUndo(text, at, hunk))
  }

  // ─── guards ───────────────────────────────────────────────────────────────

  /**
   * Refuse while VS Code holds unsaved changes for the file.
   *
   * Its own reason rather than folded into drift: it is a different fact with a
   * different remedy. The newer text is in the user's buffer and saving is
   * theirs to decide, which is not what "modified since this review" would send
   * them looking for.
   */
  private dirtyGuard(file: ReviewFile): MaterializeResult | undefined {
    for (const doc of this.workspace.textDocuments) {
      if (doc.fileName === file.path && doc.isDirty) {
        return {
          ok: false,
          reason: 'dirty',
          message: `${file.path} has unsaved editor changes. Save or discard them before rejecting.`,
        }
      }
    }
    return undefined
  }

  /**
   * Read the file and confirm it still holds what this review expects, then say
   * where `targetHunkId` sits inside it.
   *
   * One read, one pass, because the two answers have to be about the same bytes:
   * deciding the file is unchanged and *then* locating the hunk in a second read
   * would leave a window where the two disagree.
   *
   * `beforeText` and `afterText` are passed in rather than read off `file` so
   * that the caller's "this diff has both sides" check is the only place that
   * decides, and the compiler can see it. Both sides are needed: a hunk that
   * only deletes has no text on the result side to be found by, so its position
   * is recovered from the original.
   *
   * @param afterText the file as the tool left it, which is what the walk starts
   *                  from and what the rebuilt text is compared against
   */
  private async reconcile(
    file: ReviewFile,
    afterText: string,
    beforeText: string,
    targetHunkId: string | undefined,
  ): Promise<Reconciled> {
    const current = await this.readFile(file.path)
    if (current === undefined) {
      return { ok: false, reason: 'stale', message: `${file.path} no longer exists on disk.` }
    }

    const rebuilt = rebuild({ beforeText, afterText, hunks: file.hunks, targetHunkId })
    if (rebuilt === undefined) {
      return { ok: false, reason: 'stale', message: `This change is no longer present in ${file.path}.` }
    }

    if (hash(current) !== hash(rebuilt.text)) {
      return { ok: false, reason: 'stale', message: `${file.path} has been modified since this review was created.` }
    }
    return { ok: true, text: rebuilt.text, at: rebuilt.at }
  }

  // ─── low-level file I/O ────────────────────────────────────────────────────

  private async readFile(path: string): Promise<string | undefined> {
    try {
      const uri = vscode.Uri.file(path)
      const buf = await this.workspace.fs.readFile(uri)
      return Buffer.from(buf).toString('utf8')
    } catch {
      return undefined
    }
  }

  private async writeFile(path: string, content: string): Promise<MaterializeResult> {
    try {
      const uri = vscode.Uri.file(path)
      await this.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'))
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        reason: 'write-error',
        message: `Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  private async deleteFile(path: string): Promise<MaterializeResult> {
    try {
      const uri = vscode.Uri.file(path)
      await this.workspace.fs.delete(uri)
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        reason: 'write-error',
        message: `Failed to delete ${path}: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }
}

function hash(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}
