/**
 * auth.ts — browser-session authentication for the harness `/api/*` surface.
 *
 * Since DSH 0.1.6-alpha the Host Connection carrier authenticates every request:
 * `HostConnectionService.requestRejection()` runs the Host/Origin fence and then
 * `BrowserAuth.isAuthenticated()`, answering `401 unauthorized` otherwise. That
 * covers `/api/<endpoint>` RPCs *and* the `/api/remote.mux` upgrade.
 *
 * The supported exchange (see DSH `packages/client/connection/src/browser-auth.ts`
 * and `apps/cli/tests/web-auth.e2e.ts`):
 *
 *   1. `dsh web` prints a per-process launch URL to stdout:
 *        dsh web: http://127.0.0.1:3080/?token=<43-char base64url>
 *      The token is random per process and never written to disk.
 *   2. `GET http://<authority>/?token=<token>` answers `303 See Other` with
 *      `Set-Cookie: dsh-auth-<b64url(sha256(authority))>=v1.<payload>.<hmac>; …`
 *      then redirects to a clean `/`.
 *   3. Every later request sends that cookie. The signing secret lives in
 *      `$DSH_HOME/.credentials.yaml` under `client-connection/browser-session`,
 *      so the cookie survives `dsh web` restarts — until it expires (30 days by
 *      default) or the authority (host:port) changes, because the cookie name is
 *      derived from the authority the request was served under.
 *
 * We never mint a cookie ourselves: the exchange above is the only legitimate
 * path, and signing our own token would bypass the gate rather than satisfy it.
 */

import { createHash } from 'node:crypto'
import { firstHeader, httpRequest } from './http.ts'

/** Persisted cookie material. `authority` is the Host header value it was minted for. */
export interface StoredSession {
  authority: string
  name: string
  value: string
  /** Epoch milliseconds. */
  expiresAt: number
}

/** Where the cookie is kept between sessions (VS Code SecretStorage in practice). */
export interface AuthStore {
  load(): Promise<string | undefined>
  save(value: string | undefined): Promise<void>
}

export interface BrowserSessionAuthOptions {
  host: string
  port: number
  store: AuthStore
  log: (msg: string) => void
}

/** Thrown when the harness refuses a request: the caller must (re)adopt a launch URL. */
export class HarnessAuthRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HarnessAuthRequiredError'
  }
}

/** Cookie name the harness derives for one authority: `dsh-auth-` + b64url(sha256(authority)). */
export function cookieNameForAuthority(authority: string): string {
  return 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
}

/** `host:port` exactly as the Host header will carry it. */
export function authorityOf(host: string, port: number): string {
  return `${host}:${String(port)}`
}

export class BrowserSessionAuth {
  private session: StoredSession | undefined
  private ready = false

  constructor(private readonly opts: BrowserSessionAuthOptions) {}

  /** Load any persisted cookie. Safe to call repeatedly. */
  async init(): Promise<void> {
    if (this.ready) return
    this.ready = true
    try {
      const raw = await this.opts.store.load()
      if (raw === undefined) return
      const parsed = JSON.parse(raw) as unknown
      if (!isStoredSession(parsed)) {
        this.opts.log('auth: persisted session is malformed; ignoring')
        return
      }
      this.session = parsed
      this.opts.log(`auth: restored session for ${parsed.authority} (expires ${new Date(parsed.expiresAt).toISOString()})`)
    } catch (e) {
      this.opts.log(`auth: could not restore session — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** True when a cookie matching the *configured* authority is available and unexpired. */
  isReady(): boolean {
    return this.cookieHeader() !== undefined
  }

  /** The cookie header to attach, or undefined when absent/expired/authority-mismatched. */
  cookieHeader(): string | undefined {
    const s = this.session
    if (s === undefined) return undefined
    if (s.authority !== authorityOf(this.opts.host, this.opts.port)) return undefined
    if (s.expiresAt <= Date.now()) return undefined
    return `${s.name}=${s.value}`
  }

  /** Human-readable reason the plugin cannot talk to the harness yet. */
  describeGap(): string {
    const s = this.session
    if (s === undefined) return 'no browser session yet'
    if (s.authority !== authorityOf(this.opts.host, this.opts.port)) {
      return `stored session belongs to ${s.authority}, but the plugin is pointed at ${authorityOf(this.opts.host, this.opts.port)}`
    }
    return `stored session for ${s.authority} expired at ${new Date(s.expiresAt).toISOString()}`
  }

  async clear(): Promise<void> {
    this.session = undefined
    await this.opts.store.save(undefined)
  }

  /**
   * Adopt a `dsh web` launch URL: exchange its process token for a session cookie
   * and persist it.
   *
   * @param launchUrl - the full `dsh web: http://…/?token=…` line (extra prose is tolerated).
   * @returns the origin the cookie belongs to, so the caller can retarget the client.
   * @throws HarnessAuthRequiredError when the URL has no token or the exchange is refused.
   */
  async adoptLaunchUrl(launchUrl: string): Promise<{ host: string; port: number }> {
    const url = extractLaunchUrl(launchUrl)
    if (url === undefined) {
      throw new HarnessAuthRequiredError(
        'That does not look like a `dsh web` launch URL. Expected something like '
        + 'http://127.0.0.1:3080/?token=…',
      )
    }
    const token = url.searchParams.get('token')
    if (token === null || token === '') {
      throw new HarnessAuthRequiredError(
        'The launch URL carries no token=… parameter. Copy the whole `dsh web: …` line the CLI printed.',
      )
    }
    const host = url.hostname
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
    const authority = authorityOf(url.hostname, port)
    if (authority !== url.host) {
      // `url.host` already carries the port when it is non-default; keep them in sync.
      this.opts.log(`auth: normalised authority ${url.host} → ${authority}`)
    }

    // The exchange must hit the exact origin: the cookie is bound to the Host header.
    const res = await httpRequest({
      host: url.hostname,
      port,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
    })
    if (res.status !== 303) {
      throw new HarnessAuthRequiredError(
        res.status === 401
          ? 'The harness rejected that token. It is valid only for the current `dsh web` process — '
            + 'restarting `dsh web` mints a new one, so copy the latest line.'
          : `Token exchange returned HTTP ${String(res.status)} instead of 303.`,
      )
    }
    const raw = firstHeader(res.headers, 'set-cookie')
    if (raw === undefined) {
      throw new HarnessAuthRequiredError('The token exchange returned no Set-Cookie header.')
    }
    const parsed = parseSetCookie(raw)
    if (parsed === undefined) {
      throw new HarnessAuthRequiredError('The token exchange returned a Set-Cookie header we could not parse.')
    }

    this.session = {
      authority,
      name: parsed.name,
      value: parsed.value,
      expiresAt: parsed.expiresAt ?? Date.now() + 30 * 24 * 60 * 60 * 1000,
    }
    await this.opts.store.save(JSON.stringify(this.session))
    this.opts.log(`auth: acquired ${parsed.name} for ${authority}, valid until ${new Date(this.session.expiresAt).toISOString()}`)
    return { host: url.hostname, port }
  }

  /** Re-read this plugin's configured target (config changes keep the same auth object). */
  retarget(host: string, port: number): void {
    this.opts.host = host
    this.opts.port = port
  }
}

/** Find the first `http(s)://…` token inside a pasted CLI line. */
function extractLaunchUrl(text: string): URL | undefined {
  const match = /https?:\/\/\S+/u.exec(text.trim())
  if (match === null) return undefined
  try {
    return new URL(match[0])
  } catch {
    return undefined
  }
}

interface ParsedSetCookie {
  name: string
  value: string
  expiresAt: number | undefined
}

/** Parse one `Set-Cookie` value: `name=value` plus optional `Max-Age`/`Expires`. */
function parseSetCookie(raw: string): ParsedSetCookie | undefined {
  const first = raw.split(';', 1)[0]
  if (first === undefined) return undefined
  const eq = first.indexOf('=')
  if (eq <= 0) return undefined
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  if (name === '' || value === '') return undefined

  let expiresAt: number | undefined
  const maxAge = /;\s*max-age=(-?\d+)/iu.exec(raw)
  if (maxAge?.[1] !== undefined) {
    const seconds = Number(maxAge[1])
    if (Number.isFinite(seconds) && seconds > 0) expiresAt = Date.now() + seconds * 1000
  }
  if (expiresAt === undefined) {
    const expires = /;\s*expires=([^;]+)/iu.exec(raw)
    if (expires?.[1] !== undefined) {
      const parsed = Date.parse(expires[1])
      if (Number.isFinite(parsed)) expiresAt = parsed
    }
  }
  return { name, value, expiresAt }
}

function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const s = value as Record<string, unknown>
  return typeof s['authority'] === 'string'
    && typeof s['name'] === 'string'
    && typeof s['value'] === 'string'
    && typeof s['expiresAt'] === 'number'
}
