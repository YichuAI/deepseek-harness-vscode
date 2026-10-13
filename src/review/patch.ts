/**
 * Reverse-patching a captured diff.
 *
 * Pure text surgery: no filesystem, no `vscode`, nothing to stub. That is
 * deliberate — this is the part of a revert that can be *wrong* rather than
 * merely refused, and the only way to assert it honestly is to be able to call
 * it directly.
 *
 * A review's hunks carry their old and new text but not their offsets, so every
 * offset here is recovered by searching both sides of the diff at once. That is
 * more than caution: a hunk that only deletes has NO text on the result side, so
 * its position can only be recovered from the original — and a hunk that only
 * inserts has none on the original side. Searching both also means the walk can
 * check itself: the unchanged text between two hunks has to be identical on both
 * sides, and a hunk matched in the wrong place breaks that.
 */

import type { ReviewHunk } from './types.ts'

export interface RebuildInput {
  /** The file as it was before the tool ran. */
  beforeText: string
  /** The file as the tool left it. */
  afterText: string
  hunks: readonly ReviewHunk[]
  /** Also report this hunk's offset, for a caller undoing it. */
  targetHunkId?: string
}

export interface RebuiltText {
  /**
   * The file as it should look right now: `afterText` with every already-undone
   * hunk spliced back to its original text.
   */
  text: string
  /** Where `targetHunkId` starts inside `text`, when one was asked for. */
  at: number | undefined
}

/**
 * Rebuild a file from its captured diff.
 *
 * Walks the hunks in order, splicing each one that is already `rejected` back to
 * its `oldText`. Offsets are resolved with a cursor on each side that only ever
 * moves forward, which is the order a diff lists its hunks in — so a fragment
 * that occurs twice is matched at the occurrence its position implies rather
 * than at the first one in the file.
 *
 * @returns `undefined` when the two sides do not line up — a hunk that is not
 *          where the diff says it is, or unchanged text that differs between
 *          them. The signal that the file has drifted and nothing should be
 *          written on the strength of this diff.
 */
export function rebuild(input: RebuildInput): RebuiltText | undefined {
  const { beforeText, afterText, hunks, targetHunkId } = input

  let text = ''
  let at: number | undefined
  let bCursor = 0
  let aCursor = 0

  for (const h of hunks) {
    const oldText = h.oldText ?? ''
    let bFound: number
    let aFound: number

    if (h.newText === '') {
      // Deleted. Nothing on the result side to search for, so the original side
      // locates it — and the result-side offset is however far the unchanged
      // text before it reaches.
      bFound = oldText === '' ? bCursor : beforeText.indexOf(oldText, bCursor)
      if (bFound === -1) return undefined
      aFound = aCursor + (bFound - bCursor)
    } else if (oldText === '') {
      // Inserted. The mirror image.
      aFound = afterText.indexOf(h.newText, aCursor)
      if (aFound === -1) return undefined
      bFound = bCursor + (aFound - aCursor)
    } else {
      // Replaced — both sides have something to find.
      bFound = beforeText.indexOf(oldText, bCursor)
      aFound = afterText.indexOf(h.newText, aCursor)
      if (bFound === -1 || aFound === -1) return undefined
    }

    // The text between the previous hunk and this one is untouched by the tool,
    // so it has to read the same on both sides. When it does not, one of the two
    // offsets above was matched in the wrong place, and the splice below would
    // put the restored lines somewhere they never were.
    if (beforeText.slice(bCursor, bFound) !== afterText.slice(aCursor, aFound)) return undefined

    text += afterText.slice(aCursor, aFound)
    if (h.id === targetHunkId) at = text.length
    text += h.state === 'rejected' ? oldText : h.newText

    bCursor = bFound + oldText.length
    aCursor = aFound + h.newText.length
  }

  text += afterText.slice(aCursor)
  return { text, at }
}

/**
 * Undo one hunk inside already-rebuilt text.
 *
 * Separate from `rebuild` because the two answer different questions: `rebuild`
 * says what the file should hold *now*, and this says what it should hold after
 * the next undo — so `at` must be an offset in the rebuilt text, not in the
 * tool's original result.
 */
export function applyUndo(text: string, at: number, hunk: ReviewHunk): string {
  return text.slice(0, at) + (hunk.oldText ?? '') + text.slice(at + hunk.newText.length)
}
