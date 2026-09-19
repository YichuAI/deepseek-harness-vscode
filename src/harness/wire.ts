/**
 * wire.ts — protocol negotiation.
 *
 * The plugin must talk to whatever `dsh web` the user actually runs, and that
 * has already drifted once: pre-0.1 releases served `/api/<ns>.<method>`, later
 * ones `/api/<ns>/<method>`, and the event socket has been seen as both
 * `/api/events.mux` and `/api/remote.mux`. Guessing is what produced the
 * broken v0.0.4 assumptions, so the wire shape is now *discovered*, never
 * assumed:
 *
 *   1. endpoint style — POST the list endpoint in both shapes; the one that
 *      answers with a `server-response` envelope wins. A 404 means "not this
 *      shape", a 401 means "real endpoint, but you need a session cookie".
 *   2. authentication  — if every probe answers 401 the host is cookie-gated.
 *   3. event socket    — HEAD each candidate path; anything but 404 exists.
 *   4. arg shape       — `session/list` has shipped with three different
 *      declared-parameter spellings, so each is tried until one returns ok.
 *
 * Negotiation runs once per connect and the result is cached in a WireProfile.
 * Every other module asks the profile for endpoint strings instead of hardcoding
 * them, which is what keeps this plugin working across host versions.
 */

import { randomUUID } from 'node:crypto'
import { httpRequest, httpStatus } from './http.ts'

/** `session/list` (slash) vs `session.list` (dot). */
export type EndpointStyle = 'slash' | 'dot'
/** Whether `/api/*` is gated behind a browser-session cookie. */
export type AuthMode = 'none' | 'cookie'

export interface WireProfile {
  endpointStyle: EndpointStyle
  auth: AuthMode
  /** Absolute path of the event socket, e.g. `/api/remote.mux`. */
  muxPath: string
  /** The args object `session/list` accepted (or `{}` when none verified). */
  listArgs: Record<string, unknown>
  /** Model-catalog endpoint that answered, if any. */
  catalogEndpoint?: string
  /** Control-surface methods this host actually serves (`ns/method` → present). */
  capabilities: Record<string, boolean>
}

export type NegotiationResult =
  | { kind: 'ok'; profile: WireProfile }
  /** Every probe was refused with 401 — the caller must obtain a cookie first. */
  | { kind: 'auth-required' }
  /** No candidate shape answered at all — wrong port, or not a harness. */
  | { kind: 'unreachable'; message: string }

export interface NegotiateOptions {
  host: string
  port: number
  /** Current cookie header, or undefined when we have no session yet. */
  cookie: () => string | undefined
  log: (msg: string) => void
}

/** Namespaces whose methods are converted between `ns/method` and `ns.method`. */
const CONVERTIBLE_NAMESPACES = new Set([
  'session', 'workspace', 'host', 'agentPreset', 'goal', 'llm', 'subagent', 'skill', 'settings', 'credentials',
])

/** Endpoint candidates for the event socket, most-recent first. */
const MUX_PATH_CANDIDATES = ['/api/remote.mux', '/api/events.mux'] as const

/**
 * Declared-parameter spellings `session/list` has shipped with. `_request` is
 * the current upstream signature, so it is tried first — the gateway rejects an
 * args object whose fields do not match the descriptor, and we want the shape
 * the host actually prefers rather than the first one it tolerates.
 */
const LIST_ARGS_CANDIDATES: readonly Record<string, unknown>[] = [{ _request: {} }, { request: {} }, {}]

/** How long to wait for response headers when probing the event socket. */
const PROBE_TIMEOUT_MS = 2_000

/**
 * Control-surface methods, canonical `ns/method`.
 *
 * Every one of these exists in *some* release and is absent in others, and the
 * other side of the line may not even be the release we think it is. Rather
 * than shipping buttons that 404, each is probed at connect time and the UI
 * only offers what answered.
 */
export const CONTROL_METHODS = [
  'session/command',
  'session/fork',
  'session/rename',
  'session/selectModel',
  'session/updateQueue',
  'agentPreset/list',
  'agentPreset/select',
  'subagent/list',
  'subagent/interrupt',
  'llm/models',
  'workspace/archiveSession',
] as const

export type ControlMethod = (typeof CONTROL_METHODS)[number]

/**
 * Business error codes meaning "I do not serve that method".
 *
 * A 404 answers this at the HTTP level; some builds answer 200 with a typed
 * error instead. The codes below are the ones observed upstream
 * (`not_found`, `unknown_method`, `unimplemented`); the match is deliberately
 * broad because a false positive only hides a control, while a false negative
 * would render a dead button.
 */
const MISSING_METHOD_CODE = /not[_-]?found|unknown|unimplemented|unsupported|no[_-]?such|method/i

/**
 * Business error codes meaning "the arguments do not match my declared
 * parameters" — which *proves the method exists*. Contrast with
 * {@link MISSING_METHOD_CODE}: the distinction is what makes capability
 * probing possible without calling anything successfully.
 */
const SHAPE_REJECTION_CODE = /invalid[_-]?arg|bad[_-]?request|schema|validation|missing|required|malformed|too[_-]?(few|many)|unexpected/i

/** True when a typed RPC error means "no such method on this host". */
export function isMissingMethodError(code: string): boolean {
  return MISSING_METHOD_CODE.test(code)
}

/** True when a typed RPC error proves the method exists but rejected the args. */
export function isShapeRejection(code: string): boolean {
  return !isMissingMethodError(code) && SHAPE_REJECTION_CODE.test(code)
}

/** `/api/<ns><sep><method>` for one style. */
export function apiPath(style: EndpointStyle, ns: string, method: string): string {
  return `/api/${wireEndpoint(style, `${ns}/${method}`)}`
}

/**
 * Render a canonically-written `ns/method` in one wire style.
 *
 * Endpoints outside a known namespace (`$events`, `$events/result`) are passed
 * through untouched: the separator there is part of the literal name.
 */
export function wireEndpoint(style: EndpointStyle, method: string): string {
  const cut = method.indexOf('/')
  if (cut <= 0) return method
  const ns = method.slice(0, cut)
  if (!CONVERTIBLE_NAMESPACES.has(ns)) return method
  return style === 'slash' ? method : `${ns}.${method.slice(cut + 1)}`
}

/** True when the body is an RPC envelope answering our own rpcId. */
function isServerResponse(body: string, rpcId: string): boolean {
  try {
    const env = JSON.parse(body) as { type?: unknown; rpcId?: unknown }
    return env.type === 'server-response' && env.rpcId === rpcId
  } catch {
    return false
  }
}

/** True when the envelope reports a business-level success. */
function isOk(body: string): boolean {
  try {
    const env = JSON.parse(body) as { result?: { ok?: unknown } }
    return env.result?.ok === true
  } catch {
    return false
  }
}

interface ProbeOutcome {
  status: number
  body: string
}

/** POST one RPC envelope and return the raw outcome (never throws for status). */
async function postRpc(
  opts: NegotiateOptions,
  path: string,
  method: string,
  args: Record<string, unknown>,
): Promise<ProbeOutcome | undefined> {
  const cookie = opts.cookie()
  const rpcId = randomUUID()
  const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
  try {
    const res = await httpRequest({
      host: opts.host,
      port: opts.port,
      method: 'POST',
      path,
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        origin: `http://${opts.host}:${String(opts.port)}`,
      },
      body,
    })
    return { status: res.status, body: res.body }
  } catch {
    return undefined
  }
}

/**
 * Discover the wire shape of one loopback harness.
 *
 * Safe to call against a host that is not a harness: every failure path
 * degrades into `unreachable` rather than throwing.
 */
export async function negotiateWire(opts: NegotiateOptions): Promise<NegotiationResult> {
  let sawUnauthorized = false
  let sawAnyResponse = false

  for (const style of ['slash', 'dot'] as const) {
    const endpoint = wireEndpoint(style, 'session/list')
    const path = apiPath(style, 'session', 'list')
    for (const args of LIST_ARGS_CANDIDATES) {
      const outcome = await postRpc(opts, path, endpoint, args)
      if (outcome === undefined) continue
      sawAnyResponse = true
      if (outcome.status === 401) { sawUnauthorized = true; break }
      if (outcome.status === 404) break
      if (outcome.status !== 200) continue
      if (!isServerResponse(outcome.body, extractRpcId(outcome.body))) continue
      opts.log(`wire: endpoint style "${style}" confirmed via ${endpoint}`)
      const listArgs = isOk(outcome.body) ? args : {}
      const profile: WireProfile = {
        endpointStyle: style,
        auth: 'none',
        muxPath: await probeMuxPath(opts, opts.log),
        listArgs,
        capabilities: {},
      }
      const catalog = await probeCatalog(opts, style)
      if (catalog !== undefined) profile.catalogEndpoint = catalog
      profile.capabilities = await probeCapabilities(opts, style, opts.log)
      return { kind: 'ok', profile }
    }
  }

  if (sawUnauthorized) return { kind: 'auth-required' }
  if (!sawAnyResponse) {
    return {
      kind: 'unreachable',
      message: `No HTTP response from ${opts.host}:${String(opts.port)} — start \`dsh web\` first, or fix deepseekHarness.port.`,
    }
  }
  return {
    kind: 'unreachable',
    message: `${opts.host}:${String(opts.port)} answered, but exposed neither session/list nor session.list. Is it a DeepSeek Harness web host?`,
  }
}

function extractRpcId(body: string): string {
  try {
    return String((JSON.parse(body) as { rpcId?: unknown }).rpcId ?? '')
  } catch {
    return ''
  }
}

/** HEAD each event-socket candidate; the first that is not 404 wins. */
async function probeMuxPath(opts: NegotiateOptions, log: (m: string) => void): Promise<string> {
  const cookie = opts.cookie()
  for (const path of MUX_PATH_CANDIDATES) {
    const status = await httpStatus({
      host: opts.host,
      port: opts.port,
      path,
      headers: cookie === undefined ? {} : { cookie },
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    if (status === 404) continue
    if (status === 0) continue
    log(`wire: event socket ${path} (probe HTTP ${String(status)})`)
    return path
  }
  return MUX_PATH_CANDIDATES[0]
}

/** Try both known model-catalog names, in the negotiated style. */
async function probeCatalog(opts: NegotiateOptions, style: EndpointStyle): Promise<string | undefined> {
  for (const method of ['session/modelCatalog', 'session/models'] as const) {
    const endpoint = wireEndpoint(style, method)
    const outcome = await postRpc(opts, `/api/${endpoint}`, endpoint, {})
    if (outcome === undefined || outcome.status !== 200) continue
    if (!isOk(outcome.body)) continue
    return endpoint
  }
  return undefined
}

/** Parse a `server-response` envelope well enough to classify one probe. */
function parseOutcome(body: string): { ok: boolean; code?: string } | undefined {
  try {
    const env = JSON.parse(body) as {
      type?: unknown
      result?: { ok?: unknown; error?: { code?: unknown } }
    }
    if (env.type !== 'server-response' || env.result === undefined || typeof env.result.ok !== 'boolean') {
      return undefined
    }
    const code = env.result.error?.code
    return typeof code === 'string' ? { ok: env.result.ok, code } : { ok: env.result.ok }
  } catch {
    return undefined
  }
}

/**
 * Ask the host which control-surface methods it serves.
 *
 * Every probe sends EMPTY args on purpose. Declared-parameter validation runs
 * before any handler executes, so a malformed-argument response can never
 * mutate session state — and that same rejection is *proof* the method exists,
 * while a `not_found`-class code proves it does not.
 */
export async function probeCapabilities(
  opts: NegotiateOptions,
  style: EndpointStyle,
  log: (m: string) => void,
): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {}
  await Promise.all(CONTROL_METHODS.map(async (method) => {
    const endpoint = wireEndpoint(style, method)
    const outcome = await postRpc(opts, `/api/${endpoint}`, endpoint, {})
    if (outcome === undefined) return
    if (outcome.status !== 200) return // 404 = no such route; 401 = not ours to ask
    const parsed = parseOutcome(outcome.body)
    if (parsed === undefined) return
    if (!parsed.ok && parsed.code !== undefined && isMissingMethodError(parsed.code)) return
    found[method] = true
  }))
  const present = Object.keys(found)
  log(`wire: control surface ${String(present.length)}/${String(CONTROL_METHODS.length)} available`
    + (present.length > 0 ? ` — ${present.join(', ')}` : ' — none'))
  return found
}

/** A profile for hosts that never negotiated (tests, pre-connect). */
export function defaultWireProfile(): WireProfile {
  return {
    endpointStyle: 'slash',
    auth: 'cookie',
    muxPath: MUX_PATH_CANDIDATES[0],
    listArgs: {},
    capabilities: {},
  }
}
