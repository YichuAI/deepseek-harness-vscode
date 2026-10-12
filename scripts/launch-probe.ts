/**
 * launch-probe.ts — does managed launch actually work on *this* machine?
 *
 * The launcher is the one part of this extension that runs somebody else's
 * process, and every fact it depends on belongs to a machine rather than to the
 * source tree: whether `dsh` is on the `PATH` VS Code hands its extension host,
 * whether the launch URL lands on stdout or stderr, whether the port is dynamic,
 * whether the token exchange still answers `303`, and whether stopping the child
 * actually frees the port. None of that can be asserted from a unit test, and
 * all of it is cheap to observe directly.
 *
 * So: run the real launcher, print what it saw, and clean up after itself.
 * Nothing is printed that would leak the token — every URL goes through
 * `redactLaunchUrl` first. It also answers two questions a unit test cannot:
 * whether a launch token can be redeemed twice (the reconnect path depends on
 * it), and whether the process we spawned is the one holding the port (the
 * invariant `stop()` rests on).
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/launch-probe.ts ["dsh web --port 0"]
 *
 * Exit code is 0 only when a launch URL was obtained, the port went quiet again,
 * and the Host never outlived our child.
 */

import { ManagedLauncher, redactLaunchUrl } from '../src/harness/launcher'

const DEFAULT_COMMAND = 'dsh web --port 0'

async function probeUrl(url: string): Promise<{ status: number; cookieNames: string[] } | string> {
  try {
    const res = await fetch(url, { redirect: 'manual' })
    // `getSetCookie` is the undici accessor; the older `get('set-cookie')` folds
    // multiple cookies into one comma-joined string and cannot be split safely.
    const raw = res.headers.getSetCookie()
    return { status: res.status, cookieNames: raw.map((c) => c.split('=')[0] ?? '?') }
  } catch (e) {
    // `fetch failed` on its own cannot tell a closed port from a proxy eating
    // the connection, and "did the port actually go quiet?" is the whole point
    // of the post-stop check. The errno lives on `cause`.
    const code = (e as { cause?: { code?: string } }).cause?.code
    const message = e instanceof Error ? e.message : String(e)
    return code === undefined ? message : `${message} (${code})`
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? DEFAULT_COMMAND
  console.log(`command: ${command}`)
  console.log(`platform: ${process.platform}/${process.arch}, node ${process.version}`)
  console.log('')

  const launcher = new ManagedLauncher()
  const started = Date.now()
  let attempt: { url: string; host: string; port: number } | undefined
  /** Set when the child died while the Host kept answering — a daemonised Host. */
  let orphaned = false

  try {
    attempt = await launcher.start({
      command,
      timeoutMs: 120_000,
      log: (m) => { console.log(`  [launcher] ${m}`) },
    })
    console.log('')
    console.log(`launch OK after ${String(Date.now() - started)} ms`)
    console.log(`  host      ${attempt.host}`)
    console.log(`  port      ${String(attempt.port)}`)
    console.log(`  url       ${redactLaunchUrl(attempt.url)}`)

    const token = new URL(attempt.url).searchParams.get('token')
    console.log(`  token     ${token === null ? 'MISSING' : `${String(token.length)} chars`}`)

    // The sanctioned exchange: the URL is only useful if it still trades for a
    // cookie, so probe it rather than assume.
    const exchange = await probeUrl(attempt.url)
    if (typeof exchange === 'string') {
      console.log(`  exchange  FAILED — ${exchange}`)
    } else {
      console.log(`  exchange  ${String(exchange.status)} ${exchange.status === 303 ? '(as expected)' : '(UNEXPECTED)'}`)
      console.log(`  cookies   ${exchange.cookieNames.join(', ') || '(none)'}`)
    }

    // Is the token reusable? The reconnect path depends on the answer, so ask it
    // instead of reasoning about it. Upstream compares the query token against
    // the process secret on every request, so a second redemption is expected to
    // work and mint another cookie.
    const again = await probeUrl(attempt.url)
    console.log(typeof again === 'string'
      ? `  exchange² FAILED — ${again}`
      : `  exchange² ${String(again.status)} ${again.status === 303 ? '(token is reusable — reconnects are safe)' : '(token appears single-use)'}`)

    // Same URL, no token: this is what the cookie has to be good enough for.
    const bare = await probeUrl(`http://${attempt.host}:${String(attempt.port)}/`)
    if (typeof bare === 'string') {
      console.log(`  bare GET  FAILED — ${bare}`)
    } else {
      console.log(`  bare GET  ${String(bare.status)} ${bare.status === 401 ? '(fence is on, as expected)' : ''}`)
    }

    // Does the process we spawned actually own the Host?
    //
    // This is the invariant `stop()` rests on, and it cannot be asserted from a
    // unit test. `dsh` has a background-boot concept — `--dsh-boot-bg` appears in
    // the HTML it serves — so if `dsh web` printed its URL and exited, our child
    // would be a shim, killing it would leave the real Host listening, and the
    // extension would be creating exactly the kind of stray process it promises
    // not to. Sampled over a few seconds, because "it was alive at t+0" proves
    // nothing about a daemonising launcher.
    for (let i = 1; i <= 3; i += 1) {
      await new Promise((r) => setTimeout(r, 1000))
      const live = await probeUrl(`http://${attempt.host}:${String(attempt.port)}/`)
      const port = typeof live === 'string' ? live : `HTTP ${String(live.status)}`
      const alive = launcher.isRunning()
      if (!alive && typeof live !== 'string') orphaned = true
      console.log(`  owner     t+${String(i)}s child=${alive ? 'alive' : 'GONE'} port=${port}`)
    }
    console.log(orphaned
      ? '  owner     VERDICT: the Host outlived our child — dsh daemonises, and stop() cannot reap it'
      : '  owner     VERDICT: our child holds the port, so stop() really does end it')
  } catch (e) {
    console.log('')
    console.log(`launch FAILED after ${String(Date.now() - started)} ms`)
    console.log(`  ${e instanceof Error ? e.message : String(e)}`)
    if (e instanceof Error && 'kind' in e) console.log(`  kind   ${String((e as { kind: unknown }).kind)}`)
    const tail = launcher.outputTail()
    if (tail !== '') {
      console.log('  output (redacted):')
      for (const line of tail.split('\n').slice(-20)) console.log(`    ${line}`)
    }
  } finally {
    const outcome = await launcher.stop()
    console.log('')
    console.log(`stop: ${outcome}`)

    if (attempt !== undefined) {
      // `stop()` is best-effort — `npx`/`dsh` are shims whose grandchild holds
      // the port — so check the port instead of trusting the return value.
      const after = await probeUrl(`http://${attempt.host}:${String(attempt.port)}/`)
      console.log(typeof after === 'string'
        ? `after  port is quiet (${after})`
        : `after  STILL LISTENING — answered ${String(after.status)}`)
      if (typeof after !== 'string' || orphaned) process.exitCode = 1
    } else {
      process.exitCode = 1
    }
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
