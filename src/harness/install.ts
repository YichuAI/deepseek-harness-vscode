/**
 * install.ts — put a `dsh` command on this machine, from inside the extension.
 *
 * Why this is not just a line of advice in a notification
 * ──────────────────────────────────────────────────────
 * On a remote connection "this machine" is not the one the user is looking at.
 * A Remote-SSH window's extension host runs on the far side of the link, so a
 * command this extension spawns lands exactly where the Host has to run — and a
 * command the user types into a *local* terminal lands exactly where it must
 * not. The failure mode of the advice-only version is that somebody installs
 * `dsh` on their laptop and reconnects to a remote that still has none.
 *
 * So the install runs where the extension host runs. That is the whole feature,
 * and it is worth being precise about: this code has no notion of "remote" in
 * it at all, and that is the point. It spawns in `process`'s own context, which
 * VS Code has already put on the correct side of the connection.
 *
 * What it does not do
 * ───────────────────
 * It does not elevate. `npm i -g` against a system-owned prefix fails with
 * `EACCES`, and that refusal is reported verbatim rather than retried with
 * `sudo` — a plugin silently asking for a root password to install a package is
 * not a trade this extension is entitled to make on the user's behalf. The
 * output is what tells them which prefix was not writable.
 *
 * The `npx` route in `launcher.ts` is the cheaper answer to the same problem
 * and needs none of this: it fetches the CLI into the npm cache and runs it,
 * on whatever side of the connection the extension host is on. This module
 * exists for the case where that is not enough — no `npx`, a cache the user
 * would rather populate once, or a machine where a real `dsh` on `PATH` is
 * wanted for other reasons.
 */

import { spawn } from 'node:child_process'
import { NPM_INSTALL_COMMAND } from '../app/diagnosis.ts'
import { envWithAugmentedPath } from './launcher.ts'

/** How much of the install's output to keep. Enough to see an npm error, not a log file. */
const MAX_CAPTURED_OUTPUT = 64 * 1024

/**
 * How long an install may take before we stop it.
 *
 * Five minutes, because this is a cold `npm` resolving and unpacking a real
 * dependency tree on a machine that may be on the other side of the world.
 * Killing it early would leave npm's own state half-written for no gain.
 */
const DEFAULT_INSTALL_TIMEOUT_MS = 300_000

export interface InstallOptions {
  /** Defaults to {@link NPM_INSTALL_COMMAND}. */
  command?: string
  timeoutMs?: number
  log: (msg: string) => void
}

export interface InstallOutcome {
  ok: boolean
  /** The command as run, so the report and the user see the same string. */
  command: string
  /** Exit code, or `null` when it was killed by a signal or never started. */
  code: number | null
  /** Combined stdout+stderr, tail-capped. */
  output: string
  /** Set when the failure was not a plain non-zero exit. */
  error?: string
}

/**
 * Run the install, and say what happened.
 *
 * Never throws: every ending — spawn failure, non-zero exit, timeout — comes
 * back as an {@link InstallOutcome}, because the caller's next step is to show
 * the user output either way and an exception would only add a second path to
 * the same message.
 */
export async function installCli(opts: InstallOptions): Promise<InstallOutcome> {
  const command = (opts.command ?? NPM_INSTALL_COMMAND).trim()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  opts.log(`install: running \`${command}\``)

  const child = spawn(command, {
    // Shell, for the same reason the launcher uses one: the user's `npm` may be
    // an `nvm` shim or a wrapper, and a shell is what resolves it the way their
    // own terminal would.
    shell: true,
    windowsHide: true,
    env: envWithAugmentedPath(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return await new Promise<InstallOutcome>((resolve) => {
    let captured = ''
    let settled = false

    const absorb = (chunk: Buffer): void => {
      captured = (captured + chunk.toString('utf8')).slice(-MAX_CAPTURED_OUTPUT)
    }

    const finish = (outcome: InstallOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.log(`install: ${outcome.ok ? 'succeeded' : `failed (${outcome.error ?? `exit ${String(outcome.code)}`})`}`)
      resolve({ ...outcome, output: captured.trim() })
    }

    child.stdout?.on('data', absorb)
    child.stderr?.on('data', absorb)

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({
        ok: false,
        command,
        code: null,
        output: '',
        error: `no result within ${String(Math.round(timeoutMs / 1000))}s`,
      })
    }, timeoutMs)

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({
        ok: false,
        command,
        code: null,
        output: '',
        error: err.code === 'ENOENT'
          ? 'the command was not found — this machine has no `npm` either'
          : err.message,
      })
    })

    child.on('exit', (code) => {
      finish({ ok: code === 0, command, code, output: '' })
    })
  })
}
