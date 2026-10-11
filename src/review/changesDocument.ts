/**
 * ChangesDocumentProvider — native diff for a turn's changed files.
 *
 * This is the sibling of {@link ReviewVirtualDocumentProvider} and exists for a
 * different reason. A review owns whole-file before/after text captured by the
 * file tool itself, so it can be reverted and diffed verbatim. A turn's
 * changed-files summary owns only HUNKS, served by the Host from the git
 * snapshots and whole-file copies it took around the turn — which is also why
 * it can list a file no tool ever reported (a `sed -i` in a shell command), and
 * why it is the only source that covers the whole turn rather than one call.
 *
 * The Host's own Web UI renders those hunks as a per-hunk view rather than a
 * whole-file comparison, because whole-file text is exactly what it does not
 * keep. We do the same: both sides of the diff are rebuilt from the hunk list.
 * That is a faithful presentation of what the Host recorded, and it stays
 * correct even after the file on disk has moved on.
 */

import * as vscode from 'vscode'
import type { ChangesHunk } from '../harness/protocol.ts'

export const DSH_CHANGES_SCHEME = 'dsh-changes'

/** One cached comparison, keyed by the id embedded in the virtual URIs. */
export interface ChangesDiffEntry {
  /** Display path from the Host, used as the diff editor's label. */
  label: string
  before: string
  after: string
}

/**
 * Rebuild the two sides of a comparison from its hunks.
 *
 * A line in a hunk starts with `+` (present only after), `-` (present only
 * before) or a space (context). Each side therefore keeps the context lines and
 * its own half of the changes. Lines that belong to the other side are emitted
 * as empty strings so the two sides stay line-aligned — without that the two
 * columns drift apart and the comparison reads as if everything moved.
 */
export function hunksToSides(hunks: readonly ChangesHunk[]): { before: string; after: string } {
  const beforeLines: string[] = []
  const afterLines: string[] = []
  for (const hunk of hunks) {
    for (const raw of hunk.lines) {
      if (raw.length === 0) { beforeLines.push(''); afterLines.push(''); continue }
      const sign = raw.charAt(0)
      const body = raw.slice(1)
      if (sign === '+') { beforeLines.push(''); afterLines.push(body) }
      else if (sign === '-') { beforeLines.push(body); afterLines.push('') }
      else if (sign === ' ') { beforeLines.push(body); afterLines.push(body) }
      else {
        // A line with no recognized prefix is not part of the contract; keep it
        // on both sides rather than silently dropping content.
        beforeLines.push(raw); afterLines.push(raw)
      }
    }
  }
  return { before: beforeLines.join('\n'), after: afterLines.join('\n') }
}

/** Holds the comparisons the diff editor may ask for, for the life of a session. */
export class ChangesDiffStore {
  private readonly entries = new Map<string, ChangesDiffEntry>()
  private counter = 0

  /** Cache one comparison and return the id its virtual URIs are built from. */
  put(entry: ChangesDiffEntry): string {
    const id = `chg-${++this.counter}`
    this.entries.set(id, entry)
    return id
  }

  get(id: string): ChangesDiffEntry | undefined {
    return this.entries.get(id)
  }

  clear(): void {
    this.entries.clear()
  }
}

/**
 * Serves `dsh-changes://<id>/<side>` out of a {@link ChangesDiffStore}.
 *
 * `side` is `before` or `after`; everything else is ignored, exactly as the
 * review provider does, so a malformed URI degrades to an empty document rather
 * than an exception.
 */
export class ChangesVirtualDocumentProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = DSH_CHANGES_SCHEME

  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>()
  readonly onDidChange = this._onDidChange.event

  constructor(private readonly store: ChangesDiffStore) {}

  provideTextDocumentContent(uri: vscode.Uri): string {
    // The id rides in the AUTHORITY, not the path: `Uri.parse` keeps a leading
    // slash on `path` for a hierarchical URI, so splitting the path and taking
    // the first segment yields '' and the store lookup never matches.
    const id = uri.authority
    const side = uri.path.replace(/^\/+/, '')
    if (!id || (side !== 'before' && side !== 'after')) return ''
    const entry = this.store.get(id)
    if (!entry) return ''
    return side === 'before' ? entry.before : entry.after
  }
}

/** Open the native diff editor for one cached comparison. */
export async function openChangesDiff(id: string, label: string): Promise<void> {
  const beforeUri = vscode.Uri.parse(`${DSH_CHANGES_SCHEME}://${id}/before`)
  const afterUri = vscode.Uri.parse(`${DSH_CHANGES_SCHEME}://${id}/after`)
  await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, `DeepSeek: ${label}`)
}
