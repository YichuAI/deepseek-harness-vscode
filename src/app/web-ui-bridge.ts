/**
 * Hand the browser the session cookie, so "Open Web UI" works on a Host this
 * window did not start.
 *
 * The Host gates its UI per process: `/` answers `401` unless the request
 * carries the launch token or the cookie that token mints, and only the process
 * that printed the launch URL knows the token. Minting from
 * `$DSH_HOME/.credentials.yaml` produces a cookie that the Host accepts — that
 * was measured, `/` answers `200 text/html` with it — but a cookie lives in a
 * browser's jar, and no amount of `openExternal` puts one there.
 *
 * So this is the missing half: a loopback listener that exists for one request,
 * sets the cookie for the Host's host and redirects to it. Cookies are scoped by
 * host, not by port (RFC 6265 §8.5), which is what makes it work from a
 * different port on the same host.
 *
 * What it deliberately is not: it never binds anywhere but loopback, it answers
 * exactly one path, it closes after one use or `timeoutMs`, and it never logs the
 * cookie. An attacker who can reach this port is already on the machine and can
 * read the same cookie out of VS Code's secret storage.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface CookieBridgeInput {
  /** The authority the browser should end up on, as configured. */
  host: string
  port: number
  /** A `Cookie` header value the Host already accepts: `name=value`. */
  cookie: string
  /** `vscode.env.openExternal`, injected so this stays testable. */
  openExternal: (url: string) => PromiseLike<unknown>
  log?: (message: string) => void
  timeoutMs?: number
}

export type CookieBridgeResult = 'opened' | 'failed'

/** Where to listen, given the authority the user configured. */
export function listenHostFor(host: string): string {
  // `localhost` is resolved by the browser, not by us; bind the IPv4 loopback and
  // let the browser do the same, since `dsh web` itself prints 127.0.0.1.
  if (host === 'localhost') return '127.0.0.1'
  return host
}

/** `name=value` split at the first `=`, because the value may contain more. */
export function splitCookie(cookie: string): { name: string; value: string } | undefined {
  const at = cookie.indexOf('=')
  if (at <= 0) return undefined
  const name = cookie.slice(0, at).trim()
  const value = cookie.slice(at + 1).trim()
  if (name === '' || value === '') return undefined
  return { name, value }
}

/** The URL the browser is sent to, after the cookie is set. */
export function targetUrl(host: string, port: number): string {
  const authority = host.includes(':') ? `[${host}]` : host
  return `http://${authority}:${String(port)}/`
}

/**
 * Start the redirector, open the browser, stop the redirector.
 *
 * Resolves once the browser has been handed the URL — not once it has loaded the
 * page, which this cannot observe.
 */
export async function openWebUiWithCookie(input: CookieBridgeInput): Promise<CookieBridgeResult> {
  const parts = splitCookie(input.cookie)
  if (parts === undefined) {
    input.log?.('openWebUI: the stored credential is not a cookie pair; cannot bridge it')
    return 'failed'
  }

  const nonce = randomBytes(16).toString('hex')
  const path = `/${nonce}`
  const target = targetUrl(input.host, input.port)
  const lifetime = input.timeoutMs ?? 20_000

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not here')
      return
    }
    res.writeHead(302, {
      // Host-only cookie: no Domain, so it lands on exactly the host the browser
      // just used. Path=/ because the UI is served from the root.
      'set-cookie': `${parts.name}=${parts.value}; Path=/; HttpOnly; SameSite=Lax`,
      location: target,
      'cache-control': 'no-store',
    })
    res.end()
    // One use is all this is for.
    setImmediate(() => { server.close() })
  })

  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', (e: Error) => {
      input.log?.(`openWebUI: could not listen on ${listenHostFor(input.host)}: ${e.message}`)
      resolve(false)
    })
    server.listen(0, listenHostFor(input.host), () => { resolve(true) })
  })
  if (!listening) return 'failed'

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  if (port === 0) {
    server.close()
    return 'failed'
  }

  // Stays up until it has answered once or `lifetime` passes: a cold browser
  // start can take longer than the `openExternal` promise does, and closing
  // early would serve the request to nothing.
  const timer = setTimeout(() => { server.close() }, lifetime)
  timer.unref()

  const opener = `http://${listenHostFor(input.host)}:${String(port)}${path}`
  try {
    await input.openExternal(opener)
    input.log?.(`openWebUI: cookie bridge opened ${target} via loopback:${String(port)}`)
    return 'opened'
  } catch (e) {
    input.log?.(`openWebUI: openExternal failed: ${e instanceof Error ? e.message : String(e)}`)
    clearTimeout(timer)
    server.close()
    return 'failed'
  }
}
