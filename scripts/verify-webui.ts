/**
 * verify-webui.ts — end-to-end proof that "Open Web UI" actually works.
 *
 * The Open Web UI command does not compose a URL; it mints the same
 * browser-session cookie the Host would have issued and drops it into the
 * browser's jar through a one-shot loopback redirect (`web-ui-bridge.ts`). The
 * one thing that can go wrong and stay invisible is the cookie being rejected by
 * the Host — which would leave the user on a `401 unauthorized` page that looks
 * like a bug in the extension. This script proves the minted cookie is accepted.
 *
 * It mints through the extension's *own* `BrowserSessionAuth.tryMintLocalSession`
 * (not a re-implementation of the HMAC), then makes two real HTTP requests
 * against the Host named by `DSH_PORT`:
 *
 *   1. no cookie  → must be `401` (proves the Host actually gates `/`)
 *   2. minted cookie → must be `200` with the Web UI document
 *
 * Usage:
 *   npm run verify-webui                 # default 127.0.0.1:3080, $HOME/.dsh
 *   DSH_PORT=3081 npm run verify-webui   # a Host on another loopback port
 *   DSH_HOME=/path/to/.dsh npm run verify-webui
 *
 * Exit code is 0 only when both hold. Requires a running `dsh web` and a
 * readable `$DSH_HOME/.credentials.yaml` — i.e. the same preconditions as the
 * integration test, so this is a manual pre-release step, not a CI gate.
 */

import * as http from 'node:http'
import type { IncomingMessage } from 'node:http'
import { BrowserSessionAuth } from '../src/harness/auth.ts'

const HOST = process.env['DSH_HOST'] ?? '127.0.0.1'
const PORT = Number(process.env['DSH_PORT'] ?? 3080)

interface GetResult {
  status: number
  body: string
}

function get(path: string, cookie?: string): Promise<GetResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path, method: 'GET', headers: cookie ? { cookie } : {} },
      (res: IncomingMessage) => {
        let body = ''
        res.on('data', (c: Buffer) => { body += c.toString('utf8') })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 120) }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

async function main(): Promise<void> {
  console.log(`verify-webui: probing http://${HOST}:${String(PORT)}/\n`)

  // 1) Baseline — a Host that did not gate `/` would also answer 200 with no
  //    cookie, which would make step 2 meaningless. Require the refusal.
  const noCookie = await get('/')
  if (noCookie.status !== 401) {
    console.error(`FAIL: expected 401 without a cookie, got ${noCookie.status}`)
    console.error('      Is a gated `dsh web` actually running on this port?')
    process.exit(1)
  }
  console.log(`  ✓ no-cookie     GET / → ${noCookie.status}   (Host requires auth)`)

  // 2) Mint a cookie through the exact code path the extension uses.
  const auth = new BrowserSessionAuth({
    host: HOST,
    port: PORT,
    allowLocalMint: true,
    store: { load: async () => undefined, save: async () => {} },
    log: () => {},
  })
  await auth.init()
  const minted = await auth.tryMintLocalSession()
  const cookie = auth.cookieHeader()
  if (!minted || cookie === undefined) {
    console.error('FAIL: could not mint a local browser-session cookie.')
    console.error('      Is $DSH_HOME/.credentials.yaml readable and does it hold a')
    console.error('      "client-connection/browser-session" grant?')
    process.exit(1)
  }
  console.log('  ✓ minted a cookie via BrowserSessionAuth.tryMintLocalSession()')

  // 3) The minted cookie must open the Web UI.
  const withCookie = await get('/', cookie)
  if (withCookie.status !== 200) {
    console.error(`FAIL: minted cookie rejected (status ${withCookie.status}).`)
    console.error('      The signing secret in $DSH_HOME/.credentials.yaml may have rotated.')
    process.exit(1)
  }
  console.log(`  ✓ cookie        GET / → ${withCookie.status}   (Web UI reachable)`)
  console.log('\nOpen Web UI end-to-end verification PASSED.')
}

main().catch((e: unknown) => {
  console.error('verify-webui ERROR:', e instanceof Error ? e.message : String(e))
  process.exit(1)
})
