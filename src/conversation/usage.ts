/**
 * usage.ts — session token/usage projection.
 *
 * Two data sources, one accumulator:
 *
 *   1. Durable `assistant/message` events carry a per-step usage sample
 *      (`data.usage`, mirroring the official UI's `normalizeUsage` input):
 *        { inputTokens (UNCACHED prompt), outputTokens, cacheReadTokens?,
 *          cacheWriteTokens?, reasoningTokens?, totalTokens?, routes? }
 *      Folding these live keeps the panel current while the turn runs.
 *
 *   2. The host's own projections (`session/list` → `projections.values`):
 *      `tokenUsage {uncachedInputTokens, outputTokens, cacheReadTokens,
 *      cacheWriteTokens}`, `sessionStats {turns, steps, llmMs, ttftMs,
 *      decodeTokens…}` and `contextBreakdown {systemTokens, toolsTokens,
 *      messageTokens}`. These are authoritative for whole-session totals —
 *      the event fold can only see the window this client observed — so the
 *      projection value always replaces the folded one when it arrives.
 *
 * Displayed metrics mirror the official Web UI's TurnUsagePanel:
 *   cache hit % = cacheRead / (uncached input + cacheRead + cacheWrite)
 */

import type { AssistantMessageData, SessionEvent, SessionUsageProjection } from '../harness/protocol.ts'

export interface UsageTotals {
  /** Prompt tokens that were NOT served from cache (rc.2 `inputTokens`). */
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  /** Assistant steps observed (one `assistant/message` each). */
  steps: number
}

export interface SessionUsageState {
  /** Folded from observed `assistant/message` events this client received. */
  folded: UsageTotals
  /** Host projection values (authoritative whole-session totals). */
  projected?: {
    tokenUsage?: SessionUsageProjection['tokenUsage']
    sessionStats?: SessionUsageProjection['sessionStats']
    contextBreakdown?: SessionUsageProjection['contextBreakdown']
  }
  /** Monotonically increasing render signature. */
  version: number
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

export class SessionUsage {
  private totals: UsageTotals = empty()
  private projected: SessionUsageState['projected']
  private version = 0

  reset(): void {
    this.totals = empty()
    this.projected = undefined
    this.version++
  }

  /** Fold one durable session event; returns true when totals changed. */
  apply(event: SessionEvent): boolean {
    if (event.type !== 'assistant/message') return false
    const d = event.data as AssistantMessageData
    const u = d?.usage
    if (u === undefined || u === null) return false
    this.totals = {
      uncachedInputTokens: this.totals.uncachedInputTokens + count(u.inputTokens),
      outputTokens: this.totals.outputTokens + count(u.outputTokens),
      cacheReadTokens: this.totals.cacheReadTokens + count(u.cacheReadTokens),
      cacheWriteTokens: this.totals.cacheWriteTokens + count(u.cacheWriteTokens),
      reasoningTokens: this.totals.reasoningTokens + count(u.reasoningTokens),
      steps: this.totals.steps + 1,
    }
    this.version++
    return true
  }

  /**
   * Seed/replace with the host's projection values (from `session/list` or
   * `session/page`). The projection is authoritative: it sees the whole log,
   * not just the window this client observed.
   */
  applyProjection(p: SessionUsageProjection): boolean {
    const token = p?.tokenUsage
    if (token === undefined) return false
    const next = {
      tokenUsage: {
        ...(count(token.uncachedInputTokens) ? { uncachedInputTokens: count(token.uncachedInputTokens) } : {}),
        ...(count(token.outputTokens) ? { outputTokens: count(token.outputTokens) } : {}),
        ...(count(token.cacheReadTokens) ? { cacheReadTokens: count(token.cacheReadTokens) } : {}),
        ...(count(token.cacheWriteTokens) ? { cacheWriteTokens: count(token.cacheWriteTokens) } : {}),
      },
      ...(p.sessionStats !== undefined ? { sessionStats: p.sessionStats } : {}),
      ...(p.contextBreakdown !== undefined ? { contextBreakdown: p.contextBreakdown } : {}),
    }
    const prev = this.projected
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) return false
    this.projected = next
    this.version++
    return true
  }

  snapshot(): SessionUsageState {
    return {
      folded: { ...this.totals },
      ...(this.projected === undefined ? {} : { projected: this.projected }),
      version: this.version,
    }
  }
}

function empty(): UsageTotals {
  return {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    steps: 0,
  }
}

/** Cache hit % in 0–100 (one decimal), or undefined when nothing is cached. */
export function cacheHitPercent(t: { uncachedInputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): number | undefined {
  const prompt = t.uncachedInputTokens + t.cacheReadTokens + t.cacheWriteTokens
  if (prompt <= 0 || t.cacheReadTokens <= 0) return undefined
  return Math.round((t.cacheReadTokens / prompt) * 1000) / 10
}
