/**
 * Webview sidebar provider (v0.0.2 — split).
 *
 * THIS MODULE IS NOW ONLY:
 *   • WebviewViewProvider registration
 *   • HTML composition (styles.ts + html.ts + markdown-it UMD + client.ts)
 *   • State push / action dispatch bridge
 *
 * Presentation helpers live in physical siblings: styles.ts, html.ts,
 * client.ts, toolPresentation.ts. Render semantics live in ConversationModel.
 * Orchestration lives in AppController.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'
import type { HarnessClient, ConnectionState } from '../harness/client.ts'
import type { MuxStatus } from '../harness/events.ts'
import type { SessionSummary, WorkspaceView } from '../harness/protocol.ts'
import type { ConversationItem, SessionSnapshot } from '../conversation/types.ts'
import { STYLES } from './styles.ts'
import { HTML_SKELETON } from './html.ts'
import { CLIENT_SCRIPT } from './client.ts'
import { computeSnapshotDelta, needsFullSnapshot, sentFrom, type SentTranscript } from './snapshot-delta.ts'

/**
 * What changed in the transcript since the previous push.
 *
 * `items` are the ones whose `rev` moved (edits and appends alike); `removed`
 * are uids that no longer exist. Both are keyed by `uid`, the same identity the
 * renderer reconciles on, so the client can merge without re-deriving anything.
 */
export interface SnapshotDelta {
  sessionId: string
  title?: string
  running: boolean
  renderVersion: number
  /** Mirrors `SessionSnapshot.systemMessageCount`, which the badge reads. */
  systemMessageCount: number
  items: ConversationItem[]
  removed: string[]
}

/** UI state pushed to the webview (full snapshot each time). */
export interface UiState {
  connection: 'disconnected' | 'connecting' | 'connected' | 'error'
  hostInfo?: { version?: string; home?: string; provider?: string; model?: string }
  errorMessage?: string
  muxStatus?: string
  workspace?: { workspaceId: string; title: string; path: string } | null
  sessions: Array<{ sessionId: string; label: string; running: boolean; blank: boolean }>
  activeSessionId?: string
  snapshot?: import('../conversation/types.ts').SessionSnapshot
  sending: boolean
  canStop: boolean
  showSystemMessages: boolean
  systemMessageCount: number
  brandIconUri?: string
  reviews?: import('../review/types.ts').ReviewSummary[]
  approvals?: import('../approval/types.ts').ApprovalSummary[]
  /** Pending `ask_user_question` requests for the current session. */
  questions?: import('../approval/types.ts').QuestionSummary[]
  /** Control surface folded from the session's knob/goal/todo events. */
  control?: import('../conversation/control.ts').ControlState
  /** `ns/method` → served by this host. Absent key means "probed and missing". */
  capabilities?: Record<string, boolean>
  /** Model catalog (rc.2 `session/modelCatalog`) — gated by capability. */
  modelCatalog?: import('../harness/protocol.ts').ModelCatalog
  /** Slash-command registry (rc.2 `commands/list`) for the active session. */
  commands?: import('../harness/protocol.ts').CommandDescriptor[]
  /** Queued messages (rc.2 `inbox.next-turn` projection) for the active session. */
  queue?: import('../harness/protocol.ts').QueueItemView[]
  /** Session token/usage totals (folded events + host projections). */
  sessionUsage?: import('../conversation/usage.ts').SessionUsageState
  /** F6: session search panel state. */
  search?: import('../app/state.ts').SearchState | null
  /** F7: ring buffer of recently observed mux frames. */
  eventLog?: import('../app/state.ts').InspectorFrame[]
  /** `@` completion candidates for the active session (`fileReferences/list`). */
  refCandidates?: import('../harness/protocol.ts').FileReferenceCandidate[]
  /** The path text these candidates answer for; also the stale-response guard. */
  refQuery?: string
  /** Auto-approve incoming approval requests (setting mirror). */
  autoApprove: boolean
  /**
   * The part of `snapshot` that changed since the last push.
   *
   * Present instead of `snapshot` once both sides agree on a session: the
   * transcript is 93% of a push and grows without bound, so re-sending all of it
   * for one streamed delta cost 82 KB at 40 turns. The webview keeps its own
   * copy and applies this.
   */
  snapshotDelta?: SnapshotDelta
  renderVersion: number
}

/** Actions the webview posts back to the extension. */
export type WebviewAction =
  | { type: 'connect' }
  /**
   * Boot-time nudge from the panel: connect if we are not already. Distinct
   * from `connect` because that one is a *forced* reconnect and must not run
   * just because a webview was created.
   */
  | { type: 'ensureConnected' }
  | { type: 'disconnect' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'refreshSessions' }
  | { type: 'sendPrompt'; text: string; steer?: boolean }
  | { type: 'stop' }
  | { type: 'openWebUI' }
  | { type: 'toggleSystemMessages' }
  | { type: 'moveToSecondarySideBar' }
  | { type: 'appendInput'; text: string }
  // ─── review (change reporting, NOT a gate) ─────────────────────────────────
  // There is deliberately no `reviewAccept*`: a review describes a mutation the
  // turn has already made to disk, so "accepting" it was a no-op with a button.
  // What remains is the half that does something — seeing it, and undoing it.
  | { type: 'reviewRejectFile'; reviewId: string; filePath: string }
  | { type: 'reviewRejectHunk'; reviewId: string; filePath: string; hunkId: string }
  | { type: 'reviewOpenDiff'; reviewId: string; filePath: string }
  | { type: 'reviewRejectAll'; reviewId: string }
  // ─── end-of-turn changed files (`workspace/changes`) ───────────────────────
  /**
   * Open the native editor on a path mentioned in the transcript or on the
   * changed-files card. `line` is 1-based and optional; when present the editor
   * scrolls to it and selects the line.
   */
  | { type: 'openFile'; path: string; line?: number }
  /** Open the native diff for one file of one turn's changed-files card. */
  | { type: 'changesOpenDiff'; turn: number; index: number }
  /** Undo one file of a turn's changes (matched to the turn's reviews). */
  | { type: 'changesRevertFile'; turn: number; path: string }
  /** Undo every file this turn changed that we hold a review for. */
  | { type: 'changesRevertTurn'; turn: number }
  | { type: 'approvalRespond'; rpcId: string; outcome: 'allowed-once' | 'rejected' }
  /**
   * Hand a waterfall back to the Host without answering it (stays pending for
   * the Web UI). Used both by "answer in the browser" and by an approval the
   * sidebar declines to grant.
   */
  | { type: 'waterfallDelegate'; rpcId: string }
  // ─── user questions (`user-questions/request`) ─────────────────
  | { type: 'questionAnswer'; rpcId: string; answers: QuestionAnswerPayload[] }
  // ─── control surface ────────────────────────────────────────────────────────
  | { type: 'controlPlan'; active: boolean }
  | { type: 'controlPreset'; preset: string }
  | { type: 'controlModel'; provider: string; model: string; reasoningEffort?: string }
  | { type: 'controlFork' }
  | { type: 'controlCompact' }
  | { type: 'controlArchive' }
  | { type: 'controlRename' }
  // ─── queued messages (rc.2 session/updateQueue) ─────────────
  | { type: 'queueSteer'; itemId: string }
  | { type: 'queueRemove'; itemId: string }
  // ─── F6 session search ──────────────────────────────────────
  | { type: 'searchSessions'; query: string }
  | { type: 'searchClear' }
  // ─── F7 live event inspector ───────────────────────────────
  | { type: 'inspectorClear' }
  /**
   * The inspector panel opened or closed.
   *
   * Reported upwards because the panel is pure webview DOM: only that side
   * knows whether it is on screen, and therefore whether the frame ring buffer
   * (up to 300 truncated frames) is worth riding every state push.
   */
  | { type: 'inspectorToggle'; open: boolean }
  /**
   * The one install affordance, and it is only rendered while the panel is in
   * the failed state.
   *
   * Carries no payload on purpose: which route to take, and therefore whether
   * this opens a page or copies a command, is decided extension-side from the
   * same `ConnectionHint` that produced the button. A webview-supplied URL or
   * command would be an injection surface bought for nothing.
   */
  | { type: 'install' }
  /**
   * Press the repair the diagnosis named, next to the install affordance.
   *
   * Also payload-free, and for the same reason: `ConnectionHint.repair` holds
   * the command id, it is decided extension-side, and a webview that could name
   * a command could run any of them. The button only ever says "the one you
   * already decided on".
   */
  | { type: 'runRepair' }
  // ─── `@` completion (host-served fileReferences/list) ──────
  | { type: 'refsQuery'; query: string }
  // ─── composer attachments (images ride the prompt; files are staged) ──
  | { type: 'pendingAdd'; items: PendingAttachmentPayload[] }
  | { type: 'pendingRemove'; id: string }
  | { type: 'pendingClear' }
  // ─── F8 attach files (routes to the extension-host file picker) ──
  | { type: 'attachFile' }

/**
 * One attachment handed up from the composer. Bytes travel exactly once, here —
 * `UiState.pending` carries only chips, because `pushState` runs on every
 * streamed chunk and re-sending a screenshot's base64 per chunk would be absurd.
 */
export interface PendingAttachmentPayload {
  kind: 'image' | 'file'
  name: string
  mediaType?: string
  /** Base64 of the exact file bytes. */
  data: string
  /**
   * Composer-side identity, when the webview already minted one. It lets the
   * composer keep a local blob preview keyed by the very id the chip comes back
   * with, so a screenshot is never round-tripped as base64 just to be shown.
   */
  key?: string
}

/**
 * The human's answer to one question, as the webview hands it up.
 *
 * `selected` carries option LABELS (not indices): that is what the Host's
 * `AskUserQuestionAnswerItem` records, and it is what the transcript will show
 * later, so translating labels back out of a positional encoding here would
 * only add a place for the two to disagree.
 */
export interface QuestionAnswerPayload {
  id: string
  selected: string[]
  custom?: string
}

export interface ProviderDeps {
  client: HarnessClient
  getState: () => UiState
  onState: (listener: (s: UiState) => void) => vscode.Disposable
  dispatch: (action: WebviewAction) => void
  extensionUri: vscode.Uri
}

export class HarnessWebviewViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'deepseekHarness.sessionView'
  private view: vscode.WebviewView | undefined
  /**
   * What this webview already holds: sessionId plus item uid → the `rev` it was
   * sent with.
   *
   * Kept on the provider rather than derived per push, because the whole point
   * is to avoid walking and serialising the transcript on every delta. Reset
   * whenever the view is recreated, since the new webview has nothing.
   */
  private sent: SentTranscript = { sessionId: undefined, items: new Map() }
  private brandIconUri: string | undefined
  /** Cached markdown-it UMD source (loaded once on first resolve). */
  private markdownItSource: string | undefined

  constructor(private readonly deps: ProviderDeps) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.deps.extensionUri],
    }
    const iconUri = vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'icon.png')
    this.brandIconUri = view.webview.asWebviewUri(iconUri).toString()
    view.webview.html = this.html(view.webview)
    view.webview.onDidReceiveMessage((msg: WebviewAction) => {
      // F8: attaching files needs an extension-host file picker (webview cannot
      // read local disk); route the button to the registered command.
      if (msg.type === 'attachFile') {
        void vscode.commands.executeCommand('deepseekHarness.attachFile')
        return
      }
      this.deps.dispatch(msg)
    })
    view.onDidDispose(() => {
      this.view = undefined
      // The next webview starts with nothing; a delta against a cache that no
      // longer exists would render a one-item conversation.
      this.sent = { sessionId: undefined, items: new Map() }
    })
    this.deps.onState((s) => this.postState(s))
    this.postState(this.deps.getState())
  }

  private postState(state: UiState): void {
    const withIcon: UiState = this.brandIconUri ? { ...state, brandIconUri: this.brandIconUri } : state
    const view = this.view
    if (view === undefined) return

    const snap = state.snapshot
    if (snap === undefined) {
      this.sent = { sessionId: undefined, items: new Map() }
      void view.webview.postMessage({ kind: 'state', state: withIcon })
      return
    }

    // A first paint, or a different session: nothing in common with what the
    // webview holds, so send the whole thing and start tracking from it.
    if (needsFullSnapshot(this.sent, snap)) {
      this.sent = sentFrom(snap)
      void view.webview.postMessage({ kind: 'state', state: withIcon })
      return
    }

    const { changed, removed, next } = computeSnapshotDelta(this.sent, snap)
    this.sent = next

    // The rest of the state still goes out every time — status, approvals,
    // usage — but the transcript only does when it actually moved. When nothing
    // moved, the message carries no transcript at all and the webview keeps the
    // copy it already has.
    void view.webview.postMessage({
      kind: 'state',
      state: {
        ...withIcon,
        snapshot: undefined,
        ...(changed.length === 0 && removed.length === 0
          ? {}
          : {
            snapshotDelta: {
              sessionId: snap.sessionId,
              title: snap.title,
              running: snap.running,
              renderVersion: snap.renderVersion,
              systemMessageCount: snap.systemMessageCount,
              items: changed,
              removed,
            } satisfies SnapshotDelta,
          }),
      },
    })
  }

  /** Send an arbitrary message to the webview (e.g. appendInput from menu commands). */
  postToWebview(msg: Record<string, unknown>): void {
    void this.view?.webview.postMessage(msg)
  }

  // ─── HTML composition ──────────────────────────────────────────────────────
  private html(webview: vscode.Webview): string {
    const nonce = getNonce()
    const csp = [
      'default-src \'none\'',
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join('; ')

    const mdSrc = this.getMarkdownItSource()

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>DeepSeek Harness</title>
<style>
${STYLES}
</style>
</head>
<body>
${HTML_SKELETON}
<script nonce="${nonce}">
${mdSrc}
</script>
<script nonce="${nonce}">
${CLIENT_SCRIPT}
</script>
</body>
</html>`
  }

  private getMarkdownItSource(): string {
    if (this.markdownItSource) return this.markdownItSource
    // Try multiple candidate locations:
    //   1. <extension>/media/markdown-it.umd.min.js  — packaged in VSIX
    //   2. <extension>/node_modules/...              — dev mode (bundled dist/)
    //   3. <extension>/../node_modules/...           — dev mode (unbundled)
    const candidates = [
      path.join(__dirname, '..', 'media', 'markdown-it.umd.min.js'),
      path.join(__dirname, '..', 'node_modules', 'markdown-it', 'dist', 'browser', 'markdown-it.umd.min.js'),
      path.join(__dirname, '..', '..', 'node_modules', 'markdown-it', 'dist', 'browser', 'markdown-it.umd.min.js'),
    ]
    for (const candidate of candidates) {
      try {
        const src = fs.readFileSync(candidate, 'utf8')
        // UMD exposes `markdownit` global; our client script uses `MarkdownIt`.
        this.markdownItSource = src + '\n;window.MarkdownIt = window.markdownit;'
        return this.markdownItSource
      } catch { /* try next */ }
    }
    // Fallback: plain-text stub so the UI degrades gracefully. It must mirror
    // markdown-it's public shape (`renderer.rules`) closely enough that the
    // client's link-renderer override does not throw — a stub that crashes the
    // boot sequence is not a graceful degradation.
    this.markdownItSource = `window.MarkdownIt = function(){return{renderer:{rules:{}},render:function(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\\n/g,'<br/>')}}};`
    return this.markdownItSource
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let s = ''
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

// Re-exported pure helpers that AppController uses to build UiState slices.
export { connectionToUi, sessionsToUi, workspaceToUi } from '../app/state.ts'
