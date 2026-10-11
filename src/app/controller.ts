/**
 * AppController — owns the full orchestration that used to live inline in
 * extension.ts (v0.0.1→v0.0.2 refactor). This module is now the only thing that touches:
 *   - connect/disconnect
 *   - workspace lifecycle (find + ensure on demand)
 *   - session lifecycle (select / create / prompt)
 *   - mux dispatch (frames → ConversationModel)
 *   - UiState push (with renderVersion bumping)
 *
 * extension.ts stays as the pure wiring module: instantiate, register
 * commands, config changes, dispose.
 */

import type * as vscode from 'vscode'
import { HarnessRpcError, type HarnessClient } from '../harness/client.ts'
import { HarnessAuthRequiredError } from '../harness/auth.ts'
import { discoverHosts, type HostCandidate } from '../harness/discovery.ts'
import type { MuxStatus } from '../harness/events.ts'
import type { CallId, FileReferenceCandidate, ImageMediaType, QueueItemView, RpcId, SessionId, SessionSummary, SessionUsageProjection, WorkspaceView } from '../harness/protocol.ts'
import { ConversationModel, sessionLabel } from '../conversation/model.ts'
import { ControlSurface } from '../conversation/control.ts'
import { SessionUsage } from '../conversation/usage.ts'
import type { ConversationItem, SessionSnapshot } from '../conversation/types.ts'
import {
  findHarnessWorkspace, ensureHarnessWorkspace, pickVsCodeFolder,
  type WorkspaceBinding,
} from '../workspace/binding.ts'
import type { UiState, InspectorFrame, PendingChip, SearchState } from './state.ts'
import { connectionToUi, sessionsToUi, workspaceToUi } from './state.ts'
import type { PendingAttachmentPayload, WebviewAction } from '../view/provider.ts'
import type { HarnessWebviewViewProvider } from '../view/provider.ts'
import { CompositeDisposable } from '../disposable.ts'
import { formatMention } from '../context/collector.ts'
import { ReviewController } from '../review/controller.ts'
import { ReviewVirtualDocumentProvider } from '../review/virtualDocument.ts'
import { ApprovalStore } from '../approval/store.ts'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, ApprovalDecision } from '../harness/protocol.ts'

export interface ControllerDeps {
  client: HarnessClient
  vscodeAPI: {
    window: typeof vscode.window
    workspace: typeof vscode.workspace
    commands: typeof vscode.commands
  }
  getState: () => UiState
  setState: (patch: Partial<UiState>) => void
  bump: () => void
  pushState: () => void
  notifyError: (msg: string) => void
  notifyInfo: (msg: string) => void
  /**
   * Whether to look for a dsh Host on another loopback port when the configured
   * one answers nothing. Mirrors the `autoDiscover` setting.
   */
  autoDiscover: () => boolean
  openHarnessHome: () => void
  moveToSecondarySideBar: () => Promise<void>
  log: { info: (m: string) => void; error: (m: string) => void }
  provider?: HarnessWebviewViewProvider
}

/**
 * Raster formats the host's attachment store admits. Mirrors upstream
 * `attachment-local`, which pins exactly these four.
 */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
/** Upstream `DEFAULT_MAX_IMAGE_BYTES`. Checked here so the failure is local and legible. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** Upstream `DEFAULT_MAX_IMAGES_PER_MESSAGE`. */
const MAX_IMAGES_PER_MESSAGE = 20

/** One attachment held in the composer, bytes included. */
interface HeldAttachment {
  id: string
  kind: 'image' | 'file'
  name: string
  bytes: number
  mediaType?: ImageMediaType
  /** Base64 for images (sent as-is); base64 of the raw bytes for files. */
  data: string
}

let attachmentSeq = 0
function nextAttachmentId(): string {
  attachmentSeq += 1
  return `att-${String(attachmentSeq)}`
}

/** Byte length of a base64 payload without materializing the decoded buffer. */
function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.floor(((data.length - padding) * 3) / 4)
}

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/**
 * The media type to declare for one raster file.
 *
 * A clipboard image arrives with a type the browser guessed; a file from the
 * picker usually arrives with none, so the extension is the fallback. Anything
 * outside the four admitted formats is refused rather than guessed at, because
 * the host validates the declared type against fully decoded bytes.
 */
function normalizeImageMediaType(declared: string | undefined, name: string): ImageMediaType | undefined {
  const trimmed = declared?.toLowerCase().split(';', 1)[0]?.trim()
  if (trimmed !== undefined && (IMAGE_MEDIA_TYPES as readonly string[]).includes(trimmed)) {
    return trimmed as ImageMediaType
  }
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  return EXTENSION_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()]
}

function defaultAttachmentName(kind: 'image' | 'file', mediaType: string | undefined): string {
  if (kind === 'file') return 'attachment'
  const ext = (mediaType ?? 'image/png').slice('image/'.length)
  return `pasted-image.${ext === 'jpeg' ? 'jpg' : ext}`
}

/**
 * How one local file should be sent: a raster the host admits travels inline as
 * an image part (the model sees the pixels), anything else is staged as a file.
 */
export function attachmentKindFor(name: string): 'image' | 'file' {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'file'
  return EXTENSION_MEDIA_TYPES[name.slice(dot + 1).toLowerCase()] === undefined ? 'file' : 'image'
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Stand-in transcript text for a prompt that is pictures and files only. */
function attachmentEcho(held: readonly HeldAttachment[]): string {
  const images = held.filter((p) => p.kind === 'image').length
  const files = held.length - images
  const parts: string[] = []
  if (images > 0) parts.push(`${String(images)} image${images === 1 ? '' : 's'}`)
  if (files > 0) parts.push(`${String(files)} file${files === 1 ? '' : 's'}`)
  return `(${parts.join(' + ')})`
}

/**
 * Turn a prompt rejection into a sentence that says what to do next.
 *
 * The case worth translating is a text-only model. The host's own message
 * ("Model X does not support image input.") is accurate but leaves the user
 * holding a screenshot with nowhere to go; the host's `reason` code says
 * exactly what the remedy is, so it is spelled out. Everything else is passed
 * through verbatim — the host's wording is the authority.
 */
export function describePromptFailure(e: unknown): string {
  const details = e instanceof HarnessRpcError ? (e.details as { reason?: unknown } | null) : null
  if (details !== null && typeof details === 'object' && details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') {
    return `${e instanceof Error ? e.message : String(e)} `
      + 'Pick an image-capable model from the Controls panel, or remove the image and send the text alone.'
  }
  return e instanceof Error ? e.message : String(e)
}

export class AppController {
  private disposables = new CompositeDisposable()
  private binding: WorkspaceBinding | null = null
  /** null = "we looked and there is no folder". undefined = "not looked yet". */
  private noFolder: null | undefined = undefined
  private sessions: SessionSummary[] = []
  private activeSessionId: SessionId | undefined
  private model: ConversationModel | undefined
  private muxStatus: MuxStatus | undefined
  private reviewController: ReviewController | undefined
  private approvalStore = new ApprovalStore()
  /** Control surface for the active session (plan/preset/todos/goal/…). */
  private control = new ControlSurface()
  /** Session token/usage accumulator (event fold + host projections). */
  private usage = new SessionUsage()
  /** F6: last session-search result (held so the panel re-renders). */
  private search: SearchState | null = null
  /** F7: ring buffer of every mux frame seen (newest last). */
  private eventLog: InspectorFrame[] = []
  private eventLogSeq = 0
  /**
   * The most recent `@` query the composer asked for.
   *
   * This has to be tracked separately from `UiState.refQuery`, because that field
   * means "the query these candidates answer" — it is written only AFTER a reply
   * lands. Using it as the staleness guard deadlocks the very first keystroke:
   * `refQuery` starts undefined, so a bare `@` (query `''`) failed its own guard
   * and nothing was ever published; the popup could not open at all.
   */
  private refQueryLatest: string | undefined = undefined
  /**
   * Attachments held for the next prompt.
   *
   * The bytes live here and never in `UiState` — `pushState` fires on every
   * streamed chunk, so a screenshot's base64 has no business riding it. Images
   * are kept as base64 because that is exactly what the prompt needs; files are
   * kept as bytes because they are staged by a separate raw route at send time
   * (a receipt would be stale if the user sat on the composer).
   */
  private pending: HeldAttachment[] = []
  /**
   * Serialises connect attempts. A second click while one is in flight must
   * queue a fresh attempt rather than negotiate a second socket on top of the
   * first — the two would fight over `client.state` and the loser's teardown
   * would kill the winner's stream.
   */
  private connectChain: Promise<void> = Promise.resolve()
  /**
   * The live `session/follow` subscription for the active session.
   *
   * Held explicitly so switching sessions (and every forced reconnect, which
   * re-selects the same session) can drop the previous one. Letting these pile
   * up in `disposables` left one dead listener per switch alive forever.
   */
  private sessionSubscription: { dispose: () => void } | undefined

  constructor(private readonly d: ControllerDeps) {}

  start(): vscode.Disposable {
    // Wire client state → UiState
    this.disposables.add(this.d.client.onStateChange(() => this.pushFromClient()))
    let prevMuxKind: MuxStatus['kind'] | undefined
    this.disposables.add(this.d.client.onMuxStatusChange((s) => {
      const reopened = prevMuxKind !== undefined && prevMuxKind !== 'open' && s.kind === 'open'
      prevMuxKind = s.kind
      this.muxStatus = s
      if (reopened && this.activeSessionId) void this.refetchHistory(this.activeSessionId)
      this.pushFromClient()
    }))
    // Wire approval frames → ApprovalStore
    this.disposables.add(this.d.client.onApprovalFrame((frame, rpcId) => {
      this.handleApprovalFrame(frame, rpcId)
    }))
    // Create ReviewController (lives for entire extension lifetime; filters by sessionId)
    this.reviewController = new ReviewController({
      workspace: this.d.vscodeAPI.workspace,
      onChange: () => this.pushReviewApprovalState(),
      notifyError: (m) => this.d.notifyError(m),
      log: this.d.log,
    })
    this.disposables.add({ dispose: () => this.reviewController?.dispose() })
    // Wire approval store changes → pushState
    this.disposables.add(this.approvalStore.onApprovalChange(() => this.pushReviewApprovalState()))
    // Register virtual document provider for dsh-review:// URIs (native diff support)
    this.disposables.add(
      this.d.vscodeAPI.workspace.registerTextDocumentContentProvider(
        ReviewVirtualDocumentProvider.scheme,
        new ReviewVirtualDocumentProvider(this.reviewController.store),
      ),
    )
    return this.disposables
  }

  // ─── actions (called by webview + commands) ────────────────────────────────
  async dispatch(action: WebviewAction): Promise<void> {
    this.d.log.info(`dispatch: action.type=${action.type}`)
    switch (action.type) {
      case 'connect': await this.doConnect(); break
      // The webview asks for this once on boot. Unlike `connect` it does not
      // tear down a working session, so opening the panel cannot interrupt a
      // turn that the extension host already established.
      case 'ensureConnected': await this.doConnect({ force: false }); break
      case 'disconnect': this.doDisconnect(); break
      case 'selectSession': await this.selectSession(action.sessionId); break
      case 'newSession': await this.newSession(); break
      case 'refreshSessions': await this.refreshSessions(); break
      case 'sendPrompt': await this.sendPrompt(action.text, { steer: action.steer === true }); break
      case 'stop': await this.stopActive(); break
      case 'openWebUI': this.d.openHarnessHome(); break
      case 'toggleSystemMessages': this.toggleSystemMessages(); break
      case 'moveToSecondarySideBar': void this.d.moveToSecondarySideBar(); break
      case 'reviewAcceptFile': this.reviewController?.acceptFile(action.reviewId, action.filePath); break
      case 'reviewRejectFile': await this.reviewController?.rejectFile(action.reviewId, action.filePath); break
      case 'reviewRejectHunk': await this.reviewController?.rejectHunk(action.reviewId, action.filePath, action.hunkId); break
      case 'reviewOpenDiff': await this.reviewController?.openDiff(action.reviewId, action.filePath); break
      case 'reviewAcceptAll': this.reviewController?.acceptAll(action.reviewId); break
      case 'reviewRejectAll': await this.reviewController?.rejectAll(action.reviewId); break
      case 'approvalRespond': await this.respondApproval(action.rpcId, action.outcome); break
      case 'waterfallDelegate': await this.delegateWaterfall(action.rpcId); break
      case 'questionAnswer': await this.answerQuestion(action.rpcId, action.answers); break
      case 'controlPlan': await this.setPlanMode(action.active); break
      case 'controlPreset': await this.setPreset(action.preset); break
      case 'controlFork': await this.forkActive(); break
      case 'controlCompact': await this.compactActive(); break
      case 'controlArchive': await this.archiveActive(); break
      case 'controlRename': await this.renameActive(); break
      case 'controlModel': await this.setModel(action.provider, action.model, action.reasoningEffort); break
      case 'queueSteer': await this.queueAction(action.itemId, { kind: 'steer' }); break
      case 'queueRemove': await this.queueAction(action.itemId, { kind: 'remove' }); break
      case 'searchSessions': await this.doSearch(action.query); break
      case 'searchClear': this.search = null; this.d.setState({ search: null }); break
      case 'refsQuery': await this.queryFileReferences(action.query); break
      // The webview reads the bytes (it already has them from the paste) and
      // hands them up once; the chips come back through UiState.
      case 'pendingAdd': this.addPendingItems(action.items); break
      case 'pendingRemove': this.removePending(action.id); break
      case 'pendingClear': this.clearPending(); break
      case 'inspectorClear': this.eventLog = []; this.eventLogSeq = 0; this.d.setState({ eventLog: [] }); break
    }
  }

  async doConnect(opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force ?? true
    const run = (): Promise<void> => this.runConnect(force)
    this.connectChain = this.connectChain.then(run, run)
    await this.connectChain
  }

  private async runConnect(force: boolean): Promise<void> {
    // The session the user is looking at outlives a reconnect; losing it made a
    // forced reconnect look like the panel had been reset to a fresh install.
    const resume = this.activeSessionId
    const alreadyConnected = this.d.client.getState().kind === 'connected'
    try {
      // `force` tears the old socket down before negotiating. It has to, because
      // after a Host restart the client still believes it is `connected` — the
      // stream simply stopped — and a plain connect() short-circuits on that
      // state. That gap is exactly why "reload the window" used to be the only
      // recovery.
      try {
        await this.d.client.connect({ force })
      } catch (e) {
        // Only a *reachability* failure is worth hunting for another port. An
        // auth refusal means we found a Host and it said no; retrying elsewhere
        // would answer a credential problem with a port problem.
        if (e instanceof HarnessAuthRequiredError || !this.d.autoDiscover()) throw e
        if (await this.attachToDiscovered() === undefined) throw e
      }
      // A non-forced connect against a live session has nothing left to do: the
      // webview asks for one on every boot, and redoing the session handshake
      // would restart the transcript for no reason.
      if (!force && alreadyConnected) return
      await this.discoverFolder()
      // Model catalog is session-independent — fetch once per connect when the
      // host serves it, so the selector is ready before the first session opens.
      await this.fetchModelCatalog()
      await this.restoreSession(resume)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('connect failed: ' + msg)
      this.d.notifyError(msg)
    }
    this.d.pushState()
  }

  /**
   * Look for a dsh Host on another loopback port and point the client at it.
   *
   * This exists because of the desktop app: it spawns its Host with `--port 0`
   * (`apps/desktop-host/src/index.ts`), so the port is freshly assigned on every
   * launch and reported only to Electron over Node IPC. Nothing lands on disk,
   * so "the panel is stuck until I reload VS Code" was really "the plugin is
   * still aimed at last launch's port". Discovery reads ports pinned in
   * `$DSH_HOME/profiles/<name>/cordis.patch.yml` and probes the OS listener table
   * for the Host's own anonymous refusal. See `harness/discovery.ts`.
   *
   * @returns the address adopted, or undefined when nothing else answered.
   */
  private async attachToDiscovered(): Promise<HostCandidate | undefined> {
    const target = this.d.client.target()
    this.d.log.info(`connect: nothing answering at ${target.host}:${String(target.port)} — scanning loopback for a dsh Host`)
    let hosts: HostCandidate[]
    try {
      hosts = await discoverHosts({ host: target.host, port: target.port, log: (m) => this.d.log.info(m) })
    } catch (e) {
      this.d.log.info('discovery failed: ' + (e instanceof Error ? e.message : String(e)))
      return undefined
    }
    const found = hosts.find((h) => h.port !== target.port)
    if (found === undefined) {
      this.d.log.info(`connect: no other dsh Host on loopback (${String(hosts.length)} answered at the configured port)`)
      return undefined
    }
    // Retarget in memory only. A discovered port is usually OS-assigned and will
    // be different again next launch, so persisting it would leave the user with
    // a stale pin to debug — the opposite of the point.
    this.d.client.retarget(target.host, found.port)
    const via = found.source === 'pinned'
      ? `pinned in the "${found.profile ?? '?'}" profile`
      : 'found by probing loopback'
    this.d.log.info(`connect: adopting ${target.host}:${String(found.port)} (${via})`)
    await this.d.client.connect({ force: true })
    this.d.notifyInfo(
      `DeepSeek Harness: found the local Host on ${target.host}:${String(found.port)} (${via}). `
      + 'Set deepseekHarness.port to pin that port and skip the scan next time.',
    )
    return found
  }

  /**
   * Put the panel back on the session it was showing before a reconnect.
   *
   * `refreshSessions()` deliberately leaves an already-set `activeSessionId`
   * alone, so after a forced reconnect the transcript is still on screen while
   * its subscription is not — that died with the socket. Re-selecting rebuilds
   * the model and re-opens the follow stream, which is the documented resume
   * semantic here (rebuild from the host journal, not cursor-resume).
   */
  private async restoreSession(resume: SessionId | undefined): Promise<void> {
    if (resume === undefined || this.binding?.harness === undefined) return
    if (this.sessions.some((s) => s.sessionId === resume)) {
      await this.selectSession(resume)
      return
    }
    this.d.log.info(`connect: session ${resume} is not on this host — falling back to the newest`)
    this.activeSessionId = undefined
    this.model = undefined
    this.d.setState({ activeSessionId: undefined, snapshot: undefined })
    await this.refreshSessions()
  }

  doDisconnect(): void {
    this.sessionSubscription?.dispose()
    this.sessionSubscription = undefined
    this.d.client.disconnect()
    if (this.activeSessionId) {
      this.reviewController?.store.clearSession(this.activeSessionId)
      this.approvalStore.clearSession(this.activeSessionId)
    }
    this.model = undefined
    this.activeSessionId = undefined
    this.sessions = []
    this.binding = null
    this.noFolder = undefined
    this.usage.reset()
    this.d.setState({ snapshot: undefined, activeSessionId: undefined, sessions: [], workspace: undefined, reviews: undefined, approvals: undefined, questions: undefined, queue: [], sessionUsage: this.usage.snapshot() })
    this.d.pushState()
  }

  /** Discover the VS Code folder + matching harness workspace. Read-only.
   *  If no matching harness workspace exists, we don't create yet — the
   *  binding stays pending until the user's first Send. */
  private async discoverFolder(): Promise<void> {
    const folder = await pickVsCodeFolder(this.d.vscodeAPI.workspace, this.d.vscodeAPI.window)
    if (!folder) {
      this.noFolder = null
      this.d.setState({ workspace: null })
      return
    }
    const harness = await findHarnessWorkspace(this.d.client, folder)
    this.binding = { folder, harness }
    this.d.setState({ workspace: workspaceToUi(harness ?? null) })
    if (harness) await this.refreshSessions()
  }

  async refreshSessions(): Promise<void> {
    const ws = this.binding?.harness
    if (!ws) return
    try {
      const all = (await this.d.client.listSessions()).items
      const wsIds = new Set(ws.sessionIds)
      this.sessions = all.filter(s => wsIds.has(s.sessionId)).sort((a, b) => b.updatedAt - a.updatedAt)
      this.d.setState({ sessions: sessionsToUi(this.sessions, sessionLabel) })
      if (!this.activeSessionId && this.sessions.length > 0) {
        const first = this.sessions.find(s => !s.blank) ?? this.sessions[0]
        if (first) await this.selectSession(first.sessionId)
        return
      }
      this.syncSessionProjection()
      this.d.pushState()
    } catch (e) {
      this.d.log.error('list sessions: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async selectSession(sessionId: SessionId): Promise<void> {
    this.activeSessionId = sessionId
    this.control.reset()
    this.usage.reset()
    this.model = new ConversationModel(sessionId)
    this.model.setShowSystemMessages(this.d.getState().showSystemMessages)
    // Wire tool completion → ReviewController (creates review transactions for write/edit)
    this.model.setToolCompletedHandler((info) => {
      const reviewId = this.reviewController?.onToolCompleted({
        sessionId,
        callId: info.callId,
        toolName: info.toolName,
        arguments: info.arguments,
        resultMeta: info.resultMeta,
      })
      if (reviewId) this.model?.setReviewId(info.callId, reviewId)
    })
    this.d.setState({ activeSessionId: sessionId, snapshot: this.model.snapshot() })
    try {
      await this.refetchHistory(sessionId)
      this.sessionSubscription?.dispose()
      this.sessionSubscription = this.d.client.subscribe(sessionId, (frames) => {
        for (const f of frames) { this.captureFrame(f); this.applyMuxFrame(f) }
        this.d.pushState()
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('history/subscribe: ' + msg)
      this.d.notifyError(msg)
    }
    await this.fetchCommands(sessionId)
    this.syncSessionProjection()
    this.pushReviewApprovalState()
  }

  private async refetchHistory(sessionId: SessionId): Promise<void> {
    if (!this.model) return
    const h = await this.d.client.getHistory(sessionId, { maxMessages: 50 })
    const events = h.events.map(e => e.event)
    // `loadHistory` clears the model before replaying. An empty page must never
    // wipe a conversation that is already on screen: on first open the follow
    // stream has not published its cursor yet, so the page is legitimately
    // empty and the follow snapshot is about to deliver the same records.
    if (events.length === 0) {
      this.d.log.info('history: no page for this cursor yet — keeping the current transcript')
      return
    }
    this.model.loadHistory(events)
    // The control surface is a log fold: replaying history re-derives plan
    // mode, presets, todos and goal exactly as the host would.
    for (const e of events) this.control.apply(e)
    this.d.setState({ snapshot: this.model.snapshot() })
    this.pushControl()
  }

  /** Push the folded control state (and what this host lets us change). */
  private pushControl(): void {
    this.d.setState({ control: this.control.snapshot() })
    this.d.pushState()
  }

  private applyMuxFrame(frame: unknown): void {
    if (!this.model || !this.activeSessionId) return
    const f = frame as {
      type?: string
      sessionId?: string
      event?: unknown
      error?: unknown
      turn?: number
      step?: number
      chunk?: unknown
    }
    if (f.type === 'session/event' && f.sessionId === this.activeSessionId && f.event) {
      const event = f.event as Parameters<ConversationModel['applyEvent']>[0]
      this.model.applyEvent(event)
      if (this.control.apply(event)) this.pushControl()
      // Token usage: fold assistant/message samples live; refresh the host's
      // projections after a turn ends (they cover the whole session log).
      if (this.usage.apply(event)) {
        this.d.setState({ sessionUsage: this.usage.snapshot() })
      }
      if (event.type === 'turn/end') void this.syncSessionProjectionAsync()
      this.d.setState({ snapshot: this.model.snapshot() })
      const snap = this.d.getState().snapshot
      this.d.setState({ canStop: snap?.running === true })
      return
    }
    // The host's own running flag (`api-session/status`, forwarded on `$events`).
    // Durable `turn/start` / `turn/end` also flip this, but they arrive a beat
    // later — and not at all when another client drove the turn.
    if (f.type === 'session/status' && f.sessionId === this.activeSessionId) {
      const running = (frame as { running?: unknown }).running === true
      this.model?.setRunning(running)
      this.d.setState({ snapshot: this.model?.snapshot(), canStop: running })
      return
    }
    // DSH 0.1.6+ carries assistant deltas outside the durable journal, so they
    // arrive as their own frame type and bypass the model's seq guard.
    if (f.type === 'assistant/stream' && f.sessionId === this.activeSessionId
      && typeof f.turn === 'number' && typeof f.step === 'number' && f.chunk) {
      this.model.applyStreamChunk(
        f.turn,
        f.step,
        f.chunk as Parameters<ConversationModel['applyStreamChunk']>[2],
      )
      this.d.setState({ snapshot: this.model.snapshot() })
      return
    }
    if (f.type === 'stream/error' && f.error) {
      const err = f.error as { message?: string }
      this.d.notifyError('Harness stream error: ' + (err.message ?? 'unknown'))
    }
  }

  /** F7: append a raw frame to the live inspector ring buffer (cap 300). */
  private captureFrame(frame: unknown): void {
    const f = frame as { type?: string; event?: { type?: string; data?: unknown }; turn?: number; step?: number }
    const kind = f.type ?? 'unknown'
    let eventType: string | undefined
    let summary = kind
    if (kind === 'session/event' && f.event) {
      eventType = f.event.type
      const data = f.event.data as { content?: unknown; chunk?: unknown; usage?: unknown; toolName?: string; message?: unknown } | undefined
      summary = `event:${eventType}`
      if (eventType === 'assistant/message' && data?.usage) summary += ' usage'
      else if (eventType === 'tool/call' && typeof data?.toolName === 'string') summary += ` ${data.toolName}`
      else if (eventType === 'user/message') summary += ' (user input)'
    } else if (kind === 'assistant/stream') {
      summary = `stream t${String(f.turn)}.${String(f.step)}`
    } else if (kind === 'stream/error') {
      summary = 'stream error'
    }
    let raw = ''
    try { raw = JSON.stringify(frame) } catch { raw = String(frame) }
    if (raw.length > 2000) raw = raw.slice(0, 1997) + '…'
    this.eventLog.push({ seq: ++this.eventLogSeq, at: Date.now(), kind, eventType, summary, raw })
    if (this.eventLog.length > 300) this.eventLog = this.eventLog.slice(-300)
    this.d.setState({ eventLog: this.eventLog })
  }

  /** Handle approval/question frames from the dedicated waterfall listener. */
  private handleApprovalFrame(frame: unknown, eventId: RpcId): void {
    const f = frame as {
      type: string
      sessionId?: SessionId
      approvalId?: string
      toolName?: string
      callId?: CallId
      reason?: string
      outcome?: string
      questions?: AskUserQuestionItem[]
    }
    if (f.type === 'approval/requested' && f.sessionId && f.approvalId) {
      this.approvalStore.upsert({
        rpcId: eventId,
        sessionId: f.sessionId,
        approvalId: f.approvalId,
        toolName: f.toolName,
        callId: f.callId,
        reason: f.reason,
      })
      // Link approval to ToolItem if callId matches
      if (f.callId && this.model) {
        this.model.setApprovalRpcId(f.callId, eventId)
        this.d.setState({ snapshot: this.model.snapshot() })
      }
      this.d.log.info(`Approval requested: ${f.toolName ?? 'unknown'} (callId=${f.callId ?? '—'})`)
      this.pushReviewApprovalState()
      // F2: auto-approve — answer the waterfall immediately when the setting is
      // on and this approval is answerable from VS Code. Mirrors Copilot's
      // /autoApprove and Claude Code's /yolo, scoped to what canAllow permits.
      if (this.d.getState().autoApprove === true) {
        const approval = this.approvalStore.getByRpcId(eventId)
        if (approval && this.approvalStore.canAllow(approval, this.activeSessionId)) {
          this.d.log.info(`Auto-approving: ${f.toolName ?? 'unknown'} (autoApprove setting)`)
          void this.respondApproval(eventId, 'allowed-once')
        } else if (approval) {
          this.d.log.info(
            `Not auto-approving: ${f.toolName ?? 'unknown'} blocked by `
            + `${this.approvalStore.blockReason(approval, this.activeSessionId) ?? 'policy'}`,
          )
        }
      }
      return
    }
    if (f.type === 'question/requested' && f.sessionId) {
      const questions = Array.isArray(f.questions) ? f.questions : []
      // A question with nothing in it is unanswerable; upserting it would park a
      // blank card in front of the user forever.
      if (questions.length === 0) {
        this.d.log.info('Question requested with no questions — ignored')
        return
      }
      this.approvalStore.upsertQuestion({
        rpcId: eventId,
        sessionId: f.sessionId,
        callId: f.callId,
        questions,
      })
      if (f.callId && this.model) this.model.setApprovalRpcId(f.callId, eventId)
      this.d.log.info(`Question requested: ${String(questions.length)} question(s) (callId=${f.callId ?? '—'})`)
      this.pushReviewApprovalState()
      return
    }
    if (f.type === 'waterfall/resolved') {
      // The Host withdrew it — typically because another client answered, or the
      // turn ended. Drop the card instead of leaving it clickable against a
      // waterfall that no longer exists.
      const settled = this.approvalStore.resolveWaterfall(eventId, 'withdrawn')
      if (settled) {
        this.d.log.info(`Waterfall withdrawn by host: ${eventId}`)
        this.pushReviewApprovalState()
      }
      return
    }
    if (f.type === 'approval/resolved' && f.approvalId) {
      // Pre-0.2 hosts announced the verdict here; 0.2.1 sends `cancel` instead
      // (see the `waterfall/resolved` branch above).
      this.approvalStore.resolve(eventId, f.outcome ?? 'resolved')
      this.d.log.info(`Approval resolved: outcome=${f.outcome ?? '—'}`)
      this.pushReviewApprovalState()
      return
    }
  }

  /** Answer an approval waterfall via `POST /api/$events/result`. */
  private async respondApproval(eventId: RpcId, outcome: ApprovalDecision): Promise<void> {
    const approval = this.approvalStore.getByRpcId(eventId)
    if (!approval) {
      this.d.notifyError('Approval not found or already resolved.')
      return
    }
    // Security: double-check canAllow before sending allow
    if (outcome === 'allowed-once' && !this.approvalStore.canAllow(approval, this.activeSessionId)) {
      this.d.notifyError('This approval cannot be allowed from VS Code. Please review in the Harness Web UI.')
      return
    }
    this.approvalStore.setResponding(eventId)
    this.pushReviewApprovalState()
    try {
      await this.d.client.respondApproval(eventId, outcome)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('respondApproval: ' + msg)
      this.d.notifyError(`Failed to respond to approval: ${msg}`)
    }
  }

  /** Answer a `user-questions/request` waterfall. */
  private async answerQuestion(eventId: RpcId, answers: AskUserQuestionAnswerItem[]): Promise<void> {
    const question = this.approvalStore.getQuestion(eventId)
    if (!question) {
      this.d.notifyError('That question is no longer pending.')
      return
    }
    // One answer per asked question, and only for ids the Host actually asked
    // about: the Host validates the shape, and a wrong count throws inside the
    // tool call rather than failing the answer visibly.
    const asked = new Set(question.questions.map((q) => q.id))
    const cleaned = answers
      .filter((a) => asked.has(a.id))
      .map((a) => ({
        id: a.id,
        selected: Array.isArray(a.selected) ? a.selected.map(String) : [],
        ...a.custom !== undefined && a.custom !== '' ? { custom: a.custom } : {},
      }))
    this.approvalStore.setQuestionResponding(eventId)
    this.pushReviewApprovalState()
    try {
      await this.d.client.respondQuestion(eventId, { answers: cleaned })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('respondQuestion: ' + msg)
      this.d.notifyError(`Failed to answer: ${msg}`)
    }
  }

  /**
   * Hand a waterfall back to the Host without answering it.
   *
   * The request is NOT cancelled — it stays pending for the Web UI, which holds
   * its own delivery. Used for "answer this in the browser" and for an approval
   * whose risk the sidebar refuses to grant.
   */
  private async delegateWaterfall(eventId: RpcId): Promise<void> {
    try {
      await this.d.client.delegateWaterfall(eventId)
      // Drop the local card: we no longer hold a delivery, so nothing we do here
      // could answer it. Leaving it clickable would offer a button that cannot work.
      this.approvalStore.resolveWaterfall(eventId, 'delegated')
      this.pushReviewApprovalState()
      this.d.notifyError('Handed to the Harness Web UI — answer it there.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('delegateWaterfall: ' + msg)
      this.d.notifyError(`Failed to hand off: ${msg}`)
    }
  }

  /** Push review and approval summaries to UiState. Also touches the model so
   *  the webview re-renders items (review/approval cards update). */
  private pushReviewApprovalState(): void {
    const sid = this.activeSessionId
    if (this.model) this.model.touch()
    this.d.setState({
      reviews: sid ? this.reviewController?.summaries(sid) : undefined,
      approvals: this.approvalStore.summaries(sid),
      questions: this.approvalStore.questionSummaries(sid),
      snapshot: this.model?.snapshot(),
    })
    this.d.pushState()
  }

  async newSession(): Promise<void> {
    // Always go through ensureWorkspaceQuiet: a discovered workspace carries a
    // path-shaped workspaceId that `session/create` must not be given.
    const ws = await this.ensureWorkspaceQuiet()
    if (!ws) return
    try {
      const res = await this.d.client.createSession({ workspaceId: ws.workspaceId })
      await this.refreshSessions()
      await this.selectSession(res.sessionId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.notifyError(msg)
    }
  }

  /**
   * Send a prompt. Implements lazy workspace+session create:
   *  1. If no folder → tell user.
   *  2. If no harness workspace → ensureHarnessWorkspace (no modal).
   *  3. If no session → create session.
   *  4. Send the text as typed, `@` mentions and all.
   *
   * Why nothing is extracted from the text any more: an `@path` mention is
   * ordinary prompt text that the HOST understands (`$DSH_HOME` installs
   * `FILE_REFERENCE_PROMPT` guidance telling the model to read a referenced
   * file with a filesystem tool). v0.0.3…v0.1.2 read the referenced file here
   * and pasted its bytes into the message instead — every re-send duplicated
   * the file, broke the KV prefix, and contradicted the web composer, which
   * has always sent the mention alone.
   *
   * v0.0.9: a leading `/` routes through `commands/execute` (the rc.2 slash
   * write path); `opts.steer` sends with mode `'steer'` to inject into the
   * running turn instead of queueing.
   */
  async sendPrompt(rawText: string, opts: { steer?: boolean } = {}): Promise<void> {
    this.d.setState({ sending: true })
    this.d.pushState()
    try {
      // 1+2: ensure workspace (confirmed against the host — its workspaceId
      // must be a host-issued id before it reaches `session/create`).
      const ws = await this.ensureWorkspaceQuiet()
      if (!ws) {
        if (this.noFolder === null) {
          this.d.notifyError('Open a VS Code folder first — DeepSeek Harness needs a workspace root.')
        }
        return
      }
      // 3: ensure session
      if (!this.activeSessionId) {
        const created = await this.d.client.createSession({ workspaceId: ws.workspaceId })
        await this.refreshSessions()
        await this.selectSession(created.sessionId)
      }
      if (!this.activeSessionId) return

      const text = rawText.trim()
      // An image with no words is a legitimate prompt; the host only refuses a
      // prompt whose every part is blank.
      if (text === '' && this.pending.length === 0) return

      // Slash-command routing: a leading `/` is a command admission, not a
      // user message (the host durably logs the lifecycle as command/run+done).
      if (text.startsWith('/')) {
        await this.runControl(() => this.d.client.runCommand(this.activeSessionId!, text), 'command')
        return
      }

      // Stage files (images need no staging) before the optimistic echo, so a
      // failed upload leaves the composer and the transcript in agreement.
      const held = this.pending
      const staged = await this.stagePending(this.activeSessionId)

      // 4: optimistic echo (the text as typed, or the attachment summary when
      // the message is pictures only) → send the text unchanged.
      this.model?.optimisticUserEcho(text !== '' ? text : attachmentEcho(held))
      this.d.setState({ snapshot: this.model?.snapshot() })
      this.d.pushState()
      await this.d.client.prompt(
        this.activeSessionId,
        text,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
        {
          mode: opts.steer === true ? 'steer' : 'queue',
          images: staged.images,
          files: staged.files,
        },
      )
      // Held attachments are consumed by this prompt; a failure above keeps them
      // so the user can fix the cause (switch to a vision model, shrink a file)
      // and press send again instead of re-attaching everything.
      if (held.length > 0) this.clearPending()
    } catch (e) {
      this.d.notifyError(describePromptFailure(e))
    } finally {
      this.d.setState({ sending: false })
      this.d.pushState()
    }
  }

  /** Resolve-or-create a workspace, without user prompts. Errors bubble.
   *  Updates this.binding.harness on success.
   *
   *  A discovered workspace is derived from `session/list`, so its
   *  `workspaceId` is a path. `ensureHarnessWorkspace` confirms it against the
   *  host (idempotent `workspace/create`) before anything writes with that id. */
  private async ensureWorkspaceQuiet(): Promise<WorkspaceView | undefined> {
    if (!this.binding) {
      // Try picking folder once (discovery may have been skipped)
      const folder = await pickVsCodeFolder(this.d.vscodeAPI.workspace, this.d.vscodeAPI.window)
      if (!folder) { this.noFolder = null; return undefined }
      const existing = await findHarnessWorkspace(this.d.client, folder)
      this.binding = { folder, harness: existing }
    }
    if (!this.binding.confirmed) {
      const first = this.binding.harness
      const ws = await ensureHarnessWorkspace(this.d.client, this.binding)
      this.d.setState({ workspace: workspaceToUi(ws) })
      // Sessions list is out of date now (new workspace has none)
      if (!first) {
        this.sessions = []
        this.d.setState({ sessions: sessionsToUi(this.sessions, sessionLabel) })
      } else {
        await this.refreshSessions()
      }
    }
    return this.binding.harness
  }

  async stopActive(): Promise<void> {
    if (!this.activeSessionId) return
    try { await this.d.client.cancel(this.activeSessionId) } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.notifyError(msg)
    }
  }

  /** Insert an `@path` mention for one file (explorer context menu / commands).
   *  Workspace-relative, because that is what the host resolves mentions against. */
  addToChat(uri: vscode.Uri): void {
    this.insertMention(uri)
  }

  /** Insert an `@path:L<n>-L<m>` mention targeting the current selection. */
  sendSelection(): void {
    const editor = this.d.vscodeAPI.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) {
      this.d.notifyError('No text selected in the active editor.')
      return
    }
    this.insertMention(editor.document.uri, {
      lineStart: editor.selection.start.line + 1,
      lineEnd: editor.selection.end.line + 1,
    })
  }

  /**
   * Append a mention token to the composer input.
   *
   * Quotes when the path needs it (whitespace), so the inserted text is valid
   * under the grammar the host completes against.
   */
  private insertMention(uri: vscode.Uri, range: { lineStart?: number; lineEnd?: number } = {}): void {
    const relPath = this.d.vscodeAPI.workspace.asRelativePath(uri)
    const mention = formatMention(relPath, { ...range })
    if (mention === undefined) {
      this.d.notifyError(`Cannot reference ${relPath}: the path cannot be written as an @ mention.`)
      return
    }
    this.d.provider?.postToWebview({ kind: 'appendInput', text: `${mention} ` })
  }

  // ─── `@` completion (host-served fileReferences/list) ──────────────────────

  /** Query the host for `@` candidates. Answers go to UiState.refCandidates. */
  async queryFileReferences(query: string): Promise<void> {
    // Record the request BEFORE awaiting: the guard below compares the reply's
    // query against this, not against the last query that happened to land.
    this.refQueryLatest = query
    const sid = this.activeSessionId
    if (sid === undefined || !this.d.client.supports('fileReferences/list')) {
      this.d.setState({ refCandidates: [], refQuery: query })
      return
    }
    let candidates: FileReferenceCandidate[]
    try {
      candidates = await this.d.client.listFileReferences(sid, query)
    } catch (e) {
      this.d.log.error('fileReferences/list: ' + (e instanceof Error ? e.message : String(e)))
      candidates = []
    }
    // Stale-response guard: a slow early query must not overwrite the list a
    // later keystroke already replaced.
    if (this.refQueryLatest !== query) return
    // `refQuery` and `refCandidates` must be published TOGETHER — the composer
    // only draws a batch whose query matches the token it is asking about, so
    // updating the candidates without the query leaves the menu hidden.
    this.d.setState({ refCandidates: candidates.slice(0, 50), refQuery: query })
  }

  // ─── v0.0.9 surfaces (catalog / commands / projections) ──────────────────

  /** Fetch the model catalog once per connect (capability-gated). */
  private async fetchModelCatalog(): Promise<void> {
    if (!this.d.client.supports('session/modelCatalog')) return
    try {
      const catalog = await this.d.client.modelCatalog()
      this.d.setState({ modelCatalog: catalog })
      this.d.pushState()
    } catch (e) {
      this.d.log.error('modelCatalog: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** Fetch the slash-command registry for the active session (capability-gated). */
  private async fetchCommands(sessionId: SessionId): Promise<void> {
    if (!this.d.client.supports('commands/list')) {
      this.d.setState({ commands: [] })
      return
    }
    try {
      const commands = await this.d.client.listCommands(sessionId)
      this.d.setState({ commands })
      this.d.pushState()
    } catch (e) {
      this.d.log.error('commands/list: ' + (e instanceof Error ? e.message : String(e)))
      this.d.setState({ commands: [] })
    }
  }

  /** Pull queue + usage projections for the active session out of the session list. */
  private syncSessionProjection(): void {
    const sid = this.activeSessionId
    if (sid === undefined) return
    const summary = this.sessions.find(s => s.sessionId === sid)
    const values = summary?.projections?.values
    if (values === undefined) return

    // Queued messages: `inbox.next-turn` items carry an id plus text content.
    const inbox = values.inbox
    const nextTurn = (inbox !== null && typeof inbox === 'object' ? (inbox as Record<string, unknown>).nextTurn : undefined)
      ?? (inbox !== null && typeof inbox === 'object' ? (inbox as Record<string, unknown>)['next-turn'] : undefined)
    if (Array.isArray(nextTurn)) {
      const items: QueueItemView[] = []
      for (const entry of nextTurn) {
        if (entry === null || typeof entry !== 'object') continue
        const r = entry as Record<string, unknown>
        const id = typeof r.id === 'string' ? r.id : typeof r.itemId === 'string' ? r.itemId : undefined
        if (id === undefined) continue
        items.push({ id, text: queueItemText(r) })
      }
      const prev = this.d.getState().queue ?? []
      if (JSON.stringify(prev) !== JSON.stringify(items)) {
        this.d.setState({ queue: items })
      }
    }

    // Token usage + session stats projections.
    const projection: SessionUsageProjection = {
      ...(values.tokenUsage !== undefined ? { tokenUsage: values.tokenUsage as SessionUsageProjection['tokenUsage'] } : {}),
      ...(values.sessionStats !== undefined ? { sessionStats: values.sessionStats as SessionUsageProjection['sessionStats'] } : {}),
      ...(values.contextBreakdown !== undefined ? { contextBreakdown: values.contextBreakdown as SessionUsageProjection['contextBreakdown'] } : {}),
    }
    if (this.usage.applyProjection(projection)) {
      this.d.setState({ sessionUsage: this.usage.snapshot() })
    }
  }

  /** Debounce-guarded async variant used from the event path. */
  private syncTimer: ReturnType<typeof setTimeout> | undefined
  private syncSessionProjectionAsync(): void {
    if (this.syncTimer !== undefined) return
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined
      void this.refreshSessions()
    }, 300)
  }

  // ─── control surface ───────────────────────────────────────────────────────
  /**
   * Run one control write, turning transport/rpc failures into a message the
   * user can act on instead of a silent no-op.
   */
  private async runControl<T>(op: () => Promise<T>, label: string): Promise<T | undefined> {
    try {
      return await op()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error(`control/${label}: ${msg}`)
      this.d.notifyError(msg)
      return undefined
    }
  }

  /**
   * Flip plan mode.
   *
   * The write path is `/plan`, which toggles the host's wanted state — so a
   * click for a state we are already in must do nothing, not toggle twice.
   */
  private async setPlanMode(desired: boolean): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    if (this.control.snapshot().planActive === desired) {
      this.d.notifyInfo(`DeepSeek Harness: plan mode is already ${desired ? 'on' : 'off'}.`)
      return
    }
    await this.runControl(() => this.d.client.togglePlanMode(sid), 'plan')
  }

  /** Flip plan mode to the opposite of the host's current state. */
  async togglePlanMode(): Promise<void> {
    await this.setPlanMode(this.control.snapshot().planActive !== true)
  }

  /** Switch the permission preset by name (`read-only`, `workspace-write`, …). */
  async setPreset(preset: string): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    await this.runControl(() => this.d.client.setPermissionPreset(sid, preset), 'permission')
  }

  /**
   * Select the model + reasoning effort for future turns (rc.2
   * `session/selectModel`). Provider is required by the host's descriptor; the
   * webview sends the resolved `provider|model` pair from the catalog.
   */
  async setModel(provider: string, model: string, reasoningEffort?: string): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    const res = await this.runControl(
      () => this.d.client.selectModel(sid, provider, model, reasoningEffort),
      'selectModel',
    )
    if (res !== undefined) {
      this.d.notifyInfo(`DeepSeek Harness: model set to ${res.selected.model}`
        + (res.selected.reasoningEffort !== undefined ? ` (effort ${res.selected.reasoningEffort})` : '') + '.')
    }
  }

  /** Apply one action to a queued message (steer into the turn, or remove). */
  async queueAction(
    itemId: string,
    action: { kind: 'steer' } | { kind: 'remove' },
  ): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    const done = await this.runControl(() => this.d.client.updateQueue(sid, itemId, action), 'updateQueue')
    if (done === undefined) return
    // The inbox projection changes server-side; re-read it instead of guessing.
    await this.refreshSessions()
  }

  /** Fork the active session into a sibling and switch to it. */
  async forkActive(): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    const child = await this.runControl(() => this.d.client.forkSession(sid), 'fork')
    if (typeof child !== 'string' || child.length === 0) return
    await this.refreshSessions()
    await this.selectSession(child)
    this.d.notifyInfo('DeepSeek Harness: forked into a new session.')
  }

  // ─── F6: session search ──────────────────────────────────────────────────────
  async doSearch(query: string): Promise<void> {
    const q = query.trim()
    if (q.length === 0) { this.search = null; this.d.setState({ search: null }); return }
    if (!this.d.client.supports('session/search')) {
      this.search = { query: q, results: [], disabled: false, error: 'This host does not serve session/search.' }
      this.d.setState({ search: this.search })
      return
    }
    try {
      const res = await this.d.client.searchSessions(q)
      this.search = { query: q, results: res.results ?? [] }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Host deployment may have search disabled (local dsh web does).
      const disabled = /search is disabled|not (enabled|available)|search.*off/i.test(msg)
      this.search = { query: q, results: [], error: msg, disabled }
    }
    this.d.setState({ search: this.search })
  }

  // ─── composer attachments ──────────────────────────────────────────────────

  /** The chips the webview renders. Metadata only — see {@link HeldAttachment}. */
  private pendingChips(): PendingChip[] {
    return this.pending.map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      bytes: p.bytes,
      ...(p.mediaType === undefined ? {} : { mediaType: p.mediaType }),
    }))
  }

  /**
   * Take attachments handed up by the composer (paste, drop, or the file
   * picker) and hold them for the next prompt.
   *
   * Validated here rather than at the host: the four admitted raster formats,
   * the 20 MiB per-image ceiling and the 20-images-per-message ceiling are all
   * upstream constants, so a bad pick fails immediately with a sentence instead
   * of after a round trip.
   */
  addPendingItems(items: readonly PendingAttachmentPayload[]): void {
    let images = this.pending.filter((p) => p.kind === 'image').length
    for (const item of items) {
      const bytes = base64ByteLength(item.data)
      const name = item.name.trim() === '' ? defaultAttachmentName(item.kind, item.mediaType) : item.name.trim()
      const reuse = item.key !== undefined
        && !this.pending.some((p) => p.id === item.key)
        && !items.some((other) => other !== item && other.key === item.key)
      const id = reuse ? (item.key as string) : nextAttachmentId()
      if (item.kind === 'image') {
        const mediaType = normalizeImageMediaType(item.mediaType, name)
        if (mediaType === undefined) {
          this.d.notifyError(`${name}: only PNG, JPEG, WebP and GIF images can be sent to the harness.`)
          continue
        }
        if (bytes > MAX_IMAGE_BYTES) {
          this.d.notifyError(`${name} is ${formatMiB(bytes)} — the host caps a single image at 20 MB.`)
          continue
        }
        if (images >= MAX_IMAGES_PER_MESSAGE) {
          this.d.notifyError(`At most ${String(MAX_IMAGES_PER_MESSAGE)} images fit in one message.`)
          break
        }
        images += 1
        this.pending.push({ id, kind: 'image', name, bytes, mediaType, data: item.data })
        continue
      }
      this.pending.push({ id, kind: 'file', name, bytes, data: item.data })
    }
    this.d.log.info(`attachments: holding ${String(this.pending.length)} item(s)`)
    this.d.setState({ pending: this.pendingChips() })
    this.d.pushState()
  }

  removePending(id: string): void {
    const next = this.pending.filter((p) => p.id !== id)
    if (next.length === this.pending.length) return
    this.pending = next
    this.d.setState({ pending: this.pendingChips() })
    this.d.pushState()
  }

  clearPending(): void {
    if (this.pending.length === 0) return
    this.pending = []
    this.d.setState({ pending: [] })
    this.d.pushState()
  }

  /**
   * Everything the prompt needs, or a throw the caller reports verbatim.
   *
   * Images need nothing extra: they ride the prompt as base64 parts and the host
   * promotes them to durable refs during admission. Files are staged first, over
   * a route of their own — a prompt part can only ever carry a receipt, never
   * bytes.
   */
  private async stagePending(sessionId: SessionId): Promise<{
    images: { mediaType: ImageMediaType; data: string; name: string }[]
    files: { receiptId: string }[]
  }> {
    const images: { mediaType: ImageMediaType; data: string; name: string }[] = []
    const files: { receiptId: string }[] = []
    for (const held of this.pending) {
      if (held.kind === 'image') {
        images.push({ mediaType: held.mediaType ?? 'image/png', data: held.data, name: held.name })
        continue
      }
      const value = await this.d.client.uploadFile(sessionId, held.name, Buffer.from(held.data, 'base64'))
      if (value.receiptId === undefined) {
        throw new Error(`The host accepted ${held.name} but returned no receipt.`)
      }
      files.push({ receiptId: value.receiptId })
    }
    return { images, files }
  }

  /** Ask the host to compact the session's context. */
  async compactActive(): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    await this.runControl(() => this.d.client.compactSession(sid), 'compact')
  }

  /** Archive the active session and drop back to the newest remaining one. */
  async archiveActive(): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    const done = await this.runControl(() => this.d.client.archiveSession(sid), 'archive')
    if (done === undefined) return
    this.activeSessionId = undefined
    this.model = undefined
    this.control.reset()
    this.d.setState({ activeSessionId: undefined, snapshot: undefined, control: this.control.snapshot() })
    await this.refreshSessions()
    this.d.notifyInfo('DeepSeek Harness: session archived.')
  }

  /** Rename the active session from an input box (also used by the command). */
  async renameActive(): Promise<void> {
    const sid = this.activeSessionId
    if (sid === undefined) return
    // Pre-fill with the title the host is currently projecting, so the box
    // starts as "edit this" rather than "retype from scratch".
    const currentTitle = (this.sessions.find(s => s.sessionId === sid)
      ?.projections?.values.title ?? undefined) as string | undefined
    const next = await this.d.vscodeAPI.window.showInputBox({
      title: 'DeepSeek Harness: Rename session',
      prompt: 'A renamed session is pinned — the host stops regenerating its title.',
      placeHolder: 'Session title',
      value: currentTitle,
      ignoreFocusOut: true,
    })
    if (next === undefined || next.trim() === '') return
    const result = await this.runControl(() => this.d.client.renameSession(sid, next.trim()), 'rename')
    if (result !== undefined) this.d.notifyInfo(`DeepSeek Harness: renamed to “${result.title}”.`)
  }

  async toggleSystemMessages(): Promise<void> {
    const next = !this.d.getState().showSystemMessages
    this.model?.setShowSystemMessages(next)
    this.d.setState({
      showSystemMessages: next,
      snapshot: this.model?.snapshot() ?? this.d.getState().snapshot,
    })
    this.d.pushState()
  }

  /** Called by extension.ts on config change for showSystemMessages. */
  applyConfigShowSystem(v: boolean): void {
    if (v === this.d.getState().showSystemMessages) return
    this.model?.setShowSystemMessages(v)
    this.d.setState({
      showSystemMessages: v,
      snapshot: this.model?.snapshot() ?? this.d.getState().snapshot,
    })
    this.d.pushState()
  }

  /** Replace the underlying client (e.g. on host/port config change).
   *  The caller owns the connect flow and must re-run `start()`. */
  replaceClient(next: HarnessClient): void {
    this.d.client = next
    this.disposables.dispose()
    // Rebuild state on the new client; connect flow handled by the caller.
  }

  // ─── helper: push client-derived state (onStateChange + onMuxStatusChange) ──
  private pushFromClient(): void {
    const conn = connectionToUi(this.d.client.getState(), this.muxStatus)
    this.d.setState({
      connection: conn.connection,
      hostInfo: conn.hostInfo,
      errorMessage: conn.errorMessage,
      muxStatus: conn.muxStatus,
      // What the host serves decides which controls the panel may offer.
      capabilities: { ...this.d.client.capabilities() },
    })
    this.d.pushState()
  }
}

/** Extract a display text from one queued inbox item (defensive). */
function queueItemText(item: Record<string, unknown>): string {
  const content = item.content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const part of content) {
      if (part !== null && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
        const t = (part as Record<string, unknown>).text
        if (typeof t === 'string') texts.push(t)
      }
    }
    if (texts.length > 0) {
      const joined = texts.join('\n')
      return joined.length > 200 ? joined.slice(0, 199) + '…' : joined
    }
  }
  const text = item.text
  if (typeof text === 'string' && text.length > 0) return text.length > 200 ? text.slice(0, 199) + '…' : text
  return '(queued message)'
}

