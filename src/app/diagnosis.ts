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

import type { SessionMode } from './session-mode.ts'

export type ConnectionFailureKind =
  /** Nothing is listening where we looked. */
  | 'runtime-not-running'
  /** We found a Host and it refused us. */
  | 'auth-failed'
  /** Something is listening, but it is not a dsh Host. */
  | 'wrong-port'
  /** We reached a Host that does not speak the shape we need. */
  | 'protocol-incompatible'
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

const NPX_COMMAND = 'npx @deepseek-ai/dsh web'
const SOURCE_COMMAND =
  'git clone https://github.com/deepseek-ai/deepseek-harness.git && ' +
  'cd deepseek-harness && pnpm install && pnpm run build && pnpm dsh web'

/**
 * Pick the route for a platform. Pure, so the test can walk every platform.
 *
 * `arch` matters on one point only: the desktop build is Apple Silicon, so an
 * Intel Mac has to fall through to the npm package.
 */
export function installGuidanceFor(platform: string, arch: string): InstallGuidance {
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
}

/**
 * Name the routes the user is *not* already on.
 *
 * Telling somebody to do the thing they are already doing is the most annoying
 * possible failure message, so the advice is always about the alternatives.
 */
function alternatives(mode: SessionMode | undefined): string {
  switch (mode) {
    case 'credentials':
      return 'Or set deepseekHarness.sessionMode to "managed" (this extension starts a Host and takes its launch URL) or "paste" (you start it and hand over the URL) — neither one reads $DSH_HOME/.credentials.yaml.'
    case 'managed':
      return 'Or switch deepseekHarness.sessionMode to "credentials" to mint a session from $DSH_HOME/.credentials.yaml, or run "DeepSeek Harness: Use Launch URL" after starting the Host yourself.'
    case 'paste':
      return 'Or set deepseekHarness.sessionMode to "managed" so this extension starts a Host for you, or to "credentials" to mint a session from $DSH_HOME/.credentials.yaml.'
    default:
      return 'Or set deepseekHarness.sessionMode: "managed" starts the Host for you, "credentials" mints a session from $DSH_HOME/.credentials.yaml, and "paste" takes a launch URL you copy yourself.'
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
      ? installGuidanceFor(ctx.platform, ctx.arch ?? '')
      : undefined

  switch (kind) {
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
              fix: `Managed launch could not find a \`dsh\` command to run. Install the route below, then reconnect. ${alternatives(ctx.sessionMode)}`,
              repair: { command: 'deepseekHarness.connect', label: 'Retry' },
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

      // Nothing was attempted: managed launch is off, which is the default.
      const credentials = ctx.credentialsUnavailable === true
        ? ' $DSH_HOME/.credentials.yaml could not be read either, so there is no stored session to fall back on.'
        : ''
      const paste = ctx.sessionMode === 'paste'
        ? ' This is "paste" mode: start the Host yourself and then run "DeepSeek Harness: Use Launch URL".'
        : ''
      return {
        kind,
        title: 'Harness is not running',
        detail,
        fix:
          `Nothing is listening on ${where}.${credentials}${paste} ` +
          `Open the desktop app, or run "dsh web" in a terminal. ${alternatives(ctx.sessionMode)}`,
        repair: { command: 'deepseekHarness.connect', label: 'Retry' },
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
