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
 * The sanctioned way to obtain the cookie is the launch-URL exchange above. As a
 * zero-paste convenience, {@link BrowserSessionAuth.tryMintLocalSession} can also
 * mint a byte-identical cookie from that same persisted signing secret — see
 * `local-credentials.ts` for why that is permission-equivalent rather than an
 * escalation. Both paths produce the exact cookie shape the host verifies; gated
 * behind `allowLocalMint` so a deployment can force the token exchange.
 */

import { createHash, createHmac } from 'node:crypto'
import { firstHeader, httpRequest } from './http.ts'
import {
  describeSecretGap,
  readBrowserSessionSecret,
  type SecretGap,
} from './local-credentials.ts'

/**
 * Lifetime of a self-minted cookie.
 *
 * The host rejects any cookie whose `expiresAt - issuedAt` exceeds its own
 * `cookieMaxAgeDays` (default 30, minimum 1). We cannot read that configured
 * value, so we deliberately stay well under one day: minting is free and local,
 * and a short TTL satisfies every legal configuration instead of guessing.
 */
const SELF_MINTED_TTL_MS = 12 * 60 * 60 * 1000

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
  /**
   * Allow {@link tryMintLocalSession} to mint the cookie from the harness's own
   * persisted signing secret, skipping the paste. Mirrors the `autoSession`
   * setting; defaults to false (conservative) — extension.ts enables it via config.
   */
  allowLocalMint?: boolean
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
  /** True when the usable cookie came from the local credential store, not a pasted launch URL. */
  private mintedLocally = false
  private selfMintGap: SecretGap | undefined
  /**
   * Set when the harness answered 401 while `cookieHeader()` still looked usable.
   * That combination means the cookie is well-formed and unexpired but failed the
   * host's signature check — i.e. the signing secret in
   * `$DSH_HOME/.credentials.yaml` changed underneath us. Reporting "expired"
   * here would send the user chasing the wrong fix.
   */
  private rejected = false

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
    if (this.rejected && s !== undefined) {
      return `the running harness rejected the stored cookie for ${s.authority} — `
        + 'its signing secret ($DSH_HOME/.credentials.yaml) was almost certainly regenerated'
    }
    if (s === undefined) return 'no browser session yet'
    if (s.authority !== authorityOf(this.opts.host, this.opts.port)) {
      return `stored session belongs to ${s.authority}, but the plugin is pointed at ${authorityOf(this.opts.host, this.opts.port)}`
    }
    if (s.expiresAt <= Date.now()) {
      return `stored session for ${s.authority} expired at ${new Date(s.expiresAt).toISOString()}`
    }
    return `the harness refused the stored session for ${s.authority}`
  }

  /** How the current cookie was obtained — shown in the UI so the shortcut is never hidden. */
  sessionOrigin(): 'launch-url' | 'local-credential' | undefined {
    if (this.cookieHeader() === undefined) return undefined
    return this.mintedLocally ? 'local-credential' : 'launch-url'
  }

  /** Why the last local mint failed, for logging only. Never contains secret material. */
  describeMintGap(): string | undefined {
    return this.selfMintGap === undefined ? undefined : describeSecretGap(this.selfMintGap)
  }

  /**
   * Obtain a session without asking the user for anything.
   *
   * Reads the signing secret `dsh web` keeps in its own credential store and
   * mints the cookie the host would have issued. See `local-credentials.ts` for
   * the security reasoning and the caveats — this bypasses the per-process
   * launch-token gate by design, and falls back cleanly if upstream ever moves
   * the secret or changes the cookie shape.
   *
   * @returns whether a usable cookie is now available.
   */
  async tryMintLocalSession(): Promise<boolean> {
    if (this.cookieHeader() !== undefined) return true
    if (!this.opts.allowLocalMint) {
      this.opts.log('auth: local minting is disabled by configuration; paste a launch URL to connect')
      return false
    }

    const outcome = await readBrowserSessionSecret()
    if ('gap' in outcome) {
      this.selfMintGap = outcome.gap
      this.opts.log(`auth: cannot mint locally — ${describeSecretGap(outcome.gap)}`)
      return false
    }

    const authority = authorityOf(this.opts.host, this.opts.port)
    const issuedAt = Date.now()
    const expiresAt = issuedAt + SELF_MINTED_TTL_MS
    const value = encodeCookie({
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
    }, outcome.secret)

    this.session = {
      authority,
      name: cookieNameForAuthority(authority),
      value,
      expiresAt,
    }
    this.mintedLocally = true
    this.selfMintGap = undefined
    this.rejected = false
    await this.opts.store.save(JSON.stringify(this.session))
    this.opts.log(`auth: minted a ${SELF_MINTED_TTL_MS / 3_600_000}h session locally for ${authority}`)
    return true
  }

  /**
   * Record that the harness answered 401 even though we sent a cookie we
   * believed was valid. See {@link rejected}.
   */
  noteRejected(): void {
    if (!this.rejected) {
      this.rejected = true
      this.opts.log('auth: harness rejected a cookie we thought was valid — signing secret likely rotated')
    }
  }

  async clear(): Promise<void> {
    this.session = undefined
    this.rejected = false
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
    this.rejected = false
    await this.opts.store.save(JSON.stringify(this.session))
    this.opts.log(`auth: acquired ${parsed.name} for ${authority}, valid until ${new Date(this.session.expiresAt).toISOString()}`)
    return { host: url.hostname, port }
  }

  /** Re-read this plugin's configured target (config changes keep the same auth object). */
  retarget(host: string, port: number): void {
    this.opts.host = host
    this.opts.port = port
  }

  /** Toggle the auto-mint behaviour at runtime to match the `autoSession` setting. */
  setAllowLocalMint(value: boolean): void {
    this.opts.allowLocalMint = value
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

/**
 * Mirror of upstream `BrowserAuth.encodeCookie`: `v1.<payload>.<hmac>` where the
 * HMAC-SHA256 is keyed by the persisted browser-session secret. Matching this
 * construction is what lets a locally minted cookie verify.
 */
function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `v1.${body}.${createHmac('sha256', secret).update(body).digest().toString('base64url')}`
}

/** Signed cookie payload shape the host decodes and verifies. */
interface CookiePayload {
  readonly version: 1
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Signed cookie version upstream writes (`COOKIE_PAYLOAD_VERSION`). */
const COOKIE_PAYLOAD_VERSION = 1 as const

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
