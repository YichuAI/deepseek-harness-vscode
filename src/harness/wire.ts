/**
 * wire.ts — protocol negotiation.
 *
 * The plugin must talk to whatever `dsh web` the user actually runs, and that has
 * already drifted once: early releases served `/api/<ns>.<method>` with a raw
 * payload, later ones `/api/<ns>/<method>` with `{ args: … }`, and the event
 * socket has been `/api/events.mux` then `/api/remote.mux`. Guessing is what
 * produced the broken v0.0.4 assumptions, so the wire shape is *discovered*.
 *
 * The reference runtime installed on this machine is **0.2.0-rc.2**, whose
 * contract (read from `@deepseek-ai/dsh-*`, not guessed) is:
 *
 *   1. endpoint style — `POST /api/<ns>/<method>` (slash). `session/list` is the
 *      probe; it takes `_request`, most other methods take `request`.
 *   2. authentication  — every `/api/*` call and the mux upgrade need a
 *      browser-session cookie (401 without one).
 *   3. event socket    — `ws://host:port/api/remote.mux`; a HEAD/GET on the path
 *      returns 404 (it is a WS upgrade, not a normal route), so we detect it by
 *      attempting the upgrade itself.
 *   4. arg shape       — `payload` is always `{ args: <inner> }`; the inner
 *      field is the Typert parameter wire name (`_request`/`request`/none).
 *
 * Negotiation runs once per connect and the result is cached in a WireProfile.
 * Every other module asks the profile for endpoint strings instead of hardcoding
 * them, which is what keeps this plugin working across host versions.
 */

import { randomUUID } from 'node:crypto'
import { httpRequest, httpStatus } from './http.ts'
import { openWebSocket } from './ws.ts'

/** `session/list` (slash) vs `session.list` (dot). */
export type EndpointStyle = 'slash' | 'dot'
/** Whether `/api/*` is gated behind a browser-session cookie. */
export type AuthMode = 'none' | 'cookie'

export interface WireProfile {
  endpointStyle: EndpointStyle
  auth: AuthMode
  /** Absolute path of the event socket, e.g. `/api/remote.mux`. */
  muxPath: string
  /** The inner args object `session/list` accepted (always `{ _request: {} }`). */
  listArgs: Record<string, unknown>
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

/** Event-socket candidates, 0.2.0-rc.2 first (WS upgrade, not a GET route). */
const MUX_PATH_CANDIDATES = ['/api/remote.mux', '/api/events.mux'] as const

/**
 * Control-surface methods, canonical `ns/method`.
 *
 * This is the superset the plugin *calls* and wants to gate the UI on. Every one
 * below actually exists in 0.2.0-rc.2 (older names like `session/command`,
 * `agentPreset/*`, `subagent/*`, `host/describe`, `workspace/list`, `llm/models`
 * do NOT, and were removed). Each is probed at connect time and the UI only
 * offers what answered.
 */
export const CONTROL_METHODS = [
  'session/fork',
  'session/rename',
  'session/selectModel',
  'session/updateQueue',
  'workspace/archiveSession',
  'session/page',
  'workspace/create',
  'session/modelCatalog',
] as const

export type ControlMethod = (typeof CONTROL_METHODS)[number]

/**
 * Business error codes meaning "I do not serve that method".
 *
 * A 404 answers this at the HTTP level. Some builds answer 200 with a typed error
 * instead. The codes below are the ones observed upstream
 * (`gateway/method-unavailable`, `not_found`, `unknown_method`, `unimplemented`);
 * the match is deliberately broad because a false positive only hides a control,
 * while a false negative would render a dead button.
 */
const MISSING_METHOD_CODE = /gateway\/(method|service|definition|invocation)-unavailable|not[_-]?found|unknown[_-]?method|unimplemented|unsupported|no[_-]?such|method[_-]?not[_-]?found/i

/**
 * Business error codes meaning "the arguments do not match my declared
 * parameters" — which *proves the method exists*. Contrast with
 * {@link MISSING_METHOD_CODE}: the distinction is what makes capability
 * probing possible without calling anything successfully.
 */
const SHAPE_REJECTION_CODE = /gateway\/(arguments|context|lookup|provider-mismatch|result)-invalid|invalid[_-]?arg|bad[_-]?request|schema|validation|missing|required|malformed|too[_-]?(few|many)|unexpected/i

/** True when a typed RPC error means "no such method on this host". */
export function isMissingMethodError(code: string): boolean {
  return MISSING_METHOD_CODE.test(code)
}

/** True when a typed RPC error proves the method exists but rejected the args. */
export function isShapeRejection(code: string): boolean {
  return !isMissingMethodError(code) && SHAPE_REJECTION_CODE.test(code)
}

/**
 * Business error codes meaning "you need a browser-session cookie". Some builds
 * answer an unauthenticated probe with a 200 envelope carrying one of these
 * rather than a bare 401, so capability probing must recognise it too — otherwise
 * the host would be wrongly classified as unauthenticated (`auth: 'none'`).
 */
const AUTH_ERROR_CODE = /unauthor|forbidden|denied|token|session|expired|secret|not[_-]?authenticat|invalid[_-]?credential/i
export function isAuthError(code: string): boolean {
  return AUTH_ERROR_CODE.test(code)
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
  // 0.2.0-rc.2: payload is ALWAYS { args: <inner> }.
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
  const cookie = opts.cookie()

  for (const style of ['slash', 'dot'] as const) {
    const endpoint = wireEndpoint(style, 'session/list')
    const path = apiPath(style, 'session', 'list')
    // session/list uniquely takes `_request`; most other methods take `request`.
    for (const listArgs of [{ _request: {} }, { request: {} }] as Record<string, unknown>[]) {
      const outcome = await postRpc(opts, path, endpoint, listArgs)
      if (outcome === undefined) continue
      sawAnyResponse = true
      if (outcome.status === 401) { sawUnauthorized = true; break }
      if (outcome.status === 404) break
      if (outcome.status !== 200) continue
      if (!isServerResponse(outcome.body, extractRpcId(outcome.body))) continue
      if (!isOk(outcome.body)) {
        const parsed = parseOutcome(outcome.body)
        if (parsed !== undefined && !parsed.ok && parsed.code !== undefined && isAuthError(parsed.code)) {
          sawUnauthorized = true
        }
        continue
      }
      opts.log(`wire: endpoint style "${style}" confirmed via ${endpoint}`)
      const profile: WireProfile = {
        endpointStyle: style,
        // A cookie was used in the successful probe, so the host accepts one.
        auth: cookie !== undefined ? 'cookie' : 'none',
        muxPath: await probeMuxPath(opts),
        listArgs,
        capabilities: {},
      }
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

/**
 * Discover the event-socket path. The routes are WebSocket upgrades, so a plain
 * GET/HEAD returns 404 — we must attempt the upgrade itself and keep whichever
 * one answers 101.
 */
async function probeMuxPath(opts: NegotiateOptions): Promise<string> {
  for (const path of MUX_PATH_CANDIDATES) {
    if (await tryWsUpgrade(opts, path)) return path
  }
  return MUX_PATH_CANDIDATES[0]
}

/** Attempt a WS upgrade to `path`; resolve true on 101, false otherwise. */
function tryWsUpgrade(opts: NegotiateOptions, path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (v: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ws.close() } catch { /* already gone */ }
      resolve(v)
    }
    const timer = setTimeout(() => finish(false), 3000)
    const cookie = opts.cookie()
    const ws = openWebSocket(`ws://${opts.host}:${String(opts.port)}${path}`, {
      origin: `http://${opts.host}:${String(opts.port)}`,
      ...(cookie === undefined ? {} : { cookie }),
    }, {
      onOpen: () => finish(true),
      onText: () => { /* not needed for probe */ },
      onClose: () => finish(false),
      onError: () => finish(false),
    })
  })
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
 * Every probe sends the standard `{ args: { request: {} } }` on purpose. For a
 * method that exists this yields either `ok:true` or a shape-rejection
 * (e.g. `gateway/arguments-invalid`) — both prove existence. A `not found` 404
 * or a `gateway/*-unavailable` code proves absence. Declared-parameter
 * validation runs before any handler executes, so the empty-args probe can never
 * mutate session state.
 */
export async function probeCapabilities(
  opts: NegotiateOptions,
  style: EndpointStyle,
  log: (m: string) => void,
): Promise<Record<string, boolean>> {
  const found: Record<string, boolean> = {}
  await Promise.all(CONTROL_METHODS.map(async (method) => {
    const endpoint = wireEndpoint(style, method)
    const outcome = await postRpc(opts, `/api/${endpoint}`, endpoint, { request: {} })
    if (outcome === undefined) return
    if (outcome.status === 404) return // route does not exist
    if (outcome.status !== 200) return
    const parsed = parseOutcome(outcome.body)
    if (parsed === undefined) return
    if (!parsed.ok) {
      if (parsed.code !== undefined && isMissingMethodError(parsed.code)) return
      if (parsed.code !== undefined && isAuthError(parsed.code)) return
    }
    // ok:true OR a shape/other error => the endpoint exists.
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
    listArgs: { _request: {} },
    capabilities: {},
  }
}
