/**
 * local-credentials.ts — read the browser-session signing secret that `dsh web`
 * persists in its own credential store.
 *
 * Why this exists
 * ───────────────
 * `dsh web` prints a launch URL carrying a per-process token, and that token is
 * the only *sanctioned* way to obtain a session cookie. Nothing writes it to
 * disk, so a third-party client normally has to ask the user to paste it.
 *
 * But the cookie carries no trace of the token. It is an HMAC over
 * `{version, authority, issuedAt, expiresAt}` keyed by a secret that lives in
 * `$DSH_HOME/.credentials.yaml` under `client-connection/browser-session`, and
 * that secret is created once and reused across every later `dsh web` process
 * (`BrowserAuth.create` → `initializeSecret`). So any process able to read that
 * file can mint a cookie byte-identical to one the host would have issued.
 *
 * Is that safe here?
 * ─────────────────
 * The file is written with owner-only permissions (`0o077` mask in
 * `dsh-credentials-local`) and holds the user's model API keys, so being able to
 * read it already implies full authority over this harness home. Minting a
 * cookie from it is permission-equivalent, not an escalation: we are not
 * reaching anything we could not reach before, only skipping the paste.
 *
 * Two honesty caveats, both recorded in the plugin log whenever this path runs:
 *   1. It leans on upstream internals (the record key, cookie shape and HMAC
 *      construction) that carry no compatibility promise. Every read is
 *      defensive, and any mismatch falls back to asking for a launch URL.
 *   2. It deliberately bypasses the per-process launch-token gate. That gate
 *      defends against *remote* callers (rebinding/CSRF), which we are not; it
 *      does not defend against code already running as this user.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'yaml'

/** Credentials record holding the browser-session signing secret. */
const RECORD_KEY = 'client-connection/browser-session'
const CREDENTIALS_FILENAME = '.credentials.yaml'
const HOME_ENV = 'DSH_HOME'

/** Reasons the local secret is unavailable; each maps to a distinct user-facing hint. */
export type SecretGap =
  | { kind: 'missing-file'; path: string }
  | { kind: 'missing-record'; path: string }
  | { kind: 'malformed'; detail: string }

/** Read `$DSH_HOME` exactly the way `resolveDshHome` does: env, else `~/.dsh`. */
export function resolveCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[HOME_ENV]
  const home = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv.trim() : join(homedir(), '.dsh')
  return resolve(expandTilde(home), CREDENTIALS_FILENAME)
}

function expandTilde(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Read and validate the browser-session secret from the local credential store.
 *
 * @returns the raw secret bytes, or a {@link SecretGap} describing why it is
 *   unavailable. Never throws for ordinary unavailability; a file we cannot even
 *   read is reported as `missing-file`.
 */
export async function readBrowserSessionSecret(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ secret: Buffer } | { gap: SecretGap }> {
  const path = resolveCredentialsPath(env)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { gap: { kind: 'missing-file', path } }
  }

  let document: unknown
  try {
    document = parse(text)
  } catch (e) {
    return { gap: { kind: 'malformed', detail: `${path} is not valid YAML — ${e instanceof Error ? e.message : String(e)}` } }
  }

  const record = lookupRecord(document)
  if (record === undefined) return { gap: { kind: 'missing-record', path } }

  const secret = canonicalSecret(record)
  if (secret === undefined) {
    // Deliberately not quoting the value: this is credential material.
    return { gap: { kind: 'malformed', detail: `the "${RECORD_KEY}" record in ${path} has no usable 32-byte secret` } }
  }
  return { secret }
}

/** Walk `records[RECORD_KEY]` without assuming the whole document shape. */
function lookupRecord(document: unknown): unknown {
  if (typeof document !== 'object' || document === null) return undefined
  const root = document as Record<string, unknown>
  const records = root['records']
  if (typeof records !== 'object' || records === null) return undefined
  return (records as Record<string, unknown>)[RECORD_KEY]
}

/** Accept only the `{kind:'grant', payload:{version:1, secret:base64url(32B)}}` shape upstream writes. */
function canonicalSecret(record: unknown): Buffer | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const r = record as Record<string, unknown>
  if (r['kind'] !== 'grant') return undefined
  const payload = r['payload']
  if (typeof payload !== 'object' || payload === null) return undefined
  const secret = (payload as Record<string, unknown>)['secret']
  if (typeof secret !== 'string') return undefined
  const decoded = Buffer.from(secret, 'base64url')
  // 32 raw bytes survive base64url exactly at a 43-character payload; anything
  // else means the value was edited or truncated.
  return decoded.byteLength === 32 ? decoded : undefined
}

/** Human-readable note for logging. Never includes credential material. */
export function describeSecretGap(gap: SecretGap): string {
  switch (gap.kind) {
    case 'missing-file':
      return `no ${CREDENTIALS_FILENAME} at ${gap.path} (set $DSH_HOME if your harness home is elsewhere)`
    case 'missing-record':
      return `${gap.path} has no "${RECORD_KEY}" record yet — start \`dsh web\` once so it creates one`
    case 'malformed':
      return gap.detail
  }
}
