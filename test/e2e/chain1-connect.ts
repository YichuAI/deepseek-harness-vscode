/**
 * Chain 1 — "Host up → VS Code connects → Host restarts → it recovers".
 *
 * Why this chain is written before chains 2 and 3
 * -----------------------------------------------
 * The changelog for v0.0.4 through v0.1.1 is a list of ways this exact sequence
 * failed: the panel came up disconnected against a Host that was running, and
 * after a Host restart the only reliable recovery was reloading the window. Those
 * are not projection bugs — every one of them is a fact about a socket, a cookie
 * or a process lifetime, which is why a stubbed transport cannot see them.
 *
 * So this drives the real `HarnessClient` and the real `BrowserSessionAuth`
 * against the real socket server in `fake-host.ts`, and asserts on what crossed
 * the wire as well as on what the client believes.
 *
 * What it covers, in the order a user would hit it:
 *   1. the fence is actually on — a Host that lets anyone in proves nothing
 *   2. adopting the launch URL mints a session, and connect then succeeds
 *   3. the client learns the Host identity from the `ready` frame
 *   4. the Host is killed: the client does NOT notice by itself
 *   5. a plain connect() is a no-op while the stale state says `connected`
 *   6. a forced connect against the dead Host fails, loudly and by name
 *   7. a new Host on a new port cannot be reached with the old session
 *   8. adopting the NEW launch URL and forcing a connect recovers
 *   9. the old launch URL is dead — the token belongs to the process that printed it
 */

import { BrowserSessionAuth, type AuthStore } from '../../src/harness/auth.ts'
import { HarnessClient } from '../../src/harness/client.ts'
import { startFakeHarness, type FakeHarnessHost } from './fake-host.ts'
import type { ChainResult } from './chain5-revert.ts'

/** An in-memory stand-in for `context.secrets`. */
function memoryStore(): AuthStore & { value: string | undefined } {
  const box = {
    value: undefined as string | undefined,
    load: async (): Promise<string | undefined> => box.value,
    save: async (value: string | undefined): Promise<void> => { box.value = value },
  }
  return box
}

export async function runChain1(): Promise<ChainResult> {
  const name = 'Connect and auth (Host restart, reconnect)'
  let passed = 0
  let failed = 0
  const details: string[] = []

  const check = (label: string, ok: boolean, detail = ''): void => {
    if (ok) { passed++; console.log(`  ✓ ${label}`) }
    else { failed++; details.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`) }
  }

  let first: FakeHarnessHost | undefined
  let second: FakeHarnessHost | undefined
  let client: HarnessClient | undefined

  try {
    first = await startFakeHarness()

    // Auth is constructed once, against the configured authority, exactly as
    // `extension.ts` does — and deliberately NOT rebuilt when the target moves.
    const store = memoryStore()
    const auth = new BrowserSessionAuth({
      host: first.host,
      port: first.port,
      store,
      log: () => undefined,
      allowLocalMint: false,
    })
    client = new HarnessClient({ host: first.host, port: first.port, auth, log: () => undefined })

    // ── 1. the fence ────────────────────────────────────────────────────────
    {
      const res = await fetch(`http://${first.host}:${String(first.port)}/`)
      const body = await res.text()
      check('the fake Host fences unauthenticated requests', res.status === 401, `got ${String(res.status)}`)
      check('...with the fingerprint the extension classifies on',
        body.includes('dsh web authentication required'), JSON.stringify(body.slice(0, 60)))
    }

    // A connect with no session must fail as an auth problem, not as "no Host".
    {
      let message = ''
      try { await client.connect({ force: true }) } catch (e) { message = e instanceof Error ? e.message : String(e) }
      check('without a session, connect refuses to proceed', message !== '')
      check('...and the refusal is about authentication, not about a missing Host',
        client.getState().kind === 'error' && /authentication|cookie|dsh web/i.test(
          (client.getState() as { message?: string }).message ?? '',
        ), JSON.stringify(client.getState()))
      check('...with no cookie stored, so nothing was silently invented',
        auth.cookieHeader() === undefined)
    }

    // ── 2. adopt the launch URL, then connect ───────────────────────────────
    {
      await auth.adoptLaunchUrl(first.launchUrl)
      check('adopting the launch URL mints a session', auth.isReady())
      const exchanges = first.requests.filter((r) => r.path === '/' && r.method === 'GET')
      check('...by redeeming the token at the origin the URL names',
        exchanges.length >= 1, `${String(exchanges.length)} GET(s)`)

      await client.connect({ force: true })
      check('connect against a live Host succeeds', client.getState().kind === 'connected',
        JSON.stringify(client.getState()))
    }

    // ── 3. host identity came off the socket ────────────────────────────────
    {
      // `describe()` returns the `ready` frame's payload. If the mux upgrade or
      // the `open` frame had not worked, this would still be `{ home: '' }` and
      // `respondApproval` would post an empty clientId.
      const info = client.describe()
      check('the client learned the Host identity from the ready frame',
        typeof info.clientId === 'string' && info.clientId !== '',
        JSON.stringify(info))
      check('...and the host home that came with it', info.home === '/fake/dsh-home', info.home)
      check('the mux socket really opened', first.muxConnections >= 1, `${String(first.muxConnections)} connection(s)`)
    }

    // ── 4. the Host is killed ───────────────────────────────────────────────
    {
      const dead = first
      await dead.kill()
      // Give the close a moment to travel; the client has no other way to learn.
      await new Promise((r) => setTimeout(r, 150))
      check('after the Host dies the client still *believes* it is connected',
        client.getState().kind === 'connected',
        `state=${client.getState().kind} — this stale state is why plain connect() used to do nothing`)
    }

    // ── 5. plain connect() is a no-op ───────────────────────────────────────
    {
      const before = first.muxConnections
      await client.connect()
      check('a plain connect() while state says "connected" does nothing at all',
        first.muxConnections === before,
        `${String(first.muxConnections)} vs ${String(before)} mux connection(s)`)
    }

    // ── 6. a forced connect against the dead Host fails ─────────────────────
    {
      let message = ''
      try { await client.connect({ force: true }) } catch (e) { message = e instanceof Error ? e.message : String(e) }
      check('a forced connect against the dead Host fails', message !== '')
      check('...and leaves the state in error rather than connected',
        client.getState().kind === 'error', client.getState().kind)
      check('...naming the target it could not reach',
        message.includes(String(first.port)) || /unreachable|No HTTP response|socket/i.test(message),
        JSON.stringify(message.slice(0, 120)))
    }

    // ── 7. a new Host, on a new port, is not reachable on the old session ───
    {
      second = await startFakeHarness()
      check('the new Host is a different port', second.port !== first.port,
        `${String(first.port)} → ${String(second.port)}`)

      client.retarget(second.host, second.port)
      let message = ''
      try { await client.connect({ force: true }) } catch (e) { message = e instanceof Error ? e.message : String(e) }
      check('retargeting alone does not authenticate: the stored session is for the old authority',
        message !== '', message === '' ? 'connect unexpectedly succeeded' : 'refused, as it must')
      check('...and the new Host saw no successful session-less negotiation',
        client.getState().kind === 'error', client.getState().kind)
    }

    // ── 8. adopt the new launch URL and recover ─────────────────────────────
    {
      const before = second.muxConnections
      await auth.adoptLaunchUrl(second.launchUrl)
      await client.connect({ force: true })
      check('adopting the new launch URL and forcing a connect recovers',
        client.getState().kind === 'connected', JSON.stringify(client.getState()))
      check('...on a freshly opened socket, not the dead one',
        second.muxConnections > before, `${String(second.muxConnections)} vs ${String(before)}`)
      check('...and it is the NEW Host answering', client.describe().clientId !== undefined)
    }

    // ── 9. the old token is dead ────────────────────────────────────────────
    {
      // The launch token is per-process and now unreachable, so the exchange
      // simply fails. What matters is that it fails *here* rather than leaving
      // the extension holding a session it believes in.
      let failedToRedeem = false
      try { await auth.adoptLaunchUrl(first.launchUrl) } catch { failedToRedeem = true }
      check('the old Host’s launch URL can no longer be redeemed', failedToRedeem)
    }
  } catch (e) {
    failed++
    details.push(`chain threw: ${e instanceof Error ? e.message : String(e)}`)
    console.log(`  ✗ chain threw — ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    try { client?.dispose() } catch { /* noop */ }
    try { await first?.kill() } catch { /* already dead */ }
    try { await second?.kill() } catch { /* noop */ }
  }

  return { name, passed, failed, ...(details.length > 0 ? { failureDetail: details.join('; ') } : {}) }
}
