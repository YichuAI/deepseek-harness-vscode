/**
 * Approval types — PendingApproval represents an approval/requested event
 * from the Harness host that requires a human decision (Allow/Deny).
 *
 * Approval and Diff Review are separate semantic chains (goal.md §14):
 * they are correlated by `callId` but do not depend on each other.
 * The UI couples them visually (approval card embedded in ToolItem),
 * but the stores are independent.
 */

import type { AskUserQuestionItem, CallId, RpcId, SessionId } from '../harness/protocol.ts'

export type ApprovalState = 'pending' | 'responding' | 'resolved'

export interface PendingApproval {
  /** The mux frame's rpcId — used as the stable correlation key for replay. */
  rpcId: RpcId
  sessionId: SessionId
  approvalId: string
  /** Tool name that triggered the approval (if known). */
  toolName?: string
  /** Tool callId — links to ToolItem for UI embedding. */
  callId?: CallId
  /** Human-readable reason for the approval request. */
  reason?: string
  state: ApprovalState
  /** Outcome once resolved (from approval/resolved frame or our respond). */
  outcome?: string
  createdAt: number
}

/** Opaque approval summary for UI serialization. */
export interface ApprovalSummary {
  rpcId: RpcId
  approvalId: string
  sessionId: SessionId
  toolName?: string
  callId?: CallId
  reason?: string
  state: ApprovalState
  outcome?: string
  /** Whether VS Code-side Allow is permitted (safety allowlist). */
  canAllow: boolean
  /**
   * Why `canAllow` is false, when it is a policy refusal rather than "wrong
   * session" or "already answered". Rendered so a disabled Allow button is
   * never a dead end.
   */
  blockedBy?: 'high-risk' | 'session' | 'settled'
  createdAt: number
}

// ─── user questions (`user-questions/request`) ───────────────────────────────
/**
 * One pending `ask_user_question` waterfall.
 *
 * The Host blocks the tool call until this settles, so a question the sidebar
 * does not render is a hung turn, not just a missing card.
 */
export interface PendingQuestion {
  rpcId: RpcId
  sessionId: SessionId
  /** The `ask_user_question` call the card belongs to; absent on an indefinite wait. */
  callId?: CallId
  questions: AskUserQuestionItem[]
  state: ApprovalState
  createdAt: number
}

/** Opaque question summary for UI serialization. */
export interface QuestionSummary {
  rpcId: RpcId
  sessionId: SessionId
  callId?: CallId
  questions: AskUserQuestionItem[]
  state: ApprovalState
  createdAt: number
}

export type ApprovalChangeListener = (approval: PendingApproval) => void
