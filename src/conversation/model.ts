/**
 * ConversationModel — projects the SessionEvent log into ConversationItem[].
 *
 * Key v0.0.2 changes vs the old SessionModel:
 *   1. Tool call + result MERGED into one ToolItem (by callId) — two events →
 *      one semantic object.
 *   2. SystemItem is its own kind (not `UserItem { system: true }`).
 *   3. System items are hidden by default via filtering in snapshot(), so
 *      downstream code never does "if user && system" dances.
 *   4. renderVersion is a monotonically incrementing counter that bumps on
 *      EVERY mutation (including streaming assistant text updates). This is
 *      the sole change-detection signature for the webview — eliminates the
 *      "streaming item text changed but same seq → no re-render" bug.
 */

import type {
  AssistantChunkData, AssistantMessageData, CallId, ContentBlock, SessionEvent,
  SessionId, SessionSummary, StreamChunk, ToolCallData, ToolResultData, TurnEndData,
  UserMessageData,
} from '../harness/protocol.ts'
import type { ConversationItem, SessionSnapshot } from './types.ts'

function blocksToText(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && 'type' in b) {
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'reasoning' && typeof b.text === 'string') { /* handled separately */ }
      else if (b.type === 'tool-result') {
        const inner = blocksToText(b.content as ContentBlock[] | undefined)
        if (inner) parts.push(inner)
      }
    }
  }
  return parts.join('\n').trim()
}

function extractReasoning(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && 'type' in b && b.type === 'reasoning' && typeof b.text === 'string') {
      parts.push(b.text)
    }
  }
  return parts.join('\n').trim()
}

function sourceLabel(source: unknown): string | undefined {
  if (!source || typeof source !== 'object') return undefined
  const s = source as { kind?: string; plugin?: string }
  if (s.kind === 'user') return undefined
  if (s.kind && s.plugin) return `${s.plugin}`
  if (s.kind) return s.kind
  return undefined
}

/** source.kind !== 'user' → plugin injection (system prompts, approvals, …) */
function isSystemSource(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false
  const s = source as { kind?: string }
  return s.kind !== 'user'
}

export function prettyToolArgs(raw: string): string {
  if (!raw) return ''
  try { return JSON.stringify(JSON.parse(raw), null, 2) } catch { return raw }
}

/** Callback fired when a tool call+result pair completes. Returns callId + raw data. */
export interface ToolCompletedHandler {
  (info: {
    callId: CallId
    toolName: string
    arguments: string
    resultMeta?: unknown
  }): void
}

export class ConversationModel {
  private items: ConversationItem[] = []
  private running = false
  private title: string | undefined
  private lastSeq = -1
  private showSystemMessages = false
  private renderVersion = 0
  /** callId → index in this.items where ToolItem lives. */
  private toolIndexByCallId = new Map<string, number>()
  /** turn:step → accumulated streaming buffers */
  private streaming = new Map<string, { text: string; reasoning: string }>()
  /** Index of currently streaming assistant item (-1 if none). */
  private streamingAssistantIdx = -1
  /** Callback fired when tool call+result pair completes. */
  private toolCompletedHandler: ToolCompletedHandler | undefined

  constructor(private readonly sessionId: SessionId) {}

  setToolCompletedHandler(h: ToolCompletedHandler | undefined): void {
    this.toolCompletedHandler = h
  }

  /** Attach a review id to a ToolItem (called by ReviewController after creating review). */
  setReviewId(callId: CallId, reviewId: string | undefined): void {
    const idx = this.toolIndexByCallId.get(callId)
    if (idx == null) return
    const item = this.items[idx]
    if (item?.kind === 'tool') {
      item.reviewId = reviewId
      this.bump()
    }
  }

  /** Attach an approval rpcId to a ToolItem (called by AppController on approval/requested). */
  setApprovalRpcId(callId: CallId, rpcId: string | undefined): void {
    const idx = this.toolIndexByCallId.get(callId)
    if (idx == null) return
    const item = this.items[idx]
    if (item?.kind === 'tool') {
      item.approvalRpcId = rpcId
      this.bump()
    }
  }

  setShowSystemMessages(show: boolean): void {
    if (show !== this.showSystemMessages) this.renderVersion++
    this.showSystemMessages = show
  }

  /** Bump renderVersion so the webview re-renders items (used when review/approval state changes). */
  touch(): void { this.bump() }

  loadHistory(events: SessionEvent[]): void {
    this.items = []
    this.running = false
    this.lastSeq = -1
    this.streaming.clear()
    this.toolIndexByCallId.clear()
    this.streamingAssistantIdx = -1
    this.renderVersion++
    for (const e of events) this.applyEvent(e)
  }

  applyEvent(event: SessionEvent): void {
    if (event.seq <= this.lastSeq && this.lastSeq !== -1) return
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    switch (event.type) {
      case 'user/message': this.applyUserMessage(event); break
      case 'assistant/chunk': this.applyAssistantChunk(event); break
      case 'assistant/message': this.applyAssistantMessage(event); break
      case 'tool/call': this.applyToolCall(event); break
      case 'tool/result': this.applyToolResult(event); break
      case 'turn/start': this.applyTurnStart(event); break
      case 'turn/end': this.applyTurnEnd(event); break
      case 'session/title': this.applyTitle(event); break
      default: break
    }
  }

  /** Optimistic user echo (still needed — send prompt first, event arrives later). */
  optimisticUserEcho(text: string): void {
    this.items.push({
      kind: 'user',
      seq: this.lastSeq + 0.5,
      text,
    })
    this.renderVersion++
  }

  snapshot(): SessionSnapshot {
    const systemMessageCount = this.items.filter(i => i.kind === 'system').length
    const items = this.showSystemMessages
      ? this.items
      : this.items.filter(i => i.kind !== 'system')
    return {
      sessionId: this.sessionId,
      title: this.title,
      running: this.running,
      items: items.map(i => {
        if (i.kind === 'tool') {
          // Strip resultMeta — large blob, not needed by webview
          const { resultMeta, ...rest } = i
          return rest
        }
        return { ...i }
      }),
      renderVersion: this.renderVersion,
      systemMessageCount,
    }
  }

  // ─── per-type projections ──────────────────────────────────────────────────

  private bump() { this.renderVersion++ }

  private applyUserMessage(event: SessionEvent): void {
    const d = event.data as UserMessageData
    const text = blocksToText(d.content)
    const last = this.items[this.items.length - 1]
    if (last && last.kind === 'user' && last.text === text && !Number.isInteger(last.seq)) {
      this.items.pop()
    }
    if (!text) return
    if (isSystemSource(d.source)) {
      this.items.push({
        kind: 'system',
        seq: event.seq,
        text,
        source: sourceLabel(d.source),
      })
    } else {
      this.items.push({
        kind: 'user',
        seq: event.seq,
        text,
      })
    }
    this.bump()
  }

  private applyAssistantChunk(event: SessionEvent): void {
    this.applyStreamChunkData(event.data as AssistantChunkData)
  }

  /**
   * Live assistant delta delivered out-of-band by the Remote assistant stream
   * (DSH 0.1.6+ carries streaming chunks outside the durable journal, so they
   * have no real `seq` and must bypass the monotonic-seq guard in applyEvent).
   * @param turn - owning turn.
   * @param step - owning step within the turn.
   * @param chunk - one stream delta.
   */
  applyStreamChunk(turn: number, step: number, chunk: StreamChunk): void {
    this.applyStreamChunkData({ turn, step, chunk })
  }

  private applyStreamChunkData(d: AssistantChunkData): void {
    const key = `${d.turn}:${d.step}`
    let entry = this.streaming.get(key)
    if (!entry) { entry = { text: '', reasoning: '' }; this.streaming.set(key, entry) }
    const c = d.chunk
    if (c.type === 'text-delta' && typeof c.text === 'string') entry.text += c.text
    else if (c.type === 'reasoning-delta' && typeof c.text === 'string') entry.reasoning += c.text

    const hasContent = entry.text.length > 0 || entry.reasoning.length > 0
    if (this.streamingAssistantIdx >= 0) {
      const existing = this.items[this.streamingAssistantIdx]
      if (existing && existing.kind === 'assistant' && existing.streaming) {
        existing.text = entry.text
        existing.reasoning = entry.reasoning || undefined
        this.bump()
        return
      }
    }
    if (hasContent) {
      const idx = this.items.length
      this.items.push({
        kind: 'assistant',
        seq: -(d.turn * 1000 + d.step),
        text: entry.text,
        reasoning: entry.reasoning || undefined,
        toolCallIds: [],
        streaming: true,
      })
      this.streamingAssistantIdx = idx
      this.bump()
    }
  }

  private applyAssistantMessage(event: SessionEvent): void {
    const d = event.data as AssistantMessageData
    const key = `${d.turn}:${d.step}`
    this.streaming.delete(key)
    const msg = d.message
    const text = blocksToText(msg.content)
    const reasoning = extractReasoning(msg.content)
    const toolCallIds: string[] = []
    for (const b of msg.content ?? []) {
      if (b && typeof b === 'object' && b.type === 'tool-call' && typeof b.id === 'string') {
        toolCallIds.push(b.id)
      }
    }

    const newItem: ConversationItem = {
      kind: 'assistant',
      seq: event.seq,
      text,
      reasoning: reasoning || undefined,
      toolCallIds,
      usage: d.usage,
      streaming: false,
    }

    // Replace streaming placeholder if one exists at streamingAssistantIdx.
    if (this.streamingAssistantIdx >= 0) {
      const cur = this.items[this.streamingAssistantIdx]
      if (cur && cur.kind === 'assistant' && cur.streaming) {
        this.items[this.streamingAssistantIdx] = newItem
        this.streamingAssistantIdx = -1
        this.bump()
        return
      }
    }
    this.items.push(newItem)
    this.streamingAssistantIdx = -1
    this.bump()
  }

  private applyToolCall(event: SessionEvent): void {
    const d = event.data as ToolCallData
    const idx = this.items.length
    this.items.push({
      kind: 'tool',
      seq: event.seq,
      callId: d.callId,
      name: d.name,
      arguments: d.arguments,
      result: undefined,
      state: 'running',
    })
    this.toolIndexByCallId.set(d.callId, idx)
    this.bump()
  }

  private applyToolResult(event: SessionEvent): void {
    const d = event.data as ToolResultData
    const block = (d.message.content ?? []).find(
      (b): b is { type: 'tool-result'; toolCallId?: string; content?: ContentBlock[]; isError?: boolean } =>
        b?.type === 'tool-result',
    )
    const callId = block?.toolCallId ?? d.message.source?.callId ?? ''
    const text = blocksToText(block?.content) || '(no output)'
    const isError = block?.isError === true || d.error !== undefined

    if (callId) {
      const idx = this.toolIndexByCallId.get(callId)
      if (idx != null && this.items[idx]?.kind === 'tool') {
        const t = this.items[idx] as Extract<ConversationItem, { kind: 'tool' }>
        t.result = { text, isError }
        t.resultMeta = d.meta
        t.state = isError ? 'error' : 'completed'
        this.bump()
        // Notify handler so ReviewController can create a review transaction
        if (!isError) {
          this.toolCompletedHandler?.({
            callId,
            toolName: t.name,
            arguments: t.arguments,
            resultMeta: d.meta,
          })
        }
        return
      }
    }
    // Call id unknown → orphan; still append (safe fallback, won't crash UI).
    this.items.push({
      kind: 'tool',
      seq: event.seq,
      callId,
      name: d.message.source?.callId?.slice(-6) ?? 'unknown',
      arguments: '',
      result: { text, isError },
      state: isError ? 'error' : 'completed',
    })
    this.bump()
  }

  private applyTurnStart(event: SessionEvent): void {
    const d = event.data as { turn: number }
    this.running = true
    this.items.push({ kind: 'status', seq: event.seq, text: `Turn ${d.turn} — started`, running: true })
    this.bump()
  }

  private applyTurnEnd(event: SessionEvent): void {
    const d = event.data as TurnEndData
    this.running = false
    this.streaming.clear()
    this.streamingAssistantIdx = -1
    const reason = d.reason?.kind ?? 'unknown'
    this.items.push({ kind: 'status', seq: event.seq, text: `Turn ${d.turn} — ${reason}`, running: false })
    this.bump()
  }

  private applyTitle(event: SessionEvent): void {
    const d = event.data as { title?: string }
    if (typeof d.title === 'string' && d.title.length > 0 && d.title !== this.title) {
      this.title = d.title
      this.bump()
    }
  }
}

export function sessionLabel(s: SessionSummary, fallbackIndex: number): string {
  const stamp = new Date(s.updatedAt).toLocaleString()
  const id8 = s.sessionId.replace(/^session-/, '').slice(0, 8)
  const state = s.running ? '● ' : (s.blank ? '○ ' : '')
  const title = s.projections?.values?.title
  if (title && !s.blank) return `${state}${fallbackIndex}. ${title} — ${stamp}`
  return `${state}${fallbackIndex}. ${id8} — ${stamp}`
}
