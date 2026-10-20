/**
 * Which transcript items actually moved since the last push.
 *
 * Split from the provider so it can be asserted without a VS Code host — the
 * provider is the one place that cannot be imported by the protocol test, and
 * this is the part with the arithmetic in it.
 *
 * The key is `uid` and the signature is `rev`; both come from the model, and
 * `rev` is already the webview's render signature. So "changed" here means
 * exactly "the row would be redrawn", which is the only reason to send it.
 */

import type { ConversationItem, SessionSnapshot } from '../conversation/types.ts'

/** What the previous push told the webview to expect. */
export interface SentTranscript {
  sessionId: string | undefined
  /** `uid` → the `rev` that was sent with it. */
  items: ReadonlyMap<string, number>
}

export interface TranscriptDelta {
  changed: ConversationItem[]
  removed: string[]
  /** The state to carry into the next push. */
  next: SentTranscript
}

/**
 * A first paint or a session change has nothing in common with what the webview
 * holds, so it must be sent whole: the delta is only meaningful against a
 * transcript both ends agree on.
 */
export function needsFullSnapshot(sent: SentTranscript, snap: SessionSnapshot): boolean {
  return sent.sessionId !== snap.sessionId
}

/** The state to remember after a full push. */
export function sentFrom(snap: SessionSnapshot): SentTranscript {
  const items = new Map<string, number>()
  for (const item of snap.items) {
    if (item.uid === undefined) continue
    items.set(String(item.uid), item.rev ?? -1)
  }
  return { sessionId: snap.sessionId, items }
}

export function computeSnapshotDelta(sent: SentTranscript, snap: SessionSnapshot): TranscriptDelta {
  const present = new Set<string>()
  const changed: ConversationItem[] = []
  for (const item of snap.items) {
    // `uid`/`rev` are optional by contract: a hand-built snapshot has neither,
    // and such an item is always sent rather than silently dropped.
    if (item.uid === undefined) { changed.push(item); continue }
    const key = String(item.uid)
    present.add(key)
    if (sent.items.get(key) !== item.rev) changed.push(item)
  }

  const removed: string[] = []
  for (const key of sent.items.keys()) if (!present.has(key)) removed.push(key)

  const next = new Map(sent.items)
  for (const item of changed) {
    if (item.uid !== undefined) next.set(String(item.uid), item.rev ?? -1)
  }
  for (const key of removed) next.delete(key)

  return { changed, removed, next: { sessionId: snap.sessionId, items: next } }
}
