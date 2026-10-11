/**
 * Conversation projection types — v0.0.2 upgrade.
 *
 * Replaces the flat RenderItem list (one event → one UI tile) with a
 * conversation-semantic projection where:
 *
 *   - ToolItem owns BOTH its call and result (merged by callId)
 *   - SystemItem is a distinct kind, not a user-item with a boolean flag
 *   - Only items with display meaning exist — no 1:1 event parity
 *
 * This removes the "pink result block" noise and makes tool-call/result
 * appear as a single collapsible card in the UI.
 */

import type { ChangesSummary } from '../harness/protocol.ts'

/**
 * Per-item render identity, stamped by {@link ConversationModel}.
 *
 * The webview renders the transcript incrementally, so it needs two answers per
 * item and must get them in O(1): "is this still the same thing?" and "did it
 * change since I last drew it?".
 *
 *   • `uid` — stable for the life of one item. It survives streaming text
 *     updates and a tool row gaining its result; it changes only when the item
 *     itself is replaced (the streaming placeholder becoming the durable
 *     message). That is the DOM-node key.
 *   • `rev` — bumped on every mutation of the item. That is the change
 *     signature.
 *
 * Both are optional so an item literal is still valid without them; a reader
 * that finds them missing (a hand-built snapshot in a test) falls back to a
 * content signature.
 */
export interface ItemIdentity {
  uid?: number
  rev?: number
}

export interface UserMessageItem extends ItemIdentity {
  kind: 'user'
  seq: number
  text: string
}

export interface AssistantMessageItem extends ItemIdentity {
  kind: 'assistant'
  seq: number
  text: string
  reasoning?: string
  /** Reference to tool calls produced by this assistant message (ids). */
  toolCallIds: string[]
  usage?: { inputTokens?: number; outputTokens?: number }
  streaming: boolean
}

export interface SystemItem extends ItemIdentity {
  kind: 'system'
  seq: number
  text: string
  source?: string
}

export interface ToolItem extends ItemIdentity {
  kind: 'tool'
  seq: number
  /** The turn that issued this call — how a changed-files card finds the reviews it may undo. */
  turn?: number
  callId: string
  name: string
  arguments: string
  result?: { text: string; isError: boolean }
  /** Raw tool/result.meta — authoritative diff data source (goal.md §4). */
  resultMeta?: unknown
  state: 'running' | 'completed' | 'error'
  /** Review transaction id if a review was created for this tool (write/edit). */
  reviewId?: string
}

export interface StatusItem extends ItemIdentity {
  kind: 'status'
  seq: number
  text: string
  running: boolean
}

/**
 * The end-of-turn changed-files card.
 *
 * Produced by the Host's `workspace/changes` Session event and filled from the
 * deliverables summary route. This is a REPORT, not a gate: by the time it
 * exists the turn has already written whatever it wrote, and the card exists so
 * the human can SEE that — and undo it if they disagree. There is deliberately
 * no "accept" step, because nothing was ever held back.
 *
 * The summary is fetched asynchronously (it lives on the Host, not in the event
 * log), so `loading` distinguishes "still asking" from "the Host has nothing
 * for this turn". A turn that changed no file never produces the event at all.
 */
export interface ChangesItem extends ItemIdentity {
  kind: 'changes'
  seq: number
  /** The turn this card reports on. One card per turn; a repeat announcement replaces the coordinate. */
  turn: number
  summary?: ChangesSummary
  loading: boolean
  /** Set only when the route failed for a reason other than "gone". */
  error?: string
}

export type ConversationItem =
  | UserMessageItem
  | AssistantMessageItem
  | SystemItem
  | ToolItem
  | StatusItem
  | ChangesItem

export interface SessionSnapshot {
  sessionId: string
  title?: string
  running: boolean
  items: ConversationItem[]
  /** Monotonically increasing version — bumps on ANY model mutation.
   *  Used as the sole render signature (fixes the streaming-unchanged-seq bug). */
  renderVersion: number
  /** Count of system messages currently filtered out of `items` (badge counter). */
  systemMessageCount: number
}
