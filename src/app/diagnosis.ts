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
}

export interface ConnectFailureContext {
  host: string
  port: number
  /** Set when discovery found a Host on a different loopback port. */
  discoveredPort?: number
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

  switch (kind) {
    case 'auth-failed':
      return {
        kind,
        title: 'Authentication failed',
        detail,
        fix: `The Host at ${where} refused the session cookie. Run "dsh web" once in this harness home so $DSH_HOME/.credentials.yaml exists, and check that deepseekHarness.autoSession is on. Running Diagnostics shows which file was looked for.`,
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

    case 'runtime-not-running':
      return {
        kind,
        title: 'Harness is not running',
        detail,
        ...(ctx.discoveredPort !== undefined
          ? {
              fix: `Nothing is listening on ${where}. A Host was found on port ${String(ctx.discoveredPort)} instead — reconnect to use it.`,
              repair: { command: 'deepseekHarness.reconnect', label: 'Reconnect' },
            }
          : {
              fix: 'Nothing is listening on ' + where + '. This extension never starts the Host for you: run "dsh web" in a terminal (or open the desktop app) and connect again. If it is already running, check deepseekHarness.port.',
              repair: { command: 'deepseekHarness.connect', label: 'Retry' },
            }),
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
