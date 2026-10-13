/**
 * HarnessClient — the single network boundary for the extension.
 *
 * All HTTP and WebSocket access goes through here; the rest of the extension
 * never calls an HTTP client or opens a socket directly (§8).
 *
 * ── Wire contract (DSH 0.2.1-alpha.2, the runtime installed on this machine) ────
 *
 *   POST /api/<namespace>/<method>        (slash-style endpoint)
 *     Content-Type: application/json
 *     body: { type:'client-request', rpcId, method:'<ns>/<method>',
 *             payload: { args: <inner> } }
 *                                            ^ payload is always { args: … },
 *                                              and <inner> is keyed by the Typert
 *                                              parameter wire name: `_request` for
 *                                              session/list, `request` for most
 *                                              others, bare for a few
 *                                              (`commands/*`, `fileReferences/list`).
 *     resp: { type:'server-response', rpcId, result:{ ok, value | error } }
 *
 *   WS   ws://host:port/api/remote.mux    (multiplexed Remote stream carrier)
 *     One socket may carry several logical streams; each is opened with
 *     { type:'open', streamId, endpoint, payload:{ args } } and every response
 *     frame is { type:'item'|'end'|'error', streamId, value }. Any further
 *     client message is a protocol violation (the Host closes with 1008).
 *
 *     • endpoint `$events` — forwarded Host events, and the ONLY source of the
 *       host identity: its first item is
 *       { type:'ready', clientId, host:{home} }. Later items are
 *       { type:'emit', event, args } or, for the answerable ones,
 *       { type:'waterfall', event, eventId, agentId, request }.
 *       Approvals and user questions arrive here, and nowhere else.
 *
 *     • endpoint `session/follow` — one session's conversation, opened with
 *       { request:{ address:{ kind:'session', sessionId }, assistantStream:true } }:
 *         { type:'snapshot', header, cursor, records, hasMore, projections }
 *         { type:'event', event }                    ← durable log records
 *         { type:'assistant-stream', frame }         ← live start/chunk/end deltas
 *       The durable records are the same `SessionEvent`s `session/page` returns;
 *       the assistant frames are process-local and never reach the journal.
 *       (This split is why the sidebar used to connect and then stay silent:
 *       `$events` stopped carrying conversation traffic.)
 *
 *   POST /api/$events/result              (to settle an approval / question)
 *     body: { type:'client-request', rpcId, method:'$events/result',
 *             payload: { args: { clientId, eventId, outcome } } }
 *
 * Every `/api/*` call and the mux upgrade require the browser-session cookie
 * (401 without one). The `credentials` session mode mints it locally; the other
 * two modes take a cookie issued by a Host instead.
 */

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { Disposable } from '../disposable.ts'
import { CompositeDisposable } from '../disposable.ts'
import {
  DownlinkSocket, EventBuffer, EVENTS_ENDPOINT, SESSION_FOLLOW_ENDPOINT, muxUrl, type MuxStatus,
} from './events.ts'
import { HarnessAuthRequiredError, type BrowserSessionAuth } from './auth.ts'
import { httpOrigin, isLoopbackHost, nonLoopbackRefusal } from './endpoint.ts'
import { httpRequest } from './http.ts'
import {
  defaultWireProfile, isMissingMethodError, isShapeRejection, negotiateWire, wireEndpoint, type WireProfile,
} from './wire.ts'
import {
  type ApprovalDecision,
  type ApprovalOutcome,
  type AskUserQuestionAnswer,
  type AssistantStreamFrame,
  type ChangesDiff,
  type ChangesSummary,
  type ClientRequest,
  type CommandDescriptor,
  type FileReferenceCandidate,
  type HarnessInfo,
  type HistoryEntry,
  type FileUploadValue,
  type ImageMediaType,
  type ModelCatalog,
  type ModelSelectionValue,
  type MuxFrame,
  type PromptContentPart,
  type ReadyFrame,
  type RemoteEventFrame,
  type RemoteEventResult,
  type RpcError,
  type ServerResponse,
  type SessionAttachmentValue,
  type SessionCreateValue,
  type SessionFollowFrame,
  type SessionForkValue,
  type SessionSummary,
  type SessionId,
  type SessionListValue,
  type SessionPageRequest,
  type SessionPageValue,
  type SessionPromptValue,
  type SessionRenameValue,
  type SessionSearchResult,
  type WorkspaceCreateValue,
  type WorkspaceId,
  type WorkspaceListValue,
  type WorkspaceView,
  CHANGES_DIFF_PATH,
  CHANGES_SUMMARY_PATH,
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

/**
 * How long to wait for the mux socket to open, in milliseconds.
 */
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
  // `fileReferences/list` declares (agentId, query) positionally: a bare inner
  // object, with no `request` wrapper to unwrap.
  if (method === 'fileReferences/list') return [req]
  return [{ request: req }, { _request: req }, req]
}

/** Newest `updatedAt` among the sessions of one derived workspace. */
function newestSessionAt(sessions: readonly SessionSummary[], ws: WorkspaceView): number {
  let newest = 0
  for (const s of sessions) {
    if (s.cwd === ws.path && s.updatedAt > newest) newest = s.updatedAt
  }
  return newest
}

export class HarnessClient implements Disposable {
  private readonly disposables = new CompositeDisposable()
  private state: ConnectionState = { kind: 'disconnected' }
  /** `$events` carrier: host identity + forwarded events (approvals, questions). */
  private mux: DownlinkSocket<RemoteEventFrame> | undefined
  /** `session/follow` carrier: the subscribed session's conversation. */
  private follow: DownlinkSocket<SessionFollowFrame> | undefined
  /** The session `follow` is currently opened for. */
  private followSessionId: SessionId | undefined
  /**
   * `attemptId → { turn, step }` for the live assistant stream. The `start`
   * frame carries the position; the `chunk` frames that follow only carry the
   * attempt id, so the mapping is what turns a delta into a placeable item.
   */
  private readonly followAttempts = new Map<string, { turn: number; step: number }>()
  /**
   * Last durable seq seen per session on the follow stream.
   *
   * `session/page`'s `throughSeq` is a log offset, not a message count: the host
   * validates it against the log's head and rejects anything past it, and `0`
   * pages up to the very first event only. The follow opening frame publishes
   * the cursor to page from, so it is recorded here and consumed by
   * {@link getHistory}.
   */
  private readonly followCursors = new Map<SessionId, number>()

  /** Track the newest durable seq seen for one session (never regresses). */
  private noteFollowCursor(sessionId: SessionId, seq: number): void {
    const known = this.followCursors.get(sessionId)
    if (known === undefined || seq > known) this.followCursors.set(sessionId, seq)
  }

  /** The durable log cursor for one session, once the follow stream has spoken. */
  followCursor(sessionId: SessionId): number | undefined {
    return this.followCursors.get(sessionId)
  }
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
  /**
   * Observed `user-questions/request` frames, keyed by eventId. Kept separate
   * from `approvalFrames` so neither responder can answer the other's waterfall
   * with a shape the Host would resolve into nonsense.
   */
  private readonly questionFrames = new Map<string, { eventId: string; sessionId: SessionId }>()
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

  /** The host:port this client is currently pointed at. */
  target(): { host: string; port: number } {
    return { host: this.opts.host, port: this.opts.port }
  }

  // ─── connect / disconnect ───────────────────────────────────────────────────
  /**
   * Validate the host is loopback, negotiate the wire shape, open the Remote
   * stream socket (sends the `$events` open frame), wait for the `ready` frame to
   * learn the host identity, then mark the connection ready. Throws on a
   * security-boundary violation, missing credentials or an unreachable host.
   *
   * @param opts.force - tear down whatever is live *before* connecting, and do
   *   not short-circuit on an existing `connected`/`connecting` state. That is
   *   what makes the sidebar's Reconnect meaningful: after the Host is restarted
   *   the state here is still `connected` (the mux just went quiet) and a plain
   *   `connect()` would return without doing anything, which is why the only
   *   reliable recovery used to be reloading the window.
   */
  async connect(opts: { force?: boolean } = {}): Promise<void> {
    if (opts.force === true) this.disconnect()
    if (!isLoopbackHost(this.opts.host)) {
      const msg = nonLoopbackRefusal(this.opts.host)
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
    this.closeFollow()
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

  /** Tear down the conversation stream (session switch, or disconnect). */
  private closeFollow(): void {
    if (this.follow !== undefined) { this.follow.close(); this.follow = undefined }
    this.followSessionId = undefined
    this.followAttempts.clear()
    // `followCursors` deliberately survives: a stale cursor only asks for an
    // older page, and keeping it is what lets a reconnect refill history.
  }

  dispose(): void {
    this.disconnect()
    this.disposables.dispose()
  }

  /** The message shown when the harness refuses us: it names the exact fix. */
  private authRequired(): HarnessAuthRequiredError {
    // Only a cookie we actually SENT can have been rejected. Recording a
    // rejection when we never presented one made `describeGap()` report "the
    // running harness rejected the stored cookie — the signing secret was
    // almost certainly regenerated", which sends the user after the wrong
    // problem. With no cookie at all the real cause is either the session mode
    // or a missing `$DSH_HOME/.credentials.yaml`, and the message below names
    // whichever of those is actually reachable from here.
    if (this.opts.auth.cookieHeader() !== undefined) this.opts.auth.noteRejected()
    const gap = this.opts.auth.describeGap()
    const mintGap = this.opts.auth.describeMintGap()
    const minting = this.opts.auth.localMintEnabled()
    return new HarnessAuthRequiredError(
      `DeepSeek Harness requires a browser session before it answers /api/* (${gap}). `
      + (minting
        ? 'This build mints that session from $DSH_HOME/.credentials.yaml on every connect — make sure '
          + '`dsh web` runs under the same user that owns that file'
          + (this.opts.auth.sessionOrigin() === undefined && mintGap !== undefined ? ` (local mint said: ${mintGap})` : '')
          + '.'
        // Naming the setting that is off is only half an answer; the other half
        // is that two working alternatives exist, and one of them does not
        // involve reading the credential file at all.
        : 'Local minting is off, so the session has to come from a Host: set deepseekHarness.sessionMode '
          + 'to "managed" and this extension will start one, run "DeepSeek Harness: Use Launch URL" with '
          + 'the line a `dsh web` you started printed, or set the mode to "credentials" to mint one from '
          + '$DSH_HOME/.credentials.yaml.'),
    )
  }

  // ─── unary RPCs (the only methods business code may call) ───────────────────
  describe(): HarnessInfo { return this.info ?? { home: '' } }

  /**
   * Why the local mint failed, when it did — or `undefined` if it never ran or
   * succeeded.
   *
   * Exposed so the failure classifier can tell "nothing is listening" apart from
   * "nothing is listening *and* there is no credential to authenticate with".
   * Those need different advice, and the second one used to be indistinguishable
   * from the first, which sent people to start a Host they had already started.
   */
  mintGap(): string | undefined {
    return this.opts.auth.describeMintGap()
  }

  /** Workspace list — derived from `session/list` projections; see listSessions.
   *
   *  0.2.0-rc.2 has **no** `workspace/list` RPC (verified: HTTP 404 on a live
   *  host, and zero occurrences in the harness source). Workspaces are however
   *  observable: every `session/list` row carries a host-canonical `cwd`, and
   *  those directories are 1:1 with the workspace registry (a workspace is
   *  keyed by its path — `workspace/create` returns the existing workspace,
   *  `created:false`, when one already exists for that path).
   *
   *  So we reconstruct the list by grouping sessions on `cwd`. This must never
   *  be a stub: an empty result makes `findHarnessWorkspace` return undefined
   *  forever, the binding never resolves, and the UI sits at "Disconnected"
   *  even though the handshake is healthy.
   *
   *  The derived `workspaceId` is the canonical path. It is a *path*, not a
   *  host-issued id, so callers must NOT pass it to `session/create` as
   *  `workspaceId` — use `{ cwd }` instead (see AppController.newSession).
   */
  async listWorkspaces(): Promise<{ items: WorkspaceView[]; archivedSessionIds: SessionId[] }> {
    const { items: sessions } = await this.listSessions()
    const byPath = new Map<string, WorkspaceView>()
    for (const s of sessions) {
      if (!s.cwd) continue
      const existing = byPath.get(s.cwd)
      if (existing) {
        existing.sessionIds.push(s.sessionId)
        continue
      }
      byPath.set(s.cwd, {
        workspaceId: s.cwd,
        path: s.cwd,
        title: path.basename(s.cwd) || s.cwd,
        sessionIds: [s.sessionId],
        createdAt: '',
        updatedAt: '',
      })
    }
    // Most-recently-touched first: that is the workspace a returning user wants.
    const items = [...byPath.values()].sort((a, b) => newestSessionAt(sessions, b) - newestSessionAt(sessions, a))
    return { items, archivedSessionIds: [] }
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
  /**
   * One message-aligned history page, newest first.
   *
   * `throughSeq` is a **log-offset cursor**, not a count and not a sentinel: the
   * host validates it against the log head (`throughSeq: 100000` on a 31-event
   * log answers `gateway/bad-request ... past cursor 30`), and `throughSeq: 0`
   * pages up to the very first event only — which on a real session is a single
   * `permission/preset` record, no messages at all. `-1` is accepted by
   * validation but resolves to an empty page inside `paginate`.
   *
   * The cursor to page from is published by the `session/follow` opening frame,
   * so it is read from {@link followCursor} unless the caller supplies one. When
   * neither exists the honest answer is "no page yet" — the follow stream's own
   * snapshot is about to deliver the same records.
   */
  async getHistory(
    sessionId: SessionId,
    opts: { maxMessages?: number; throughSeq?: number } = {},
  ): Promise<{ events: HistoryEntry[]; hasMore: boolean }> {
    const throughSeq = opts.throughSeq ?? this.followCursors.get(sessionId)
    if (throughSeq === undefined) return { events: [], hasMore: false }
    const request: SessionPageRequest = {
      address: { kind: 'session', sessionId },
      throughSeq,
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
   *
   * Attachments ride the prompt itself; there is no separate send step.
   * `images` are inlined as base64 parts (the host promotes them to durable
   * refs during admission) and `files` reference receipts minted by
   * {@link uploadFile}. The text part is dropped when it is empty and something
   * else is attached, because the host rejects a prompt whose every part is
   * blank.
   */
  prompt(
    sessionId: SessionId,
    text: string,
    clientTimeZone?: string,
    opts: {
      mode?: 'queue' | 'steer'
      images?: readonly { mediaType: ImageMediaType; data: string; name?: string }[]
      files?: readonly { receiptId: string }[]
    } = {},
  ): Promise<SessionPromptValue> {
    const content: PromptContentPart[] = []
    if (text !== '') content.push({ type: 'text', text })
    for (const image of opts.images ?? []) {
      content.push({
        type: 'image',
        mediaType: image.mediaType,
        data: image.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      })
    }
    for (const file of opts.files ?? []) content.push({ type: 'file', receiptId: file.receiptId })
    if (content.length === 0) content.push({ type: 'text', text })
    const request: Record<string, unknown> = {
      requestId: randomUUID(),
      sessionId,
      mode: opts.mode ?? 'queue',
      content,
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
   * `@` completion candidates for one session's working directory (host-served
   * `fileReferences/list`, the same source the web composer's `@` menu reads).
   *
   * The host owns ranking, caching and invalidation; this only forwards the
   * text typed after `@`. Candidates are paths, never content — picking one
   * never attaches a file, it only names one, which is why the model still has
   * to call a filesystem tool to read it.
   */
  listFileReferences(sessionId: SessionId, query: string): Promise<FileReferenceCandidate[]> {
    return this.rpc<FileReferenceCandidate[]>('fileReferences/list', { agentId: sessionId, query })
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
   * Read back one durable image by its content address.
   *
   * `session/attachment` is a **read**, not an upload: `{ sessionId, attachmentId }`
   * answers the stored ref plus its bytes (base64). The host may have rescaled
   * or re-encoded during admission, so `attachment.mediaType` is authoritative
   * and the bytes are not guaranteed byte-identical to what was sent.
   */
  readAttachment(sessionId: SessionId, attachmentId: string): Promise<SessionAttachmentValue> {
    this.requireControl('session/attachment')
    return this.rpc<SessionAttachmentValue>('session/attachment', { sessionId, attachmentId })
  }

  /**
   * Stage one file and get the receipt a prompt references.
   *
   * Uploading does not ride the Remote surface at all: it is a raw byte route,
   * `POST /api/session/uploadFileBinary?sessionId=<id>&name=<leaf>`, body
   * `application/octet-stream`, answering `{ok:true, value:{receiptId, file}}`.
   * The receipt is scoped to that session and to this host process. Verified
   * live against `0.2.1-alpha.2` (30 bytes in, `receiptId` back).
   */
  async uploadFile(sessionId: SessionId, name: string, bytes: Uint8Array): Promise<FileUploadValue> {
    const url = `${httpOrigin(this.opts.host, this.opts.port)}/api/session/uploadFileBinary`
      + `?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`
    const cookie = this.opts.auth.cookieHeader()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: bytes as unknown as BodyInit,
    })
    if (res.status !== 200) {
      throw new HarnessRpcError('gateway/internal',
        `uploadFileBinary answered HTTP ${String(res.status)} ${res.statusText}`, { status: res.status })
    }
    const body = await res.json() as { ok?: boolean; value?: FileUploadValue; error?: { code?: string; message?: string } }
    if (body.ok !== true || body.value === undefined) {
      const err = body.error
      throw new HarnessRpcError(err?.code ?? 'gateway/internal',
        err?.message ?? 'uploadFileBinary returned no receipt', err ?? {})
    }
    return body.value
  }

  /** Archive the session out of the active workspace list. */
  archiveSession(sessionId: SessionId): Promise<unknown> {
    this.requireControl('workspace/archiveSession')
    return this.rpc<unknown>('workspace/archiveSession', { sessionId })
  }

  /**
   * Read the Host's record of one turn's changed files.
   *
   * `workspace/changes` is a Session event whose data carries only the turn; the
   * coordinate this route is addressed by is the EVENT'S OWN `seq`. Returns
   * `undefined` when the Host no longer serves the summary — a disposed Session,
   * or a Host restarted since the turn ran (the recorder keeps its summaries in
   * memory for the Session's lifetime only).
   */
  changesSummary(sessionId: SessionId, seq: number): Promise<ChangesSummary | undefined> {
    return this.getRoute<ChangesSummary>(CHANGES_SUMMARY_PATH, {
      sessionId,
      seq: String(seq),
    })
  }

  /**
   * Read one listed file's turn-start / turn-end comparison.
   *
   * `index` addresses the file inside the summary's own `files` array — the
   * route keeps no id of its own, so the pair (seq, index) is the whole handle.
   * `undefined` means the Host no longer serves it.
   */
  changesDiff(sessionId: SessionId, seq: number, index: number): Promise<ChangesDiff | undefined> {
    return this.getRoute<ChangesDiff>(CHANGES_DIFF_PATH, {
      sessionId,
      seq: String(seq),
      index: String(index),
    })
  }

  /**
   * Answer one approval waterfall. The `approval/request` frame (seen on the
   * `$events` stream) carries an `eventId`; we POST it to `/api/$events/result`
   * with our `clientId` in a `client-request` envelope.
   *
   * The decision string must ride in `outcome.value`, NOT be encoded as
   * `{kind:'result'}` alone: the value IS the waterfall's return value, so an
   * omitted one resolves the Host listener with `undefined`, which
   * `ApprovalService.decide` normalizes to `'unavailable'` — a fail-closed deny
   * that still writes a plausible-looking `approval/decided` audit entry. A
   * bare `{kind:'result'}` therefore *looks* accepted and silently refuses.
   */
  respondApproval(eventId: string, outcome: ApprovalDecision): Promise<void> {
    const frame = this.approvalFrames.get(eventId)
    if (frame === undefined) {
      throw new Error(
        `Cannot resolve approval ${eventId}: no matching approval/request frame was observed for this session.`,
      )
    }
    const payload: RemoteEventResult = {
      clientId: this.info?.clientId ?? '',
      eventId,
      outcome: { kind: 'result', value: outcome },
    }
    return this.respondToRemoteEvent(payload)
  }

  /**
   * Answer one `user-questions/request` waterfall.
   *
   * Same envelope rule as {@link respondApproval}: the return value of the Host
   * waterfall is the whole `AskUserQuestionAnswer` object, so it travels in
   * `outcome.value` (`{ answers: [{ id, selected, custom? }] }`). Answering any
   * other way leaves the tool call waiting on a promise that never settles.
   */
  respondQuestion(eventId: string, answer: AskUserQuestionAnswer): Promise<void> {
    if (!this.questionFrames.has(eventId)) {
      throw new Error(
        `Cannot answer question ${eventId}: no matching user-questions/request frame was observed for this session.`,
      )
    }
    const payload: RemoteEventResult = {
      clientId: this.info?.clientId ?? '',
      eventId,
      outcome: { kind: 'result', value: answer },
    }
    return this.respondToRemoteEvent(payload)
  }

  /**
   * Hand a still-open waterfall back to the Host chain without answering it.
   *
   * This is a real delegation, not a dismissal: the Host drops our delivery and
   * the request stays pending for whichever client still holds one (the Web UI).
   * Only when no delivery is left does it settle the chain with `next()`.
   */
  delegateWaterfall(eventId: string): Promise<void> {
    if (!this.approvalFrames.has(eventId) && !this.questionFrames.has(eventId)) {
      throw new Error(`Cannot delegate ${eventId}: no matching waterfall frame was observed.`)
    }
    const payload: RemoteEventResult = {
      clientId: this.info?.clientId ?? '',
      eventId,
      outcome: { kind: 'next' },
    }
    return this.respondToRemoteEvent(payload).then(() => {
      // We hold no delivery any more, so a second answer from here would be a
      // silent no-op. Forgetting the frame turns that into a thrown error.
      this.approvalFrames.delete(eventId)
      this.questionFrames.delete(eventId)
    })
  }

  // ─── event subscription ─────────────────────────────────────────────────────
  /**
   * Subscribe to `sessionId`'s conversation.
   *
   * This opens a `session/follow` stream on its own mux carrier. The Host
   * answers with an opening `{type:'snapshot'}` (history prefix + log cut),
   * then every durable `{type:'event'}` record, then live
   * `{type:'assistant-stream'}` deltas while a turn runs. Each of those is
   * translated into this plugin's internal vocabulary before it reaches
   * `onFlush`, so `ConversationModel` never learns the wire names:
   *
   *   follow `event`             → { type:'session/event', sessionId, event }
   *   follow `assistant-stream`  → { type:'assistant/stream', sessionId, turn, step, chunk }
   *   follow `snapshot.records`  → { type:'session/event', … } (second delivery
   *                                of history; the model's seq guard drops the
   *                                overlap, so a reconnect only appends what is new)
   *
   * Switching sessions replaces the stream: the previous one is disposed, so at
   * most one conversation is ever being followed.
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
    this.openFollow(sessionId)
    return {
      dispose: () => {
        if (this.activeSink !== sink) return
        sink.buffer.dispose()
        this.activeSink = undefined
        if (this.activeSessionId === sessionId) this.activeSessionId = undefined
        this.closeFollow()
      },
    }
  }

  /** Open (replacing any previous) the conversation stream for one session. */
  private openFollow(sessionId: SessionId): void {
    if (this.followSessionId === sessionId && this.follow !== undefined) return
    this.closeFollow()
    this.followSessionId = sessionId
    const follow = new DownlinkSocket<SessionFollowFrame>({
      url: () => muxUrl(this.opts.host, this.opts.port, this.profile?.muxPath ?? defaultWireProfile().muxPath),
      headers: () => {
        const origin = httpOrigin(this.opts.host, this.opts.port)
        const cookie = this.opts.auth.cookieHeader()
        const headers: Record<string, string> = { origin }
        if (cookie !== undefined) headers['cookie'] = cookie
        return headers
      },
      endpoint: SESSION_FOLLOW_ENDPOINT,
      streamIdPrefix: 'harness-follow-',
      openArgs: () => ({
        request: {
          address: { kind: 'session', sessionId },
          // Opt in to the process-local assistant deltas; without this the
          // stream is history-only and a running turn renders as a blank wait.
          assistantStream: true,
        },
      }),
      onFrame: (frame) => { this.onFollowFrame(sessionId, frame) },
      onStreamError: (err) => {
        const message = (err as { message?: string } | undefined)?.message ?? JSON.stringify(err)
        this.opts.log(`follow: stream error — ${String(message).slice(0, 200)}`)
        for (const l of this.muxStatusListeners) {
          try { l({ kind: 'error', message: `session/follow: ${String(message).slice(0, 120)}` }) } catch { /* noop */ }
        }
      },
      // Health of the conversation stream is informational: it must never
      // overwrite the `$events` status the panel already shows.
      onStatus: (s) => { this.opts.log(`follow: ${s.kind}${'reason' in s ? ' — ' + s.reason : ''}`) },
      log: this.opts.log,
    })
    this.follow = follow
    follow.open()
  }

  /**
   * Translate one `session/follow` frame into the plugin's internal frames and
   * hand it to the active sink.
   */
  private onFollowFrame(sessionId: SessionId, frame: SessionFollowFrame): void {
    const sink = this.activeSink
    if (sink === undefined || sink.sessionId !== sessionId) return
    const f = frame as unknown as { type?: string; [k: string]: unknown }
    switch (f.type) {
      case 'snapshot': {
        // The stream's opening history prefix — and, on this host, the only
        // correct source of it. `session/page` needs a log-offset cursor, which
        // is exactly what this frame carries; the plugin used to page with
        // `throughSeq: 0` and get a single non-message record back.
        const records = Array.isArray(f.records) ? f.records : []
        if (typeof f.cursor === 'number') this.noteFollowCursor(sessionId, f.cursor)
        for (const record of records) {
          const event = (record as { event?: unknown }).event
          if (event === undefined) continue
          sink.buffer.push({ type: 'session/event', sessionId, event } as unknown as MuxFrame)
        }
        this.opts.log(`follow: snapshot with ${String(records.length)} record(s), cursor=${String(f.cursor)}`)
        return
      }
      case 'event': {
        if (f.event === undefined) return
        const seq = (f.event as { seq?: unknown }).seq
        if (typeof seq === 'number') this.noteFollowCursor(sessionId, seq)
        sink.buffer.push({ type: 'session/event', sessionId, event: f.event } as unknown as MuxFrame)
        return
      }
      case 'assistant-stream': {
        this.onAssistantStreamFrame(sink, sessionId, f.frame as AssistantStreamFrame | undefined)
        return
      }
      default:
        // Forward-compatible: an unknown frame is passed through untouched so a
        // newer host's addition shows up in the event inspector instead of
        // vanishing.
        sink.buffer.push(frame as unknown as MuxFrame)
    }
  }

  /** Fold one live assistant frame into an `assistant/stream` internal frame. */
  private onAssistantStreamFrame(sink: ActiveSink, sessionId: SessionId, frame: AssistantStreamFrame | undefined): void {
    if (frame === undefined || typeof frame !== 'object') return
    switch (frame.type) {
      case 'start':
        this.followAttempts.set(frame.attemptId, { turn: frame.turn, step: frame.step })
        return
      case 'chunk': {
        const at = this.followAttempts.get(frame.attemptId)
        // A chunk for an attempt we never saw start (mid-stream reconnect) has
        // no place to land: `applyStreamChunk` keys on turn:step, so guessing
        // would scatter the text. Drop it — the durable `assistant/message`
        // that closes the attempt carries the full text anyway.
        if (at === undefined) return
        sink.buffer.push({
          type: 'assistant/stream',
          sessionId,
          turn: at.turn,
          step: at.step,
          chunk: frame.chunk,
        } as unknown as MuxFrame)
        return
      }
      case 'end':
        this.followAttempts.delete(frame.attemptId)
        return
      default:
        return
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

  // There used to be an `outcomeFor()` here that mapped a decision onto an
  // envelope, and its `rejected` branch was
  // `{ kind: 'rejected', error: { name: 'rejected' } }`. That is wrong in the
  // same way the missing value was: a rejected outcome cancels the Host
  // waterfall, whose rejection `ApprovalService.decide` then contains and
  // normalizes to `'unavailable'`. A click on Deny was therefore audited as
  // "requires approval, but no approval channel is available" instead of
  // "the user rejected tool X". A deny is a RESULT carrying the vocabulary
  // string, not a transport error — nothing sends `rejected` any more.

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
    if (!isLoopbackHost(this.opts.host)) {
      throw new Error(nonLoopbackRefusal(this.opts.host))
    }
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    // Only a cookie-gated host actually needs one; rc.2 serves /api/* unauthenticated? No —
    // rc.2 REQUIRES the cookie. If we have no cookie and the host is gated, fail fast.
    if (cookie === undefined && (this.profile?.auth ?? 'cookie') === 'cookie') throw this.authRequired()

    const candidates = innerCandidates(method, req)
    const all = candidates.map((c, i) => ({ c, i }))
    const remembered = this.argShapes.get(method)
    // The shape that worked last time goes FIRST. It used to go last, which made
    // every call after the first retry two known-wrong shapes against the live
    // host before landing on the right one — three round trips per prompt, and a
    // wire shape that wandered between calls depending on which permissive
    // attempt a host happened to accept.
    const order = remembered === undefined
      ? all
      : [all[remembered]!, ...all.filter(x => x.i !== remembered)]

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
    const origin = httpOrigin(this.opts.host, this.opts.port)
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

  /**
   * GET one of the Host's plain authenticated routes — the deliverables
   * `changes.*` family — and decode the body.
   *
   * These routes sit BESIDE the gateway rather than on it, so they take query
   * parameters instead of a `{ args }` envelope. Every other rule still holds:
   * loopback only, cookie required, 401 means "mint one". A 404 here is not
   * "unsupported method" — it means the resource is GONE (Session disposed, or
   * the Host restarted and no longer holds the turn's record), which is a normal
   * state the UI renders as "no card" rather than as an error.
   */
  private async getRoute<T>(routePath: string, query: Record<string, string>): Promise<T | undefined> {
    if (!isLoopbackHost(this.opts.host)) {
      throw new Error(nonLoopbackRefusal(this.opts.host))
    }
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    if (cookie === undefined && (this.profile?.auth ?? 'cookie') === 'cookie') throw this.authRequired()
    const origin = httpOrigin(this.opts.host, this.opts.port)
    const search = new URLSearchParams(query).toString()
    let res
    try {
      res = await httpRequest({
        host: this.opts.host,
        port: this.opts.port,
        method: 'GET',
        path: search.length > 0 ? `${routePath}?${search}` : routePath,
        headers: { ...(cookie === undefined ? {} : { cookie }), origin },
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      throw new Error(`Cannot reach dsh web at ${this.opts.host}:${String(this.opts.port)} — ${message}`)
    }
    if (res.status === 401) throw this.authRequired()
    if (res.status === 404) return undefined
    if (res.status !== 200) {
      throw new Error(`HTTP ${String(res.status)} on ${routePath}: ${res.body.trim().slice(0, 200)}`)
    }
    const body = res.body.trim()
    if (body.length === 0) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error(`Harness returned a non-JSON body on ${routePath}.`)
    }
    // The route answers the record itself. Accept a gateway-shaped envelope too,
    // so a host that later decides to wrap it does not silently blank the card.
    if (parsed !== null && typeof parsed === 'object' && 'ok' in parsed) {
      const env = parsed as { ok?: unknown; value?: unknown }
      return env.ok === true ? (env.value as T) : undefined
    }
    return parsed as T
  }

  /** POST a `client-request` to /api/$events/result to settle an approval. */
  private async respondToRemoteEvent(payload: RemoteEventResult): Promise<void> {
    await this.opts.auth.init()
    const cookie = this.opts.auth.cookieHeader()
    const origin = httpOrigin(this.opts.host, this.opts.port)
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: '$events/result',
      payload: { args: payload },
    } as ClientRequest)
    let res
    try {
      res = await httpRequest({
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

    // A 200 is not the same as "the answer was accepted", and the difference is
    // the whole reliability of the Allow button: this POST is the only thing
    // between a clicked approval and a tool that actually runs. The Host reports
    // a refusal in two shapes — a non-200 status, and a 200 whose envelope
    // carries `result.ok === false` — and this method used to inspect neither,
    // so a refused answer was indistinguishable from an accepted one. The card
    // was then settled while the Host had declined it: the same fail-closed
    // outcome as a missing `outcome.value`, one layer further down.
    if (res.status === 401) throw this.authRequired()
    if (res.status !== 200) {
      throw new Error(
        `The harness refused the answer (HTTP ${String(res.status)}): ${res.body.trim().slice(0, 200)}`,
      )
    }
    const text = res.body.trim()
    if (text === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A non-JSON 200 is odd but not a refusal we can read, and inventing one
      // would make a working host look broken.
      return
    }
    const result = (parsed as { result?: { ok?: unknown; error?: RpcError } }).result
    if (result !== undefined && result.ok === false) {
      const err = result.error
      throw new HarnessRpcError(
        err?.code ?? 'gateway/internal',
        err?.message ?? 'The harness declined the answer.',
        err?.details,
      )
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
   * One decoded `$events` frame — the `value` of a Remote stream `item`.
   *
   * Only two families live here: forwarded `emit` events (session status and
   * activity, plugin-inventory changes, …) and the answerable `waterfall`
   * frames (approvals, user questions). The wire names differ from this
   * plugin's internal vocabulary, so translate the waterfalls before routing:
   * `approval/request` → `approval/requested`,
   * `user-questions/request` → `question/requested`.
   *
   * The pre-0.2 shape — a bare `{type:'approval/request'}` frame — is still
   * tolerated so the plugin keeps working against an older host.
   */
  private onMuxMessage(frame: RemoteEventFrame): void {
    const f = frame as unknown as { type: string; [k: string]: unknown }
    switch (f.type) {
      case 'waterfall': {
        const event = String(f.event ?? '')
        const eventId = String(f.eventId ?? '')
        const req = (f.request ?? {}) as Record<string, unknown>
        if (event === 'approval/request') {
          this.emitApprovalRequested(eventId, req)
          return
        }
        if (event === 'user-questions/request') {
          this.emitQuestionRequested(eventId, req)
          return
        }
        this.opts.log(`$events: unhandled waterfall "${event}"`)
        return
      }
      case 'cancel': {
        // The Host withdrew a waterfall: either another client answered it, or
        // the turn ended. Nothing else announces that to a mux client, so
        // without this the card sits pending forever.
        const eventId = String(f.eventId ?? '')
        this.approvalFrames.delete(eventId)
        this.questionFrames.delete(eventId)
        this.opts.log(`$events: waterfall withdrawn (${eventId})`)
        this.notifyApproval({ type: 'waterfall/resolved', eventId } as unknown as MuxFrame, eventId)
        return
      }
      case 'emit': {
        // `api-session/status` is the host's own running flag; without it the
        // Stop button only updates when a full turn/end event arrives.
        if (f.event === 'api-session/status') {
          const args = Array.isArray(f.args) ? f.args : []
          const sessionId = typeof args[0] === 'string' ? args[0] : undefined
          const running = args[1] === true
          if (sessionId !== undefined) {
            this.notifySessionFrame({ type: 'session/status', sessionId, running } as unknown as MuxFrame)
          }
          return
        }
        // Every other forwarded event is informational for this plugin.
        return
      }
      // ── pre-0.2 compatibility: the same waterfall delivered unwrapped ──
      case 'approval/request': {
        this.emitApprovalRequested(String(f.eventId ?? ''), (f.request ?? {}) as Record<string, unknown>)
        return
      }
      case 'user-questions/request': {
        this.emitQuestionRequested(String(f.eventId ?? ''), (f.request ?? {}) as Record<string, unknown>)
        return
      }
    }
    this.onMuxFrame(frame as unknown as MuxFrame)
  }

  /** Translate one wire `approval/request` into the internal requested frame. */
  private emitApprovalRequested(eventId: string, req: Record<string, unknown>): void {
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
  }

  /**
   * Translate one wire `user-questions/request` into the internal requested
   * frame.
   *
   * `sessionId` is the one field the wire request does not carry: the event is
   * delivered on an Agent-scoped waterfall, so the session identity is the scope
   * subject's. `wait.callId` is the tool call the card belongs to and is what
   * lets the answer be tied back to an `ask_user_question` row; it is absent for
   * an indefinite wait, which is still answerable, just unattached.
   */
  private emitQuestionRequested(eventId: string, req: Record<string, unknown>): void {
    const wait = (req.wait ?? {}) as Record<string, unknown>
    const internal = {
      type: 'question/requested',
      sessionId: typeof req.sessionId === 'string' ? req.sessionId : (this.activeSessionId ?? ''),
      questions: Array.isArray(req.questions) ? req.questions : [],
      callId: typeof wait.callId === 'string' ? wait.callId : undefined,
    } as MuxFrame
    this.questionFrames.set(eventId, { eventId, sessionId: (internal as { sessionId: string }).sessionId })
    this.notifyApproval(internal, eventId)
  }

  /** Deliver one session-scoped frame to the active sink when it matches. */
  private notifySessionFrame(frame: MuxFrame): void {
    const f = frame as { sessionId?: unknown }
    if (this.activeSink === undefined || typeof f.sessionId !== 'string') return
    if (f.sessionId !== this.activeSink.sessionId) return
    this.activeSink.buffer.push(frame)
  }

  /**
   * Route one already-internal frame: approvals to the approval listeners,
   * session-scoped frames to the active conversation sink. Reached from the
   * pre-0.2 compatibility paths and from the event inspector's pass-through.
   */
  private onMuxFrame(frame: MuxFrame): void {
    const f = frame as { type: string; [k: string]: unknown }
    switch (f.type) {
      case 'approval/requested':
      case 'approval/resolved': {
        this.notifyApproval(frame, String(f.approvalId ?? ''))
        return
      }
      case 'question/requested': {
        this.notifyApproval(frame, 'question')
        return
      }
      case 'question/resolved': {
        this.notifyApproval(frame, String(f.questionRpcId ?? ''))
        return
      }
      case 'stream/error': {
        this.activeSink?.buffer.push(frame)
        return
      }
      default: {
        this.notifySessionFrame(frame)
      }
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
      this.mux = new DownlinkSocket<RemoteEventFrame>({
        url: () => muxUrl(this.opts.host, this.opts.port, this.profile?.muxPath ?? defaultWireProfile().muxPath),
        headers: () => {
          const origin = httpOrigin(this.opts.host, this.opts.port)
          const cookie = this.opts.auth.cookieHeader()
          const headers: Record<string, string> = { origin }
          if (cookie !== undefined) headers['cookie'] = cookie
          return headers
        },
        endpoint: EVENTS_ENDPOINT,
        expectReady: true,
        openArgs: () => ({}),
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
