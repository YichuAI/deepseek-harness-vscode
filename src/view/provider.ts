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
import { STYLES } from './styles.ts'
import { HTML_SKELETON } from './html.ts'
import { CLIENT_SCRIPT } from './client.ts'

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
  renderVersion: number
}

/** Actions the webview posts back to the extension. */
export type WebviewAction =
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'newSession' }
  | { type: 'refreshSessions' }
  | { type: 'sendPrompt'; text: string; context?: import('../harness/protocol.ts').PromptContext }
  | { type: 'stop' }
  | { type: 'openWebUI' }
  | { type: 'toggleSystemMessages' }
  | { type: 'moveToSecondarySideBar' }
  | { type: 'appendInput'; text: string }
  | { type: 'reviewAcceptFile'; reviewId: string; filePath: string }
  | { type: 'reviewRejectFile'; reviewId: string; filePath: string }
  | { type: 'reviewRejectHunk'; reviewId: string; filePath: string; hunkId: string }
  | { type: 'reviewOpenDiff'; reviewId: string; filePath: string }
  | { type: 'reviewAcceptAll'; reviewId: string }
  | { type: 'reviewRejectAll'; reviewId: string }
  | { type: 'approvalRespond'; rpcId: string; outcome: 'allowed-once' | 'rejected' }

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
      this.deps.dispatch(msg)
    })
    view.onDidDispose(() => { this.view = undefined })
    this.deps.onState((s) => this.postState(s))
    this.postState(this.deps.getState())
  }

  private postState(state: UiState): void {
    const withIcon: UiState = this.brandIconUri ? { ...state, brandIconUri: this.brandIconUri } : state
    void this.view?.webview.postMessage({ kind: 'state', state: withIcon })
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
    // Fallback: plain-text stub so the UI degrades gracefully.
    this.markdownItSource = `window.MarkdownIt = function(){return{render:function(s){return String(s==null?'':s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/\\n/g,'<br/>')}}};`
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
