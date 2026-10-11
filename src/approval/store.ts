/**
 * ApprovalStore — owns the pending-answer lifecycle for BOTH forwarded
 * waterfalls: `approval/request` (a tool wants permission) and
 * `user-questions/request` (the agent wants an answer).
 *
 * They are one store because they are one lifecycle — arrive on `$events`,
 * hold until a result or a `cancel` — and because two stores would mean two
 * listeners, two pushes and two chances for one of them to be forgotten. The
 * outcome types stay disjoint; only the plumbing is shared.
 *
 * Security (goal.md §15-16):
 *   - Only render an answerable card when sessionId === activeSessionId
 *   - callId must match a known ToolItem (checked by controller)
 *   - Never auto-approve — explicit human click only
 *   - Reason gate: a request that announces an escalation to full/unrestricted
 *     access gets no inline Allow; it points at the Web UI instead.
 */

import type { AskUserQuestionItem, CallId, RpcId, SessionId } from '../harness/protocol.ts'
import type {
  ApprovalChangeListener, ApprovalSummary, PendingApproval, PendingQuestion, QuestionSummary,
} from './types.ts'

/**
 * Approval reasons too dangerous to grant from the sidebar.
 *
 * This replaces an earlier tool-NAME allowlist (`write`, `edit`, `grep`, …).
 * That list was wrong twice over: it named tools this Host does not have (the
 * shell tool is `pwsh`/`bash`, so every real escalation was refused), and it
 * gated on the least informative field in the request — a name says nothing
 * about how much power the call is asking for, while the reason says exactly
 * that ("escalate sandbox to danger-full-access: …"). Nothing was lost by
 * dropping it: the reason is the Host's own statement of the risk, and it is
 * displayed verbatim next to the buttons.
 *
 * Fail-closed direction is preserved — an unrecognised reason with no
 * escalation wording is still allow-able, but nothing *dangerous* slips
 * through on a name we happened to forget to add.
 */
const HIGH_RISK_PATTERNS = [
  'danger-full-access',
  'danger_full_access',
  'full-access',
  'full_access',
  'escalation',
  'sandbox-escalate',
]

export interface UpsertApprovalInput {
  rpcId: RpcId
  sessionId: SessionId
  approvalId: string
  toolName?: string
  callId?: CallId
  reason?: string
}

export interface UpsertQuestionInput {
  rpcId: RpcId
  sessionId: SessionId
  callId?: CallId
  questions: AskUserQuestionItem[]
}

export class ApprovalStore {
  private approvals = new Map<RpcId, PendingApproval>()
  private questions = new Map<RpcId, PendingQuestion>()
  private listeners = new Set<ApprovalChangeListener>()

  onApprovalChange(listener: ApprovalChangeListener): { dispose: () => void } {
    this.listeners.add(listener)
    return { dispose: () => { this.listeners.delete(listener) } }
  }

  private notify(approval: PendingApproval | PendingQuestion): void {
    for (const l of this.listeners) {
      try { l(approval as PendingApproval) } catch { /* listener errors must not break store */ }
    }
  }

  upsert(input: UpsertApprovalInput): PendingApproval {
    const existing = this.approvals.get(input.rpcId)
    if (existing) {
      // Update fields if provided (e.g. replays may have more info)
      if (input.toolName && !existing.toolName) existing.toolName = input.toolName
      if (input.callId && !existing.callId) {
        existing.callId = input.callId
      }
      if (input.reason && !existing.reason) existing.reason = input.reason
      this.notify(existing)
      return existing
    }

    const approval: PendingApproval = {
      rpcId: input.rpcId,
      sessionId: input.sessionId,
      approvalId: input.approvalId,
      toolName: input.toolName,
      callId: input.callId,
      reason: input.reason,
      state: 'pending',
      createdAt: Date.now(),
    }
    this.approvals.set(input.rpcId, approval)
    this.notify(approval)
    return approval
  }

  /** Mark as responding (user clicked Allow/Deny, waiting for server). */
  setResponding(rpcId: RpcId): void {
    const a = this.approvals.get(rpcId)
    if (!a || a.state !== 'pending') return
    a.state = 'responding'
    this.notify(a)
  }

  /** Mark as resolved (from approval/resolved frame or our respond success). */
  resolve(rpcId: RpcId, outcome: string): void {
    const a = this.approvals.get(rpcId)
    if (!a) return
    a.state = 'resolved'
    a.outcome = outcome
    this.notify(a)
    // Clean up after a delay so the UI can show the resolved state
    setTimeout(() => {
      this.approvals.delete(rpcId)
    }, 5000)
  }

  getByRpcId(rpcId: RpcId): PendingApproval | undefined {
    return this.approvals.get(rpcId)
  }

  /** Pending approvals for a session (resolved ones are cleaned up). */
  pending(sessionId: SessionId): PendingApproval[] {
    const out: PendingApproval[] = []
    for (const a of this.approvals.values()) {
      if (a.sessionId === sessionId && a.state !== 'resolved') out.push(a)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  summaries(activeSessionId: SessionId | undefined): ApprovalSummary[] {
    const all = activeSessionId
      ? this.pending(activeSessionId)
      : [...this.approvals.values()]
    return all.map(a => ({
      rpcId: a.rpcId,
      approvalId: a.approvalId,
      sessionId: a.sessionId,
      toolName: a.toolName,
      callId: a.callId,
      reason: a.reason,
      state: a.state,
      outcome: a.outcome,
      canAllow: this.canAllow(a, activeSessionId),
      blockedBy: this.blockReason(a, activeSessionId),
      createdAt: a.createdAt,
    }))
  }

  // ─── questions ─────────────────────────────────────────────────────────────

  upsertQuestion(input: UpsertQuestionInput): PendingQuestion {
    const existing = this.questions.get(input.rpcId)
    if (existing) {
      // A replay (reconnect) can carry the same waterfall again; keep the first
      // arrival time so ordering stays stable across reconnects.
      this.notify(existing)
      return existing
    }
    const question: PendingQuestion = {
      rpcId: input.rpcId,
      sessionId: input.sessionId,
      callId: input.callId,
      questions: input.questions,
      state: 'pending',
      createdAt: Date.now(),
    }
    this.questions.set(input.rpcId, question)
    this.notify(question)
    return question
  }

  setQuestionResponding(rpcId: RpcId): void {
    const q = this.questions.get(rpcId)
    if (!q || q.state !== 'pending') return
    q.state = 'responding'
    this.notify(q)
  }

  getQuestion(rpcId: RpcId): PendingQuestion | undefined {
    return this.questions.get(rpcId)
  }

  /** Pending questions for a session, oldest first. */
  pendingQuestions(sessionId: SessionId): PendingQuestion[] {
    const out: PendingQuestion[] = []
    for (const q of this.questions.values()) {
      if (q.sessionId === sessionId && q.state !== 'resolved') out.push(q)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  questionSummaries(activeSessionId: SessionId | undefined): QuestionSummary[] {
    const all = activeSessionId
      ? this.pendingQuestions(activeSessionId)
      : [...this.questions.values()]
    return all.map(q => ({
      rpcId: q.rpcId,
      sessionId: q.sessionId,
      callId: q.callId,
      questions: q.questions,
      state: q.state,
      createdAt: q.createdAt,
    }))
  }

  /**
   * Put a waterfall back to pending, in either store.
   *
   * The counterpart to {@link resolveWaterfall}, and needed for the same reason
   * the settle-on-success is: the Host sends a mux client no `approval/resolved`
   * frame, so we own the lifecycle. A POST that *failed* used to leave the card
   * in 'responding' for the rest of the session — buttons reading "Allowing…",
   * nothing clickable, and no way back, because the only route to pending was
   * for the card to be dropped entirely.
   */
  revertResponding(rpcId: RpcId): void {
    const a = this.approvals.get(rpcId)
    if (a && a.state === 'responding') {
      a.state = 'pending'
      this.notify(a)
    }
    const q = this.questions.get(rpcId)
    if (q && q.state === 'responding') {
      q.state = 'pending'
      this.notify(q)
    }
  }

  clearSession(sessionId: SessionId): void {
    for (const [rpcId, a] of this.approvals) {
      if (a.sessionId === sessionId) {
        this.approvals.delete(rpcId)
        }
    }
    for (const [rpcId, q] of this.questions) {
      if (q.sessionId === sessionId) this.questions.delete(rpcId)
    }
  }

  /**
   * Settle whichever waterfall an `eventId` names, in either store.
   *
   * One entry point because the Host's withdrawal signal (`cancel`) carries
   * only the eventId — it does not say whether an approval or a question it
   * used to be, and after the fact neither do we. Returns true when something
   * was actually settled, so a caller can tell a stale cancel from a live one.
   */
  resolveWaterfall(rpcId: RpcId, outcome: string): boolean {
    let settled = false
    if (this.approvals.has(rpcId)) { this.resolve(rpcId, outcome); settled = true }
    const q = this.questions.get(rpcId)
    if (q && q.state !== 'resolved') {
      q.state = 'resolved'
      this.notify(q)
      setTimeout(() => { this.questions.delete(rpcId) }, 5000)
      settled = true
    }
    return settled
  }

  /** Security gate: can this approval be Allowed from VS Code? */
  canAllow(approval: PendingApproval, activeSessionId: SessionId | undefined): boolean {
    return this.blockReason(approval, activeSessionId) === undefined
  }

  /**
   * The single source of truth behind {@link canAllow}, returning WHY instead of
   * a bare boolean. The UI needs the reason: a disabled Allow button with no
   * explanation is the exact dead end this gate is supposed to avoid.
   */
  blockReason(
    approval: PendingApproval,
    activeSessionId: SessionId | undefined,
  ): ApprovalSummary['blockedBy'] {
    // 1. Session must match the one on screen — an approval from a session the
    //    user cannot see must not be answerable by reflex.
    if (!activeSessionId || approval.sessionId !== activeSessionId) return 'session'
    // 2. Must still be answerable.
    if (approval.state !== 'pending') return 'settled'
    // 3. Reason gate (see HIGH_RISK_PATTERNS).
    const reason = (approval.reason ?? '').toLowerCase()
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (reason.includes(pattern)) return 'high-risk'
    }
    return undefined
  }
}
