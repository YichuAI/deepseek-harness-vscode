/**
 * DeepSeek Harness Connector — extension entry point.
 *
 * WIRING ONLY. This file should contain nothing beyond:
 *   • activate() / deactivate()
 *   • readConfig()
 *   • command registration
 *   • dependency instantiation + wiring
 *
 * Harness transport + auth → src/harness/{client,auth,remote,http,ws}.ts
 * Orchestration → AppController (src/app/controller.ts)
 * Conversation projection → ConversationModel (src/conversation/model.ts)
 * Workspace resolve/ensure → workspace/binding.ts
 * Webview composition → src/view/{provider,styles,html,client}.ts
 */

import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import { HarnessClient } from './harness/client.ts'
import { BrowserSessionAuth, type AuthStore } from './harness/auth.ts'
import { AppController, attachmentKindFor } from './app/controller.ts'
import { DSH_REVIEW_SCHEME } from './review/virtualDocument.ts'
import type { PendingAttachmentPayload, WebviewAction } from './view/provider.ts'
import { HarnessWebviewViewProvider, type UiState } from './view/provider.ts'
import { CompositeDisposable } from './disposable.ts'

const SECTION = 'deepseekHarness'
const OUTPUT_CHANNEL = 'DeepSeek Harness'
/** SecretStorage key holding the browser-session cookie JSON. */
const SESSION_SECRET_KEY = 'deepseekHarness.browserSession'

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel(OUTPUT_CHANNEL, { log: true })
  context.subscriptions.push(log)
  log.info('DeepSeek Harness Connector activating')

  const disposables = new CompositeDisposable()
  context.subscriptions.push(disposables)

  // ─── config + auth + client ─────────────────────────────────────────────────
  const cfg = readConfig()

  /**
   * The browser-session cookie is a bearer credential: keep it in the OS
   * keychain rather than settings.json.
   */
  const authStore: AuthStore = {
    load: async () => await context.secrets.get(SESSION_SECRET_KEY),
    save: async (value) => {
      if (value === undefined) await context.secrets.delete(SESSION_SECRET_KEY)
      else await context.secrets.store(SESSION_SECRET_KEY, value)
    },
  }
  const auth = new BrowserSessionAuth({
    host: cfg.host,
    port: cfg.port,
    store: authStore,
    log: (m) => log.info(m),
    allowLocalMint: cfg.autoSession,
  })

  const client = new HarnessClient({
    host: cfg.host,
    port: cfg.port,
    auth,
    log: (m) => log.info(m),
  })

  // ─── mutable UiState (owned here; controller + provider share via accessor)
  const state: UiState = {
    connection: 'disconnected',
    sessions: [],
    sending: false,
    canStop: false,
    showSystemMessages: cfg.showSystemMessages,
    systemMessageCount: 0,
    autoApprove: cfg.autoApproveApprovals,
    renderVersion: 0,
  }
  const stateListeners = new Set<(s: UiState) => void>()

  function getState(): UiState { return state }
  function setState(patch: Partial<UiState>): void {
    Object.assign(state, patch)
  }
  function bump(): void { state.renderVersion++ }
  function pushState(): void {
    bump()
    for (const l of stateListeners) { try { l(state) } catch { /* swallow listener errors */ } }
  }

  // ─── provider + controller ──────────────────────────────────────────────────
  const provider = new HarnessWebviewViewProvider({
    client,
    extensionUri: context.extensionUri,
    getState,
    onState: (listener) => {
      stateListeners.add(listener)
      return { dispose: () => { stateListeners.delete(listener) } }
    },
    dispatch: (action: WebviewAction) => { void controller.dispatch(action) },
  })
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(
    HarnessWebviewViewProvider.viewType, provider,
    { webviewOptions: { retainContextWhenHidden: true } },
  ))

  const controller = new AppController({
    client,
    vscodeAPI: { window: vscode.window, workspace: vscode.workspace, commands: vscode.commands },
    getState,
    setState,
    bump,
    pushState,
    notifyError: (m) => vscode.window.showErrorMessage(`DeepSeek Harness: ${m}`),
    notifyInfo: (m) => vscode.window.showInformationMessage(m),
    autoDiscover: () => cfg.autoDiscover,
    openHarnessHome: () => {
      void vscode.window.showInformationMessage(
        'Open the DeepSeek Harness web UI with the URL printed by `dsh web` — '
        + 'it carries the per-process token the harness now requires.',
      )
    },
    moveToSecondarySideBar: async () => {
      try {
        await vscode.commands.executeCommand('workbench.action.moveViews', {
          viewIds: ['deepseekHarness.sessionView'],
          destinationId: 'workbench.view.auxiliarybar',
        })
      } catch {
        void vscode.window.showInformationMessage(
          'Right-click the "DeepSeek Harness" view title and choose "Move to Secondary Side Bar" to dock it on the right.',
        )
      }
    },
    log: { info: (m) => log.info(m), error: (m) => log.error(m) },
    provider,
  })
  disposables.add(controller.start())

  // ─── commands ───────────────────────────────────────────────────────────────
  const wireAction = <T extends WebviewAction['type']>(type: T) =>
    () => void controller.dispatch({ type } as WebviewAction)

  /**
   * Pick a permission preset.
   *
   * Upstream's preset table is deployment-configurable, so the documented
   * defaults are offered as choices and any other name can be typed — the host
   * rejects unknown presets with a message naming what it does serve.
   */
  const setPermissionPreset = async (): Promise<void> => {
    const known = ['read-only', 'workspace-write', 'danger-full-access']
    const picked = await vscode.window.showQuickPick(
      [...known, 'Type a preset name…'],
      { title: 'DeepSeek Harness: Permission Preset', placeHolder: 'Preset name', ignoreFocusOut: true },
    )
    if (picked === undefined) return
    const name = picked === 'Type a preset name…'
      ? await vscode.window.showInputBox({
        title: 'DeepSeek Harness: Permission Preset',
        prompt: 'Preset name as configured on the harness host.',
        placeHolder: 'workspace-write',
        ignoreFocusOut: true,
      })
      : picked
    if (name === undefined || name.trim() === '') return
    await controller.setPreset(name.trim())
  }

  const clearSessionToken = async (): Promise<void> => {
    await auth.clear()
    client.disconnect()
    vscode.window.showInformationMessage(
      'DeepSeek Harness: stored session cleared. Reconnecting will mint a fresh one from $DSH_HOME/.credentials.yaml.',
    )
    await controller.doConnect()
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.connect', wireAction('connect')),
    // Same path as Connect on purpose: `doConnect()` always tears the existing
    // session down first, so "connect" and "reconnect" are one operation. The
    // separate command exists so the panel header can keep a button visible
    // while connected — the old entry was gated on `deepseekHarness.offline`,
    // which hid it exactly when a reconnect was wanted.
    vscode.commands.registerCommand('deepseekHarness.reconnect', wireAction('connect')),
    vscode.commands.registerCommand('deepseekHarness.disconnect', wireAction('disconnect')),
    vscode.commands.registerCommand('deepseekHarness.clearSessionToken', clearSessionToken),
    vscode.commands.registerCommand('deepseekHarness.openWebUI', () => {
      // The harness authenticates its web UI per process, so a plain origin
      // opens nothing useful; only the token-bearing launch URL does. That URL
      // is on the `dsh web` console, and this extension has no way to guess it.
      void vscode.window.showInformationMessage(
        'Open the web UI with the URL `dsh web` printed to its console — it carries the '
        + 'per-process token the browser needs. The extension itself authenticates on its own, '
        + 'by minting a session cookie from $DSH_HOME/.credentials.yaml.',
      )
    }),
    vscode.commands.registerCommand('deepseekHarness.showLogs', () => log.show()),
    vscode.commands.registerCommand('deepseekHarness.newSession', wireAction('newSession')),
    vscode.commands.registerCommand('deepseekHarness.refreshSessions', wireAction('refreshSessions')),
    vscode.commands.registerCommand('deepseekHarness.openInSecondarySideBar', wireAction('moveToSecondarySideBar')),
    vscode.commands.registerCommand('deepseekHarness.togglePlanMode', () => {
      void controller.togglePlanMode()
    }),
    vscode.commands.registerCommand('deepseekHarness.setPermissionPreset', setPermissionPreset),
    vscode.commands.registerCommand('deepseekHarness.forkSession', () => {
      void controller.forkActive()
    }),
    vscode.commands.registerCommand('deepseekHarness.renameSession', () => {
      void controller.renameActive()
    }),
    vscode.commands.registerCommand('deepseekHarness.compactSession', () => {
      void controller.compactActive()
    }),
    vscode.commands.registerCommand('deepseekHarness.archiveSession', () => {
      void controller.archiveActive()
    }),
    vscode.commands.registerCommand('deepseekHarness.addFileToChat', (uri: vscode.Uri) => {
      controller.addToChat(uri)
    }),
    vscode.commands.registerCommand('deepseekHarness.sendSelectionToChat', () => {
      void controller.sendSelection()
    }),
    vscode.commands.registerCommand('deepseekHarness.attachFile', async () => {
      const picks = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach to prompt',
        title: 'Attach file(s) or image(s) to the next DeepSeek Harness prompt',
      })
      if (!picks || picks.length === 0) return
      const items: PendingAttachmentPayload[] = []
      for (const uri of picks) {
        try {
          const bytes = readFileSync(uri.fsPath)
          const name = uri.path.split('/').pop() ?? uri.fsPath
          // Rasters the host admits go inline as images; everything else is
          // staged as a file and referenced by receipt.
          items.push({ kind: attachmentKindFor(name), name, data: bytes.toString('base64') })
        } catch (e) {
          vscode.window.showErrorMessage('Could not read ' + uri.fsPath + ': ' + (e instanceof Error ? e.message : String(e)))
        }
      }
      controller.addPendingItems(items)
    }),
  )

  // ─── revert straight from the native diff ──────────────────────────────────
  //
  // The review card already offers Revert, but the diff editor is where a person
  // actually reads a change — and walking back to the sidebar to disagree with
  // it is the round trip this removes. The lens is attached to the AFTER side
  // only, so one comparison shows one action instead of two.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'deepseekHarness.revertReviewFile',
      (reviewId: string, filePath: string) => {
        void controller.dispatch({ type: 'reviewRejectFile', reviewId, filePath })
      },
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: DSH_REVIEW_SCHEME },
      {
        provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
          const parsed = parseReviewUri(document.uri)
          if (parsed === undefined) return []
          return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
            title: 'Revert this file',
            command: 'deepseekHarness.revertReviewFile',
            arguments: [parsed.reviewId, parsed.filePath],
          })]
        },
      },
    ),
  )

  // ─── config-change handler (§17: retarget + reconnect) ─────────────────────
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration(SECTION)) return
    const next = readConfig()
    if (next.host !== cfg.host || next.port !== cfg.port) {
      cfg.host = next.host
      cfg.port = next.port
      // Same client, same credentials: only the target moves. A cookie minted
      // for another authority simply stops matching, and the next request
      // reports exactly that instead of failing with a bare 401.
      client.retarget(cfg.host, cfg.port)
      client.disconnect()
      vscode.window.showInformationMessage(
        `DeepSeek Harness: now targeting ${cfg.host}:${String(cfg.port)} — reconnecting.`,
      )
      void controller.doConnect()
    }
    if (next.showSystemMessages !== cfg.showSystemMessages) {
      cfg.showSystemMessages = next.showSystemMessages
      controller.applyConfigShowSystem(next.showSystemMessages)
    }
    if (next.autoApproveApprovals !== cfg.autoApproveApprovals) {
      cfg.autoApproveApprovals = next.autoApproveApprovals
      setState({ autoApprove: next.autoApproveApprovals })
      pushState()
    }
    if (next.autoDiscover !== cfg.autoDiscover) {
      cfg.autoDiscover = next.autoDiscover
      // Turning it on cannot hurt an already-connected client; turning it off
      // only stops future scans, so nothing to re-run here.
    }
    if (next.autoSession !== cfg.autoSession) {
      cfg.autoSession = next.autoSession
      auth.setAllowLocalMint(next.autoSession)
      // Re-evaluate connectivity: enabling may mint a cookie now; disabling
      // leaves us without one, and there is no paste-a-URL fallback any more —
      // the connect failure says so.
      if (auth.cookieHeader() === undefined) {
        client.disconnect()
        void controller.doConnect()
      }
    }
  }))

  // Auto-connect on activation. If no session can be minted the connect fails
  // with an actionable message pointing at $DSH_HOME/.credentials.yaml and the
  // `autoSession` setting.
  void controller.doConnect()
}

export function deactivate(): void {
  // Disposables owned by context.subscriptions; nothing to do here.
}

function readConfig(): { host: string; port: number; showSystemMessages: boolean; autoSession: boolean; autoApproveApprovals: boolean; autoDiscover: boolean } {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const host = cfg.get<string>('host') ?? '127.0.0.1'
  const port = cfg.get<number>('port') ?? 3080
  const showSystemMessages = cfg.get<boolean>('showSystemMessages') ?? false
  const autoSession = cfg.get<boolean>('autoSession') ?? true
  const autoApproveApprovals = cfg.get<boolean>('autoApproveApprovals') ?? false
  const autoDiscover = cfg.get<boolean>('autoDiscover') ?? true
  return { host, port, showSystemMessages, autoSession, autoApproveApprovals, autoDiscover }
}

/**
 * Read the coordinates back out of a `dsh-review://` URI.
 *
 * The review id lives in the URI's AUTHORITY, because `Uri.parse` keeps a
 * leading slash on `path` for a hierarchical URI — reading the id off the path
 * yields '' and the identifier is lost. Only the `after` side carries the
 * revert lens, so a comparison offers one action rather than one per side.
 */
function parseReviewUri(uri: vscode.Uri): { reviewId: string; filePath: string } | undefined {
  const parts = uri.path.replace(/^\/+/, '').split('/')
  const side = parts.pop()
  if (side !== 'after') return undefined
  const reviewId = uri.authority
  const filePath = decodeURIComponent(parts.join('/'))
  if (reviewId === '' || filePath === '') return undefined
  return { reviewId, filePath }
}
