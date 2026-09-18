/**
 * HarnessClient — the single network boundary for the extension.
 *
 * All HTTP and WebSocket access goes through here; the rest of the extension
 * never calls an HTTP client or opens a socket directly (§8).
 *
 * ── Wire contract (DSH 0.1.6-alpha) ─────────────────────────────────────────
 *
 *   POST /api/<namespace>/<method>
 *     Cookie: dsh-auth-<b64url(sha256("<host>:<port>"))>=v1.<payload>.<hmac>
 *     Content-Type: application/json
 *     body: { type:'client-request', rpcId, method:'<namespace>/<method>', payload:{ args:{…} } }
 *     resp: { type:'server-response', rpcId, result:{ ok, value | error } }
 *
 *   WS   /api/remote.mux          (same cookie; 401 refuses the upgrade)
 *     → { type:'open', streamId, endpoint, payload:{ args:{…} } } | { type:'cancel', streamId }
 *     ← { type:'item', streamId, value } | { type:'end', streamId } | { type:'error', streamId, error }
 *
 * Three things changed versus the pre-0.1.6 plugin and they caused the reported
 * 401 on `/api/host.describe`:
 *   1. `/api/*` is cookie-authenticated (see auth.ts).
 *   2. `host.describe` was deleted and endpoints became `ns/method`, not `ns.method`.
 *   3. The event socket moved to `/api/remote.mux` and is now a logical-stream
 *      mux, not a one-way push channel.
 *
 * The client translates the new transport back into the legacy frame shapes the
 * UI layers already understand (`session/event`, `approval/requested`, …), so
 * the conversation model and the approval store stay untouched.
 */

import { randomUUID } from 'node:crypto'
import type { Disposable } from '../disposable.ts'
import { CompositeDisposable } from '../disposable.ts'
import { EventBuffer, muxUrl, RemoteStreamMux, type MuxStatus, type StreamHandle, type StreamHandlers } from './events.ts'
import { HarnessAuthRequiredError, type BrowserSessionAuth } from './auth.ts'
import { httpRequest } from './http.ts'
import {
  APPROVAL_REQUEST_EVENT,
  REMOTE_EVENT_RESULT_ENDPOINT,
  REMOTE_EVENT_STREAM_ENDPOINT,
  sessionAddress,
  type ApprovalOutcome,
  type HarnessInfo,
  type HistoryEntry,
  type ModelCatalog,
  type MuxFrame,
  type RemoteEventDownlinkFrame,
  type RemoteEventInvocationFrame,
  type RemoteStreamFailure,
  type RpcError,
  type SessionAssistantStreamFrame,
  type SessionCreateRequest,
  type SessionCreateValue,
  type SessionFollowFrame,
  type SessionId,
  type SessionPromptRequest,
  type SessionPromptValue,
  type SessionSummary,
  type ServerResponse,
  type StreamChunk,
  type WorkspaceFollowFrame,
  type WorkspaceId,
  type WorkspaceView,
} from './protocol.ts'

/** A typed view onto a business error from the harness. */
export class HarnessRpcError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown) {
    super(message)
    this.name = 'HarnessRpcError'
  }
}

/** Connection states surfaced to the UI. */
export type ConnectionState =
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'connected'; info: HarnessInfo }
  | { kind: 'error'; message: string }

/** Listener for the active session's event stream (already filtered by sessionId). */
export type SessionEventListener = (frame: MuxFrame) => void

/** Listener for approval frames — receives the waterfall eventId for correlation. */
export type ApprovalFrameListener = (frame: MuxFrame, eventId: string) => void

export interface HarnessClientOptions {
  host: string
  port: number
  auth: BrowserSessionAuth
  log: (msg: string) => void
}

/** v0.0.x: only loopback hosts are accepted. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** How long to wait for one opening frame, in milliseconds. */
const OPEN_TIMEOUT_MS = 10_000

/** Records requested for one opening history window. */
const HISTORY_WINDOW = 50

interface FollowState {
  handle: StreamHandle
  buffer: EventBuffer
  cursor: number
  /** Current streaming attempt, carried out-of-band by the assistant stream. */
  attempt: { turn: number; step: number } | undefined
}

export class HarnessClient implements Disposable {
  private readonly disposables = new CompositeDisposable()
  private state: ConnectionState = { kind: 'disconnected' }
  private mux: RemoteStreamMux | undefined
  private eventsStream: StreamHandle | undefined
  private eventClientId: string | undefined
  private readySignal: { resolve: () => void; reject: (e: Error) => void } | undefined
  private info: HarnessInfo | undefined
  /** Active session filter; only frames for this session reach `sessionListeners`. */
  private activeSessionId: SessionId | undefined
  private readonly follow = new Map<SessionId, FollowState>()
  /** Last committed seq seen per session, reused as the `session/page` cut. */
  private readonly cursors = new Map<SessionId, number>()
  private readonly sessionListeners = new Set<SessionEventListener>()
  private readonly approvalListeners = new Set<ApprovalFrameListener>()
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  private readonly muxStatusListeners = new Set<(s: MuxStatus) => void>()

  constructor(private readonly opts: HarnessClientOptions) {}

  // ─── state ──────────────────────────────────────────────────────────────────
  getState(): ConnectionState { return this.state }
  onStateChange(listener: (s: ConnectionState) => void): Disposable {
    this.stateListeners.add(listener)
    return { dispose: () => { this.stateListeners.delete(listener) } }
  }
  onMuxStatusChange(listener: (s: MuxStatus) => void): Disposable {
    this.muxStatusListeners.add(listener)
    return { dispose: () => { this.muxStatusListeners.delete(listener) } }
  }
  /** Register a listener for approval frames (approval/requested, approval/resolved).
   *  The listener receives the waterfall eventId for correlation with `$events/result`. */
  onApprovalFrame(listener: ApprovalFrameListener): Disposable {
    this.approvalListeners.add(listener)
    return { dispose: () => { this.approvalListeners.delete(listener) } }
  }
  private setState(s: ConnectionState): void {
    this.state = s
    for (const l of this.stateListeners) {
      try { l(s) } catch { /* listener errors must not propagate */ }
    }
  }

  /** Retarget after a config change, keeping the same auth owner. */
  retarget(host: string, port: number): void {
    this.opts.host = host
    this.opts.port = port
    this.opts.auth.retarget(host, port)
  }

  // ─── connect / disconnect ───────────────────────────────────────────────────
  /**
   * Validate the host is loopback, verify the browser session, open the mux and
   * wait for the `$events` ready frame — the replacement for the removed
   * `host.describe` probe. Throws on security-boundary violation, missing
   * credentials or an unreachable host.
   */
  async connect(): Promise<void> {
    if (!LOOPBACK_HOSTS.has(this.opts.host)) {
      const msg = 'v0.0.x only supports local DeepSeek Harness instances.'
      this.setState({ kind: 'error', message: msg })
      throw new Error(msg)
    }
    if (this.state.kind === 'connected' || this.state.kind === 'connecting') return
    this.setState({ kind: 'connecting' })
    try {
      await this.opts.auth.init()
      if (!this.opts.auth.isReady()) throw this.authRequired()
      this.info = undefined
      this.eventClientId = undefined
      this.openMux()
      await this.awaitEventsReady()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setState({ kind: 'error', message })
      throw e
    }
    // Provider/model are cosmetic; never fail a connect over them.
    this.setState({ kind: 'connected', info: this.info ?? { home: '' } })
    void this.enrichInfo()
  }

  disconnect(): void {
    for (const f of this.follow.values()) f.buffer.dispose()
    this.follow.clear()
    if (this.eventsStream !== undefined) { this.eventsStream.cancel(); this.eventsStream = undefined }
    if (this.mux !== undefined) { this.mux.dispose(); this.mux = undefined }
    this.activeSessionId = undefined
    this.info = undefined
    this.eventClientId = undefined
    this.readySignal = undefined
    this.setState({ kind: 'disconnected' })
  }

  dispose(): void {
    this.disconnect()
    this.disposables.dispose()
  }

  /** The message shown when the harness refuses us: it names the exact fix. */
  private authRequired(): HarnessAuthRequiredError {
    return new HarnessAuthRequiredError(
      `DeepSeek Harness requires a browser session before it answers /api/* (${this.opts.auth.describeGap()}). `
      + 'Start `dsh web`, then run "DeepSeek Harness: Set Session Token from Launch URL" '
      + 'and paste the line it printed (it looks like `dsh web: http://127.0.0.1:3080/?token=…`).',
    )
  }

  // ─── unary RPCs (the only methods business code may call) ───────────────────
  describe(): HarnessInfo { return this.info ?? { home: '' } }

  /** Workspace list. `workspace/list` is gone; the state arrives as a stream baseline. */
  async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }> {
    const baseline = await this.firstStreamItem<Extract<WorkspaceFollowFrame, { type: 'baseline' }>>(
      'workspace/follow',
      {},
      value => value.type === 'baseline' ? value : undefined,
    )
    return { items: [...baseline.value.items], archivedSessionIds: [...baseline.value.archivedSessionIds] }
  }

  /** Create or idempotently resolve a workspace over an existing directory. */
  createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.rpc('workspace/create', { request: { path } })
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    // The declared parameter is literally named `_request` upstream, and the
    // gateway rejects an args object whose fields do not match the descriptor.
    return this.rpc('session/list', { _request: {} })
  }

  /**
   * Read one opening history window.
   *
   * `session.history` was replaced by `session/page`, which needs an inclusive
   * `throughSeq` cut obtained from a `session/follow` opening frame. So we open
   * a follow stream just far enough to read its snapshot, then cancel it.
   */
  async getHistory(
    sessionId: SessionId,
    opts: { maxMessages?: number } = {},
  ): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    const snapshot = await this.firstStreamItem<Extract<SessionFollowFrame, { type: 'snapshot' }>>(
      'session/follow',
      {
        request: {
          address: sessionAddress(sessionId),
          ...(opts.maxMessages === undefined ? {} : { maxMessages: opts.maxMessages }),
        },
      },
      value => value.type === 'snapshot' ? value : undefined,
    )
    this.cursors.set(sessionId, snapshot.cursor)
    return {
      events: snapshot.records.map((record) => ({ event: record.event, view: record.view })),
      hasMore: snapshot.hasMore,
    }
  }

  createSession(opts: { workspaceId?: WorkspaceId; cwd?: string } = {}): Promise<SessionCreateValue> {
    const request: SessionCreateRequest = {}
    if (opts.workspaceId !== undefined) request.workspaceId = opts.workspaceId
    if (opts.cwd !== undefined) request.cwd = opts.cwd
    return this.rpc('session/create', { request })
  }

  /**
   * Send a text prompt to an existing session (mode 'queue' = normal send).
   *
   * 0.1.6-alpha removed the old `payload.context` escape hatch, so editor
   * metadata can no longer travel beside the message. The controller renders
   * that metadata into the prompt text instead (see `AppController.sendPrompt`).
   */
  prompt(sessionId: SessionId, text: string, clientTimeZone?: string): Promise<SessionPromptValue> {
    const request: SessionPromptRequest = {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
    }
    return this.rpc('session/prompt', { request })
  }

  /** Cancel the session's active turn (preserves pending inbox work). */
  cancel(sessionId: SessionId): Promise<{ accepted: true }> {
    return this.rpc('session/cancel', { request: { sessionId } })
  }

  /**
   * Answer one approval waterfall.
   *
   * `POST /api/respond` is gone: approvals are now agent-scoped Cordis
   * `approval/request` waterfalls forwarded over `$events`, and the answer is a
   * `$events/result` RPC carrying the clientId/eventId pair.
   */
  respondApproval(eventId: string, outcome: ApprovalOutcome): Promise<void> {
    const clientId = this.eventClientId
    if (clientId === undefined) {
      throw new Error('Cannot answer an approval before the event stream is ready.')
    }
    return this.rpc<undefined>(REMOTE_EVENT_RESULT_ENDPOINT, {
      clientId,
      eventId,
      outcome: { kind: 'result', value: outcome },
    })
  }

  // ─── event subscription ─────────────────────────────────────────────────────
  /**
   * Subscribe to `sessionId`. Frames for other sessions are dropped.
   *
   * Durable events arrive as `session/event` frames (unchanged shape), while
   * assistant deltas — which 0.1.6-alpha moved out of the durable log into the
   * process-local assistant stream — arrive as `assistant/stream` frames.
   * The buffer coalesces high-frequency frames; `onFlush` receives batches.
   */
  subscribe(sessionId: SessionId, onFlush: (frames: MuxFrame[]) => void, opts: { flushMs?: number } = {}): Disposable {
    this.activeSessionId = sessionId
    const previous = this.follow.get(sessionId)
    if (previous !== undefined) { previous.handle.cancel(); previous.buffer.dispose() }

    this.openMux()
    const buffer = new EventBuffer((batch) => onFlush(batch as MuxFrame[]), opts.flushMs ?? 30)
    const state: FollowState = {
      handle: undefined as unknown as StreamHandle,
      buffer,
      cursor: this.cursors.get(sessionId) ?? -1,
      attempt: undefined,
    }

    const handler = (frame: SessionFollowFrame): void => {
      if (frame.type === 'snapshot') {
        state.cursor = frame.cursor
        this.cursors.set(sessionId, frame.cursor)
        const attempt = frame.assistantStream?.activeAttempt
        state.attempt = attempt === undefined ? undefined : { turn: attempt.turn, step: attempt.step }
        // Replaying the snapshot is safe: ConversationModel.applyEvent drops any
        // event whose seq it already applied, and replay recovers whatever
        // happened while the socket was down.
        for (const record of frame.records) {
          buffer.push({ type: 'session/event', sessionId, event: record.event, view: record.view })
        }
        buffer.push({ type: 'session/subscribed', sessionId, lastSeq: frame.cursor })
        buffer.flushNow()
        return
      }
      if (frame.type === 'assistant-stream') {
        this.applyAssistantStream(sessionId, state, frame.frame)
        return
      }
      // A durable event entry.
      buffer.push({ type: 'session/event', sessionId, event: frame.event, view: frame.view })
      if (frame.event.type === 'turn/end' || frame.event.type === 'assistant/message') {
        state.attempt = undefined
        buffer.flushNow()
      }
    }

    const handlers: StreamHandlers = {
      onItem: (value) => { handler(value as SessionFollowFrame) },
      onError: (error) => { this.failSession(sessionId, error) },
      onEnd: () => { this.failSession(sessionId, { code: 'stream/ended', message: 'session/follow ended unexpectedly', details: {} }) },
      onReopen: () => {
        this.opts.log(`session/follow ${sessionId} reopened`)
        for (const l of this.sessionListeners) {
          try { l({ type: 'mux/reopened', sessionId }) } catch { /* noop */ }
        }
      },
    }

    const mux = this.mux
    if (mux === undefined) throw new Error('mux is not open')
    state.handle = mux.request(
      'session/follow',
      { request: { address: sessionAddress(sessionId), maxMessages: HISTORY_WINDOW, assistantStream: true } },
      handlers,
    )
    this.follow.set(sessionId, state)

    return {
      dispose: () => {
        const current = this.follow.get(sessionId)
        if (current !== state) return
        state.handle.cancel()
        state.buffer.dispose()
        this.follow.delete(sessionId)
        if (this.activeSessionId === sessionId) this.activeSessionId = undefined
      },
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────
  private async rpc<V>(endpoint: string, args: Record<string, unknown>): Promise<V> {
    if (!LOOPBACK_HOSTS.has(this.opts.host)) {
      throw new Error('v0.0.1 only supports local DeepSeek Harness instances.')
    }
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    if (cookie === undefined) throw this.authRequired()
    const origin = `http://${this.opts.host}:${String(this.opts.port)}`
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args },
    })
    let res
    try {
      res = await httpRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'POST',
        path: `/api/${endpoint}`,
        headers: { cookie, origin },
        body,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot reach dsh web at ${this.opts.host}:${String(this.opts.port)} — ${message}`)
    }
    if (res.status === 401) throw this.authRequired()
    if (res.status === 404) {
      throw new Error(
        `HTTP 404 on /api/${endpoint} — the running harness does not expose that endpoint. `
        + 'This plugin targets DSH 0.1.6-alpha or newer.',
      )
    }
    if (res.status !== 200) {
      throw new Error(`HTTP ${String(res.status)} on /api/${endpoint}: ${res.body.trim().slice(0, 200)}`)
    }
    let env: ServerResponse<V>
    try {
      env = JSON.parse(res.body) as ServerResponse<V>
    } catch {
      throw new Error(`Harness returned a non-JSON body on /api/${endpoint}.`)
    }
    if (!env.result.ok) {
      const err = env.result.error as RpcError
      throw new HarnessRpcError(err.code, err.message, err.details)
    }
    return env.result.value
  }

  /** Open `$events` and wait for its ready frame. */
  private async awaitEventsReady(): Promise<void> {
    const mux = this.mux
    if (mux === undefined) throw new Error('mux is not open')
    const ready = new Promise<void>((resolve, reject) => {
      this.readySignal = { resolve, reject }
    })
    this.eventsStream = mux.request(REMOTE_EVENT_STREAM_ENDPOINT, {}, {
      onItem: (value) => { this.onEventFrame(value) },
      onError: (error) => { this.failReady(new Error(`$events failed: ${error.code} — ${error.message}`)) },
      onEnd: () => { this.failReady(new Error('$events ended unexpectedly.')) },
      onReopen: () => { this.opts.log('events: reopened after reconnect') },
    })
    const timer = setTimeout(() => {
      this.failReady(new Error('Timed out waiting for the harness event stream to become ready.'))
    }, OPEN_TIMEOUT_MS)
    try {
      await ready
    } finally {
      clearTimeout(timer)
      this.readySignal = undefined
    }
  }

  private failReady(error: Error): void {
    this.readySignal?.reject(error)
  }

  private onEventFrame(value: unknown): void {
    const frame = value as RemoteEventDownlinkFrame | undefined
    if (frame === null || typeof frame !== 'object') return
    switch (frame.type) {
      case 'ready':
        this.eventClientId = frame.clientId
        this.info = { home: frame.host.home, clientId: frame.clientId }
        this.opts.log(`events: ready (clientId=${frame.clientId}, home=${frame.host.home})`)
        this.readySignal?.resolve()
        return
      case 'waterfall':
        this.onWaterfall(frame)
        return
      case 'cancel':
        this.notifyApproval(
          { type: 'approval/resolved', approvalId: frame.eventId, outcome: 'cancelled' },
          frame.eventId,
        )
        return
      case 'emit':
        // Session-flow events travel on the dedicated `session/follow` stream.
        return
      default:
        return
    }
  }

  private onWaterfall(frame: RemoteEventInvocationFrame): void {
    if (frame.event !== APPROVAL_REQUEST_EVENT) {
      // `user-questions/request` shares the waterfall mechanism, but the VS Code
      // sidebar cannot render a question form. We deliberately leave that
      // delivery pending so another answerer (the web UI) can still settle it —
      // the Host resolves on the first answer, so answering `next` here would
      // wrongly pre-empt it.
      this.opts.log(`events: unhandled waterfall ${frame.event} (eventId=${frame.eventId})`)
      return
    }
    const request = frame.request as { toolName?: unknown; callId?: unknown; reason?: unknown }
    // The Host projects a scoped event's Agent identity into `agentId`, and the
    // gateway derives that from `agent.id` — which IS the SessionId.
    this.notifyApproval({
      type: 'approval/requested',
      sessionId: frame.agentId,
      approvalId: frame.eventId,
      toolName: typeof request.toolName === 'string' ? request.toolName : 'unknown',
      ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
      ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
    }, frame.eventId)
  }

  private notifyApproval(frame: MuxFrame, eventId: string): void {
    for (const l of this.approvalListeners) {
      try { l(frame, eventId) } catch { /* listener errors must not break the stream */ }
    }
  }

  /** Translate one assistant-stream frame into the UI's legacy chunk shape. */
  private applyAssistantStream(sessionId: SessionId, state: FollowState, frame: SessionAssistantStreamFrame): void {
    switch (frame.type) {
      case 'start':
        state.attempt = { turn: frame.turn, step: frame.step }
        return
      case 'chunk': {
        const attempt = state.attempt
        if (attempt === undefined) return
        const chunk = frame.chunk as StreamChunk
        state.buffer.push({ type: 'assistant/stream', sessionId, turn: attempt.turn, step: attempt.step, chunk })
        if (chunk.type === 'finish') state.buffer.flushNow()
        return
      }
      case 'end':
        state.attempt = undefined
        state.buffer.flushNow()
        return
      default:
        return
    }
  }

  private failSession(sessionId: SessionId, error: RemoteStreamFailure): void {
    this.opts.log(`session/follow ${sessionId} failed: ${error.code} — ${error.message}`)
    for (const l of this.sessionListeners) {
      try {
        l({ type: 'stream/error', error: { code: error.code, message: error.message, details: error.details } })
      } catch { /* noop */ }
    }
  }

  /**
   * Open a logical stream, keep only the first item matching `pick`, then cancel.
   * Used for the stream-shaped replacements of deleted unary RPCs.
   */
  private async firstStreamItem<T>(
    endpoint: string,
    args: Record<string, unknown>,
    pick: (value: SessionFollowFrame | WorkspaceFollowFrame) => T | undefined,
  ): Promise<T> {
    this.openMux()
    const mux = this.mux
    if (mux === undefined) throw new Error('mux is not open')
    return await new Promise<T>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        clearTimeout(timer)
        handle.cancel()
        fn()
      }
      const timer = setTimeout(() => {
        finish(() => { reject(new Error(`${endpoint} produced no opening frame in time.`)) })
      }, OPEN_TIMEOUT_MS)
      const handle = mux.request(endpoint, args, {
        onItem: (value) => {
          const picked = pick(value as SessionFollowFrame | WorkspaceFollowFrame)
          if (picked === undefined) return
          finish(() => { resolve(picked) })
        },
        onError: (error) => { finish(() => { reject(new Error(`${endpoint} failed: ${error.code} — ${error.message}`)) }) },
        onEnd: () => { finish(() => { reject(new Error(`${endpoint} ended before producing a frame.`)) }) },
      })
    })
  }

  private openMux(): void {
    if (this.mux === undefined) {
      this.mux = new RemoteStreamMux({
        url: () => muxUrl(this.opts.host, this.opts.port),
        headers: () => {
          const origin = `http://${this.opts.host}:${String(this.opts.port)}`
          const cookie = this.opts.auth.cookieHeader()
          const headers: Record<string, string> = { origin }
          if (cookie !== undefined) headers['cookie'] = cookie
          return headers
        },
        onStatus: (s) => {
          this.opts.log(`mux ${s.kind}${'reason' in s ? `: ${s.reason}` : ''}${'message' in s ? `: ${s.message}` : ''}`)
          for (const l of this.muxStatusListeners) {
            try { l(s) } catch { /* noop */ }
          }
        },
        log: this.opts.log,
      })
    }
    this.mux.open()
  }

  /** Best-effort host identity for the UI header (never throws). */
  private async enrichInfo(): Promise<void> {
    try {
      const catalog = await this.rpc<ModelCatalog>('session/modelCatalog', {})
      if (this.state.kind !== 'connected') return
      const info: HarnessInfo = {
        ...this.state.info,
        provider: catalog.default.provider,
        model: catalog.default.model,
      }
      this.info = info
      this.setState({ kind: 'connected', info })
    } catch (e) {
      this.opts.log(`modelCatalog: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
