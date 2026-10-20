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
import { DEFAULT_LAUNCH_COMMAND, ManagedLauncher, detectDesktopInstall } from './harness/launcher.ts'
import { installCli } from './harness/install.ts'
import { AppController, attachmentKindFor } from './app/controller.ts'
import { buildDiagnosticsReport, NPM_INSTALL_COMMAND } from './app/diagnosis.ts'
import {
  AUTO_SESSION_COMMAND,
  OPEN_WEB_UI_TEXT,
  parseSessionMode,
  planOpenWebUi,
  traitsOf,
  USE_LAUNCH_URL_COMMAND,
  type SessionMode,
} from './app/session-mode.ts'
import { openWebUiWithCookie } from './app/web-ui-bridge.ts'
import { DSH_REVIEW_SCHEME } from './review/virtualDocument.ts'
import type { PendingAttachmentPayload, WebviewAction } from './view/provider.ts'
import { HarnessWebviewViewProvider, type UiState } from './view/provider.ts'
import { CompositeDisposable } from './disposable.ts'

const SECTION = 'deepseekHarness'
const OUTPUT_CHANNEL = 'DeepSeek Harness'
/** SecretStorage key holding the browser-session cookie JSON. */
const SESSION_SECRET_KEY = 'deepseekHarness.browserSession'

/**
 * The Host this extension started, if it started one.
 *
 * Module-level because `deactivate()` is a free function that receives no
 * context, and because reaping the child is the one shutdown duty that cannot be
 * left to a disposable: a `dispose()` runs synchronously and cannot wait for
 * `taskkill` (or a signal to a process group) to land, and a Host left listening
 * on a port after its owner is gone is exactly the mess this extension exists to
 * avoid creating.
 */
let ownedLauncher: ManagedLauncher | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
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
    allowLocalMint: traitsOf(cfg.sessionMode).allowLocalMint,
  })

  const client = new HarnessClient({
    host: cfg.host,
    port: cfg.port,
    auth,
    log: (m) => log.info(m),
  })

  /**
   * The managed-launch Host, created only if the mode ever asks for one.
   *
   * One instance for the whole session, not one per connect: the child *is* the
   * server, so a per-attempt lifetime would tear down the very thing it just
   * started. `sessionMode()` is consulted on every connect, so switching the
   * setting takes effect immediately without rebuilding the controller.
   */
  const launcher = new ManagedLauncher()
  const launcherForMode = (): ManagedLauncher | undefined =>
    traitsOf(cfg.sessionMode).startsHost ? launcher : undefined
  ownedLauncher = launcher

  /**
   * Is the desktop app installed?
   *
   * Awaited before the first connect rather than probed in the background.
   * Whether it is present changes the advice a failed connect gives — "open the
   * app you already have" versus "here is how to install one" — and losing that
   * race would show an install button to somebody who already installed it.
   * Two `access()` calls, so the cost is noise.
   */
  const desktopInstall = await detectDesktopInstall()
  log.info(desktopInstall === undefined
    ? 'session: no desktop install found'
    : `session: desktop app found at ${desktopInstall}`)
  log.info(`session: mode=${cfg.sessionMode} (local mint ${traitsOf(cfg.sessionMode).allowLocalMint ? 'on' : 'off'})`)

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
    sessionMode: () => cfg.sessionMode,
    launcher: launcherForMode,
    launchCommand: () => cfg.launchCommand,
    // The same exchange the paste route uses, minus the paste. `adoptLaunchUrl`
    // checks whether it already holds a session for that authority before
    // spending the token, which is what makes a reconnect cheap.
    adoptLaunchUrl: async (url: string) => {
      const { host, port } = await auth.adoptLaunchUrl(url)
      client.retarget(host, port)
      return { host, port }
    },
    desktopInstall: () => desktopInstall,
    platform: process.platform,
    arch: process.arch,
    // `'ssh-remote'` / `'wsl'` / `'dev-container'` / `'attached-container'`, or
    // absent. Read by the failure classifier, which has to tell a user sitting
    // at a machine apart from a user connected to one.
    remoteName: vscode.env.remoteName,
    openExternal: async (url: string) => { await vscode.env.openExternal(vscode.Uri.parse(url)) },
    copyToClipboard: async (text: string) => { await vscode.env.clipboard.writeText(text) },
    // The panel's "open web UI" link is the same operation as the command, so
    // it is the same function rather than a second copy of the reasoning. It is
    // resolved at click time, which is why referring to a `const` declared
    // further down this function is correct rather than a mistake.
    openHarnessHome: () => { void openWebUi() },
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
    const how = cfg.sessionMode === 'managed'
      ? 'Reconnecting will start a Host and take the session it issues.'
      : cfg.sessionMode === 'paste'
        ? 'Reconnecting will need a launch URL before it can authenticate — use "DeepSeek Harness: Use Launch URL".'
        : 'Reconnecting will mint a fresh one from $DSH_HOME/.credentials.yaml.'
    vscode.window.showInformationMessage('DeepSeek Harness: stored session cleared. ' + how)
    await controller.doConnect()
  }

  /**
   * Install the `dsh` CLI *here* — and on a remote connection, "here" is the remote.
   *
   * The extension host is what spawns this, so it inherits whatever side of the
   * connection VS Code put the extension on. That is the entire trick: on a
   * Remote-SSH window the install lands on the machine that has to run the Host,
   * which is the machine the user's own terminal is *not* on.
   *
   * Confirmed first rather than run on a click that looked like a link: this
   * writes to the machine's package prefix. It does not elevate, so the honest
   * failure on a system-owned `npm` is an `EACCES` the user can read.
   */
  const installHost = async (): Promise<void> => {
    const remote = vscode.env.remoteName
    const where = remote === undefined ? 'this machine' : `the remote ("${remote}")`
    const proceed = await vscode.window.showWarningMessage(
      `Install the DeepSeek Harness CLI on ${where}?`,
      {
        modal: true,
        detail:
          `Runs \`${NPM_INSTALL_COMMAND}\` in the extension host, which is ${where}. `
          + 'Nothing is elevated and nothing is written outside that machine\'s package prefix.',
      },
      'Install',
    )
    if (proceed !== 'Install') return

    log.info(`install: requested by the user for ${where}`)
    const outcome = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'DeepSeek Harness: installing the dsh CLI',
        cancellable: false,
      },
      async () => await installCli({ log: (m) => log.info(m) }),
    )
    // Always to the log, pass or fail: npm's own output is the only thing that
    // says *which* prefix was not writable, and a summary cannot carry that.
    for (const line of outcome.output.split('\n')) log.info(`  ${line}`)

    if (!outcome.ok) {
      const why = outcome.error ?? `exit ${String(outcome.code)}`
      log.error(`install: \`${outcome.command}\` failed — ${why}`)
      const pick = await vscode.window.showErrorMessage(
        `DeepSeek Harness: installing \`dsh\` failed (${why}).`,
        'Show Log',
      )
      if (pick === 'Show Log') log.show()
      return
    }
    log.info('install: succeeded — reconnecting')
    void vscode.window.showInformationMessage('DeepSeek Harness: `dsh` installed. Reconnecting.')
    await controller.doConnect()
  }

  /**
   * Hand the harness web UI to the browser, token and all.
   *
   * The harness gates its web UI per process, and only the launch URL carries the
   * token that opens it, so this is never a link we can compose — it is one we
   * have to hold. Which route holds one, and what to do when none does, is
   * `planOpenWebUi` in `app/session-mode.ts`; this function only executes the
   * answer.
   *
   * The mistake this command used to make was to read the mode as a single bit
   * about minting. That bit is off for `managed` *and* for `paste`, so a `paste`
   * window was advised to switch to `managed` and a `managed` window to switch to
   * the mode it was already in — while the one state that actually needed the
   * offer, `credentials` with no live cookie, fell into the same sentence as both.
   * The mode now travels in as the mode, and every branch ends in a step.
   */
  const openWebUi = async (): Promise<void> => {
    // `auth.browserUrl()` is the pasted route and declines unless it is still
    // authenticated for the Host we are pointed at; `launcherForMode()` is only
    // defined in the mode that starts a Host. The mode itself goes in because
    // two of the three routes start nothing and their remedies are opposites.
    const target = client.target()
    const at = `${target.host}:${String(target.port)}`
    const adopted = auth.browserUrl()
    const plan = planOpenWebUi({
      launchedUrl: launcherForMode()?.launchUrl(),
      adoptedUrl: adopted,
      mode: cfg.sessionMode,
      authenticated: auth.isReady(),
      connected: getState().connection === 'connected',
      remoteName: vscode.env.remoteName,
    })

    if (plan.kind === 'open') {
      if (plan.url === adopted) {
        log.info('openWebUI: reopening the launch URL this session was adopted from')
      }
      await vscode.env.openExternal(vscode.Uri.parse(plan.url))
      return
    }

    // The case that used to be a dead end: a Host we did not start, a cookie we
    // do hold. The Host accepts that cookie at `/` — measured, not assumed — so
    // the only missing piece is putting it in the browser's jar.
    if (plan.kind === 'open-with-cookie') {
      const cookie = auth.cookieHeader()
      if (cookie === undefined) {
        void vscode.window.showWarningMessage(OPEN_WEB_UI_TEXT.cookieBridgeFailed)
        return
      }
      const result = await openWebUiWithCookie({
        host: target.host,
        port: target.port,
        cookie,
        openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url)),
        log: (m) => log.info(m),
      })
      if (result === 'failed') {
        void vscode.window.showWarningMessage(OPEN_WEB_UI_TEXT.cookieBridgeFailed)
      }
      return
    }

    if (plan.kind === 'explain-remote') {
      // `starts-host` names the mode it is talking about, so the copy is a
      // function; `minted` describes the credential route and needs no argument.
      const copy = OPEN_WEB_UI_TEXT.explainRemote[plan.reason]
      void vscode.window.showInformationMessage(
        typeof copy === 'function' ? copy(cfg.sessionMode) : copy,
      )
      return
    }

    // `paste` is the one mode whose whole contract is "hand me the line `dsh web`
    // printed", so the command runs the ask rather than describing it.
    if (plan.kind === 'ask-launch-url') {
      const { message, action, dismiss } = OPEN_WEB_UI_TEXT.askLaunchUrl
      if (await vscode.window.showInformationMessage(message(at), action, dismiss) === action) {
        await vscode.commands.executeCommand(USE_LAUNCH_URL_COMMAND)
      }
      return
    }

    if (plan.kind === 'offer-managed') {
      const { action, dismiss } = OPEN_WEB_UI_TEXT.offerManaged
      const message = plan.reason === 'minted'
        ? OPEN_WEB_UI_TEXT.offerManaged.minted
        : OPEN_WEB_UI_TEXT.offerManaged.noSession(at)
      if (await vscode.window.showInformationMessage(message, action, dismiss) !== action) return

      // Persisted rather than remembered for one call: the Host this starts has to
      // outlive the next connect, and a reconnect that still read `credentials`
      // would abandon it. The config-change handler notices the new mode and
      // reconnects on its own; awaiting a connect here is what makes the launch
      // URL exist (or provably not exist) by the time we look for it.
      await vscode.workspace
        .getConfiguration(SECTION)
        .update('sessionMode', 'managed', vscode.ConfigurationTarget.Global)
    }

    // `start-managed` arrives here already in the mode that owns the child's
    // console; `offer-managed` arrives after switching into it. Both need the
    // same thing: a connect that starts the Host and yields a URL.
    await controller.doConnect({ force: true })
    const url = launcher.launchUrl()
    if (url === undefined) {
      // Two different failures wear the same empty result. A Host already
      // answering on the port was *adopted*, so nothing on this machine printed a
      // URL for it; anything else means we could not start one at all, and the
      // controller's own diagnosis says why.
      void vscode.window.showWarningMessage(
        getState().connection === 'connected'
          ? OPEN_WEB_UI_TEXT.alreadyRunning(at)
          : OPEN_WEB_UI_TEXT.startFailed(at, connectFailureText()),
      )
      return
    }
    await vscode.env.openExternal(vscode.Uri.parse(url))
  }

  /**
   * Switch to `auto` and connect again — the repair for "nothing is listening".
   *
   * `credentials` authenticates and never starts anything, so a fresh install on
   * a machine where nobody ran `dsh web` failed its first connection and was told
   * to go edit a setting. `auto` is that setting's answer, and this makes it one
   * click instead of a detour through Settings.
   *
   * Persisted rather than remembered for one call: the Host it starts has to
   * outlive the next connect, and the next connect reads the setting.
   */
  const useAutoSession = async (): Promise<void> => {
    if (cfg.sessionMode !== 'auto') {
      log.info(`session: ${cfg.sessionMode} → auto, from the status row's repair action`)
      await vscode.workspace
        .getConfiguration(SECTION)
        .update('sessionMode', 'auto', vscode.ConfigurationTarget.Global)
    }
    // `force`, because the previous attempt left the client convinced it had
    // already tried: a plain connect short-circuits on `connected`, and the
    // state we are repairing is usually "failed", which is sticky in the same way.
    await controller.doConnect({ force: true })
    const state = getState()
    if (state.connection !== 'connected') {
      void vscode.window.showWarningMessage(
        `DeepSeek Harness: still not connected in "auto". ${connectFailureText()}`,
      )
    }
  }

  /**
   * One line for "why the Host would not start", from the controller's own record.
   *
   * Read at the moment of failure rather than reconstructed: the connect path
   * already decided whether `dsh` is missing, whether `npx` was worth trying, and
   * what the Host said, and a second guess here would eventually disagree with it.
   */
  const connectFailureText = (): string => {
    const { lastError, hint } = controller.diagnostics()
    if (hint !== undefined && hint.fix !== '') return hint.fix
    if (lastError !== undefined && lastError !== '') return lastError
    return 'Start `dsh web` yourself and paste its line with "DeepSeek Harness: Use Launch URL".'
  }

  /**
   * The `paste` route, as a command.
   *
   * This is what `autoSession: false` should always have been: a real
   * alternative rather than a switch that turns authentication off. Start
   * `dsh web` (or the desktop app), copy the line it printed, paste it here —
   * the extension trades the token for a session and connects. Nothing is read
   * from disk and nothing is started.
   */
  const useLaunchUrl = async (): Promise<void> => {
    const pasted = await vscode.window.showInputBox({
      title: 'DeepSeek Harness: Use Launch URL',
      prompt: 'Paste the whole line `dsh web` printed — it carries the per-process token.',
      placeHolder: 'dsh web: http://127.0.0.1:3080/?token=…',
      ignoreFocusOut: true,
    })
    if (pasted === undefined || pasted.trim() === '') return
    try {
      const { host, port } = await auth.adoptLaunchUrl(pasted)
      client.retarget(host, port)
      log.info(`auth: adopted a pasted launch URL for ${host}:${String(port)}`)
      await controller.doConnect()
    } catch (e) {
      // The exchange's own messages name the real problem ("that token is valid
      // only for the current `dsh web` process"), so they are shown verbatim
      // rather than wrapped in something vaguer.
      const msg = e instanceof Error ? e.message : String(e)
      log.error('launch URL rejected: ' + msg)
      void vscode.window.showErrorMessage('DeepSeek Harness: ' + msg)
    }
  }

  /**
   * One document that answers "why is this not connected" without a round trip
   * through a maintainer.
   *
   * Opened as an untitled Markdown document rather than a custom panel: it costs
   * no webview, and the reader gets selection, find and Save As for free. The
   * report is built by a pure function in `app/diagnosis.ts`, so the redaction
   * rules and the capability summary are unit-tested without a VS Code host.
   */
  const diagnostics = async (): Promise<void> => {
    const s = getState()
    const target = client.target()
    const cfg = vscode.workspace.getConfiguration(SECTION)
    const { lastError, hint } = controller.diagnostics()

    const report = buildDiagnosticsReport({
      extensionVersion: String(context.extension?.packageJSON?.['version'] ?? 'unknown'),
      vscodeVersion: vscode.version,
      nodeVersion: `Electron ${process.versions['electron'] ?? '?'} / Node ${process.versions.node}`,
      platform: `${process.platform} ${process.arch}`,
      host: target.host,
      port: target.port,
      connection: s.connection,
      ...(s.muxStatus !== undefined ? { muxStatus: s.muxStatus } : {}),
      ...(s.hostInfo !== undefined ? { hostInfo: s.hostInfo } : {}),
      ...(s.capabilities !== undefined ? { capabilities: s.capabilities } : {}),
      ...(lastError !== undefined ? { lastError } : {}),
      ...(hint !== undefined ? { hint } : {}),
      settings: {
        host: cfg.get('host'),
        port: cfg.get('port'),
        sessionMode: cfg.get('sessionMode'),
        launchCommand: cfg.get('launchCommand'),
        autoDiscover: cfg.get('autoDiscover'),
        autoApproveApprovals: cfg.get('autoApproveApprovals'),
        showSystemMessages: cfg.get('showSystemMessages'),
        dshHome: process.env['DSH_HOME'],
        desktopInstall: desktopInstall ?? 'not found',
      },
      generatedAt: new Date().toISOString(),
    })

    const doc = await vscode.workspace.openTextDocument({ content: report, language: 'markdown' })
    await vscode.window.showTextDocument(doc, { preview: false })

    const COPY = 'Copy redacted report'
    const picked = await vscode.window.showInformationMessage(
      'DeepSeek Harness diagnostics opened — it contains no credential material.',
      COPY, 'Show Logs',
    )
    if (picked === COPY) {
      await vscode.env.clipboard.writeText(report)
      void vscode.window.showInformationMessage('Diagnostics copied to the clipboard.')
    } else if (picked === 'Show Logs') {
      log.show()
    }
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
    vscode.commands.registerCommand(USE_LAUNCH_URL_COMMAND, useLaunchUrl),
    // The repair the status row offers when nothing is listening. Registered as a
    // command because `ConnectionHint.repair` names one by id.
    vscode.commands.registerCommand(AUTO_SESSION_COMMAND, useAutoSession),
    // Installs on whichever machine the extension host is on — see `installHost`.
    vscode.commands.registerCommand('deepseekHarness.installHost', installHost),
    vscode.commands.registerCommand('deepseekHarness.openWebUI', openWebUi),
    vscode.commands.registerCommand('deepseekHarness.showLogs', () => log.show()),
    vscode.commands.registerCommand('deepseekHarness.diagnostics', diagnostics),
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
    // ─── right-click quick tasks ──────────────────────────────────────────
    //
    // Nine commands, three per surface, all landing on the same pre-fill
    // channel `addFileToChat` uses. The menu picks the surface — a selection, a
    // whole file, a change — and each handler only resolves its own target and
    // writes the ask; nothing is sent. Registered one at a time rather than in
    // a loop so a rename is still findable by grep.
    vscode.commands.registerCommand('deepseekHarness.explainSelection', () => {
      controller.askSelection('explain')
    }),
    vscode.commands.registerCommand('deepseekHarness.fixSelection', () => {
      controller.askSelection('fix')
    }),
    vscode.commands.registerCommand('deepseekHarness.reviewSelection', () => {
      controller.askSelection('review')
    }),
    vscode.commands.registerCommand('deepseekHarness.explainFile', (uri?: vscode.Uri) => {
      controller.askFile(uri, 'explain')
    }),
    vscode.commands.registerCommand('deepseekHarness.fixFile', (uri?: vscode.Uri) => {
      controller.askFile(uri, 'fix')
    }),
    vscode.commands.registerCommand('deepseekHarness.reviewFile', (uri?: vscode.Uri) => {
      controller.askFile(uri, 'review')
    }),
    // The argument is deliberately `unknown`: the same command is reached from
    // `scm/resourceState/context` (a resource state, or an array of them) and
    // from `editor/context` in a diff tab (a document URI), and asking VS Code
    // to type that union would only move the guessing into a cast.
    vscode.commands.registerCommand('deepseekHarness.explainChange', (arg?: unknown) => {
      controller.askChange(arg, 'explain')
    }),
    vscode.commands.registerCommand('deepseekHarness.fixChange', (arg?: unknown) => {
      controller.askChange(arg, 'fix')
    }),
    vscode.commands.registerCommand('deepseekHarness.reviewChange', (arg?: unknown) => {
      controller.askChange(arg, 'review')
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
    if (next.sessionMode !== cfg.sessionMode) {
      cfg.sessionMode = next.sessionMode
      auth.setAllowLocalMint(traitsOf(next.sessionMode).allowLocalMint)
      // A mode change moves where a session can come from, so the one we are
      // holding is no evidence about the new mode: "credentials" may mint where
      // "paste" could not, and "managed" may start a Host nothing else would.
      // Reconnecting re-derives instead of leaving the panel on a session that
      // no longer matches the setting the user just changed.
      void controller.doConnect()
    }
    if (next.launchCommand !== cfg.launchCommand) {
      cfg.launchCommand = next.launchCommand
      // Only ever read at spawn time. A Host already running is left alone —
      // killing it because a setting changed would be a surprising way to lose
      // a session mid-conversation.
    }
  }))

  // Auto-connect on activation. A failure here is classified into one specific
  // next action (see `app/diagnosis.ts`), which is also where the install
  // guidance for a machine that has no harness at all comes from.
  void controller.doConnect()
}

export async function deactivate(): Promise<void> {
  // Disposables owned by context.subscriptions; the one thing they cannot do is
  // wait. Reaping the Host we started is worth awaiting: `taskkill` and a signal
  // to a process group are both asynchronous, and a Host that outlives its owner
  // keeps holding a port the user cannot account for.
  try {
    await ownedLauncher?.stop()
  } catch {
    // `stop()` is best-effort by design and reports its own outcome; there is
    // nothing left to tell anyone once the extension host is going away.
  }
  ownedLauncher = undefined
}

function readConfig(): {
  host: string
  port: number
  showSystemMessages: boolean
  sessionMode: SessionMode
  launchCommand: string
  autoApproveApprovals: boolean
  autoDiscover: boolean
} {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  const host = cfg.get<string>('host') ?? '127.0.0.1'
  const port = cfg.get<number>('port') ?? 3080
  const showSystemMessages = cfg.get<boolean>('showSystemMessages') ?? false
  // An unknown value falls back to the default rather than throwing: settings
  // are hand-editable JSON and a typo should not stop the extension starting.
  const sessionMode = parseSessionMode(cfg.get('sessionMode'))
  const launchCommand = (cfg.get<string>('launchCommand') ?? '').trim() || DEFAULT_LAUNCH_COMMAND
  const autoApproveApprovals = cfg.get<boolean>('autoApproveApprovals') ?? false
  const autoDiscover = cfg.get<boolean>('autoDiscover') ?? true
  return { host, port, showSystemMessages, sessionMode, launchCommand, autoApproveApprovals, autoDiscover }
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
