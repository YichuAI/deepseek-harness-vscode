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
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import type { HarnessClient } from '../harness/client.ts'
import type { MuxStatus } from '../harness/events.ts'
import type { CallId, FileReference, PromptContext, RpcId, SessionId, SessionSummary, WorkspaceView } from '../harness/protocol.ts'
import { ConversationModel, sessionLabel } from '../conversation/model.ts'
import { ControlSurface } from '../conversation/control.ts'
import type { ConversationItem, SessionSnapshot } from '../conversation/types.ts'
import {
  findHarnessWorkspace, ensureHarnessWorkspace, pickVsCodeFolder,
  type WorkspaceBinding,
} from '../workspace/binding.ts'
import type { UiState } from './state.ts'
import { connectionToUi, sessionsToUi, workspaceToUi } from './state.ts'
import type { WebviewAction } from '../view/provider.ts'
import type { HarnessWebviewViewProvider } from '../view/provider.ts'
import { CompositeDisposable } from '../disposable.ts'
import { collectEditorContext, mergeContext, parseAtFileReferences, renderContextBlock } from '../context/collector.ts'
import { ReviewController } from '../review/controller.ts'
import { ReviewVirtualDocumentProvider } from '../review/virtualDocument.ts'
import { ApprovalStore } from '../approval/store.ts'

export interface ControllerDeps {
  client: HarnessClient
  vscodeAPI: {
    window: typeof vscode.window
    workspace: typeof vscode.workspace
  }
  getState: () => UiState
  setState: (patch: Partial<UiState>) => void
  bump: () => void
  pushState: () => void
  notifyError: (msg: string) => void
  notifyInfo: (msg: string) => void
  openHarnessHome: () => void
  moveToSecondarySideBar: () => Promise<void>
  log: { info: (m: string) => void; error: (m: string) => void }
  provider?: HarnessWebviewViewProvider
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
  /** Tracks which sessions have already received their first prompt (with context). */
  private firstPromptSent = new Set<SessionId>()

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
      case 'disconnect': this.doDisconnect(); break
      case 'selectSession': await this.selectSession(action.sessionId); break
      case 'newSession': await this.newSession(); break
      case 'refreshSessions': await this.refreshSessions(); break
      case 'sendPrompt': await this.sendPrompt(action.text, action.context); break
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
      case 'controlPlan': await this.setPlanMode(action.active); break
      case 'controlPreset': await this.setPreset(action.preset); break
      case 'controlFork': await this.forkActive(); break
      case 'controlCompact': await this.compactActive(); break
      case 'controlArchive': await this.archiveActive(); break
      case 'controlRename': await this.renameActive(); break
    }
  }

  async doConnect(): Promise<void> {
    try {
      await this.d.client.connect()
      await this.discoverFolder()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('connect failed: ' + msg)
      this.d.notifyError(msg)
    }
    this.d.pushState()
  }

  doDisconnect(): void {
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
    this.firstPromptSent.clear()
    this.d.setState({ snapshot: undefined, activeSessionId: undefined, sessions: [], workspace: undefined, reviews: undefined, approvals: undefined })
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
      this.d.pushState()
    } catch (e) {
      this.d.log.error('list sessions: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async selectSession(sessionId: SessionId): Promise<void> {
    this.activeSessionId = sessionId
    this.control.reset()
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
      this.disposables.add(this.d.client.subscribe(sessionId, (frames) => {
        for (const f of frames) this.applyMuxFrame(f)
        this.d.pushState()
      }))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.log.error('history/subscribe: ' + msg)
      this.d.notifyError(msg)
    }
    this.pushReviewApprovalState()
  }

  private async refetchHistory(sessionId: SessionId): Promise<void> {
    if (!this.model) return
    const h = await this.d.client.getHistory(sessionId, { maxMessages: 50 })
    const events = h.events.map(e => e.event)
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
      this.d.setState({ snapshot: this.model.snapshot() })
      const snap = this.d.getState().snapshot
      this.d.setState({ canStop: snap?.running === true })
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

  /** Handle approval frames from the dedicated approval listener (has the waterfall eventId). */
  private handleApprovalFrame(frame: unknown, eventId: RpcId): void {
    const f = frame as {
      type: string
      sessionId?: SessionId
      approvalId?: string
      toolName?: string
      callId?: CallId
      reason?: string
      outcome?: string
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
      return
    }
    if (f.type === 'approval/resolved' && f.approvalId) {
      this.approvalStore.resolve(eventId, f.outcome ?? 'resolved')
      this.d.log.info(`Approval resolved: outcome=${f.outcome ?? '—'}`)
      this.pushReviewApprovalState()
      return
    }
  }

  /** Answer an approval waterfall via `POST /api/$events/result`. */
  private async respondApproval(eventId: RpcId, outcome: 'allowed-once' | 'rejected'): Promise<void> {
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

  /** Push review and approval summaries to UiState. Also touches the model so
   *  the webview re-renders items (review/approval cards update). */
  private pushReviewApprovalState(): void {
    const sid = this.activeSessionId
    if (this.model) this.model.touch()
    this.d.setState({
      reviews: sid ? this.reviewController?.summaries(sid) : undefined,
      approvals: this.approvalStore.summaries(sid),
      snapshot: this.model?.snapshot(),
    })
    this.d.pushState()
  }

  async newSession(): Promise<void> {
    // Make sure workspace exists; user may be clicking this on a pending binding.
    const ws = this.binding?.harness ?? await this.ensureWorkspaceQuiet()
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

  /** Send a prompt. Implements lazy workspace+session create (v0.0.2 UX):
   *  1. If no folder → tell user.
   *  2. If no harness workspace → ensureHarnessWorkspace (no modal).
   *  3. If no session → create session.
   *  4. Parse @file refs from text (strip tokens → cleaned text).
   *  5. Read file content and inline into prompt text (always).
   *  6. Only on the FIRST prompt of a session, also attach `context` metadata
   *     (active file, selection). Subsequent prompts rely on inlined content.
   *  7. Optimistic echo (user text only) → send prompt.
   */
  async sendPrompt(rawText: string, _webviewContext?: PromptContext): Promise<void> {
    this.d.setState({ sending: true })
    this.d.pushState()
    try {
      // 1+2: ensure workspace
      let ws = this.binding?.harness
      if (!ws) {
        ws = await this.ensureWorkspaceQuiet()
        if (!ws) {
          if (this.noFolder === null) {
            this.d.notifyError('Open a VS Code folder first — DeepSeek Harness needs a workspace root.')
          }
          return
        }
      }
      // 3: ensure session
      if (!this.activeSessionId) {
        const created = await this.d.client.createSession({ workspaceId: ws.workspaceId })
        await this.refreshSessions()
        await this.selectSession(created.sessionId)
      }
      if (!this.activeSessionId) return

      // 4: parse @file references (strips tokens from text)
      const { cleanedText, files: atFileRefs } = parseAtFileReferences(rawText)
      const resolvedRefs = this.resolveFileRefs(atFileRefs)

      // Build display text for the optimistic echo (user-visible, no file content)
      let displayText = cleanedText
      if (!displayText && resolvedRefs.length > 0) {
        const names = resolvedRefs.map(f => {
          const parts = f.path.split('/')
          const name = parts[parts.length - 1] ?? f.path
          const range = f.lineStart ? `:L${f.lineStart}${f.lineEnd ? `-L${f.lineEnd}` : ''}` : ''
          return `${name}${range}`
        })
        displayText = `(See: ${names.join(', ')})`
      }

      // 5: read file content for each @file ref and inline into prompt text.
      //    File content ALWAYS goes into `content` (the user message), because
      //    the backend does not reliably process the `context` field.
      let promptText = displayText
      if (resolvedRefs.length > 0) {
        const fileBlocks: string[] = []
        for (const ref of resolvedRefs) {
          try {
            const raw = readFileSync(ref.path, 'utf8')
            const lines = raw.split('\n')
            const start = ref.lineStart ? ref.lineStart - 1 : 0
            const end = ref.lineEnd ?? lines.length
            const excerpt = lines.slice(start, end).join('\n')
            const label = ref.lineStart
              ? `${ref.path}:L${ref.lineStart}${ref.lineEnd ? `-L${ref.lineEnd}` : ''}`
              : ref.path
            fileBlocks.push(`<file path="${label}">\n${excerpt}\n</file>`)
          } catch (e) {
            this.d.log.error(`sendPrompt: failed to read @file ${ref.path} — ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        if (fileBlocks.length > 0) {
          promptText = fileBlocks.join('\n\n') + '\n\n' + displayText
        }
      }

      // 6: only attach editor context on the first prompt of this session — on
      //    later prompts the file content is already inlined above. DSH 0.1.6
      //    removed `payload.context`, so the metadata is rendered into the text.
      const isFirstPrompt = !this.firstPromptSent.has(this.activeSessionId)
      if (isFirstPrompt) {
        const editorCtx = collectEditorContext(this.d.vscodeAPI.window)
        const contextBlock = renderContextBlock(mergeContext(editorCtx, resolvedRefs))
        if (contextBlock) promptText = `${promptText}\n\n${contextBlock}`
        this.firstPromptSent.add(this.activeSessionId)
      }

      // 7: optimistic echo (user text only) → send prompt with inlined content
      this.model?.optimisticUserEcho(displayText)
      this.d.setState({ snapshot: this.model?.snapshot() })
      this.d.pushState()
      await this.d.client.prompt(
        this.activeSessionId,
        promptText,
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.d.notifyError(msg)
    } finally {
      this.d.setState({ sending: false })
      this.d.pushState()
    }
  }

  /** Resolve-or-create a workspace, without user prompts. Errors bubble.
   *  Updates this.binding.harness on success. */
  private async ensureWorkspaceQuiet(): Promise<WorkspaceView | undefined> {
    if (!this.binding) {
      // Try picking folder once (discovery may have been skipped)
      const folder = await pickVsCodeFolder(this.d.vscodeAPI.workspace, this.d.vscodeAPI.window)
      if (!folder) { this.noFolder = null; return undefined }
      const existing = await findHarnessWorkspace(this.d.client, folder)
      this.binding = { folder, harness: existing }
    }
    if (!this.binding.harness) {
      const ws = await ensureHarnessWorkspace(this.d.client, this.binding)
      this.d.setState({ workspace: workspaceToUi(ws) })
      // Sessions list is out of date now (new workspace has none)
      this.sessions = []
      this.d.setState({ sessions: sessionsToUi(this.sessions, sessionLabel) })
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

  /** Append an @file reference to the webview input (called from explorer/context menu).
   *  Uses workspace-relative path for readability. */
  addToChat(uri: vscode.Uri): void {
    const relPath = this.d.vscodeAPI.workspace.asRelativePath(uri)
    const token = `@file:${relPath.replace(/\\/g, '/')} `
    this.d.provider?.postToWebview({ kind: 'appendInput', text: token })
  }

  /** Append an @file reference (path + line range) for the current selection to the chat input.
   *  Uses workspace-relative path for readability. */
  sendSelection(): void {
    const editor = this.d.vscodeAPI.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) {
      this.d.notifyError('No text selected in the active editor.')
      return
    }
    const relPath = this.d.vscodeAPI.workspace.asRelativePath(editor.document.uri)
    const filePath = relPath.replace(/\\/g, '/')
    const startLine = editor.selection.start.line + 1
    const endLine = editor.selection.end.line + 1
    const range = startLine === endLine ? `:L${startLine}` : `:L${startLine}-L${endLine}`
    const token = `@file:${filePath}${range} `
    this.d.provider?.postToWebview({ kind: 'appendInput', text: token })
  }

  /** Resolve relative @file paths to absolute (backend needs absolute paths to read files). */
  private resolveFileRefs(refs: FileReference[]): FileReference[] {
    const wsRoot = this.binding?.folder?.uri.fsPath
    if (!wsRoot) return refs
    return refs.map(ref => ({
      ...ref,
      path: path.isAbsolute(ref.path) ? ref.path : path.resolve(wsRoot, ref.path).replace(/\\/g, '/'),
    }))
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
    const current = this.control.snapshot().goal === undefined ? undefined : undefined
    void current
    const next = await this.d.vscodeAPI.window.showInputBox({
      title: 'DeepSeek Harness: Rename session',
      prompt: 'A renamed session is pinned — the host stops regenerating its title.',
      placeHolder: 'Session title',
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


