/**
 * launcher.ts — start `dsh web` ourselves and read the launch URL off its console.
 *
 * Why this exists
 * ───────────────
 * There are only two ways to obtain a Harness session, and both used to cost the
 * user something:
 *
 *   1. The sanctioned exchange: `dsh web` prints a per-process launch URL
 *      carrying a token, and `GET /?token=…` trades it for the session cookie.
 *      Nothing writes that token to disk, so a third-party client normally has
 *      to ask the person to copy a line out of a terminal.
 *   2. Minting the cookie from the signing secret in
 *      `$DSH_HOME/.credentials.yaml` — zero paste, but it means reading a file
 *      that also holds the user's model API keys. That is the single largest
 *      trust obstacle this extension has, and rightly so.
 *
 * Starting the Host ourselves removes the trade-off. If we own the process, its
 * stdout is ours: no paste, and no credential file either. `dsh` gets to stay the
 * only writer of its own secrets, and the extension's "we do not start processes
 * for you" default stays intact because this is opt-in.
 *
 * Scope, stated honestly
 * ──────────────────────
 * This only helps when **nothing is listening**. A Host that somebody else
 * started (a terminal, the desktop app) never exposes its token to us, so that
 * case still ends in the paste-a-launch-URL command. Managed launch is therefore
 * not a replacement for it — the two cover different halves.
 *
 * Credential handling
 * ───────────────────
 * The launch URL *is* a credential. It is returned to the caller, held in memory
 * for `openWebUI`, and must never be logged, persisted to settings, pushed into
 * the webview, or included in the diagnostics export. {@link redactLaunchUrl}
 * exists so that the one place we do echo it — the plugin log — cannot leak it,
 * and every log line in this file goes through it.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { pathKey } from './path-identity.ts'

/**
 * The `dsh web` launch line.
 *
 * Upstream prints `dsh web: http://127.0.0.1:3080/?token=<43-char base64url>`.
 * Only loopback is matched: the extension refuses non-loopback targets, so a URL
 * for any other host is not one it could use.
 */
const LAUNCH_URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::(\d+))?\/\?token=([A-Za-z0-9_-]+)/u

/** How much console output to keep for diagnosis. Enough for a stack trace, not a log file. */
const MAX_CAPTURED_OUTPUT = 64 * 1024

/** A Host we started, and where it is. */
export interface LaunchAttempt {
  /** The full launch URL, token included. Credential material — never log it raw. */
  url: string
  host: string
  /** The port the Host actually bound, which is not necessarily the configured one. */
  port: number
}

/** Find the launch URL in a chunk of `dsh web` output. */
export function findLaunchUrl(text: string): { url: string; port: number } | undefined {
  const m = LAUNCH_URL_RE.exec(text)
  if (m === null) return undefined
  const url = m[0]
  // `m[1]` is absent when the URL omits the port, which means the default.
  const port = m[1] === undefined ? 80 : Number(m[1])
  return { url, port }
}

/** Strip the token so a launch URL can be logged or shown. */
export function redactLaunchUrl(text: string): string {
  return text.replace(/([?&]token=)[A-Za-z0-9_-]+/gu, '$1<redacted>')
}

/**
 * `platform` decides both the separator and the joiner.
 *
 * Not `process.platform`'s — passing a platform in and then ignoring it for the
 * separator is how a Windows host silently produces a one-entry `PATH` for a
 * macOS target, which is the kind of defect that only shows up on somebody
 * else's machine. `process.platform` is still the *default*, so production
 * behaviour is unchanged.
 */
function joinFor(platform: NodeJS.Platform): (...parts: string[]) => string {
  return platform === 'win32' ? win32.join : posix.join
}

function delimiterFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/**
 * Extra directories the extension host's `PATH` usually lacks.
 *
 * A VS Code window launched from Finder or the Windows Start menu inherits a
 * minimal `PATH` — on macOS typically `/usr/bin:/bin:/usr/sbin:/sbin` — even
 * though the user's shell can see `npx` perfectly well. Without this, managed
 * launch would fail with "command not found" for people who have Node installed
 * and working, which is the least debuggable outcome there is.
 */
export function pathAugmentations(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const join = joinFor(platform)
  if (platform === 'darwin') {
    return [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      join(homedir(), '.volta', 'bin'),
    ]
  }
  if (platform === 'win32') {
    return [
      env['ProgramFiles'] === undefined ? 'C:\\Program Files\\nodejs' : join(env['ProgramFiles'], 'nodejs'),
      env['APPDATA'] === undefined ? '' : join(env['APPDATA'], 'npm'),
      env['LOCALAPPDATA'] === undefined ? '' : join(env['LOCALAPPDATA'], 'Programs', 'nodejs'),
    ].filter((p) => p !== '')
  }
  return [
    '/usr/local/bin',
    '/usr/bin',
    join(homedir(), '.local', 'bin'),
  ]
}

/** `env` with {@link pathAugmentations} appended to `PATH`, without duplicating entries. */
export function envWithAugmentedPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const separator = delimiterFor(platform)
  const current = (env['PATH'] ?? '').split(separator).filter((p) => p !== '')
  const seen = new Set(current.map((p) => pathKey(p, platform)))
  const extra = pathAugmentations(platform, env).filter((p) => {
    const key = pathKey(p, platform)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { ...env, PATH: [...current, ...extra].join(separator) }
}

// ─── what to start, and whether there is a desktop app already ──────────────

/**
 * The command managed launch runs by default.
 *
 * `--port 0` rather than a fixed port on purpose: managed mode takes the port
 * from the launch URL it reads, so pinning one only adds a way to fail when
 * something else already holds it. A user who wants a predictable port can set
 * the command to whatever they like.
 *
 * Note there is no "open a browser" flag to suppress — `dsh web` does not have
 * one (verified against 0.2.1-rc.2's `--help`), so the default command carries
 * nothing that a future upstream could remove under us.
 */
export const DEFAULT_LAUNCH_COMMAND = 'dsh web --port 0'

/**
 * What to try when `dsh` is not on `PATH` at all.
 *
 * Only ever used for `not-found`. If `dsh` exists but is too old to boot, the
 * fix is to update it, and silently launching a *different* build instead would
 * hide that — which is why this is a `not-found`-only fallback rather than a
 * general "retry with npx".
 *
 * This is also the whole remote story for the common case. Under Remote-SSH the
 * extension host — and therefore this spawn — runs on the *remote* machine, so
 * `npx` fetches the CLI there and starts the Host there. Nothing is installed
 * globally, nothing has to be on the remote's `PATH`, and the loopback address
 * the Host binds is the remote's own loopback, which is the only address this
 * plugin will talk to anyway.
 */
export const NPX_FALLBACK_COMMAND = 'npx -y @deepseek-ai/dsh@latest web --port 0'

/** How long the first attempt gets. A local `dsh` boots in seconds. */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000

/**
 * How long `npx` gets, which has to be longer.
 *
 * `npx -y` downloads and unpacks the package before it can print anything, and
 * on a remote host over a slow link that is the slowest part of the whole
 * operation. Reusing the local timeout would make a cold cache look like a
 * broken install.
 */
export const NPX_LAUNCH_TIMEOUT_MS = 300_000

/** Which of the two commands a plan step is. */
export type LaunchRoute = 'configured' | 'npx-fallback'

/** One command managed launch may run, and how long it may take. */
export interface LaunchStep {
  command: string
  route: LaunchRoute
  timeoutMs: number
}

/** Does this command already go through `npx`? Then the fallback would be a no-op. */
export function usesNpx(command: string): boolean {
  return /(^|[\s;&|("'`])npx([\s"')`]|$)/u.test(command)
}

/**
 * The ordered commands managed launch will try for one connect.
 *
 * Two decisions, both about not lying to the user:
 *
 *  · **The fallback only follows `not-found`.** A Host that started and then
 *    died on a port conflict has nothing to gain from a second, slower command.
 *  · **The fallback only follows the default command.** If somebody set
 *    `deepseekHarness.launchCommand` to their own wrapper, `dsh` not being found
 *    is information about *their* setup — and quietly running a different build
 *    over the top of it would hide the one thing they need to see. An explicit
 *    choice gets an explicit failure.
 */
export function launchPlan(command: string): LaunchStep[] {
  const configured: LaunchStep = {
    command,
    route: 'configured',
    timeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
  }
  if (command.trim() !== DEFAULT_LAUNCH_COMMAND || usesNpx(command)) return [configured]
  return [
    configured,
    { command: NPX_FALLBACK_COMMAND, route: 'npx-fallback', timeoutMs: NPX_LAUNCH_TIMEOUT_MS },
  ]
}

/**
 * Where a desktop install would be, per platform.
 *
 * Upstream ships this app for Windows x64 and Apple Silicon; there is no Linux
 * package, so that list is empty. Knowing whether it is installed is worth the
 * `access()` call because it changes the advice completely — "open the app you
 * already have" versus "install something".
 */
export function desktopInstallCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const join = joinFor(platform)
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA']
    return local === undefined ? [] : [join(local, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe')]
  }
  if (platform === 'darwin') {
    return ['/Applications/DeepSeek Harness.app', join(homedir(), 'Applications', 'DeepSeek Harness.app')]
  }
  return []
}

/** The desktop install's path, or `undefined` when there is none. Best-effort. */
export async function detectDesktopInstall(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  for (const candidate of desktopInstallCandidates(platform, env)) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Not there, or not readable. Either way it is not something we can point at.
    }
  }
  return undefined
}

/**
 * Why a launch failed, in terms the user can act on.
 *
 * `not-found` is separated from the rest on purpose: "the command does not
 * exist" is an installation problem with an installation fix, while "it exited"
 * is usually a port conflict or a broken install — two different next steps,
 * and conflating them sends people to reinstall something they already have.
 */
export type LaunchFailureKind = 'not-found' | 'timeout' | 'exited' | 'refused'

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly kind: LaunchFailureKind,
    /** Redacted console output, for the log and the diagnostic report. */
    readonly output: string,
  ) {
    super(message)
    this.name = 'LaunchError'
  }
}

export interface ManagedLaunchOptions {
  /** Shell command that starts the Host, e.g. `dsh web --port 0`. */
  command: string
  /** Working directory for the child. Defaults to the extension host's cwd. */
  cwd?: string
  /** How long to wait for the launch URL before giving up. */
  timeoutMs?: number
  log: (msg: string) => void
}

/** Outcomes of a signal-based stop, so the caller can tell the user the truth. */
export type StopOutcome = 'not-running' | 'stopped' | 'signalled'

/**
 * Owns the `dsh web` process this extension started, if any.
 *
 * Deliberately a single long-lived instance rather than one per connect attempt:
 * the child *is* the server, so a per-attempt lifetime would tear down the very
 * thing we just started. It lives until {@link stop} — in practice until the
 * extension deactivates.
 */
export class ManagedLauncher {
  private child: ChildProcess | undefined
  /** Everything the child printed, capped. Token-bearing lines go through redaction on read. */
  private captured = ''
  private url: string | undefined
  private stopped = false

  /** True when a child of ours is alive. */
  isRunning(): boolean {
    return this.child !== undefined && this.child.exitCode === null && this.child.signalCode === null
  }

  /** The launch URL of the Host we started, if we started one. Credential material. */
  launchUrl(): string | undefined {
    return this.url
  }

  /**
   * Start the Host and return once it has printed a launch URL.
   *
   * @throws LaunchError for every failure mode, so the caller never has to
   *   distinguish a spawn error from an exit from a timeout.
   */
  async start(opts: ManagedLaunchOptions): Promise<LaunchAttempt> {
    if (this.isRunning()) {
      // Idempotent-ish: a second caller wants the existing Host, not a second
      // one that would just collide on the port.
      const existing = this.url
      if (existing !== undefined) {
        const parsed = new URL(existing)
        return { url: existing, host: parsed.hostname, port: Number(parsed.port === '' ? '80' : parsed.port) }
      }
      throw new LaunchError('a Host started by this extension is already running', 'refused', '')
    }

    const command = opts.command.trim()
    if (command === '') throw new LaunchError('the launch command is empty', 'refused', '')

    const timeoutMs = opts.timeoutMs ?? 120_000
    opts.log(`launch: starting \`${command}\``)

    const child = spawn(command, {
      cwd: opts.cwd,
      env: envWithAugmentedPath(),
      // The command comes from the user's own settings, so a shell is how their
      // `npx`/`pnpm`/wrapper scripts resolve — the same thing a terminal would do.
      shell: true,
      windowsHide: true,
      // A process group on POSIX so `stop()` can take the whole tree down; the
      // child is not unref'd, so it does not outlive the extension host silently.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.stopped = false

    return await new Promise<LaunchAttempt>((resolve, reject) => {
      let settled = false

      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      const absorb = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        this.captured = (this.captured + text).slice(-MAX_CAPTURED_OUTPUT)
        const found = findLaunchUrl(text)
        if (found === undefined) return
        this.url = found.url
        const parsed = new URL(found.url)
        opts.log(`launch: Host is up on ${parsed.hostname}:${parsed.port} (launch URL redacted)`)
        finish(() => { resolve({ url: found.url, host: parsed.hostname, port: found.port }) })
      }

      child.stdout?.on('data', absorb)
      child.stderr?.on('data', absorb)

      const timer = setTimeout(() => {
        finish(() => {
          reject(new LaunchError(
            `\`${command}\` printed no launch URL within ${String(Math.round(timeoutMs / 1000))}s`,
            'timeout',
            redactLaunchUrl(this.captured),
          ))
        })
      }, timeoutMs)

      child.on('error', (err: NodeJS.ErrnoException) => {
        const notFound = err.code === 'ENOENT'
        finish(() => {
          reject(new LaunchError(
            notFound
              ? `could not run \`${command}\` — the command was not found on this machine`
              : `could not run \`${command}\` — ${err.message}`,
            notFound ? 'not-found' : 'exited',
            redactLaunchUrl(this.captured),
          ))
        })
      })

      child.on('exit', (code, signal) => {
        this.child = undefined
        finish(() => {
          const how = signal !== null ? `signal ${signal}` : `code ${String(code)}`
          reject(new LaunchError(
            `\`${command}\` exited with ${how} before printing a launch URL`,
            'exited',
            redactLaunchUrl(this.captured),
          ))
        })
      })
    })
  }

  /** Redacted tail of the child's console output, for the log and the report. */
  outputTail(): string {
    return redactLaunchUrl(this.captured).trim()
  }

  /**
   * Stop the Host this extension started.
   *
   * Best-effort by design, and the caller is expected to say so rather than
   * imply success: `npx` is a shim that spawns the real server as a grandchild,
   * so a plain `kill()` reaps the shim and leaves the server holding the port.
   * Windows needs `taskkill /T`; POSIX needs the process group we created at
   * spawn time. Neither is guaranteed to succeed on a given machine.
   */
  async stop(): Promise<StopOutcome> {
    const child = this.child
    if (child === undefined || child.pid === undefined || !this.isRunning()) {
      this.child = undefined
      return 'not-running'
    }
    this.stopped = true
    const pid = child.pid

    const signalled = await new Promise<boolean>((resolve) => {
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
          resolve(err === null)
        })
        return
      }
      try {
        // Negative pid targets the group created by `detached: true`.
        process.kill(-pid, 'SIGTERM')
        resolve(true)
      } catch {
        try {
          child.kill('SIGTERM')
          resolve(true)
        } catch {
          resolve(false)
        }
      }
    })

    this.child = undefined
    this.url = undefined
    if (signalled) return 'stopped'
    // `taskkill` can lose a race with a child that exited on its own, and then
    // reports "no process found" — which reads like a failure but means the Host
    // is already gone, i.e. exactly the outcome we wanted. Only a child that is
    // *still alive* after the attempt is a genuinely unconfirmed stop, and saying
    // otherwise would train the reader to ignore this value.
    return child.exitCode === null && child.signalCode === null ? 'signalled' : 'stopped'
  }
}

/**
 * Whether this extension started the Host, as opposed to attaching to one the
 * user already had running. Only ever true after {@link ManagedLauncher.start}.
 */
export function isOwnedByExtension(launcher: ManagedLauncher): boolean {
  return launcher.isRunning()
}
