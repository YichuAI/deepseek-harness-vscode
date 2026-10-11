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
 *      EVERY mutation (including streaming assistant text updates). It is the
 *      "something changed, re-run render()" signal. The webview no longer uses
 *      it to rebuild the transcript wholesale: each item also carries a `uid`
 *      (its DOM key) and a `rev` (its own change signature), so a streamed
 *      chunk re-renders one row instead of every row. See `ItemIdentity`.
 */

import type {
  AssistantChunkData, AssistantMessageData, CallId, ChangesSummary, ContentBlock, SessionEvent,
  SessionId, SessionSummary, StreamChunk, ToolCallData, ToolResultData, TurnEndData,
  UserMessageData, WorkspaceChangesEventData,
} from '../harness/protocol.ts'
import type { ConversationItem, SessionSnapshot } from './types.ts'

function blocksToText(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (b && typeof b === 'object' && 'type' in b) {
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'reasoning' && typeof b.text === 'string') { /* handled separately */ }
      // An image block carries a durable ref, not text. Stand in for it so a
      // picture in the transcript is visibly there rather than an empty bubble.
      else if (b.type === 'image') parts.push('[image]')
      else if (b.type === 'file') parts.push('[file]')
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

/**
 * Callback fired when a turn announces its changed files.
 *
 * The model cannot fetch anything (it is pure projection — no network, no VS
 * Code), so it names the turn and the coordinate and lets the controller ask
 * the Host. `seq` is the announcement event's own sequence; that, not the turn
 * number, is what the summary route is addressed by.
 */
export interface ChangesRequestHandler {
  (turn: number, seq: number): void
}

/**
 * Source of {@link ItemIdentity.uid}, deliberately module-level rather than
 * per-model.
 *
 * The webview caches a DOM node per `uid` and shows it again when the key and
 * the change signature both match. A per-instance counter would restart at 1
 * every time a session is (re)selected — a reconnect, a fork, a switch — and
 * the fresh transcript's `user:1` would then match the *previous* transcript's
 * cached row and be answered with a stale node. A process-wide counter removes
 * that possibility by construction: no two items ever share a uid.
 */
let nextItemUid = 0

export class ConversationModel {
  private items: ConversationItem[] = []
  private running = false
  private title: string | undefined
  private lastSeq = -1
  private showSystemMessages = false
  private renderVersion = 0
  /** callId → index in this.items where ToolItem lives. */
  private toolIndexByCallId = new Map<string, number>()
  /** turn → index in this.items where its ChangesItem lives (one card per turn). */
  private changesIndex = new Map<number, number>()
  /** turn:step → accumulated streaming buffers */
  private streaming = new Map<string, { text: string; reasoning: string }>()
  /** Index of currently streaming assistant item (-1 if none). */
  private streamingAssistantIdx = -1
  /** Monotonic counter for {@link ItemIdentity.rev} — see {@link stamp}. */
  private revSeq = 0
  /**
   * Highest turn whose `turn/end` has been folded.
   *
   * A live delta can still be in flight when the turn ends (a durable
   * `assistant/message` and the stream's own `end` frame are not ordered against
   * each other). Without this the late delta started a fresh streaming bubble
   * at the very bottom of the transcript — a duplicated answer under the
   * "Turn N — stop" line.
   */
  private lastEndedTurn = -1
  /**
   * `turn:step` keys already closed by a durable `assistant/message`.
   *
   * The durable message is authoritative and replaces the streaming placeholder.
   * A delta that arrives after it would find no placeholder and start a second
   * bubble for text the transcript already shows.
   */
  private finalizedSteps = new Set<string>()
  /** Callback fired when tool call+result pair completes. */
  private toolCompletedHandler: ToolCompletedHandler | undefined
  /** Callback fired when a turn announces its changed files. */
  private changesRequestHandler: ChangesRequestHandler | undefined

  constructor(private readonly sessionId: SessionId) {}

  /**
   * Stamp one item with its render identity (see {@link ItemIdentity}).
   *
   * Used on creation and again on every mutation: `uid` is assigned once and
   * kept, `rev` advances every call. That pair is what lets the webview reuse
   * the DOM node it already built instead of re-rendering the whole transcript.
   */
  private stamp<T extends ConversationItem>(item: T): T {
    item.uid ??= ++nextItemUid
    item.rev = ++this.revSeq
    return item
  }

  setToolCompletedHandler(h: ToolCompletedHandler | undefined): void {
    this.toolCompletedHandler = h
  }

  setChangesRequestHandler(h: ChangesRequestHandler | undefined): void {
    this.changesRequestHandler = h
  }

  /** Attach a review id to a ToolItem (called by ReviewController after creating review). */
  setReviewId(callId: CallId, reviewId: string | undefined): void {
    const idx = this.toolIndexByCallId.get(callId)
    if (idx == null) return
    const item = this.items[idx]
    if (item?.kind === 'tool') {
      item.reviewId = reviewId
      this.stamp(item)
      this.bump()
    }
  }

  setShowSystemMessages(show: boolean): void {
    if (show !== this.showSystemMessages) this.renderVersion++
    this.showSystemMessages = show
  }

  /**
   * Force a webview re-render of the transcript.
   *
   * Only review cards need this: they are drawn INSIDE transcript tool rows, so
   * a review whose state changed has no other way to reach the screen. Approval
   * and question cards live in the pending panel above the composer instead, so
   * touching the model for one of those bought a full transcript rebuild for a
   * diff of nothing.
   */
  touch(): void { this.bump() }

  /**
   * The current change-detection signature, read without mutating anything.
   *
   * `touch()` is the only other way to observe this, and it bumps as a side
   * effect — which is exactly what a caller trying to decide *whether* a
   * re-render is warranted cannot afford to do. A webview rebuild costs a
   * markdown re-parse plus a full DOM teardown of the transcript, so "did
   * anything change" has to be answerable for free.
   */
  get version(): number { return this.renderVersion }

  /**
   * Set the running flag from the host's own status relay
   * (`api-session/status` on the `$events` stream).
   *
   * The durable `turn/start` / `turn/end` events also flip this, but they lag by
   * a round trip — and they never arrive at all when another client drove the
   * turn, which is exactly when the Stop button must appear.
   */
  setRunning(running: boolean): void {
    if (this.running === running) return
    this.running = running
    this.bump()
  }

  loadHistory(events: SessionEvent[]): void {
    this.items = []
    this.running = false
    this.lastSeq = -1
    this.streaming.clear()
    this.toolIndexByCallId.clear()
    this.changesIndex.clear()
    this.streamingAssistantIdx = -1
    this.lastEndedTurn = -1
    this.finalizedSteps.clear()
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
      case 'workspace/changes': this.applyWorkspaceChanges(event); break
      default: break
    }
  }

  /** Optimistic user echo (still needed — send prompt first, event arrives later). */
  optimisticUserEcho(text: string): void {
    this.items.push(this.stamp({
      kind: 'user',
      seq: this.lastSeq + 0.5,
      text,
    }))
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
      this.items.push(this.stamp({
        kind: 'system',
        seq: event.seq,
        text,
        source: sourceLabel(d.source),
      }))
    } else {
      this.items.push(this.stamp({
        kind: 'user',
        seq: event.seq,
        text,
      }))
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
    // A delta that outlived its turn or its durable message has nowhere to land:
    // it would recreate the buffer the close already dropped and append a second
    // bubble for text the transcript is already showing.
    if (d.turn <= this.lastEndedTurn) return
    const key = `${d.turn}:${d.step}`
    if (this.finalizedSteps.has(key)) return

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
        this.stamp(existing)
        this.bump()
        return
      }
    }
    if (hasContent) {
      const idx = this.items.length
      this.items.push(this.stamp({
        kind: 'assistant',
        seq: -(d.turn * 1000 + d.step),
        text: entry.text,
        reasoning: entry.reasoning || undefined,
        toolCallIds: [],
        streaming: true,
      }))
      this.streamingAssistantIdx = idx
      this.bump()
    }
  }

  private applyAssistantMessage(event: SessionEvent): void {
    const d = event.data as AssistantMessageData
    const key = `${d.turn}:${d.step}`
    this.streaming.delete(key)
    // The durable message is the authority for this step; any delta still in
    // flight for it is a stale echo and must not reopen the buffer.
    this.finalizedSteps.add(key)
    const msg = d.message
    const text = blocksToText(msg.content)
    const reasoning = extractReasoning(msg.content)
    const toolCallIds: string[] = []
    for (const b of msg.content ?? []) {
      if (b && typeof b === 'object' && b.type === 'tool-call' && typeof b.id === 'string') {
        toolCallIds.push(b.id)
      }
    }

    const newItem: ConversationItem = this.stamp({
      kind: 'assistant',
      seq: event.seq,
      text,
      reasoning: reasoning || undefined,
      toolCallIds,
      usage: d.usage,
      streaming: false,
    })

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
    this.items.push(this.stamp({
      kind: 'tool',
      seq: event.seq,
      turn: typeof d.turn === 'number' ? d.turn : undefined,
      callId: d.callId,
      name: d.name,
      arguments: d.arguments,
      result: undefined,
      state: 'running',
    }))
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
        this.stamp(t)
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
    this.items.push(this.stamp({
      kind: 'tool',
      seq: event.seq,
      callId,
      name: d.message.source?.callId?.slice(-6) ?? 'unknown',
      arguments: '',
      result: { text, isError },
      state: isError ? 'error' : 'completed',
    }))
    this.bump()
  }

  private applyTurnStart(event: SessionEvent): void {
    const d = event.data as { turn: number }
    this.running = true
    this.items.push(this.stamp({ kind: 'status', seq: event.seq, text: `Turn ${d.turn} — started`, running: true }))
    this.bump()
  }

  private applyTurnEnd(event: SessionEvent): void {
    const d = event.data as TurnEndData
    this.running = false
    this.streaming.clear()
    this.streamingAssistantIdx = -1
    // Anything still arriving for this turn (or an earlier one) is a late echo.
    this.lastEndedTurn = Math.max(this.lastEndedTurn, d.turn)
    const reason = d.reason?.kind ?? 'unknown'
    this.items.push(this.stamp({ kind: 'status', seq: event.seq, text: `Turn ${d.turn} — ${reason}`, running: false }))
    this.bump()
  }

  private applyTitle(event: SessionEvent): void {
    const d = event.data as { title?: string }
    if (typeof d.title === 'string' && d.title.length > 0 && d.title !== this.title) {
      this.title = d.title
      this.bump()
    }
  }

  /**
   * The Host's end-of-turn record of what the turn changed.
   *
   * One card per turn. A turn may announce more than once — `agent/turn-stopping`
   * records inside the turn and `turn/end` records again when tool results
   * settled after that — and the LATEST announcement owns the coordinate the
   * summary route is addressed by. A repeat therefore REPLACES the card's `seq`
   * and re-asks, rather than stacking a second card on the same turn.
   *
   * Nothing is rendered until the summary arrives: a turn that changed no file
   * never emits the event at all, but an announcement whose summary is gone
   * (disposed Session, restarted Host) resolves to a hidden row rather than an
   * empty card.
   */
  private applyWorkspaceChanges(event: SessionEvent): void {
    const d = event.data as WorkspaceChangesEventData | undefined
    const turn = d?.turn
    if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) return

    const known = this.changesIndex.get(turn)
    if (known !== undefined) {
      const existing = this.items[known]
      if (existing?.kind === 'changes') {
        existing.seq = event.seq
        existing.summary = undefined
        existing.error = undefined
        existing.loading = true
        this.stamp(existing)
        this.bump()
        this.changesRequestHandler?.(turn, event.seq)
        return
      }
    }

    const idx = this.items.length
    this.items.push(this.stamp({
      kind: 'changes',
      seq: event.seq,
      turn,
      loading: true,
    }))
    this.changesIndex.set(turn, idx)
    this.bump()
    this.changesRequestHandler?.(turn, event.seq)
  }

  /**
   * Fill in one turn's changed-files summary, or resolve it to nothing.
   *
   * Called by the controller once the deliverables route answers. A `undefined`
   * summary with no `error` means the Host has no record for this turn (it was
   * disposed, or the Host restarted) — the Web UI shows no card in that case and
   * so does this one, which is why the row is left present-but-empty rather than
   * spliced out (removing an item would invalidate every index the model keeps).
   */
  setChangesSummary(turn: number, summary: ChangesSummary | undefined, error?: string): void {
    const idx = this.changesIndex.get(turn)
    if (idx === undefined) return
    const item = this.items[idx]
    if (item?.kind !== 'changes') return
    item.loading = false
    item.summary = summary
    item.error = error
    this.stamp(item)
    this.bump()
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
