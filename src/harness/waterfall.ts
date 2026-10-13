/**
 * waterfall.ts — which conversation does an answerable waterfall belong to?
 *
 * `$events` is a **host-wide** stream. Every session's approvals and questions
 * are forwarded down the one socket, so a card cannot be rendered until the
 * frame says which session it came from — and the frame does not always say it
 * in the same place:
 *
 *   approvals    `{ type:'waterfall', event:'approval/request', agentId, request }`
 *                where `request` also carries a `sessionId`
 *   questions    `{ type:'waterfall', event:'user-questions/request', agentId, request }`
 *                where `request` carries NO session of any kind
 *
 * `agentId` is the one field both have, and it *is* the session. That is not an
 * inference from naming: the shipped Host registers the wire codec as
 *
 *     lookups.register('agent', {
 *       wire: 'agentId',
 *       wireTypeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
 *       resolve: (sessionId) => this.get(sessionId),
 *     })
 *
 * — the declared wire type of `agentId` is `SessionId`, and it is validated as
 * such (`isRemoteEventAgentId`) before the frame is ever forwarded.
 *
 * Why this file exists: the question path used to read `request.sessionId`,
 * find nothing, and fall back to *the session the panel happened to be showing*.
 * So a question raised in a browser tab was rendered as a card in the VS Code
 * conversation — answerable, and about the wrong conversation. Nothing could
 * tell the two apart, because the value that would have said so was sitting in
 * `agentId` the whole time, unread.
 *
 * The rule here is deliberately narrow: **we never guess.** A frame that names
 * no session is not attributed to whatever is on screen; it is dropped, and the
 * caller is expected to log it. An unanswerable card the user cannot explain is
 * worse than a missing one, and the two failure modes are not symmetric — a
 * dropped frame is visibly missing, a misplaced one is silently wrong.
 *
 * Pure on purpose: no `vscode`, no socket, no clock. The whole rule is one
 * function that can be asserted exhaustively instead of inferred from a
 * rendered card.
 */

import type { SessionId } from './protocol.ts'

/** The fields a waterfall frame can name its session with, as they arrive off the wire. */
export interface WaterfallScope {
  /** `agentId` — the waterfall's declared scope. Validated by the frame codec. */
  agentId?: unknown
  /** `request.sessionId`, which the approval projection carries and questions do not. */
  requestSessionId?: unknown
}

/**
 * The session an answerable waterfall belongs to, or `undefined` when the frame
 * does not say.
 *
 * `agentId` wins over `request.sessionId` when both are present: they name the
 * same session on a current Host, and if a future Host ever made them disagree,
 * the scope the frame was delivered under is the one that says who is asking.
 */
export function waterfallSession(scope: WaterfallScope): SessionId | undefined {
  if (isNonEmptyString(scope.agentId)) return scope.agentId
  if (isNonEmptyString(scope.requestSessionId)) return scope.requestSessionId
  return undefined
}

/** `''` is the shape a missing field takes once it has been through a template literal. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}
