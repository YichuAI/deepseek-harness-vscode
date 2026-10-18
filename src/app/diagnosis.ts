/**
 * diagnosis.ts — turning "Disconnected" into something a person can act on.
 *
 * The panel used to have four states and one of them was a shrug: `error` set
 * `host-info` to whatever string the transport threw. "ECONNREFUSED" and
 * "$DSH_HOME/.credentials.yaml could not be read" are not the same problem, do
 * not have the same fix, and were rendered identically — so the first thing a
 * user had to do was guess which one they had, and the first thing a maintainer
 * had to do was ask.
 *
 * Everything here is pure: no `vscode`, no network, no filesystem. That is
 * deliberate — the integration test imports this module, and it cannot import
 * anything that pulls in `vscode` (only the protocol test installs the module
 * stub). It also means the classifier is the one part of the connect path that
 * can be asserted directly instead of inferred from a rendered string.
 */

import { AUTO_SESSION_COMMAND, USE_LAUNCH_URL_COMMAND, type SessionMode } from './session-mode.ts'

export type ConnectionFailureKind =
  /** Nothing is listening where we looked. */
  | 'runtime-not-running'
  /** We found a Host and it refused us. */
  | 'auth-failed'
  /** Something is listening, but it is not a dsh Host. */
  | 'wrong-port'
  /** We reached a Host that does not speak the shape we need. */
  | 'protocol-incompatible'
  /** The configured host is not one this plugin will talk to at all. */
  | 'non-loopback-host'
  /** Reachable and talkative, and we still do not know. */
  | 'unknown'

export interface ConnectionHint {
  kind: ConnectionFailureKind
  /** One line for the status row. */
  title: string
  /** What was actually observed, in the words the transport used. */
  detail: string
  /** What to do about it. */
  fix: string
  /** The repair, when one exists as a command. */
  repair?: { command: string; label: string }
  /**
   * How to get the thing that is missing, when that is the answer.
   *
   * Only ever set on `runtime-not-running`, and only when nothing is installed
   * yet. The panel renders exactly one button from it, and only while the
   * connection is in the failed state — an extension that offers to install its
   * own host while the host is happily running is just noise.
   */
  install?: InstallGuidance
}

// ─── install guidance ───────────────────────────────────────────────────────

/**
 * Which upstream route this platform should be told about.
 *
 * Windows and macOS have a desktop build; Linux does not. That is not a
 * preference, it is what upstream ships, and saying so once here beats
 * rediscovering it in every call site.
 */
export type InstallRoute = 'desktop' | 'npx' | 'source'

export interface InstallGuidance {
  route: InstallRoute
  /** The one button's text. */
  label: string
  /** What pressing it does, in one line. */
  detail: string
  /** Opened by the button. Desktop route only. */
  url?: string
  /** Copied to the clipboard by the button. The other two routes. */
  command?: string
}

/**
 * Stable entry points only.
 *
 * The desktop installer itself is version-bearing
 * (`…/dsh-desk/bin/win-x64/deepseek-harness-<build>-x64.exe`) and there is no
 * `latest.yml` to resolve the build through, so a direct link would rot within
 * weeks. Pointing at the page instead costs one click and never goes stale.
 */
export const DESKTOP_DOWNLOAD_URL = 'https://download.deepseek.com/dsh-desk/'
export const SOURCE_REPO_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/**
 * The one install that works everywhere this extension runs.
 *
 * A desktop installer is a thing a person double-clicks, which makes it the
 * wrong answer for a machine they are only connected to — a Remote-SSH host, a
 * dev container, a WSL distro. The npm package is the same product as a CLI, it
 * installs into the extension host (so it lands on the remote), and it needs
 * nothing on the machine except a `node` that `dsh` would have needed anyway.
 *
 * It is also what `deepseekHarness.installHost` runs.
 */
export const NPM_INSTALL_COMMAND = 'npm i -g @deepseek-ai/dsh'

const NPX_COMMAND = 'npx @deepseek-ai/dsh web'
const SOURCE_COMMAND =
  'git clone https://github.com/deepseek-ai/deepseek-harness.git && ' +
  'cd deepseek-harness && pnpm install && pnpm run build && pnpm dsh web'

/**
 * Pick the route for a platform. Pure, so the test can walk every platform.
 *
 * `arch` matters on one point only: the desktop build is Apple Silicon, so an
 * Intel Mac has to fall through to the npm package.
 *
 * `remote` is the third input, and it overrides the other two. `vscode.env.remoteName`
 * is `'ssh-remote'` / `'wsl'` / `'dev-container'` / `'attached-container'` when the
 * extension host is not the machine in front of the user. There, `platform` still
 * describes the *target* correctly — which is exactly why the desktop route has to
 * be ruled out: a Windows remote host offered a `.exe` download would be told to
 * install something it cannot run, on a screen whose mouse cannot reach it.
 */
export function installGuidanceFor(platform: string, arch: string, remote?: string): InstallGuidance {
  if (remote !== undefined && remote !== '') {
    return {
      route: 'npx',
      label: 'Copy install command',
      detail:
        `This window is connected to a remote ("${remote}"), so the Host has to run there. Copies the npm `
        + 'install that lands in the extension host — i.e. on the remote — or run "DeepSeek Harness: Install Host" '
        + 'and this extension runs it for you.',
      command: NPM_INSTALL_COMMAND,
    }
  }
  if (platform === 'win32') {
    return {
      route: 'desktop',
      label: 'Download DeepSeek Harness',
      detail: 'The desktop app starts a Host for you and adds the `dsh` command to your PATH.',
      url: DESKTOP_DOWNLOAD_URL,
    }
  }
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return {
        route: 'desktop',
        label: 'Download DeepSeek Harness',
        detail: 'Apple Silicon build. It starts a Host for you and installs `dsh` to /usr/local/bin.',
        url: DESKTOP_DOWNLOAD_URL,
      }
    }
    return {
      route: 'npx',
      label: 'Copy command',
      detail: 'Upstream ships no Intel-Mac desktop build. The npm package runs the same Host.',
      command: NPX_COMMAND,
    }
  }
  return {
    route: 'source',
    label: 'Copy setup commands',
    detail:
      'Upstream ships no desktop build for Linux. Source build is the supported route; ' +
      'the npm package is the shortcut when a prebuilt binary covers your CPU.',
    command: `# build from source\n${SOURCE_COMMAND}\n\n# or use the prebuilt web package\n${NPX_COMMAND}`,
  }
}

/** What a managed-launch attempt ended in, when one was made. */
export type ManagedLaunchOutcome = 'not-found' | 'timeout' | 'exited' | 'refused'

export interface ConnectFailureContext {
  host: string
  port: number
  /** Set when discovery found a Host on a different loopback port. */
  discoveredPort?: number
  /** `process.platform`; omit to get no install guidance. */
  platform?: string
  /** `process.arch`. Only consulted on macOS. */
  arch?: string
  /**
   * Set when `$DSH_HOME/.credentials.yaml` could not be read, so local minting
   * was never on the table.
   */
  credentialsUnavailable?: boolean
  /** Set when the desktop app was found on disk. */
  desktopInstalled?: string
  /** Set when managed launch ran and did not produce a launch URL. */
  managedAttempted?: ManagedLaunchOutcome
  /** The active `deepseekHarness.sessionMode`, when known. */
  sessionMode?: SessionMode
  /**
   * `vscode.env.remoteName` — `'ssh-remote'`, `'wsl'`, `'dev-container'`, … —
   * or absent for a local window. Changes which install is even installable,
   * so it is an input to the advice rather than a decoration on it.
   */
  remote?: string
}

/**
 * Name the routes the user is *not* already on.
 *
 * Telling somebody to do the thing they are already doing is the most annoying
 * possible failure message, so the advice is always about the alternatives.
 */
function alternatives(mode: SessionMode | undefined): string {
  switch (mode) {
    case 'auto':
      return 'You are in "auto", which is the mode that does both: it minted from $DSH_HOME/.credentials.yaml if it could, then tried to start a Host. If it still could not start one, the command it runs is deepseekHarness.launchCommand — or install a Host above and this window connects itself.'
    case 'credentials':
      return 'Or set deepseekHarness.sessionMode to "auto" (mint from $DSH_HOME/.credentials.yaml when it is readable, and start a Host when nothing is listening) or "paste" (you start it and hand over the URL) — "credentials" only authenticates, it never starts a Host.'
    case 'managed':
      return 'Or switch deepseekHarness.sessionMode to "auto" to also mint from $DSH_HOME/.credentials.yaml when a Host is already running, or run "DeepSeek Harness: Use Launch URL" after starting the Host yourself.'
    case 'paste':
      return 'Or set deepseekHarness.sessionMode to "auto" and this extension starts a Host for you, or to "credentials" to mint a session from $DSH_HOME/.credentials.yaml.'
    default:
      return 'Or set deepseekHarness.sessionMode: "auto" does both (mint from $DSH_HOME/.credentials.yaml when it is readable, start a Host when nothing answers), "credentials" only mints, "managed" only starts, and "paste" takes a launch URL you copy yourself.'
  }
}

/**
 * Ordered rules, most specific first.
 *
 * Ordering is load-bearing rather than cosmetic. An auth refusal arrives as a
 * message that also mentions the failure to reach `/api/*`, so a reachability
 * rule tested first would relabel a credential problem as a dead process — and
 * "start dsh web" is exactly the wrong advice for it.
 */
const RULES: { kind: ConnectionFailureKind; re: RegExp }[] = [
  // First, because it is not a failure to diagnose — it is a decision, made
  // before a socket was opened, and its own message already says so. Matched on
  // the refusal's own opening words so it cannot be confused with a transport
  // error against a host that happens to be spelled the same way.
  { kind: 'non-loopback-host', re: /Refusing to talk to "/ },
  // The Host itself told us no. Its refusal sentence is a stable fingerprint.
  { kind: 'auth-failed', re: /authentication required|dsh-auth|session cookie|credentials\.yaml|unauthoriz|\b401\b|Refused to mint/i },
  // Something answered that is not a dsh Host: the HTML/JSON it returned is not
  // the shape any of our routes produce.
  { kind: 'wrong-port', re: /not a dsh|foreign|unexpected response|invalid json|<!doctype|<html|text\/html/i },
  // Reachable, recognisably a Host, and it does not serve what we need.
  { kind: 'protocol-incompatible', re: /method-unavailable|no such method|unknown method|does not serve|unsupported (wire|protocol)|wire negotiation|incompatible/i },
  // Nothing there.
  { kind: 'runtime-not-running', re: /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|fetch failed|cannot reach|socket hang ?up|network error/i },
]

export function classifyConnectFailure(message: string, ctx: ConnectFailureContext): ConnectionHint {
  const kind = RULES.find((r) => r.re.test(message))?.kind ?? 'unknown'
  const where = `${ctx.host}:${String(ctx.port)}`
  const detail = message.trim()
  // Offered only when something is genuinely absent: no desktop app on disk.
  // The three `managedAttempted` branches below further narrow it to the one
  // outcome where the command itself was missing.
  const install =
    ctx.platform !== undefined && ctx.desktopInstalled === undefined
      ? installGuidanceFor(ctx.platform, ctx.arch ?? '', ctx.remote)
      : undefined

  switch (kind) {
    case 'non-loopback-host':
      return {
        kind,
        title: `DeepSeek Harness is only reachable on this machine`,
        detail,
        fix:
          `${where} is not a host this plugin will talk to. It only ever drives a Harness running on the ` +
          'same machine as the VS Code window, and it checks that before opening a socket — so this is a refusal, ' +
          'not a network problem. Set deepseekHarness.host to 127.0.0.1, localhost or ::1. If your workspace is on ' +
          'another machine (Remote-SSH, WSL, a container), run the Harness on that machine and let the extension ' +
          'talk to its loopback — see "Remote development" in the README.',
        repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
      }

    case 'auth-failed':
      return {
        kind,
        title: 'Authentication failed',
        detail,
        fix:
          `The Host at ${where} refused the session cookie. ` +
          (ctx.sessionMode === 'credentials'
            ? 'In "credentials" mode the cookie is minted from $DSH_HOME/.credentials.yaml, so either that file moved, the signing secret in it was regenerated, or the Host is running as a different user.'
            : `Currently in "${String(ctx.sessionMode ?? 'credentials')}" mode.`) +
          ` ${alternatives(ctx.sessionMode)} Running Diagnostics shows which file was looked for.`,
        repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
      }

    case 'wrong-port':
      return {
        kind,
        title: `Something else is listening on ${where}`,
        detail,
        fix: `Port ${String(ctx.port)} answered, but not like a DeepSeek Harness Host. Another service is probably holding it. Set deepseekHarness.port to the port your Host printed, or clear it and let auto-discovery find the Host itself.`,
        repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
      }

    case 'protocol-incompatible':
      return {
        kind,
        title: 'Host does not speak this protocol',
        detail,
        fix: 'The Host answered but does not serve the endpoints this build negotiates. Run "DeepSeek Harness: Probe Host" to see what it does serve, and compare against the "Verified against" versions in the README.',
        repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
      }

    case 'runtime-not-running': {
      if (ctx.discoveredPort !== undefined) {
        return {
          kind,
          title: 'Harness is not running',
          detail,
          fix: `Nothing is listening on ${where}. A Host was found on port ${String(ctx.discoveredPort)} instead — reconnect to use it.`,
          repair: { command: 'deepseekHarness.reconnect', label: 'Reconnect' },
        }
      }

      // A desktop install changes the answer completely, and it is the one case
      // where telling the user to install something would be an insult.
      if (ctx.desktopInstalled !== undefined) {
        return {
          kind,
          title: 'Harness is not running',
          detail: `${detail}\n(desktop app found at ${ctx.desktopInstalled})`,
          fix: `Nothing is listening on ${where}, but the desktop app is installed. Open it — it starts a Host on a loopback port and prints the URL — then connect again. If it is already open, pick "管理 dsh 命令…" from its menu to register the command.`,
          repair: { command: 'deepseekHarness.connect', label: 'Retry' },
        }
      }

      // Managed launch was tried and failed. Each ending has its own cause, and
      // only one of them means "you do not have this installed yet".
      if (ctx.managedAttempted !== undefined) {
        switch (ctx.managedAttempted) {
          case 'not-found':
            return {
              kind,
              title: '`dsh` is not on PATH',
              detail,
              fix:
                'Managed launch tried `dsh` and then `npx`, and neither could run — so this machine has no '
                + 'usable `dsh` and no working `npx`. Run "DeepSeek Harness: Install Host" to install it here'
                + (ctx.remote !== undefined && ctx.remote !== ''
                  ? ` (in the extension host, which on this "${ctx.remote}" connection is the remote machine)`
                  : '')
                + `, or run \`${NPM_INSTALL_COMMAND}\` yourself. ${alternatives(ctx.sessionMode)}`,
              repair: { command: 'deepseekHarness.installHost', label: 'Install Host' },
              ...(install !== undefined ? { install } : {}),
            }
          case 'timeout':
            return {
              kind,
              title: 'Harness started but never printed a URL',
              detail,
              fix: 'A `dsh` command did run, but no launch URL appeared within 120 seconds. Open the DeepSeek Harness log to see what it printed. If it is waiting on first-run setup, finish that in a terminal once.',
              repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
            }
          case 'exited':
            return {
              kind,
              title: 'Harness exited immediately',
              detail,
              fix: `The command exited before printing a launch URL — usually because port ${String(ctx.port)} is already taken by something else. Check the log for its last lines, or run it in a terminal once to see the error in full.`,
              repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
            }
          case 'refused':
            return {
              kind,
              title: 'Launch URL was printed, nothing accepted it',
              detail,
              fix: 'A launch URL was printed but no connection was accepted on it. Something is likely intercepting loopback traffic — this machine has a proxy configured. See the Diagnostics report for what was tried.',
              repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
            }
        }
      }

      // Nothing was attempted: only `auto` and `managed` reach the launcher, and
      // this branch is what the other two get. It used to say "which is the
      // default" — true until v0.2.8, and the reason a fresh install failed
      // before the user had done anything wrong.
      const credentials = ctx.credentialsUnavailable === true
        ? ' $DSH_HOME/.credentials.yaml could not be read either, so there is no stored session to fall back on.'
        : ''
      const paste = ctx.sessionMode === 'paste'
        ? ' This is "paste" mode: start the Host yourself and then run "DeepSeek Harness: Use Launch URL".'
        : ''
      // "Open the desktop app" is advice for a machine the user is sitting at.
      // On a remote connection the Host has to run over there, and the desktop
      // build is not installed on a headless box in the first place.
      const howToStart = ctx.remote !== undefined && ctx.remote !== ''
        ? `Start the Host on that machine — a terminal there running "dsh web" — or set `
          + 'deepseekHarness.sessionMode to "auto" and this extension starts it on the remote for you.'
        : 'Open the desktop app, or run "dsh web" in a terminal.'
      // The repair is the *specific* next step, not "try the thing that just
      // failed". `credentials` cannot start a Host by design, so a Retry button
      // there offers the one action guaranteed not to help.
      const repair = ctx.sessionMode === 'paste'
        ? { command: USE_LAUNCH_URL_COMMAND, label: 'Paste launch URL' }
        : ctx.sessionMode === 'credentials'
          ? { command: AUTO_SESSION_COMMAND, label: 'Switch to auto' }
          : { command: 'deepseekHarness.connect', label: 'Retry' }
      return {
        kind,
        title: 'Harness is not running',
        detail,
        fix:
          `Nothing is listening on ${where}.${credentials}${paste} ` +
          `${howToStart} ${alternatives(ctx.sessionMode)}`,
        repair,
        ...(install !== undefined ? { install } : {}),
      }
    }

    case 'unknown':
      return {
        kind,
        title: 'Could not connect',
        detail,
        fix: 'The failure did not match a known cause. Diagnostics records what was tried, the capabilities the Host reported, and the last error.',
        repair: { command: 'deepseekHarness.diagnostics', label: 'Diagnostics' },
      }
  }
}

// ─── diagnostics report ─────────────────────────────────────────────────────

export interface DiagnosticsInput {
  extensionVersion: string
  vscodeVersion: string
  platform: string
  nodeVersion: string
  host: string
  port: number
  connection: string
  muxStatus?: string
  hostInfo?: { version?: string; home?: string; provider?: string; model?: string }
  /** `ns/method` → served? Absent key means "probed and missing". */
  capabilities?: Record<string, boolean>
  lastError?: string
  hint?: ConnectionHint
  settings: Record<string, unknown>
  generatedAt: string
}

/**
 * Scratch secrets out of free text.
 *
 * Everything this module emits is built from values we chose, with two
 * exceptions: a transport error message, and the Host's home path. A transport
 * error is the one place a URL can carry a query string, and upstream launch
 * URLs carry `?token=<43 chars>`. Rather than trust every future error message
 * to stay clean, scrub by shape at the boundary.
 *
 * This is a backstop, not the primary control — the primary control is that the
 * cookie is never put into these fields in the first place.
 */
export function redact(text: string): string {
  return text
    // `?token=…` / `&token=…` in a URL, whatever the length.
    .replace(/([?&](?:token|key|secret|password|pat)=)[^&\s"']+/gi, '$1<redacted>')
    // A bare 43-char base64url blob — the shape dsh mints its launch token in.
    .replace(/\b[A-Za-z0-9_-]{43}\b/g, '<redacted>')
    // `dsh-auth-<hex>=<value>` and any Set-Cookie we might echo.
    .replace(/dsh-auth-[0-9a-f]{6,}=[^\s;]+/gi, 'dsh-auth-<redacted>')
    // Long hex runs (hashes, keys) — 32+ chars is not a path segment in practice.
    .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted>')
}

function served(capabilities: Record<string, boolean> | undefined): { yes: string[]; no: string[] } {
  const yes: string[] = []
  const no: string[] = []
  for (const [k, v] of Object.entries(capabilities ?? {})) (v ? yes : no).push(k)
  yes.sort()
  no.sort()
  return { yes, no }
}

export function buildDiagnosticsReport(input: DiagnosticsInput): string {
  const { yes, no } = served(input.capabilities)
  const lines: string[] = []

  lines.push('# DeepSeek Harness Connector — diagnostics')
  lines.push('')
  lines.push(`Generated ${input.generatedAt}`)
  lines.push('')
  lines.push('> This report contains no credential material. It is safe to attach to a bug')
  lines.push('> report — but read it first; a Host home path can name your user account.')
  lines.push('')

  lines.push('## Versions')
  lines.push('')
  lines.push('| | |')
  lines.push('| --- | --- |')
  lines.push(`| Extension | ${input.extensionVersion} |`)
  lines.push(`| VS Code | ${input.vscodeVersion} |`)
  lines.push(`| Electron / Node | ${input.nodeVersion} |`)
  lines.push(`| Platform | ${input.platform} |`)
  lines.push(`| Harness Host | ${input.hostInfo?.version ?? 'unknown (the Host does not advertise one)'} |`)
  lines.push('')

  lines.push('## Connection')
  lines.push('')
  lines.push('| | |')
  lines.push('| --- | --- |')
  lines.push(`| State | ${input.connection} |`)
  lines.push(`| Target | ${input.host}:${String(input.port)} |`)
  lines.push(`| Event stream | ${input.muxStatus ?? 'not open'} |`)
  lines.push(`| Host home | ${input.hostInfo?.home ? redact(input.hostInfo.home) : 'unknown'} |`)
  lines.push(`| Provider / model | ${[input.hostInfo?.provider, input.hostInfo?.model].filter(Boolean).join(' / ') || 'unknown'} |`)
  lines.push('')

  if (input.hint) {
    lines.push('## Why it is not connected')
    lines.push('')
    lines.push(`**${input.hint.title}** (\`${input.hint.kind}\`)`)
    lines.push('')
    if (input.hint.detail) {
      lines.push('```')
      lines.push(redact(input.hint.detail))
      lines.push('```')
      lines.push('')
    }
    lines.push(input.hint.fix)
    lines.push('')
    if (input.hint.install) {
      lines.push(`**Get started** — ${input.hint.install.detail}`)
      lines.push('')
      if (input.hint.install.command) {
        lines.push('```sh')
        lines.push(input.hint.install.command)
        lines.push('```')
        lines.push('')
      } else if (input.hint.install.url) {
        lines.push(input.hint.install.url)
        lines.push('')
      }
    }
  } else if (input.lastError) {
    lines.push('## Last error')
    lines.push('')
    lines.push('```')
    lines.push(redact(input.lastError))
    lines.push('```')
    lines.push('')
  }

  lines.push('## Capabilities')
  lines.push('')
  if (yes.length === 0 && no.length === 0) {
    lines.push('Not probed — capability probing happens at connect time.')
  } else {
    lines.push(`${String(yes.length)} served, ${String(no.length)} probed and missing.`)
    lines.push('')
    lines.push('<details><summary>Served</summary>')
    lines.push('')
    for (const c of yes) lines.push(`- \`${c}\``)
    lines.push('')
    lines.push('</details>')
    lines.push('')
    lines.push('<details><summary>Probed and missing</summary>')
    lines.push('')
    for (const c of no) lines.push(`- \`${c}\``)
    lines.push('')
    lines.push('</details>')
  }
  lines.push('')

  lines.push('## Settings')
  lines.push('')
  lines.push('| Setting | Value |')
  lines.push('| --- | --- |')
  for (const [k, v] of Object.entries(input.settings).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| \`${k}\` | ${redact(formatSetting(v))} |`)
  }
  lines.push('')
  lines.push('## Credentials')
  lines.push('')
  lines.push('The session cookie is minted from `$DSH_HOME/.credentials.yaml` and stored in')
  lines.push("VS Code's secret storage. It is not read here, not printed, and not exported.")
  lines.push('')

  return lines.join('\n')
}

function formatSetting(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return '—'
  try { return JSON.stringify(v) } catch { return '<unserialisable>' }
}
