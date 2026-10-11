/**
 * VirtualDocumentProvider — exposes review before/after content as virtual
 * documents via the `dsh-review://` URI scheme.
 *
 * This enables `vscode.diff` to open a native Diff Editor between:
 *   dsh-review://<reviewId>/<filePath>/before
 *   dsh-review://<reviewId>/<filePath>/after
 *
 * The provider reads from ReviewStore; the content is the captured
 * before/after text from the tool/result.meta, NOT from the live filesystem.
 * This guarantees the diff is stable even after the user edits the file.
 */

import * as vscode from 'vscode'
import type { ReviewStore } from './store.ts'

export const DSH_REVIEW_SCHEME = 'dsh-review'

export class ReviewVirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = DSH_REVIEW_SCHEME

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this._onDidChange.event

  constructor(private readonly store: ReviewStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    // URI structure: dsh-review://<reviewId in authority>/<encoded-file-path>/before|after
    //
    // The review id must come from `authority`. `Uri.parse` keeps a leading
    // slash on `path` for a hierarchical URI, so `path.split('/')` starts with
    // an empty segment — reading the id off it yields '' and every diff opened
    // through this provider silently renders blank.
    const reviewId = uri.authority
    const parts = uri.path.replace(/^\/+/, '').split('/')
    const side = parts.pop() // 'before' or 'after'
    const filePath = decodeURIComponent(parts.join('/'))

    if (!reviewId || !side || !filePath) return ''

    const review = this.store.getById(reviewId)
    if (!review) return ''

    const file = review.files.find(f => f.path === filePath)
    if (!file) return ''

    if (side === 'before') return file.beforeText ?? ''
    if (side === 'after') return file.afterText ?? ''
    return ''
  }
}

/** Build a before/after URI pair for a review file, then open native diff. */
export async function openDiffEditor(
  reviewId: string,
  filePath: string,
  label: string,
): Promise<void> {
  const encoded = encodeURIComponent(filePath)
  const beforeUri = vscode.Uri.parse(`${DSH_REVIEW_SCHEME}://${reviewId}/${encoded}/before`)
  const afterUri = vscode.Uri.parse(`${DSH_REVIEW_SCHEME}://${reviewId}/${encoded}/after`)
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `DeepSeek: ${label}`)
}
