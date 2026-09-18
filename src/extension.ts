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
import { HarnessClient } from './harness/client.ts'
import { BrowserSessionAuth, type AuthStore } from './harness/auth.ts'
import { AppController } from './app/controller.ts'
import type { WebviewAction } from './view/provider.ts'
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
    vscodeAPI: { window: vscode.window, workspace: vscode.workspace },
    getState,
    setState,
    bump,
    pushState,
    notifyError: (m) => vscode.window.showErrorMessage(`DeepSeek Harness: ${m}`),
    notifyInfo: (m) => vscode.window.showInformationMessage(m),
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
   * Adopt a `dsh web` launch URL.
   *
   * The harness mints a per-process token and accepts it only at
   * `GET /?token=…`, answering with the session cookie every later request
   * needs. The cookie is authority-bound, so a URL on another port also
   * retargets the plugin.
   */
  const setSessionToken = async (): Promise<void> => {
    const value = await vscode.window.showInputBox({
      title: 'DeepSeek Harness: Set Session Token',
      prompt: 'Paste the whole line `dsh web` printed. It looks like: dsh web: http://127.0.0.1:3080/?token=…',
      placeHolder: 'dsh web: http://127.0.0.1:3080/?token=…',
      ignoreFocusOut: true,
      validateInput: (text) => /https?:\/\/\S+/u.test(text) ? undefined : 'No URL found in that text.',
    })
    if (value === undefined || value.trim() === '') return
    try {
      const origin = await auth.adoptLaunchUrl(value)
      const next = readConfig()
      if (origin.host !== next.host || origin.port !== next.port) {
        const settings = vscode.workspace.getConfiguration(SECTION)
        await settings.update('host', origin.host, vscode.ConfigurationTarget.Global)
        await settings.update('port', origin.port, vscode.ConfigurationTarget.Global)
        cfg.host = origin.host
        cfg.port = origin.port
        client.retarget(origin.host, origin.port)
      }
      // The previous failure left the mux closed; reconnecting is the fix.
      client.disconnect()
      await controller.doConnect()
      vscode.window.showInformationMessage(
        `DeepSeek Harness: session acquired for ${origin.host}:${String(origin.port)}.`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log.error(`setSessionToken: ${msg}`)
      vscode.window.showErrorMessage(`DeepSeek Harness: ${msg}`)
    }
  }

  const clearSessionToken = async (): Promise<void> => {
    await auth.clear()
    client.disconnect()
    vscode.window.showInformationMessage('DeepSeek Harness: stored session cleared.')
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('deepseekHarness.connect', wireAction('connect')),
    vscode.commands.registerCommand('deepseekHarness.disconnect', wireAction('disconnect')),
    vscode.commands.registerCommand('deepseekHarness.setSessionToken', setSessionToken),
    vscode.commands.registerCommand('deepseekHarness.clearSessionToken', clearSessionToken),
    vscode.commands.registerCommand('deepseekHarness.openWebUI', () => {
      // The harness authenticates its web UI per process, so the plain origin no
      // longer opens anything useful — the token-bearing launch URL does.
      void vscode.window.showInformationMessage(
        'The DeepSeek Harness web UI must be opened with the URL printed by `dsh web` '
        + '(it carries a per-process token). Run "DeepSeek Harness: Set Session Token from Launch URL" '
        + 'to authenticate this extension with the same URL.',
      )
    }),
    vscode.commands.registerCommand('deepseekHarness.showLogs', () => log.show()),
    vscode.commands.registerCommand('deepseekHarness.newSession', wireAction('newSession')),
    vscode.commands.registerCommand('deepseekHarness.refreshSessions', wireAction('refreshSessions')),
    vscode.commands.registerCommand('deepseekHarness.openInSecondarySideBar', wireAction('moveToSecondarySideBar')),
    vscode.commands.registerCommand('deepseekHarness.addFileToChat', (uri: vscode.Uri) => {
      controller.addToChat(uri)
    }),
    vscode.commands.registerCommand('deepseekHarness.sendSelectionToChat', () => {
      void controller.sendSelection()
    }),
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
    if (next.autoSession !== cfg.autoSession) {
      cfg.autoSession = next.autoSession
      auth.setAllowLocalMint(next.autoSession)
      // Re-evaluate connectivity: enabling may mint a cookie now; disabling may
      // leave us without one and must fall back to the launch-URL exchange.
      if (auth.cookieHeader() === undefined) {
        client.disconnect()
        void controller.doConnect()
      }
    }
  }))

  // Auto-connect on activation. If no session is stored the connect fails with
  // an actionable message pointing at the Set Session Token command.
  void controller.doConnect()
}

export function deactivate(): void {
  // Disposables owned by context.subscriptions; nothing to do here.
}

function readConfig(): { host: string; port: number; showSystemMessages: boolean; autoSession: boolean } {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const host = cfg.get<string>('host') ?? '127.0.0.1'
  const port = cfg.get<number>('port') ?? 3080
  const showSystemMessages = cfg.get<boolean>('showSystemMessages') ?? false
  const autoSession = cfg.get<boolean>('autoSession') ?? true
  return { host, port, showSystemMessages, autoSession }
}
