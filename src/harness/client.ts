/**
 * HarnessClient — the single network boundary for the extension.
 *
 * All HTTP and WebSocket access goes through here; the rest of the extension
 * never calls an HTTP client or opens a socket directly (§8).
 *
 * ── Wire contract (DSH 0.2.0-rc.2, the runtime installed on this machine) ──────
 *
 *   POST /api/<namespace>/<method>        (slash-style endpoint)
 *     Content-Type: application/json
 *     body: { type:'client-request', rpcId, method:'<ns>/<method>',
 *             payload: { args: <inner> } }
 *                                            ^ payload is always { args: … },
 *                                              and <inner> is keyed by the Typert
 *                                              parameter wire name: `_request` for
 *                                              session/list, `request` for most
 *                                              others, none for arg-less methods.
 *     resp: { type:'server-response', rpcId, result:{ ok, value | error } }
 *
 *   WS   ws://host:port/api/remote.mux    (multiplexed Remote stream)
 *     → send one `open` frame for the `$events` logical stream:
 *       { type:'open', streamId, endpoint:'$events', payload:{args:{}} }
 *     ← frames: { type:'item'|'end'|'error', streamId, value }
 *       the FIRST `item.value` is { type:'ready', clientId, host:{home} } — that
 *       is the only host-identity frame (there is no host.describe in rc.2).
 *       every later `item.value` is a MuxFrame (session/event, approval/request, …).
 *
 *   POST /api/$events/result              (to settle an approval / question)
 *     body: { type:'client-request', rpcId, method:'$events/result',
 *             payload: { args: { clientId, eventId, outcome } } }
 *
 * Every `/api/*` call and the mux upgrade require the browser-session cookie
 * (401 without one). The autoSession cookie machinery mints it locally.
 *
 * The transport was rewritten from a fictional 0.1.6-alpha model (which invented
 * logical-stream muxes, a `ready` frame, `session/follow` streams and a
 * `$events/result` RPC) — and then from a mis-remembered rc.6 model — to the real
 * 0.2.0-rc.2 model above, verified against the installed package source and a
 * live `dsh web` running on this machine.
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
  defaultWireProfile, isMissingMethodError, isShapeRejection, negotiateWire, wireEndpoint, type WireProfile,
} from './wire.ts'
import {
  type ApprovalOutcome,
  type ClientRequest,
  type CommandDescriptor,
  type HarnessInfo,
  type HistoryEntry,
  type ModelCatalog,
  type ModelSelectionValue,
  type MuxFrame,
  type ReadyFrame,
  type RemoteEventResult,
  type RpcError,
  type ServerResponse,
  type SessionCreateValue,
  type SessionForkValue,
  type SessionSummary,
  type SessionId,
  type SessionListValue,
  type SessionPageRequest,
  type SessionPageValue,
  type SessionPromptValue,
  type SessionRenameValue,
  type SessionSearchResult,
  type SessionAttachmentResult,
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

/** Listener for approval frames — receives a correlation id (the eventId). */
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
/** How long to wait for the `ready` frame before proceeding anyway (non-fatal). */
const READY_TIMEOUT_MS = 5_000

/** One active session subscription. */
interface ActiveSink {
  sessionId: SessionId
  buffer: EventBuffer
}

/** Candidate inner arg shapes tried per method (in order). */
function innerCandidates(method: string, req: Record<string, unknown>): Record<string, unknown>[] {
  if (method === 'session/list') return [{ _request: req }, { request: req }, req]
  if (method === 'session/page' || method === 'session/modelCatalog' || method === 'llm/listProviders') {
    return [{ request: req }, req]
  }
  // rc.2 (official bundle, empirically pinned): these take the {request:{...}}
  // wrapper; commands/execute takes the bare {agentId,line,submittedAttachments}.
  if (method === 'session/selectModel' || method === 'session/updateQueue') return [{ request: req }, req]
  if (method === 'session/search' || method === 'session/attachment') return [{ request: req }, req]
  if (method === 'commands/execute' || method === 'commands/list') return [req]
  return [{ request: req }, { _request: req }, req]
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
  /** Observed approval/request frames, keyed by eventId, for later respond. */
  private readonly approvalFrames = new Map<string, { eventId: string; sessionId: SessionId }>()
  private readonly sessionListeners = new Set<SessionEventListener>()
  private readonly approvalListeners = new Set<ApprovalFrameListener>()
  private readonly stateListeners = new Set<(s: ConnectionState) => void>()
  private readonly muxStatusListeners = new Set<(s: MuxStatus) => void>()
  /** Index of the `{args}` inner spelling that worked, per canonical method. */
  private readonly argShapes = new Map<string, number>()
  /** Resolved when the `ready` frame arrives (host identity). */
  private readyResolved = false
  private readyResolver: (() => void) | undefined
  private readyTimer: ReturnType<typeof setTimeout> | undefined

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
   *  The listener receives the frame plus a correlation id (the eventId) so the
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
   * Validate the host is loopback, negotiate the wire shape, open the Remote
   * stream socket (sends the `$events` open frame), wait for the `ready` frame to
   * learn the host identity, then mark the connection ready. Throws on a
   * security-boundary violation, missing credentials or an unreachable host.
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
      // minting there is permission-equivalent to reading the file at all.
      if (!this.opts.auth.isReady()) await this.opts.auth.tryMintLocalSession()

      // Never assume the wire shape — discover it. Endpoint style, cookie gating
      // and the event-socket path have all drifted between releases.
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
      // The `ready` frame carries host identity; wait for it but do not block
      // forever — session listing works without it.
      await this.awaitReady()
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
    this.readyResolved = false
    this.readyResolver = undefined
    if (this.readyTimer !== undefined) { clearTimeout(this.readyTimer); this.readyTimer = undefined }
    this.setState({ kind: 'disconnected' })
  }

  dispose(): void {
    this.disconnect()
    this.disposables.dispose()
  }

  /** The message shown when the harness refuses us: it names the exact fix. */
  private authRequired(): HarnessAuthRequiredError {
    this.opts.auth.noteRejected()
    return new HarnessAuthRequiredError(
      `DeepSeek Harness requires a browser session before it answers /api/* (${this.opts.auth.describeGap()}). `
      + 'Start `dsh web`, then run "DeepSeek Harness: Set Session Token from Launch URL" '
      + 'and paste the line it printed (it looks like `dsh web: http://127.0.0.1:3080/?token=…`).',
    )
  }

  // ─── unary RPCs (the only methods business code may call) ───────────────────
  describe(): HarnessInfo { return this.info ?? { home: '' } }

  /** Workspace list — derived from `session/list` projections; see listSessions. */
  async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }> {
    // 0.2.0-rc.2 has no `workspace/list` RPC; workspaces are surfaced through
    // `session/list` projections. Until that projection is wired, return empty.
    return { items: [], archivedSessionIds: [] }
  }

  createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.rpc<WorkspaceCreateValue>('workspace/create', { path })
      .then(value => ({ workspace: value.workspace, created: value.created }))
  }

  listSessions(): Promise<{ items: SessionSummary[] }> {
    const listArgs = this.profile?.listArgs ?? { _request: {} }
    return this.rpc<SessionListValue>('session/list', listArgs as Record<string, unknown>)
      .then(value => ({ items: [...value.items] }))
  }

  /**
   * Read one opening history window. `session.page` is the unary RPC in 0.2.0-rc.2
   * (there is no `session.history`):
   *   POST /api/session/page  payload { args:{ request:{ address, throughSeq, beforeSeq?, maxMessages? } } }
   * → { records:[{type:'event',event}], hasMore }.
   */
  async getHistory(
    sessionId: SessionId,
    opts: { maxMessages?: number } = {},
  ): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    const request: SessionPageRequest = {
      address: { kind: 'session', sessionId },
      throughSeq: 0,
      ...(opts.maxMessages === undefined ? {} : { maxMessages: opts.maxMessages }),
    }
    const value = await this.rpc<SessionPageValue>('session/page', request as unknown as Record<string, unknown>)
    const events: HistoryEntry[] = value.records.map(r => ({ event: r.event }))
    return { events, hasMore: value.hasMore }
  }

  createSession(opts: { workspaceId?: WorkspaceId; cwd?: string } = {}): Promise<SessionCreateValue> {
    const request: Record<string, unknown> = {}
    if (opts.workspaceId !== undefined) request.workspaceId = opts.workspaceId
    if (opts.cwd !== undefined) request.cwd = opts.cwd
    return this.rpc<SessionCreateValue>('session/create', request)
  }

  /**
   * Send a prompt to an existing session.
   *
   * `mode` mirrors the rc.2 wire union: `'queue'` appends to the inbox (the
   * host runs it when the session is idle), `'steer'` injects into the RUNNING
   * turn. rc.2 args are `{ request: { requestId, sessionId, mode, content,
   * clientTimeZone? } }` — `requestId` is a required client-minted identity.
   */
  prompt(
    sessionId: SessionId,
    text: string,
    clientTimeZone?: string,
    opts: { mode?: 'queue' | 'steer' } = {},
  ): Promise<SessionPromptValue> {
    const request: Record<string, unknown> = {
      requestId: randomUUID(),
      sessionId,
      mode: opts.mode ?? 'queue',
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
   * Run one slash-command line against a session's agent.
   *
   * rc.2's write path is `commands/execute` (`{ agentId, line,
   * submittedAttachments }`) — there is NO `session/command` RPC in rc.2, and
   * calling it (as v0.0.8 did) always answered 404. The host durably logs the
   * command lifecycle; outcomes render as `command/run`/`command/done` events.
   */
  runCommand(sessionId: SessionId, line: string): Promise<{ matched?: boolean }> {
    this.requireControl('commands/execute')
    const text = line.startsWith('/') ? line : `/${line}`
    return this.rpc<{ matched?: boolean }>('commands/execute', {
      agentId: sessionId,
      line: text,
      submittedAttachments: [],
    })
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

  /** Fork a session from a completed-turn prefix. rc.2 serves `session.fork`. */
  forkSession(sessionId: SessionId, opts: { atSeq?: number } = {}): Promise<SessionId> {
    this.requireControl('session/fork')
    const base = opts.atSeq === undefined ? { sessionId } : { sessionId, atSeq: opts.atSeq }
    return this.rpc<SessionForkValue>('session/fork', base).then(value => value.sessionId)
  }

  /** Rename the session, pinning its title against automatic regeneration. */
  renameSession(sessionId: SessionId, title: string): Promise<{ title: string; seq?: number }> {
    this.requireControl('session/rename')
    return this.rpc<SessionRenameValue>('session/rename', { sessionId, title })
  }

  /**
   * Fetch the model catalog (rc.2 `session/modelCatalog` — takes no args).
   * Groups models per provider and carries each model's reasoning-effort ladder.
   */
  modelCatalog(): Promise<ModelCatalog> {
    return this.rpc<ModelCatalog>('session/modelCatalog', {})
  }

  /**
   * Select the model (provider + model + optional reasoning effort) for future
   * turns. rc.2 args: `{ request: { sessionId, provider, model, reasoningEffort? } }`.
   */
  selectModel(sessionId: SessionId, provider: string, model: string, reasoningEffort?: string): Promise<ModelSelectionValue> {
    this.requireControl('session/selectModel')
    const request: Record<string, unknown> = { sessionId, provider, model }
    if (reasoningEffort !== undefined) request.reasoningEffort = reasoningEffort
    return this.rpc<ModelSelectionValue>('session/selectModel', request)
  }

  /**
   * Apply one action to a queued message (rc.2 `session/updateQueue`).
   * Actions: `{kind:'steer'}` (inject into the running turn),
   * `{kind:'edit', content:[{type:'text',text}]}` or `{kind:'remove'}`.
   */
  updateQueue(
    sessionId: SessionId,
    itemId: string,
    action: { kind: 'steer' } | { kind: 'edit'; content: { type: 'text'; text: string }[] } | { kind: 'remove' },
  ): Promise<{ accepted: true }> {
    this.requireControl('session/updateQueue')
    return this.rpc<{ accepted: true }>('session/updateQueue', { sessionId, itemId, action })
  }

  /** The slash-command registry this host serves for the session's agent. */
  listCommands(sessionId: SessionId): Promise<CommandDescriptor[]> {
    return this.rpc<CommandDescriptor[]>('commands/list', { agentId: sessionId })
  }

  /**
   * Full-text session search (rc.2 `session/search`, `{ request: { query } }`).
   *
   * NOTE: this endpoint may be disabled by the host deployment (the local
   * `dsh web` answers `gateway/internal: session search is disabled`). When that
   * happens the call rejects with the host's error; the caller surfaces it as an
   * "search unavailable here" notice rather than a hard failure.
   */
  searchSessions(query: string): Promise<SessionSearchResult> {
    return this.rpc<SessionSearchResult>('session/search', { query })
  }

  /**
   * Attach local files to a session (rc.2 `session/attachment`,
   * `{ request: { sessionId, attachments: [{ name, content }] } }`, `content` is
   * base64 of the file bytes). The host's inner descriptor could not be pinned by
   * blind probing against the local deployment, so this is the best-known shape;
   * errors are surfaced verbatim to the caller.
   */
  uploadAttachment(
    sessionId: SessionId,
    attachments: Array<{ name: string; content: string }>,
  ): Promise<SessionAttachmentResult> {
    this.requireControl('session/attachment')
    return this.rpc<SessionAttachmentResult>('session/attachment', { sessionId, attachments })
  }

  /** Archive the session out of the active workspace list. */
  archiveSession(sessionId: SessionId): Promise<unknown> {
    this.requireControl('workspace/archiveSession')
    return this.rpc<unknown>('workspace/archiveSession', { sessionId })
  }

  /**
   * Answer one approval waterfall. The `approval/request` frame (seen on the
   * `$events` stream) carries an `eventId`; we POST it to `/api/$events/result`
   * with our `clientId` in a `client-request` envelope.
   */
  respondApproval(eventId: string, outcome: ApprovalOutcome): Promise<void> {
    const frame = this.approvalFrames.get(eventId)
    if (frame === undefined) {
      throw new Error(
        `Cannot resolve approval ${eventId}: no matching approval/request frame was observed for this session.`,
      )
    }
    const payload: RemoteEventResult = {
      clientId: this.info?.clientId ?? '',
      eventId,
      outcome: this.outcomeFor(outcome),
    }
    return this.respondToRemoteEvent(payload)
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
    return wireEndpoint(this.profile?.endpointStyle ?? 'slash', method)
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

  private outcomeFor(o: ApprovalOutcome): RemoteEventResult['outcome'] {
    switch (o) {
      case 'allowed-once': return { kind: 'result' }
      case 'rejected': return { kind: 'rejected', error: { name: 'rejected', message: 'Rejected by user' } }
      case 'cancelled': return { kind: 'rejected', error: { name: 'cancelled', message: 'Cancelled by user' } }
      case 'unavailable': return { kind: 'rejected', error: { name: 'unavailable', message: 'Unavailable' } }
    }
  }

  /**
   * Call one method. The request object `req` is wrapped as `{ args: <inner> }`,
   * where `<inner>` is tried in the method-appropriate candidate set
   * (`_request` for session/list, `request` for most, bare for arg-less). The
   * winning spelling is remembered per method — never the argument VALUES: two
   * calls to `session/command` carry different lines, so caching the object itself
   * would silently replay the first call's payload forever. The follow-up call
   * then costs exactly one round trip.
   */
  private async rpc<V>(method: string, req: Record<string, unknown>): Promise<V> {
    if (!LOOPBACK_HOSTS.has(this.opts.host)) {
      throw new Error(`Refusing to talk to non-loopback host ${this.opts.host}: this plugin only drives a local DeepSeek Harness.`)
    }
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    // Only a cookie-gated host actually needs one; rc.2 serves /api/* unauthenticated? No —
    // rc.2 REQUIRES the cookie. If we have no cookie and the host is gated, fail fast.
    if (cookie === undefined && (this.profile?.auth ?? 'cookie') === 'cookie') throw this.authRequired()

    const candidates = innerCandidates(method, req)
    const all = candidates.map((c, i) => ({ c, i }))
    const remembered = this.argShapes.get(method)
    const order = remembered === undefined
      ? all
      : [...all.filter(x => x.i !== remembered), all[remembered]!]

    let last: unknown
    for (const { c, i } of order) {
      try {
        const value = await this.postEnvelope<V>(method, c, cookie)
        this.argShapes.set(method, i)
        return value
      } catch (e) {
        if (e instanceof HarnessRpcError && isShapeRejection(e.code)) { last = e; continue }
        throw e
      }
    }
    throw last instanceof Error
      ? last
      : new Error(`${method}: the host accepted none of the known argument shapes.`)
  }

  /** POST one `{ args: inner }` envelope and decode the server-response. */
  private async postEnvelope<V>(method: string, inner: Record<string, unknown>, cookie: string | undefined): Promise<V> {
    const endpoint = this.ep(method)
    const origin = `http://${this.opts.host}:${String(this.opts.port)}`
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: endpoint,
      payload: { args: inner },
    } as ClientRequest)
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
      throw new HarnessUnsupportedError(method, endpoint)
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
      // Missing-method errors mean "this host doesn't serve it" → surface as unsupported.
      if (isMissingMethodError(err.code)) throw new HarnessUnsupportedError(method, endpoint)
      throw new HarnessRpcError(err.code, err.message, err.details)
    }
    return env.result.value
  }

  /** POST a `client-request` to /api/$events/result to settle an approval. */
  private async respondToRemoteEvent(payload: RemoteEventResult): Promise<void> {
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    const origin = `http://${this.opts.host}:${String(this.opts.port)}`
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: '$events/result',
      payload: { args: payload },
    } as ClientRequest)
    try {
      await httpRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'POST',
        path: '/api/$events/result',
        headers: { ...(cookie === undefined ? {} : { cookie }), origin },
        body,
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot reach dsh web at ${this.opts.host}:${String(this.opts.port)} — ${message}`)
    }
  }

  // ─── downlink mux frame dispatch ────────────────────────────────────────────
  /** Host identity from the `ready` frame (carries home + clientId only). */
  private onReady(ready: ReadyFrame): void {
    this.info = { home: ready.host.home, clientId: ready.clientId }
    this.opts.log(`ready: home=${ready.host.home} clientId=${ready.clientId.slice(0, 12)}…`)
    // Re-emit connected with the now-known identity, if already connected.
    if (this.state.kind === 'connected') {
      this.setState({ kind: 'connected', info: this.info })
    }
    if (!this.readyResolved) {
      this.readyResolved = true
      clearTimeout(this.readyTimer)
      this.readyResolver?.()
      this.readyResolver = undefined
    }
  }

  /**
   * One decoded `$events` frame (the `value` of a Remote stream `item`). The wire
   * names differ from this plugin's internal vocabulary, so translate the
   * waterfall events before routing: `approval/request` → `approval/requested`,
   * `user-questions/request` → `question/requested`. Everything else passes
   * through to the existing routing unchanged.
   */
  private onMuxMessage(frame: MuxFrame): void {
    const f = frame as { type: string; [k: string]: unknown }
    switch (f.type) {
      case 'approval/request': {
        const eventId = String(f.eventId ?? '')
        const req = (f.request ?? {}) as Record<string, unknown>
        const internal = {
          type: 'approval/requested',
          sessionId: typeof req.sessionId === 'string' ? req.sessionId : (this.activeSessionId ?? ''),
          approvalId: eventId,
          toolName: typeof req.toolName === 'string' ? req.toolName : undefined,
          callId: typeof req.callId === 'string' ? req.callId : undefined,
          reason: typeof req.reason === 'string' ? req.reason : undefined,
        } as MuxFrame
        this.approvalFrames.set(eventId, { eventId, sessionId: (internal as { sessionId: string }).sessionId })
        this.notifyApproval(internal, eventId)
        return
      }
      case 'user-questions/request': {
        const eventId = String(f.eventId ?? '')
        const req = (f.request ?? {}) as Record<string, unknown>
        const internal = {
          type: 'question/requested',
          sessionId: typeof req.sessionId === 'string' ? req.sessionId : (this.activeSessionId ?? ''),
          questions: Array.isArray(req.questions) ? req.questions : [],
        } as MuxFrame
        this.notifyApproval(internal, eventId)
        return
      }
    }
    this.onMuxFrame(frame)
  }

  /** One decoded mux frame: route approvals to approval listeners, session frames to the active sink. */
  private onMuxFrame(frame: MuxFrame): void {
    const f = frame as { type: string; [k: string]: unknown }
    switch (f.type) {
      case 'approval/requested': {
        const af = frame as Extract<MuxFrame, { type: 'approval/requested' }>
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
        onReady: (ready) => { this.onReady(ready) },
        onFrame: (frame) => { this.onMuxMessage(frame) },
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

  /** Resolve once the mux socket reports open (the WS upgrade succeeded). */
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

  /** Resolve (once) when the `ready` frame arrives, or after a short timeout. */
  private awaitReady(): Promise<void> {
    if (this.readyResolved) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.readyResolver = resolve
      this.readyTimer = setTimeout(() => {
        if (!this.readyResolved) {
          this.readyResolved = true
          this.readyResolver = undefined
          resolve()
        }
      }, READY_TIMEOUT_MS)
    })
  }
}
