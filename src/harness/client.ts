/**
 * HarnessClient — the single network boundary for the extension.
 *
 * All HTTP and WebSocket access goes through here; the rest of the extension
 * never calls an HTTP client or opens a socket directly (§8).
 *
 * ── Wire contract (DSH 0.1.0-rc.6, the runtime actually installed) ──────────
 *
 *   POST /api/<namespace>.<method>        (dot-style endpoint; slash on older hosts)
 *     Content-Type: application/json
 *     body: { type:'client-request', rpcId, method:'<ns>.<method>', payload:<args> }
 *                                            ^ payload is the args object DIRECTLY,
 *                                              never wrapped in {args}/{request}.
 *     resp: { type:'server-response', rpcId, result:{ ok, value | error } }
 *
 *   WS   ws://host:port/api/events.mux    (downlink-only; single WebSocket)
 *     → server-request envelopes; each frame is envelope.payload.
 *     There is NO `ready` frame — connection-open IS the ready signal. The
 *     client never sends anything on this socket.
 *   WS   ws://host:port/api/events.host   (host-wide frames; opened but unused here)
 *
 *   POST /api/respond                     (to settle an approval waterfall)
 *     body: { type:'client-response', rpcId, result:{ sessionId, approvalId, outcome } }
 *
 * rc.6 has NO cookie authentication on /api/* — every unary call and the mux
 * WebSocket succeed unauthenticated. (The autoSession cookie machinery is kept
 * for hosts that do gate, and degrades gracefully when they don't.)
 *
 * The transport here was rewritten from a fictional 0.1.6-alpha model (which
 * invented logical-stream muxes, a `ready` frame, `session/follow` streams and a
 * `$events/result` RPC) to the real rc.6 model above. The UI layers consume the
 * same `MuxFrame` union, so only this file (plus protocol/events/wire) changed.
 */

import { randomUUID } from 'node:crypto'
import type { Disposable } from '../disposable.ts'
import { CompositeDisposable } from '../disposable.ts'
import {
  DownlinkSocket, EventBuffer, muxUrl, type MuxStatus,
} from './events.ts'
import { HarnessAuthRequiredError, type BrowserSessionAuth } from './auth.ts'
import { httpRequest } from './http.ts'
import {
  defaultWireProfile, isShapeRejection, negotiateWire, wireEndpoint, type WireProfile,
} from './wire.ts'
import {
  type ApprovalOutcome,
  type ApprovalRespondRequest,
  type ClientResponse,
  type HarnessInfo,
  type HistoryEntry,
  type HostDescribeValue,
  type MuxFrame,
  type RpcError,
  type ServerResponse,
  type SessionCreateValue,
  type SessionForkValue,
  type SessionId,
  type SessionListValue,
  type SessionPromptValue,
  type SessionRenameValue,
  type SessionSummary,
  type SessionHistoryValue,
  type WorkspaceCreateValue,
  type WorkspaceId,
  type WorkspaceListValue,
  type WorkspaceView,
} from './protocol.ts'

/** A typed view onto a business error from the harness. */
export class HarnessRpcError extends Error {
  constructor(public readonly code: string, message: string, public readonly details: unknown) {
    super(message)
    this.name = 'HarnessRpcError'
  }
}

/**
 * Thrown when the running harness does not serve a control-surface method.
 *
 * The message is written for users: it names what is missing and says the fix
 * is upstream (a newer host), because nothing in this plugin can conjure an
 * endpoint the host does not have.
 */
export class HarnessUnsupportedError extends Error {
  constructor(canonicalMethod: string, served: string) {
    super(
      `This harness does not serve \`${served}\` (\`${canonicalMethod}\`), so that control is unavailable. `
      + 'It is provided by newer DeepSeek Harness builds — upgrade the host, or use the Web UI.',
    )
    this.name = 'HarnessUnsupportedError'
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

/** Listener for approval frames — receives a correlation id (the approvalId). */
export type ApprovalFrameListener = (frame: MuxFrame, eventId: string) => void

export interface HarnessClientOptions {
  host: string
  port: number
  auth: BrowserSessionAuth
  log: (msg: string) => void
}

/** v0.0.x: only loopback hosts are accepted. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** How long to wait for the mux socket to open, in milliseconds. */
const OPEN_TIMEOUT_MS = 10_000

/** One active session subscription. */
interface ActiveSink {
  sessionId: SessionId
  buffer: EventBuffer
}

export class HarnessClient implements Disposable {
  private readonly disposables = new CompositeDisposable()
  private state: ConnectionState = { kind: 'disconnected' }
  private mux: DownlinkSocket<MuxFrame> | undefined
  private muxOpened = false
  private muxOpenSignal: { resolve: () => void; reject: (e: Error) => void } | undefined
  private info: HarnessInfo | undefined
  /** Negotiated wire shape; `undefined` until the first successful connect. */
  private profile: WireProfile | undefined
  /** Active session filter; only frames for this session reach `sessionListeners`. */
  private activeSessionId: SessionId | undefined
  private activeSink: ActiveSink | undefined
  /** Observed approval/requested frames, keyed by approvalId, for later respond. */
  private readonly approvalFrames = new Map<string, Extract<MuxFrame, { type: 'approval/requested' }>>()
  private readonly sessionListeners = new Set<SessionEventListener>()
  private readonly approvalListeners = new Set<ApprovalFrameListener>()
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  private readonly muxStatusListeners = new Set<(s: MuxStatus) => void>()
  /** Index of the `{args}` spelling that worked, per canonical method. */
  private readonly argShapes = new Map<string, number>()

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
   *  The listener receives the frame plus a correlation id (the approvalId) so the
   *  controller can tie the answer back to a tool call. */
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
   * Validate the host is loopback, negotiate the wire shape, open the downlink
   * mux socket (open = ready, no `ready` frame), then call `host.describe` once
   * to learn the host identity. Throws on a security-boundary violation, missing
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
      // No paste required when the harness's own credential store is readable:
      // minting there is permission-equivalent to reading the file at all. On
      // rc.6 (no cookie auth) this is a harmless no-op.
      if (!this.opts.auth.isReady()) await this.opts.auth.tryMintLocalSession()

      // Never assume the wire shape — discover it. Endpoint style, cookie
      // gating and the event-socket path have all drifted between releases.
      const negotiation = await negotiateWire({
        host: this.opts.host,
        port: this.opts.port,
        cookie: () => this.opts.auth.cookieHeader(),
        log: this.opts.log,
      })
      if (negotiation.kind === 'auth-required') throw this.authRequired()
      if (negotiation.kind === 'unreachable') throw new Error(negotiation.message)
      this.profile = negotiation.profile
      this.opts.log(
        `wire: style=${negotiation.profile.endpointStyle} auth=${negotiation.profile.auth} `
        + `mux=${negotiation.profile.muxPath}`,
      )

      this.info = undefined
      this.muxOpened = false
      this.muxOpenSignal = undefined
      this.openMux()
      await this.awaitMuxOpen()
      // Best-effort host identity; connect succeeds regardless.
      await this.hostDescribe()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setState({ kind: 'error', message })
      throw e
    }
    this.setState({ kind: 'connected', info: this.info ?? { home: '' } })
  }

  disconnect(): void {
    this.activeSink?.buffer.dispose()
    this.activeSink = undefined
    if (this.mux !== undefined) { this.mux.close(); this.mux = undefined }
    this.approvalFrames.clear()
    this.info = undefined
    this.activeSessionId = undefined
    this.muxOpened = false
    this.muxOpenSignal = undefined
    this.setState({ kind: 'disconnected' })
  }

  dispose(): void {
    this.disconnect()
    this.disposables.dispose()
  }

  /** The message shown when the harness refuses us: it names the exact fix. */
  private authRequired(): HarnessAuthRequiredError {
    // Only meaningful when we *did* send a cookie: that means the host rejected
    // its signature rather than missing it, and the wording should say so.
    this.opts.auth.noteRejected()
    return new HarnessAuthRequiredError(
      `DeepSeek Harness requires a browser session before it answers /api/* (${this.opts.auth.describeGap()}). `
      + 'Start `dsh web`, then run "DeepSeek Harness: Set Session Token from Launch URL" '
      + 'and paste the line it printed (it looks like `dsh web: http://127.0.0.1:3080/?token=…`).',
    )
  }

  // ─── unary RPCs (the only methods business code may call) ───────────────────
  describe(): HarnessInfo { return this.info ?? { home: '' } }

  /** Workspace list — `workspace.list` unary RPC, flat `{}` payload in rc.6. */
  async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }> {
    const value = await this.rpc<WorkspaceListValue>('workspace/list', {})
    return { items: [...value.items], archivedSessionIds: [...value.archivedSessionIds] }
  }

  /** Create or idempotently resolve a workspace over an existing directory. */
  createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.rpc<WorkspaceCreateValue>('workspace/create', { path })
      .then(value => ({ workspace: value.workspace, created: value.created }))
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    // The declared parameter shape has shipped with several spellings; negotiation
    // recorded the one this host takes (empty `{}` for rc.6).
    return this.rpc<SessionListValue>('session/list', this.profile?.listArgs ?? {})
      .then(value => ({ items: [...value.items] }))
  }

  /**
   * Read one opening history window. `session.history` is a unary RPC in rc.6:
   * POST /api/session.history with `{ sessionId, maxMessages? }`.
   */
  async getHistory(
    sessionId: SessionId,
    opts: { maxMessages?: number } = {},
  ): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    const value = await this.rpc<SessionHistoryValue>('session/history', {
      sessionId,
      ...(opts.maxMessages === undefined ? {} : { maxMessages: opts.maxMessages }),
    })
    return { events: value.events as HistoryEntry[], hasMore: value.hasMore }
  }

  createSession(opts: { workspaceId?: WorkspaceId; cwd?: string } = {}): Promise<SessionCreateValue> {
    const request: Record<string, unknown> = {}
    if (opts.workspaceId !== undefined) request.workspaceId = opts.workspaceId
    if (opts.cwd !== undefined) request.cwd = opts.cwd
    return this.rpc<SessionCreateValue>('session/create', request)
  }

  /**
   * Send a text prompt to an existing session (mode 'queue' = normal send).
   *
   * rc.6 dropped the old `payload.context` escape hatch, so editor metadata can
   * no longer travel beside the message. The controller renders that metadata
   * into the prompt text instead (see `AppController.sendPrompt`).
   */
  prompt(sessionId: SessionId, text: string, clientTimeZone?: string): Promise<SessionPromptValue> {
    const request: Record<string, unknown> = {
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }
    if (clientTimeZone !== undefined) request.clientTimeZone = clientTimeZone
    return this.rpc<SessionPromptValue>('session/prompt', request)
  }

  /** Cancel the session's active turn (preserves pending inbox work). */
  cancel(sessionId: SessionId): Promise<{ accepted: true }> {
    return this.rpc('session/cancel', { sessionId })
  }

  // ─── control surface ───────────────────────────────────────────────────────
  /**
   * The control-surface methods this host serves, keyed by canonical
   * `ns/method`. An absent key means "probed and missing", never "unknown".
   */
  capabilities(): Readonly<Record<string, boolean>> {
    return this.profile?.capabilities ?? {}
  }

  /** Whether `canonicalMethod` was discovered to exist on the running host. */
  supports(canonicalMethod: string): boolean {
    return this.profile?.capabilities[canonicalMethod] === true
  }

  /**
   * Execute one slash-command line against a session's agent.
   *
   * Upstream routes the control-plane writes through the command registry
   * (`/plan`, `/permission <preset>`, `/goal …`, `/compact`), so this is the one
   * write path shared by every control. When the running host does not serve
   * `session/command` (rc.6 does not), `requireControl` throws and the caller
   * surfaces a friendly "upgrade the host" notice.
   */
  runCommand(sessionId: SessionId, line: string): Promise<{ matched?: boolean }> {
    this.requireControl('session/command')
    const text = line.startsWith('/') ? line : `/${line}`
    return this.rpcVariants<{ matched?: boolean }>('session/command', [
      { request: { sessionId, line: text } },
      { sessionId, line: text },
      { request: { line: text } },
      { line: text },
    ])
  }

  /** Switch permission preset (`/permission <preset>`), e.g. `workspace-write`. */
  setPermissionPreset(sessionId: SessionId, preset: string): Promise<{ matched?: boolean }> {
    return this.runCommand(sessionId, `/permission ${preset}`)
  }

  /** Flip plan mode (`/plan`), which toggles the host's wanted state. */
  togglePlanMode(sessionId: SessionId): Promise<{ matched?: boolean }> {
    return this.runCommand(sessionId, '/plan')
  }

  /** Request context compaction (`/compact`). */
  compactSession(sessionId: SessionId): Promise<{ matched?: boolean }> {
    return this.runCommand(sessionId, '/compact')
  }

  /**
   * Fork a session from a completed-turn prefix. rc.6 serves `session.fork`
   * (`{ sessionId, atSeq? }`); `increaseTitle` is tolerated and stripped.
   */
  forkSession(sessionId: SessionId, opts: { atSeq?: number } = {}): Promise<SessionId> {
    this.requireControl('session/fork')
    const base = opts.atSeq === undefined ? { sessionId } : { sessionId, atSeq: opts.atSeq }
    return this.rpcVariants<SessionForkValue>('session/fork', [
      { request: { ...base, increaseTitle: true } },
      { request: base },
      { ...base, increaseTitle: true },
      base,
    ]).then(value => value.sessionId)
  }

  /** Rename the session, pinning its title against automatic regeneration. */
  renameSession(sessionId: SessionId, title: string): Promise<{ title: string; seq?: number }> {
    this.requireControl('session/rename')
    return this.rpcVariants<SessionRenameValue>('session/rename', [
      { request: { sessionId, title } },
      { sessionId, title },
      { request: { title } },
      { title },
    ])
  }

  /** Select the model (and optionally the provider) for future turns. */
  selectModel(sessionId: SessionId, model: string, provider?: string): Promise<unknown> {
    this.requireControl('session/selectModel')
    const base = provider === undefined ? { sessionId, model } : { sessionId, model, provider }
    return this.rpcVariants<unknown>('session/selectModel', [
      { request: base },
      base,
    ])
  }

  /** Archive the session out of the active workspace list. */
  archiveSession(sessionId: SessionId): Promise<unknown> {
    this.requireControl('workspace/archiveSession')
    return this.rpcVariants<unknown>('workspace/archiveSession', [
      { request: { sessionId } },
      { sessionId },
    ])
  }

  /**
   * Answer one approval waterfall. The `approval/requested` frame (seen on the
   * mux) carries `sessionId` + `approvalId`; we POST them to `/api/respond` in a
   * `client-response` envelope.
   */
  respondApproval(eventId: string, outcome: ApprovalOutcome): Promise<void> {
    const frame = this.approvalFrames.get(eventId)
    if (frame === undefined) {
      throw new Error(
        `Cannot resolve approval ${eventId}: no matching approval/requested frame was observed for this session.`,
      )
    }
    const payload: ApprovalRespondRequest = {
      sessionId: frame.sessionId,
      approvalId: frame.approvalId,
      outcome: outcome === 'allowed-once' ? 'allowed-once' : 'rejected',
    }
    return this.respond(payload)
  }

  // ─── event subscription ─────────────────────────────────────────────────────
  /**
   * Subscribe to `sessionId`. Frames for other sessions are dropped. Durable
   * events arrive as `session/event` frames; assistant streaming deltas arrive
   * as `session/event` frames with `event.type === 'assistant/chunk'` — both are
   * delivered to the conversation model unchanged. The buffer coalesces
   * high-frequency frames; `onFlush` receives batches.
   */
  subscribe(
    sessionId: SessionId,
    onFlush: (frames: MuxFrame[]) => void,
    opts: { flushMs?: number } = {},
  ): Disposable {
    this.activeSessionId = sessionId
    this.openMux()
    const buffer = new EventBuffer((batch) => onFlush(batch as MuxFrame[]), opts.flushMs ?? 30)
    const sink: ActiveSink = { sessionId, buffer }
    const previous = this.activeSink
    if (previous !== undefined) previous.buffer.dispose()
    this.activeSink = sink
    return {
      dispose: () => {
        if (this.activeSink !== sink) return
        sink.buffer.dispose()
        this.activeSink = undefined
        if (this.activeSessionId === sessionId) this.activeSessionId = undefined
      },
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────
  /** Render one canonically-written `ns/method` in the negotiated style. */
  private ep(method: string): string {
    return wireEndpoint(this.profile?.endpointStyle ?? 'dot', method)
  }

  /** Fail fast, with actionable wording, when the host lacks a control method. */
  private requireControl(canonicalMethod: string): void {
    // No profile means we never negotiated (unit tests, pre-connect): let the
    // call run so the real answer decides.
    if (this.profile === undefined) return
    if (!this.supports(canonicalMethod)) {
      throw new HarnessUnsupportedError(canonicalMethod, this.ep(canonicalMethod))
    }
  }

  /**
   * Call a control-surface method, tolerating the several `{args}` spellings
   * upstream has shipped (`request`, `_request`, bare fields, none).
   *
   * A business error whose code says "your arguments do not match my declared
   * parameters" proves the endpoint EXISTS — so it advances to the next
   * spelling instead of failing. Anything else is a real failure and throws.
   * The winning SPELLING is remembered per method — never the argument VALUES:
   * two calls to `session/command` carry different lines, so caching the object
   * itself would silently replay the first call's payload forever. The follow-up
   * call then costs exactly one round trip.
   */
  private async rpcVariants<V>(
    canonicalMethod: string,
    variants: readonly Record<string, unknown>[],
  ): Promise<V> {
    const remembered = this.argShapes.get(canonicalMethod)
    const indexed = variants.map((args, index) => ({ args, index }))
    const winner = remembered === undefined ? undefined : indexed[remembered]
    const order = winner === undefined
      ? indexed
      // Try remembered spelling first, then everything it is not — without
      // excluding it, a warm call would attempt the same shape twice.
      : [winner, ...indexed.filter(v => v.index !== remembered)]
    let last: unknown
    for (const { args, index } of order) {
      try {
        const value = await this.rpc<V>(canonicalMethod, args)
        this.argShapes.set(canonicalMethod, index)
        return value
      } catch (e) {
        if (e instanceof HarnessRpcError && isShapeRejection(e.code)) { last = e; continue }
        throw e
      }
    }
    throw last instanceof Error
      ? last
      : new Error(`${canonicalMethod}: the host accepted none of the known argument shapes.`)
  }

  private async rpc<V>(method: string, args: Record<string, unknown>): Promise<V> {
    if (!LOOPBACK_HOSTS.has(this.opts.host)) {
      throw new Error(`Refusing to talk to non-loopback host ${this.opts.host}: this plugin only drives a local DeepSeek Harness.`)
    }
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    // Only a cookie-gated host actually needs one; rc.6 serves /api/* unauthenticated.
    if (cookie === undefined && (this.profile?.auth ?? 'cookie') === 'cookie') throw this.authRequired()
    const endpoint = this.ep(method)
    const origin = `http://${this.opts.host}:${String(this.opts.port)}`
    // rc.6: payload is the args object DIRECTLY — no {args}/{request} wrapper.
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: args,
    })
    let res
    try {
      res = await httpRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'POST',
        path: `/api/${endpoint}`,
        headers: { ...(cookie === undefined ? {} : { cookie }), origin },
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
        + `Negotiated wire style is "${this.profile?.endpointStyle ?? 'dot'}"; the host may be a different release.`,
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

  /** POST a `client-response` to /api/respond to settle an approval. */
  private async respond(payload: ApprovalRespondRequest): Promise<void> {
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    const origin = `http://${this.opts.host}:${String(this.opts.port)}`
    const body = JSON.stringify({
      type: 'client-response',
      rpcId: randomUUID(),
      result: payload,
    } as ClientResponse<ApprovalRespondRequest>)
    try {
      await httpRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'POST',
        path: '/api/respond',
        headers: { ...(cookie === undefined ? {} : { cookie }), origin },
        body,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot reach dsh web at ${this.opts.host}:${String(this.opts.port)} — ${message}`)
    }
  }

  /** Learn host identity from `host.describe` (called once, after the mux opens). */
  private async hostDescribe(): Promise<void> {
    try {
      const d = await this.rpc<HostDescribeValue>('host/describe', {})
      this.info = {
        home: d.cwd,
        version: d.version,
        provider: d.provider,
        model: d.model,
      }
      this.opts.log(`host.describe: version=${d.version} cwd=${d.cwd} provider=${d.provider ?? '?'} model=${d.model ?? '?'}`)
    } catch (e) {
      this.opts.log(`host.describe: ${e instanceof Error ? e.message : String(e)}`)
      this.info = this.info ?? { home: '' }
    }
  }

  // ─── downlink mux frame dispatch ────────────────────────────────────────────
  /** One decoded mux frame: route approvals to approval listeners, session frames to the active sink. */
  private onMuxFrame(frame: MuxFrame): void {
    // MuxFrame is an open union (catch-all member with `type: string`), so discriminant
    // narrowing does not exclude the catch-all; cast at the field-access sites.
    const f = frame as { type: string; [k: string]: unknown }
    switch (f.type) {
      case 'approval/requested': {
        const af = frame as Extract<MuxFrame, { type: 'approval/requested' }>
        this.approvalFrames.set(af.approvalId, af)
        this.notifyApproval(af, af.approvalId)
        return
      }
      case 'approval/resolved': {
        const af = frame as Extract<MuxFrame, { type: 'approval/resolved' }>
        this.notifyApproval(af, af.approvalId)
        return
      }
      case 'question/requested': {
        this.notifyApproval(frame, 'question')
        return
      }
      case 'question/resolved': {
        const qf = frame as Extract<MuxFrame, { type: 'question/resolved' }>
        this.notifyApproval(qf, qf.questionRpcId)
        return
      }
      case 'stream/error': {
        this.activeSink?.buffer.push(frame)
        return
      }
    }
    // Session-scoped frames: deliver to the active sink only when it matches.
    if (
      this.activeSink !== undefined
      && f.type.startsWith('session/')
      && typeof f.sessionId === 'string'
      && f.sessionId === this.activeSink.sessionId
    ) {
      this.activeSink.buffer.push(frame)
    }
  }

  private notifyApproval(frame: MuxFrame, eventId: string): void {
    for (const l of this.approvalListeners) {
      try { l(frame, eventId) } catch { /* listener errors must not break the stream */ }
    }
  }

  // ─── downlink mux lifecycle ─────────────────────────────────────────────────
  private openMux(): void {
    if (this.mux === undefined) {
      this.mux = new DownlinkSocket<MuxFrame>({
        url: () => muxUrl(this.opts.host, this.opts.port, this.profile?.muxPath ?? defaultWireProfile().muxPath),
        headers: () => {
          const origin = `http://${this.opts.host}:${String(this.opts.port)}`
          const cookie = this.opts.auth.cookieHeader()
          const headers: Record<string, string> = { origin }
          if (cookie !== undefined) headers['cookie'] = cookie
          return headers
        },
        onFrame: (frame) => { this.onMuxFrame(frame) },
        onStatus: (s) => { this.onMuxStatus(s) },
        log: this.opts.log,
      })
    }
    this.mux.open()
  }

  private onMuxStatus(s: MuxStatus): void {
    if (s.kind === 'open' && !this.muxOpened) {
      this.muxOpened = true
      this.muxOpenSignal?.resolve()
      this.muxOpenSignal = undefined
    }
    if ((s.kind === 'error' || s.kind === 'closed') && !this.muxOpened) {
      const detail = 'reason' in s ? `: ${s.reason}` : 'message' in s ? `: ${s.message}` : ''
      this.muxOpenSignal?.reject(new Error(`mux socket ${s.kind}${detail}`))
      this.muxOpenSignal = undefined
    }
    for (const l of this.muxStatusListeners) {
      try { l(s) } catch { /* noop */ }
    }
  }

  /** Resolve once the mux socket reports open; the ready signal for rc.6. */
  private awaitMuxOpen(): Promise<void> {
    const mux = this.mux
    if (mux === undefined) return Promise.reject(new Error('mux is not open'))
    if (mux.getStatus().kind === 'open') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.muxOpenSignal = undefined
        reject(new Error(`Timed out waiting for the harness event socket to open (${OPEN_TIMEOUT_MS}ms).`))
      }, OPEN_TIMEOUT_MS)
      this.muxOpenSignal = {
        resolve: () => { clearTimeout(timer); resolve() },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
    })
  }
}
