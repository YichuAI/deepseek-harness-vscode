/**
 * protocol-test.ts — drives the REAL transport code against a fake harness.
 *
 * The runtime we actually target is DSH `0.2.1-alpha.2` (the version running on
 * this machine; verified against the workspace source and a live `dsh web`). The
 * script implements the *server half* of that contract exactly and points the
 * production client at it, so the handshake is exercised end to end without a
 * real `dsh web`.
 *
 * What that contract looks like (and therefore what this file proves):
 *   • endpoints are `POST /api/<ns>/<method>` (slash style), payload is wrapped:
 *     `{ args: <inner> }`. The `<inner>` field is the Typert parameter wire name —
 *     `session/list` uses `_request`, most methods use `request`, and a few
 *     (`commands/*`, `fileReferences/list`) take a bare object.
 *   • the event carrier is ONE multiplexed Remote-stream WebSocket per logical
 *     stream, `ws://…/api/remote.mux`. The client sends exactly one `open` frame
 *     `{ type:'open', streamId, endpoint, payload:{args} }` and the Host replies
 *     with `{ type:'item'|'end'|'error', streamId, value }`. Any further client
 *     message is a protocol violation (the Host closes 1008 `downlink only`).
 *   • endpoint `$events` carries a *fixed allowlist* of forwarded Host events —
 *     `{ type:'emit', event, args }` and the answerable
 *     `{ type:'waterfall', event, eventId, agentId, request }` — and nothing else.
 *     Its first item is `{ type:'ready', clientId, host:{home} }`, the only
 *     host-identity frame (there is NO `host.describe`).
 *   • endpoint `session/follow` carries one session's conversation:
 *     `{type:'snapshot'}` → `{type:'event', event}` → live
 *     `{type:'assistant-stream', frame}` (start/chunk/end). This split is the
 *     whole point: `$events` stopped carrying conversation traffic, which is why
 *     the sidebar used to connect and then never receive a reply.
 *   • history is `session/page` (unary), not `session/history`.
 *   • approvals arrive as the `approval/request` waterfall on `$events` and are
 *     settled via `POST /api/$events/result` with `{ clientId, eventId, outcome }`
 *     — NOT `/api/respond`.
 *   • the host REQUIRES a browser-session cookie (401 without one); the
 *     autoSession / token-exchange auth machinery is exercised in step E.
 *
 * Run:  npx tsx scripts/protocol-test.ts
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { BrowserSessionAuth } from '../src/harness/auth.ts'
import { HarnessClient, HarnessRpcError } from '../src/harness/client.ts'
import type { MuxFrame, ReadyFrame, RemoteEventResult } from '../src/harness/protocol.ts'
// The webview script is a plain template string, so tsc never looks inside it.
// These two give the regression gate eyes on it (see step G).
import { CLIENT_SCRIPT } from '../src/view/client.ts'
import { ApprovalStore } from '../src/approval/store.ts'
import { HTML_SKELETON } from '../src/view/html.ts'
import { ControlSurface } from '../src/conversation/control.ts'
import { ConversationModel } from '../src/conversation/model.ts'
import { cookieNameForAuthority } from '../src/harness/auth.ts'
import { isMissingMethodError, isShapeRejection, negotiateWire, wireEndpoint } from '../src/harness/wire.ts'
import {
  DSH_FENCE_FINGERPRINT, discoverHosts, parseLsofListeners, parseNetstatListeners,
  parseProcNetListeners, parseWebserverPort, probeHost,
} from '../src/harness/discovery.ts'
import { findHarnessWorkspace } from '../src/workspace/binding.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Host home advertised in the `ready` frame. */
const HOME = '/home/tester'
/** clientId advertised in the `ready` frame. */
const READY_CLIENT_ID = 'fake-client-0001'

/** One durable session event, as the fold receives it. */
function ev(type: string, data: unknown, seq = 0): { type: string; seq: number; time: number; data: unknown } {
  return { type, seq, time: seq, data }
}

const LAUNCH_TOKEN = 'launch-token-abcdefghijklmnopqrstuvwxyz0123456789A'

let step = 0
let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  step += 1
  if (!ok) failures += 1
  console.log(`${ok ? '✓' : '✗'} ${String(step).padStart(2, '0')} ${name}${detail ? `: ${detail}` : ''}`)
}
function eq<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`)
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => { setTimeout(r, ms) })
}
function lastOf<T>(a: T[]): T | undefined {
  return a.length > 0 ? a[a.length - 1] : undefined
}

/**
 * Import `AppController` in a process where `vscode` does not exist.
 *
 * The controller itself only imports VS Code for types, but it reaches
 * `src/review/materializer.ts`, which calls `vscode.Uri.file` at runtime. That
 * module is only resolvable inside the extension host, so patch Node's CJS
 * loader for the duration of this process and load the controller lazily.
 * Nothing else in this file touches a VS Code API.
 */
async function loadControllerWithVscodeStub(): Promise<typeof import('../src/app/controller.ts')> {
  const moduleApi = await import('node:module')
  const loadable = (moduleApi.default ?? moduleApi) as unknown as {
    _load: (request: string, parent: unknown, isMain: boolean) => unknown
  }
  const original = loadable._load
  const stubUri = (p: string): Record<string, unknown> => ({
    fsPath: p, scheme: 'file', path: p, toString: () => `file://${p}`,
  })
  const stub: Record<string, unknown> = {
    Uri: { file: stubUri, parse: stubUri, joinPath: (base: { fsPath?: string }, ...parts: string[]) => stubUri([base.fsPath ?? '', ...parts].join('/')) },
    Position: class { constructor(public line: number, public character: number) {} },
    Range: class { constructor(public start: unknown, public end: unknown) {} },
    Disposable: class { dispose(): void {} },
    EventEmitter: class { event = (): void => undefined; fire(): void {}; dispose(): void {} },
    window: {}, workspace: {}, commands: {}, languages: {}, env: {},
  }
  loadable._load = function (request: string, parent: unknown, isMain: boolean): unknown {
    if (request === 'vscode') return stub
    return original.call(this, request, parent, isMain)
  }
  return import('../src/app/controller.ts')
}

// ─── webview boot harness (step G) ────────────────────────────────────────────
type StubEl = Record<string, unknown>
type StubListener = (e: unknown) => void

/**
 * A DOM stub faithful enough to *drive*, not just to boot.
 *
 * Listeners are recorded (so a test can click), and assigning `''` to
 * `innerHTML` drops the children (so a re-render does not leave the previous
 * tree behind and make a walk assert against stale nodes). Both matter the
 * moment a test wants to check what a button DOES rather than that it exists.
 */
function makeStubEl(id: string): StubEl {
  const el: StubEl = {
    id, value: '', textContent: '', className: '', src: '', alt: '', title: '', type: '',
    disabled: false, checked: false, selected: false,
    style: {}, children: [] as unknown[], dataset: {} as Record<string, string>,
    scrollTop: 0, scrollHeight: 0,
    listeners: {} as Record<string, StubListener[]>,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener(type: string, fn: StubListener) {
      const map = el['listeners'] as Record<string, StubListener[]>
      ;(map[type] ??= []).push(fn)
    },
    appendChild(c: unknown) { (el['children'] as unknown[]).push(c); return c },
    focus() {}, setAttribute() {}, getAttribute() { return null },
  }
  let html = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v: unknown) => { html = String(v ?? ''); if (html === '') el['children'] = [] },
  })
  return el
}

/** Fire every listener of `type` on one stub element. */
function fire(el: unknown, type: string): void {
  const handlers = ((el as StubEl)['listeners'] as Record<string, StubListener[]> | undefined)?.[type] ?? []
  for (const fn of handlers) fn({ stopPropagation() {}, preventDefault() {}, key: 'Enter', shiftKey: false })
}

/** Depth-first walk of a stub tree. */
function walk(el: unknown, out: StubEl[] = []): StubEl[] {
  const node = el as StubEl
  out.push(node)
  for (const c of (node['children'] as unknown[]) ?? []) walk(c, out)
  return out
}

const stubText = (el: unknown): string =>
  walk(el).map((n) => String(n['textContent'] ?? '')).join(' ')

const stubButtons = (el: unknown): StubEl[] =>
  walk(el).filter((n) => n['tag'] === 'button' || (n['listeners'] as Record<string, unknown> | undefined)?.['click'] !== undefined)

/**
 * Boot the real webview script against a minimal DOM stub and feed it one state.
 *
 * This is the exact path that froze the sidebar on its static "Disconnected"
 * placeholder: the script is a template string, so a stray TypeScript annotation
 * (or a backslash the template ate) parses fine for tsc and dies only in the
 * webview — killing every control with no visible error.
 */
function bootWebview(
  script: string,
  skeleton: string,
  markdownItFactory?: () => unknown,
  connection = 'connected',
): { handlerRegistered: boolean; statusText: string; connectVisible: boolean; connectLabel: string; connectDisabled: boolean; error: string } {
  const ids = [...skeleton.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string)
  const els = new Map(ids.map((id) => [id, makeStubEl(id)]))
  let handler: ((e: unknown) => void) | undefined
  const g = globalThis as unknown as Record<string, unknown>
  g.document = { getElementById: (id: string) => els.get(id) ?? null, createElement: (t: string) => makeStubEl(t) }
  g.window = { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') handler = fn } }
  g.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return undefined }, setState() {} })
  // Default: a real-shaped MarkdownIt, as the shipped UMD bundle provides.
  g.MarkdownIt = markdownItFactory
    ?? function () { return { renderer: { rules: {} as Record<string, unknown> }, render: (s: string) => String(s ?? '') } }
  const fail = (message: string, registered = false) => ({
    handlerRegistered: registered, statusText: '', connectVisible: false,
    connectLabel: '', connectDisabled: false, error: message,
  })
  try {
    new Function(script)()
  } catch (e) {
    return fail((e as Error).message)
  }
  if (typeof handler !== 'function') return fail('no state listener registered')
  const state = {
    connection, sessions: [], sending: false, canStop: false,
    showSystemMessages: false, systemMessageCount: 0, autoApprove: false, renderVersion: 1,
    capabilities: {}, commands: [], queue: [], eventLog: [], search: null,
    workspace: { workspaceId: '/w', title: 'w', path: '/w' },
  }
  try {
    handler({ data: { kind: 'state', state } })
  } catch (e) {
    return fail((e as Error).message, true)
  }
  const btn = els.get('connect') as { textContent: string; disabled: boolean; style: Record<string, string> }
  return {
    handlerRegistered: true,
    statusText: String((els.get('status-text') as { textContent: string }).textContent),
    connectVisible: btn.style.display !== 'none',
    connectLabel: String(btn.textContent),
    connectDisabled: btn.disabled === true,
    error: '',
  }
}

/**
 * Boot the webview script and keep the wiring, so a test can drive it.
 *
 * `bootWebview` only proves the panel comes up; this one hands back the element
 * tree and the actions the script posts, which is what it takes to assert that a
 * button does the right thing rather than merely that it was drawn.
 */
function bootWebviewInteractive(
  script: string,
  skeleton: string,
  state: Record<string, unknown>,
): { error: string; panel: StubEl; actions: Record<string, unknown>[]; bootActions: Record<string, unknown>[]; push: (patch: Record<string, unknown>) => void; el: (id: string) => StubEl; stats: { nodes: number; markdownCalls: number } } {
  const ids = [...skeleton.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string)
  const els = new Map(ids.map((id) => [id, makeStubEl(id)]))
  let handler: ((e: unknown) => void) | undefined
  const actions: Record<string, unknown>[] = []
  // Counts what a re-render actually costs: nodes constructed and markdown
  // passes. A transcript rebuild shows up in both; an incremental update in
  // neither but for the one row that changed.
  const stats = { nodes: 0, markdownCalls: 0 }
  const g = globalThis as unknown as Record<string, unknown>
  g.document = {
    getElementById: (id: string) => els.get(id) ?? null,
    createElement: (t: string) => { stats.nodes += 1; const e = makeStubEl(t); e['tag'] = t; return e },
    createDocumentFragment: () => { stats.nodes += 1; return makeStubEl('#fragment') },
  }
  g.window = { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') handler = fn } }
  g.acquireVsCodeApi = () => ({
    postMessage: (m: Record<string, unknown>) => { actions.push(m) },
    getState() { return undefined },
    setState() {},
  })
  g.MarkdownIt = function () {
    return {
      renderer: { rules: {} as Record<string, unknown> },
      render: (s: string) => { stats.markdownCalls += 1; return String(s ?? '') },
    }
  }
  try {
    new Function(script)()
  } catch (e) {
    return { error: (e as Error).message, panel: makeStubEl('pending-panel'), actions, bootActions: [], push: () => {}, el: () => makeStubEl('x'), stats }
  }
  const base = {
    connection: 'connected', sessions: [], sending: false, canStop: false,
    showSystemMessages: false, systemMessageCount: 0, autoApprove: false, renderVersion: 1,
    capabilities: {}, commands: [], queue: [], eventLog: [], search: null,
    workspace: { workspaceId: '/w', title: 'w', path: '/w' },
  }
  let version = 1
  const push = (patch: Record<string, unknown>): void => {
    version += 1
    handler?.({ data: { kind: 'state', state: { ...base, ...patch, renderVersion: version } } })
  }
  push(state)
  // The script asks for a connection on boot; that is not what these assertions
  // are about, and leaving it in would offset every count. It is kept separately
  // so the *shape* of that request can still be asserted.
  const bootActions = [...actions]
  actions.length = 0
  return {
    error: '',
    panel: els.get('pending-panel') as StubEl,
    actions,
    bootActions,
    push: (patch: Record<string, unknown>) => { actions.length = 0; push(patch) },
    el: (id: string) => els.get(id) as StubEl,
    stats,
  }
}

// ─── WebSocket helpers (minimal RFC 6455 server side) ─────────────────────────
function wsAccept(socket: Duplex, key: string | undefined): void {
  const accept = createHash('sha1').update((key ?? '') + WS_GUID).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))
}
function wsFrame(opcode: number, payload: Buffer): Buffer {
  const header: number[] = [0x80 | opcode]
  if (payload.length < 126) header.push(payload.length)
  else { header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff) }
  return Buffer.concat([Buffer.from(header), payload])
}
function wsSend(socket: Duplex, value: unknown): void {
  try { socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'))) } catch { /* closed */ }
}
function wsReadFrames(socket: Duplex, onText: (text: string) => void): void {
  let buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 2) return
      const opcode = (buffer[0] as number) & 0x0f
      const b1 = buffer[1] as number
      let length = b1 & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      }
      const masked = (b1 & 0x80) !== 0
      let key: Buffer | undefined
      if (masked) {
        if (buffer.length < offset + 4) return
        key = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (key !== undefined) {
        for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] as number) ^ (key[i % 4] as number)
      }
      buffer = buffer.subarray(offset + length)
      if (opcode === 0x8) { try { socket.end() } catch { /* already gone */ } return }
      if (opcode !== 0x1) continue
      onText(payload.toString('utf8'))
    }
  })
}

// ─── fake harness ─────────────────────────────────────────────────────────────
type AuthMode = 'none' | 'cookie'
/**
 * Control-surface methods that exist in 0.2.0-rc.2 (the exact `CONTROL_METHODS`
 * set the client probes). Everything else is reported absent.
 */
const PRESENT_CONTROLS = new Set<string>([
  'session/fork', 'session/rename', 'session/selectModel', 'session/updateQueue',
  'workspace/archiveSession', 'session/page', 'workspace/create', 'session/modelCatalog',
  'commands/execute', 'commands/list', 'session/search', 'session/attachment',
  'fileReferences/list',
])

function okBody(value: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value } })
}
function failBody(code: string, message: string): string {
  return JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: false, error: { code, message, details: {} } } })
}

/**
 * The changed-files summary the fake host serves, shaped exactly as the real
 * route validates it (`isChangesSummary` / `isChangedFile` upstream).
 */
const CHANGES_SUMMARY_BODY = {
  turn: 7,
  total: 2,
  added: 12,
  deleted: 3,
  files: [
    { path: 'src/app/controller.ts', display: 'src/app/controller.ts', added: 10, deleted: 2 },
    { path: 'notes.md', display: 'notes.md', added: 2, deleted: 1 },
  ],
}
/** A `seq` the fake host answers 404 for: the summary is gone with the Session. */
const CHANGES_SUMMARY_MISSING_SEQ = 999
/** One served comparison, hunks included, as `isChangesDiff` accepts it. */
const CHANGES_DIFF_BODY = {
  kind: 'text',
  path: 'src/app/controller.ts',
  display: 'src/app/controller.ts',
  before: true,
  after: true,
  coarse: false,
  hunks: [
    { oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' const a = 1', '-const b = 2', '+const b = 3', '+const c = 4', ' const d = 5'] },
  ],
}

interface FakeMuxState {
  open: boolean
  streamId?: string
  /** Which logical stream this socket subscribed to. */
  endpoint?: string
  readySent: boolean
  pending: Record<string, unknown>[]
  /** Sockets that already received a `session/follow` opening snapshot. */
  followSnapshotSent: boolean
}

/** One fake harness. `auth:'none'` = no cookie needed; `'cookie'` = gated host. */
function makeHarness(auth: AuthMode, controls: Set<string>): {
  secret: Buffer
  seen: {
    rpc: { endpoint: string; payload: Record<string, unknown>; inner: Record<string, unknown> }[]
    responses: RemoteEventResult[]
    muxOpened: boolean
    muxPath: string | undefined
    /** `open` frames the client sent, one per connected logical stream. */
    streams: { endpoint?: unknown; streamId?: unknown; payload?: unknown }[]
    /** Hits on the raw-byte staging route (file attachments). */
    uploads: { sessionId: string; name: string; mediaType: string; bytes: number; head: string }[]
    /** Plain authenticated GETs — the deliverables `changes.*` routes. */
    gets: { path: string; query: Record<string, string> }[]
  }
  /** Push one forwarded `$events` frame (emit / waterfall / ready). */
  pushEvent: (frame: Record<string, unknown>) => void
  /** Push one `session/follow` frame (snapshot parts / event / assistant-stream). */
  pushFollow: (frame: Record<string, unknown>) => void
  start: () => Promise<number>
  stop: () => Promise<void>
} {
  const secret = randomBytes(32)
  const seen = {
    rpc: [] as { endpoint: string; payload: Record<string, unknown>; inner: Record<string, unknown> }[],
    responses: [] as RemoteEventResult[],
    muxOpened: false,
    muxPath: undefined as string | undefined,
    streams: [] as { endpoint?: unknown; streamId?: unknown; payload?: unknown }[],
    /** Raw-byte staging route hits (file attachments do not ride the RPC surface). */
    uploads: [] as { sessionId: string; name: string; mediaType: string; bytes: number; head: string }[],
    gets: [] as { path: string; query: Record<string, string> }[],
  }
  const muxSockets = new Map<Duplex, FakeMuxState>()

  const cookieName = (authority: string): string => cookieNameForAuthority(authority)
  function mintCookie(authority: string): string {
    const payload = { version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 }
    const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
    const signature = createHmac('sha256', secret).update(body).digest().toString('base64url')
    return `v1.${body}.${signature}`
  }
  function authenticated(req: IncomingMessage): boolean {
    const authority = req.headers.host
    if (authority === undefined) return false
    const name = cookieName(authority)
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const at = part.indexOf('=')
      if (at === -1) continue
      if (part.slice(0, at).trim() !== name) continue
      const value = part.slice(at + 1).trim()
      const [version, body, signature] = value.split('.')
      if (version !== 'v1' || body === undefined || signature === undefined) return false
      const expected = createHmac('sha256', secret).update(body).digest().toString('base64url')
      if (expected !== signature) return false
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { authority?: string }
      return decoded.authority === authority
    }
    return false
  }

  function dispatch(endpoint: string, args: Record<string, unknown>): { status: number; body: string } {
    const missing = (): { status: number; body: string } => ({ status: 404, body: 'not found' })
    switch (endpoint) {
      case 'session/list':
        return { status: 200, body: okBody({ items: [
          { sessionId: 'session-1', updatedAt: 2, running: false, blank: false, cwd: '/repo/alpha' },
          { sessionId: 'session-2', updatedAt: 9, running: false, blank: false, cwd: '/repo/beta' },
          { sessionId: 'session-3', updatedAt: 5, running: false, blank: false, cwd: '/repo/alpha' },
        ] }) }
      case 'session/page':
        return controls.has('session/page') ? { status: 200, body: okBody({ records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } } }], hasMore: false }) } : missing()
      case 'session/create': {
        if (!controls.has('session/create')) return missing()
        const inner = (args['request'] as Record<string, unknown> | undefined) ?? args
        const workspaceId = inner['workspaceId']
        // Mirrors the live host: the workspaceId must be one the host ISSUED.
        // `listWorkspaces()` hands back a path, and `workspace/create` is what
        // turns a path into a real record — so a path here is a business
        // `workspace/not-found`, not a missing method. That distinction is what
        // section D2 pins.
        if (workspaceId !== 'ws-new') {
          return { status: 200, body: failBody('workspace/not-found', `workspace ${JSON.stringify(workspaceId)} not found`) }
        }
        return { status: 200, body: okBody({ sessionId: 'session-new', agentPreset: 'standard' }) }
      }
      case 'workspace/create': {
        if (!controls.has('workspace/create')) return missing()
        const inner = (args['request'] as Record<string, unknown> | undefined) ?? args
        const path = typeof inner['path'] === 'string' ? (inner['path'] as string) : '/tmp/new'
        return { status: 200, body: okBody({ workspace: { workspaceId: 'ws-new', path, title: 'new', sessionIds: [], createdAt: 'x', updatedAt: 'y' }, created: true }) }
      }
      case 'session/prompt':
        return { status: 200, body: okBody({ accepted: true }) }
      case 'session/cancel':
        return { status: 200, body: okBody({ accepted: true }) }
      case 'session/fork':
        return controls.has('session/fork') ? { status: 200, body: okBody({ sessionId: 'session-2' }) } : missing()
      case 'session/rename': {
        if (!controls.has('session/rename')) return missing()
        const inner = (args['request'] as Record<string, unknown> | undefined) ?? {}
        const title = String(inner['title'] ?? 'untitled')
        return { status: 200, body: okBody({ title, seq: 12 }) }
      }
      case 'session/selectModel':
        return controls.has('session/selectModel') ? { status: 200, body: okBody({ accepted: true }) } : missing()
      case 'session/updateQueue':
        return controls.has('session/updateQueue') ? { status: 200, body: okBody({ accepted: true }) } : missing()
      case 'workspace/archiveSession':
        return controls.has('workspace/archiveSession') ? { status: 200, body: okBody({ accepted: true }) } : missing()
      case 'session/modelCatalog':
        return controls.has('session/modelCatalog')
          ? { status: 200, body: okBody({
              default: { provider: 'deepseek', model: 'deepseek-v4-pro' },
              routableProviders: ['deepseek'],
              groups: [{
                id: 'deepseek', name: 'DeepSeek',
                models: [{
                  id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro',
                  reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
                }],
              }],
              failures: [],
            }) }
          : missing()
      case 'commands/execute': {
        if (!controls.has('commands/execute')) return missing()
        const inner = (args['request'] as Record<string, unknown> | undefined) ?? args
        return { status: 200, body: okBody({ matched: typeof inner['line'] === 'string' && inner['line'].startsWith('/') }) }
      }
      case 'commands/list':
        return controls.has('commands/list')
          ? { status: 200, body: okBody([
              { definitionId: 'd1', name: 'permission', description: 'Switch the permission preset' },
            ]) }
          : missing()
      case 'session/search':
        return controls.has('session/search')
          ? { status: 200, body: okBody({ results: [{ sessionId: 'session-1', title: 'Session 1', snippet: '…hello…' }], total: 1 }) }
          : missing()
      // `session/attachment` is a durable image READ — `{sessionId, attachmentId}`
      // → the stored ref plus its bytes. It has never been an upload path.
      case 'session/attachment':
        return controls.has('session/attachment')
          ? { status: 200, body: okBody({
            attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 2, height: 2, bytes: 73 },
            data: 'aGVsbG8=',
          }) }
          : missing()
      // The `@` completion source. Its descriptor is positional
      // `(agentId, query)`, so the inner args are bare — a `request` wrapper is
      // a shape rejection here, which is exactly what the assertion in step 12b
      // pins.
      case 'fileReferences/list': {
        if (!controls.has('fileReferences/list')) return missing()
        if (!('agentId' in args) || !('query' in args) || 'request' in args) {
          return { status: 200, body: failBody('gateway/arguments-invalid', 'typert gateway: fileReferences/list: args fields do not match the descriptor: missing "agentId", "query"') }
        }
        return { status: 200, body: okBody([
          { path: 'src/foo.ts', kind: 'file' },
          { path: 'docs notes', kind: 'directory' },
        ]) }
      }
      // rc.2 does NOT serve any of these — they must be reported as absent.
      case 'session/command':
      case 'agentPreset/list':
      case 'agentPreset/select':
      case 'llm/models':
      case 'subagent/list':
      case 'subagent/interrupt':
      case 'host/describe':
      case 'workspace/list':
      case 'session/history':
      case 'goal/create':
        return missing()
      default:
        return missing()
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const authority = req.headers.host ?? ''

    if (url.pathname === '/') {
      if (auth === 'cookie') {
        const token = url.searchParams.get('token')
        if (token !== null) {
          if (token !== LAUNCH_TOKEN) { res.writeHead(401, { 'content-type': 'text/plain' }); res.end('rejected'); return }
          res.writeHead(303, {
            location: '/',
            'set-cookie': `${cookieName(authority)}=${mintCookie(authority)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
          })
          res.end()
          return
        }
        res.writeHead(authenticated(req) ? 200 : 401)
        res.end()
        return
      }
      // rc.2 auth-less host: root is a health ping.
      res.writeHead(200)
      res.end()
      return
    }

    if (auth === 'cookie' && !authenticated(req)) {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end('unauthorized')
      return
    }

    // The deliverables `changes.*` routes sit BESIDE the gateway: plain
    // authenticated GETs taking query parameters, not a `{args}` envelope. They
    // are the one place a changed-files card gets its data from.
    if (req.method === 'GET' && (url.pathname === '/api/changes.summary' || url.pathname === '/api/changes.diff')) {
      seen.gets.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) })
      if (url.pathname === '/api/changes.summary' && url.searchParams.get('seq') === String(CHANGES_SUMMARY_MISSING_SEQ)) {
        // Gone with the Session: the real host drops summaries it no longer holds.
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('gone')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(url.pathname === '/api/changes.summary' ? CHANGES_SUMMARY_BODY : CHANGES_DIFF_BODY))
      return
    }

    if (req.method !== 'POST') {
      // `/api/remote.mux` etc. are WebSocket upgrades, not GET routes.
      res.writeHead(404)
      res.end()
      return
    }

    // The staged file-upload route: raw `application/octet-stream` bytes plus a
    // query, answering `{ok, value:{receiptId, file}}`. It is deliberately NOT a
    // JSON RPC envelope, which is what the old plugin guessed wrong.
    if (url.pathname === '/api/session/uploadFileBinary') {
      const raw: Buffer[] = []
      req.on('data', (c: Buffer) => { raw.push(c) })
      req.on('end', () => {
        const body = Buffer.concat(raw)
        const mediaType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
        const sessionId = url.searchParams.get('sessionId') ?? ''
        const name = url.searchParams.get('name') ?? ''
        seen.uploads.push({ sessionId, name, mediaType, bytes: body.length, head: body.toString('utf8').slice(0, 32) })
        if (mediaType !== 'application/octet-stream') {
          res.writeHead(415, { 'content-type': 'text/plain' })
          res.end('content type must be application/octet-stream')
          return
        }
        if (sessionId === '') {
          res.writeHead(400, { 'content-type': 'text/plain' })
          res.end('sessionId is required')
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          ok: true,
          value: { receiptId: 'receipt-1', file: { attachmentId: 'sha256:demo', name, bytes: body.length } },
        }))
      })
      return
    }

    const chunks: Uint8Array[] = []
    req.on('data', (c: Buffer) => { chunks.push(c) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const body = JSON.parse(raw) as { rpcId?: string; method?: string; payload?: Record<string, unknown> }
      const endpoint = url.pathname.replace(/^\/api\//, '')
      if (endpoint === '$events/result') {
        const a = (body.payload as { args?: RemoteEventResult } | undefined)?.args
        if (a !== undefined) seen.responses.push(a)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(okBody(null))
        return
      }
      const args = (body.payload as { args?: Record<string, unknown> } | undefined)?.args ?? {}
      seen.rpc.push({ endpoint, payload: body.payload ?? {}, inner: args })
      const out = dispatch(endpoint, args)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(out.body)
    })
  })

  server.on('upgrade', (req, socket, _head) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
    if (pathname !== '/api/remote.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      socket.end()
      return
    }
    if (auth === 'cookie' && !authenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      void socket.destroy()
      return
    }
    wsAccept(socket, req.headers['sec-websocket-key'] as string | undefined)
    seen.muxOpened = true
    seen.muxPath = pathname
    const st: FakeMuxState = { open: true, readySent: false, pending: [], followSnapshotSent: false }
    muxSockets.set(socket, st)
    wsReadFrames(socket, (text) => {
      let msg: { type?: unknown; streamId?: unknown; endpoint?: unknown; payload?: unknown }
      try { msg = JSON.parse(text) as { type?: unknown; streamId?: unknown; endpoint?: unknown; payload?: unknown } } catch { return }
      if (msg.type === 'open' && typeof msg.streamId === 'string') {
        st.streamId = msg.streamId
        st.endpoint = typeof msg.endpoint === 'string' ? msg.endpoint : undefined
        seen.streams.push({ endpoint: msg.endpoint, streamId: msg.streamId, payload: msg.payload })
        if (st.endpoint === 'session/follow') {
          // A follow stream opens straight into its snapshot — there is no
          // `ready` on this endpoint (that one belongs to `$events`).
          if (!st.followSnapshotSent) {
            st.followSnapshotSent = true
            wsSend(socket, { type: 'item', streamId: msg.streamId, value: {
              type: 'snapshot',
              header: { id: 'session-1', cwd: '/repo/alpha' },
              cursor: 1,
              records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'from snapshot' }] } } }],
              hasMore: false,
            } })
          }
          return
        }
        if (!st.readySent) {
          st.readySent = true
          wsSend(socket, { type: 'item', streamId: msg.streamId, value: { type: 'ready', clientId: READY_CLIENT_ID, host: { home: HOME } } as ReadyFrame })
        }
        for (const f of st.pending) wsSend(socket, { type: 'item', streamId: msg.streamId, value: f })
        st.pending = []
      }
    })
    const drop = (): void => { st.open = false }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  /** Broadcast one frame to every open socket subscribed to `endpoint`. */
  const broadcast = (endpoint: string, frameObj: Record<string, unknown>): void => {
    for (const [socket, st] of muxSockets) {
      if (!st.open || st.endpoint !== endpoint) continue
      if (st.streamId === undefined) { st.pending.push(frameObj); continue }
      wsSend(socket, { type: 'item', streamId: st.streamId, value: frameObj })
    }
  }

  return {
    secret,
    seen,
    pushEvent: (frameObj: Record<string, unknown>) => { broadcast('$events', frameObj) },
    pushFollow: (frameObj: Record<string, unknown>) => { broadcast('session/follow', frameObj) },
    start: () => new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => { resolve((server.address() as { port: number }).port) })
    }),
    stop: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

// ─── the actual test ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // A. rc.2 harness — full control surface, no cookie needed for the probe.
  const harness = makeHarness('none', PRESENT_CONTROLS)
  const port = await harness.start()
  console.log(`\nfake rc.2 harness listening on 127.0.0.1:${String(port)}\n`)

  const noopAuth = new BrowserSessionAuth({
    host: '127.0.0.1', port, store: { load: async () => undefined, save: async () => {} }, log: () => {},
  })
  const client = new HarnessClient({ host: '127.0.0.1', port, auth: noopAuth, log: () => {} })

  // 01. rc.2 connect: no pasted session required, identity from the `ready` frame.
  await client.connect()
  const conn = client.getState()
  check('rc.2 connect succeeds without a pasted session', conn.kind === 'connected', conn.kind)
  check('host identity comes from the ready frame (home)', conn.kind === 'connected' && conn.info.home === HOME, conn.kind === 'connected' ? conn.info.home : '')
  check('rc.2 has no host.describe: version is not transmitted', conn.kind === 'connected' && conn.info.version === undefined, conn.kind === 'connected' ? String(conn.info.version) : '')

  // 02. Unary RPCs speak the rc.2 contract: slash endpoint, payload wrapped in {args}.
  const listRpcs = harness.seen.rpc.filter((r) => r.endpoint === 'session/list')
  check('session/list is called slash-style (POST /api/session/list)', listRpcs.length > 0)
  check('unary payload is wrapped in {args:{...}} (never the args directly)',
    listRpcs.every((r) => 'args' in (r.payload as Record<string, unknown>)))
  check('the mux socket was opened at /api/remote.mux', harness.seen.muxOpened && harness.seen.muxPath === '/api/remote.mux', String(harness.seen.muxPath))

  // 03. Listing works.
  const sessions = await client.listSessions()
  eq('session/list returns the host list', sessions.items.length, 3)
  eq('session/list rows carry a host-canonical cwd', sessions.items[0]?.cwd, '/repo/alpha')
  const workspaces = await client.listWorkspaces()
  check('rc.2 serves no workspace/list, yet listWorkspaces still resolves the registry',
    workspaces.items.length > 0, JSON.stringify(workspaces.items.map(w => w.path)))

  // 04. createWorkspace.
  const created = await client.createWorkspace('/tmp/new')
  check('workspace/create resolves with a workspace view', created.workspace.workspaceId === 'ws-new' && created.created === true)

  // 05. prompt / cancel — inner args wrapped under `request`.
  await client.prompt('session-1', 'hello', 'UTC')
  await client.cancel('session-1')
  const promptRpc = harness.seen.rpc.find((r) => r.endpoint === 'session/prompt')
  const promptRequest = (promptRpc?.inner as { request?: Record<string, unknown> } | undefined)?.request
  check('session/prompt inner is {request:{requestId,sessionId,mode,content}}',
    typeof promptRequest?.['requestId'] === 'string' && promptRequest['requestId'].length > 0
    && promptRequest['sessionId'] === 'session-1' && promptRequest['mode'] === 'queue'
    && JSON.stringify(promptRequest['content']) === JSON.stringify([{ type: 'text', text: 'hello' }]),
    JSON.stringify(promptRequest?.['requestId'] !== undefined))

  // 06. History is `session/page` (a unary RPC) — and its `throughSeq` is a log
  //     cursor, not a count and not `0`. With no follow snapshot yet there is no
  //     cursor to page from, and inventing one is precisely what used to break
  //     the panel: `throughSeq: 0` pages up to the first event only, so the page
  //     came back a single `permission/preset` record, and `loadHistory` — which
  //     clears the model before replaying — then blanked the transcript on every
  //     mux reopen.
  const pagesBefore = harness.seen.rpc.filter((r) => r.endpoint === 'session/page').length
  const uncursored = await client.getHistory('session-1', { maxMessages: 50 })
  eq('without a follow cursor there is no page to ask for', uncursored.events, [])
  eq('...so the client asks the host nothing new',
    harness.seen.rpc.filter((r) => r.endpoint === 'session/page').length, pagesBefore)

  const history = await client.getHistory('session-1', { maxMessages: 50, throughSeq: 7 })
  eq('session/page returns the events (no session/history)', history.events[0]?.event.type, 'user/message')
  eq('session/page reports hasMore', history.hasMore, false)
  check('the history RPC is session/page, not session/history',
    harness.seen.rpc.some((r) => r.endpoint === 'session/page') && !harness.seen.rpc.some((r) => r.endpoint === 'session/history'))
  eq('the page carries the cursor through as throughSeq',
    harness.seen.rpc.filter((r) => r.endpoint === 'session/page').at(-1)?.inner,
    { request: { address: { kind: 'session', sessionId: 'session-1' }, throughSeq: 7, maxMessages: 50 } })

  // 07. Conversation transport. `$events` carries host identity and forwarded
  //     events only; the session's own traffic rides a `session/follow` stream
  //     on its own carrier. Getting this split wrong is what made the sidebar
  //     connect and then go silent, so the shape is pinned here.
  const frames: MuxFrame[] = []
  client.subscribe('session-1', (batch) => { frames.push(...batch) })
  await wait(120)
  const streamOpens = harness.seen.streams
  eq('the client opens the $events stream with a payload of {args:{}}',
    streamOpens.filter((s) => s.endpoint === '$events').map((s) => s.payload),
    [{ args: {} }])
  const followOpen = streamOpens.find((s) => s.endpoint === 'session/follow')
  check('the client opens a session/follow stream for the subscribed session', followOpen !== undefined)
  eq('session/follow is opened with {request:{address:{kind:session,sessionId},assistantStream:true}}',
    (followOpen?.payload as { args?: unknown } | undefined)?.args,
    { request: { address: { kind: 'session', sessionId: 'session-1' }, assistantStream: true } })

  // The fake host answers a follow open with a snapshot; the client re-offers
  // those records as session/event frames (the model's seq guard drops the
  // overlap with session/page).
  check('the opening snapshot records arrive as session/event frames',
    frames.some((f) => f.type === 'session/event'
      && (f as { event?: { type?: string } }).event?.type === 'user/message'))
  check('snapshot records carry the followed session id',
    frames.every((f) => (f as { sessionId?: string }).sessionId === 'session-1'))

  // The snapshot is also what publishes the history cursor: `session/page`
  // cannot be asked for a page without one. This is the fix for the transcript
  // blanking itself on every mux reopen (see step 06).
  const afterSnapshot = await client.getHistory('session-1', { maxMessages: 50 })
  eq('the follow snapshot teaches the client its history cursor',
    (harness.seen.rpc.filter((r) => r.endpoint === 'session/page').at(-1)?.inner as { request?: { throughSeq?: number } } | undefined)?.request?.throughSeq,
    1)
  check('...so a cursor-free page call now returns records', afterSnapshot.events.length > 0,
    String(afterSnapshot.events.length))
  eq('and it keeps following the newest durable seq',
    client.followCursor('session-1'), 1)

  // Durable records.
  harness.pushFollow({ type: 'event', event: { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'hi' }] } } })
  harness.pushFollow({ type: 'event', event: { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } } })
  // Live assistant deltas: `start` carries the turn/step the chunks belong to.
  harness.pushFollow({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  harness.pushFollow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 5, chunk: { type: 'text-delta', index: 0, text: 'po' } } })
  harness.pushFollow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 6, chunk: { type: 'text-delta', index: 0, text: 'ng' } } })
  // A chunk for an attempt never seen starting has nowhere to land: dropped,
  // rather than guessed onto the wrong turn.
  harness.pushFollow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'ghost', revision: 1, index: 0, time: 7, chunk: { type: 'text-delta', index: 0, text: 'BOOM' } } })
  harness.pushFollow({ type: 'assistant-stream', frame: { type: 'end', attemptId: 'a1', revision: 1, index: 2 } })
  // After `end` the attempt is forgotten, so a late chunk is dropped too.
  harness.pushFollow({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 3, time: 8, chunk: { type: 'text-delta', index: 0, text: 'LATE' } } })
  harness.pushFollow({ type: 'event', event: { type: 'turn/end', seq: 4, time: 9, data: { turn: 1, reason: { kind: 'stop' } } } })
  await wait(150)

  check('follow durable records arrive as session/event frames',
    frames.some((f) => f.type === 'session/event' && (f as { event?: { type?: string } }).event?.type === 'turn/start'))
  const deltas = frames.filter((f) => f.type === 'assistant/stream')
  eq('follow assistant chunks become assistant/stream frames', deltas.length, 2)
  eq('an assistant chunk carries the turn/step from its start frame',
    deltas.map((f) => `${String((f as { turn?: number }).turn)}.${String((f as { step?: number }).step)}`),
    ['1.1', '1.1'])
  eq('the chunk payload is passed through untouched',
    (deltas[0] as { chunk?: unknown }).chunk, { type: 'text-delta', index: 0, text: 'po' })
  check('a chunk whose attempt never started is dropped',
    !frames.some((f) => JSON.stringify(f).includes('BOOM')))
  check('a chunk arriving after the attempt ended is dropped',
    !frames.some((f) => JSON.stringify(f).includes('LATE')))

  // 07b. Forwarded events on `$events`: the host's own running flag becomes a
  //      session/status frame, which is what keeps the Stop button honest.
  harness.pushEvent({ type: 'emit', event: 'api-session/status', args: ['session-1', true] })
  await wait(80)
  check('api-session/status becomes a session/status frame',
    frames.some((f) => f.type === 'session/status' && (f as { running?: boolean }).running === true))
  check('a status frame for another session is not delivered to this sink',
    !frames.some((f) => f.type === 'session/status' && (f as { sessionId?: string }).sessionId === 'session-9'))

  // 08. Approvals ride `$events` as the `approval/request` WATERFALL, and the
  //     answer goes to POST /api/$events/result (not /api/respond).
  const approvals: { frame: MuxFrame; eventId: string }[] = []
  client.onApprovalFrame((frame, eventId) => approvals.push({ frame, eventId }))
  harness.pushEvent({ type: 'waterfall', event: 'approval/request', eventId: 'evt-2', agentId: 'session-1', request: { sessionId: 'session-1', toolName: 'write', callId: 'call-2', reason: 'outside workspace' } })
  await wait(80)
  const approval = approvals.find((a) => a.eventId === 'evt-2')
  check('the wire approval/request waterfall reaches the listener as approval/requested', approval?.frame.type === 'approval/requested')
  check('the translated frame carries the session id', (approval?.frame as { sessionId?: string } | undefined)?.sessionId === 'session-1')
  check('the translated frame carries the tool name', (approval?.frame as { toolName?: string } | undefined)?.toolName === 'write')
  // A forwarded event the plugin does not act on must not turn into traffic.
  const before = frames.length
  harness.pushEvent({ type: 'emit', event: 'plugin-manager/changed', args: ['whatever'] })
  await wait(60)
  eq('an unrelated forwarded event adds no conversation frame', frames.length, before)
  await client.respondApproval('evt-2', 'allowed-once')
  await wait(80)
  // The DECISION rides in outcome.value. `{kind:'result'}` alone settles the Host
  // waterfall with `undefined`, which ApprovalService normalizes to
  // 'unavailable' — an allow that silently denies. Verified against a live host:
  // the bare shape audited `approval/decided: unavailable` and the tool call
  // errored with "no approval channel is available".
  eq('allowing sends outcome{kind:result, value:allowed-once}',
    lastOf(harness.seen.responses) as unknown as Record<string, unknown>,
    { clientId: READY_CLIENT_ID, eventId: 'evt-2', outcome: { kind: 'result', value: 'allowed-once' } })

  // 08b. A deny is a result too, NOT a transport rejection: rejecting the Host
  //      waterfall makes ApprovalService contain the throw and answer
  //      'unavailable', so a Deny click used to be audited as "no approval
  //      channel is available" instead of "the user rejected tool X".
  harness.pushEvent({ type: 'waterfall', event: 'approval/request', eventId: 'evt-3', agentId: 'session-1', request: { sessionId: 'session-1', toolName: 'pwsh', callId: 'call-3', reason: 'escalate sandbox to danger-full-access: probe' } })
  await wait(80)
  await client.respondApproval('evt-3', 'rejected')
  await wait(80)
  eq('denying sends outcome{kind:result, value:rejected}',
    lastOf(harness.seen.responses) as unknown as Record<string, unknown>,
    { clientId: READY_CLIENT_ID, eventId: 'evt-3', outcome: { kind: 'result', value: 'rejected' } })

  // 08c. user-questions/request is the SAME transport with a different payload.
  //      It used to be translated and then dropped by the controller, so the
  //      Host blocked on a tool call nobody could answer.
  harness.pushEvent({
    type: 'waterfall', event: 'user-questions/request', eventId: 'evt-q1', agentId: 'session-1',
    request: {
      questions: [{ id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'green' }] }],
      wait: { callId: 'call-4', timed: false },
    },
  })
  await wait(80)
  const question = approvals.find((a) => a.eventId === 'evt-q1')
  check('the wire user-questions/request reaches the listener as question/requested',
    question?.frame.type === 'question/requested')
  eq('the question frame carries the wait callId',
    (question?.frame as { callId?: string } | undefined)?.callId, 'call-4')
  eq('the question frame carries the questions verbatim',
    (question?.frame as { questions?: unknown } | undefined)?.questions,
    [{ id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'green' }] }])

  await client.respondQuestion('evt-q1', { answers: [{ id: 'q1', selected: ['green'] }] })
  await wait(80)
  eq('answering sends outcome{kind:result, value:{answers}}',
    lastOf(harness.seen.responses) as unknown as Record<string, unknown>,
    {
      clientId: READY_CLIENT_ID,
      eventId: 'evt-q1',
      outcome: { kind: 'result', value: { answers: [{ id: 'q1', selected: ['green'] }] } },
    })

  // 08d. Delegation: `next` drops our delivery and leaves the request pending for
  //      whichever client still holds one (the Web UI), instead of answering it.
  harness.pushEvent({
    type: 'waterfall', event: 'user-questions/request', eventId: 'evt-q2', agentId: 'session-1',
    request: { questions: [{ id: 'q2', question: 'Which env?' }] },
  })
  await wait(80)
  await client.delegateWaterfall('evt-q2')
  await wait(80)
  eq('delegating sends outcome{kind:next}',
    lastOf(harness.seen.responses) as unknown as Record<string, unknown>,
    { clientId: READY_CLIENT_ID, eventId: 'evt-q2', outcome: { kind: 'next' } })
  let delegatedAnswerRejected = false
  try { await client.respondQuestion('evt-q2', { answers: [{ id: 'q2', selected: [] }] }) } catch { delegatedAnswerRejected = true }
  check('a delegated waterfall can no longer be answered from here', delegatedAnswerRejected)

  // 08e. A waterfall only a responder knows about must be refused, not guessed at.
  let unknownRejected = false
  try { await client.respondQuestion('evt-never-seen', { answers: [] }) } catch { unknownRejected = true }
  check('answering a question the client never observed throws', unknownRejected)

  // 08f. `cancel` is the ONLY resolution signal a mux client gets on
  //      0.2.1-alpha.2 — there is no forwarded approval/resolved or
  //      question/resolved. Without surfacing it, a card answered in the Web UI
  //      stayed clickable here forever.
  harness.pushEvent({ type: 'waterfall', event: 'approval/request', eventId: 'evt-4', agentId: 'session-1', request: { sessionId: 'session-1', toolName: 'write', callId: 'call-5', reason: 'outside workspace' } })
  await wait(80)
  harness.pushEvent({ type: 'cancel', eventId: 'evt-4' })
  await wait(80)
  const withdrawn = approvals.find((a) => a.eventId === 'evt-4' && a.frame.type === 'waterfall/resolved')
  check('a cancel frame surfaces as waterfall/resolved', withdrawn !== undefined)
  let lateAnswerRejected = false
  try { await client.respondApproval('evt-4', 'allowed-once') } catch { lateAnswerRejected = true }
  check('a withdrawn waterfall can no longer be answered', lateAnswerRejected)

  // 09. Control surface: discovered by probing, only offered when served.
  const caps = client.capabilities()
  check('all rc.2 control methods are recorded as present',
    caps['session/fork'] === true && caps['session/rename'] === true && caps['session/selectModel'] === true
    && caps['session/updateQueue'] === true && caps['workspace/archiveSession'] === true && caps['session/page'] === true
    && caps['workspace/create'] === true && caps['session/modelCatalog'] === true)
  check('session/command is NOT served in rc.2 (capability gate), so it reads absent',
    caps['session/command'] !== true)
  check('a 404 (not-found) method probe records absence', caps['agentPreset/list'] !== true)

  // 10. Control methods that DO exist are callable.
  eq('fork returns the child session id', await client.forkSession('session-1'), 'session-2')
  eq('rename returns the accepted title', (await client.renameSession('session-1', 'My title')).title, 'My title')
  check('archive answers without throwing', (await client.archiveSession('session-1')) !== undefined)

  // 9b. listWorkspaces() derives the registry from session/list cwd.
  // Regression: it used to return a hard-coded empty array, so
  // findHarnessWorkspace() never resolved and the UI stayed "Disconnected".
  const wsList = await client.listWorkspaces()
  eq('listWorkspaces derives one entry per distinct cwd', wsList.items.map(w => w.path), ['/repo/beta', '/repo/alpha'])
  eq('a derived workspace collects every session under that cwd',
    wsList.items.find(w => w.path === '/repo/alpha')?.sessionIds, ['session-1', 'session-3'])
  eq('a derived workspace is titled after its directory',
    wsList.items.find(w => w.path === '/repo/alpha')?.title, 'alpha')
  check('listWorkspaces derives in most-recently-touched order',
    wsList.items[0]?.path === '/repo/beta', JSON.stringify(wsList.items.map(w => w.path)))
  check('listWorkspaces never calls the non-existent workspace/list RPC',
    !harness.seen.rpc.some((r) => r.endpoint === 'workspace/list'))
  const alpha = { uri: { fsPath: '/repo/alpha' } } as unknown as Parameters<typeof findHarnessWorkspace>[1]
  eq('findHarnessWorkspace resolves a derived workspace by path',
    (await findHarnessWorkspace(client, alpha))?.path, '/repo/alpha')
  check('selectModel answers without throwing (provider is required)',
    (await client.selectModel('session-1', 'deepseek', 'deepseek-v4-pro', 'high')) !== undefined)
  const selectModelRpc = harness.seen.rpc.filter((r) => r.endpoint === 'session/selectModel').at(-1)
  eq('selectModel inner is {request:{sessionId,provider,model,reasoningEffort}}',
    selectModelRpc?.inner as Record<string, unknown>,
    { request: { sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' } })

  const catalog = await client.modelCatalog()
  eq('modelCatalog returns the provider groups with reasoning efforts',
    catalog.groups[0]?.models[0]?.reasoning?.efforts.map((e) => e.id) ?? [], ['high'])

  check('updateQueue steer answers without throwing',
    (await client.updateQueue('session-1', 'item-1', { kind: 'steer' })) !== undefined)
  const updateQueueRpc = harness.seen.rpc.filter((r) => r.endpoint === 'session/updateQueue').at(-1)
  eq('updateQueue inner is {request:{sessionId,itemId,action}}',
    updateQueueRpc?.inner as Record<string, unknown>,
    { request: { sessionId: 'session-1', itemId: 'item-1', action: { kind: 'steer' } } })

  // 11. rc.2 write path for slash commands: commands/execute (NOT session/command).
  const matched = await client.runCommand('session-1', '/permission workspace-write')
  eq('commands/execute accepts the slash line', matched.matched, true)
  const execRpc = harness.seen.rpc.filter((r) => r.endpoint === 'commands/execute').at(-1)
  eq('commands/execute inner is {agentId,line,submittedAttachments:[]}',
    execRpc?.inner as Record<string, unknown>,
    { agentId: 'session-1', line: '/permission workspace-write', submittedAttachments: [] })
  const commands = await client.listCommands('session-1')
  eq('commands/list returns the registry descriptors',
    commands.map((c) => c.name), ['permission'])
  check('session/command is never called (rc.2 has no such RPC)',
    !harness.seen.rpc.some((r) => r.endpoint === 'session/command'))

  // 12. F6/F8: session/search plus the two attachment routes — and the reason
  //      they are two: `session/attachment` READS a stored image by content
  //      address, while staging a file is a raw byte POST that never touches the
  //      RPC surface. The plugin used to send a write-shaped payload to
  //      `session/attachment` and hope; a fake host that models the real split is
  //      what keeps that from coming back.
  const found = await client.searchSessions('hello')
  eq('session/search returns results', found.results?.[0]?.sessionId, 'session-1')
  const searchRpc = harness.seen.rpc.filter((r) => r.endpoint === 'session/search').at(-1)
  eq('session/search inner is {request:{query}}', searchRpc?.inner as Record<string, unknown>,
    { request: { query: 'hello' } })

  const readBack = await client.readAttachment('session-1', 'sha256:abc')
  eq('session/attachment answers the stored ref', readBack.attachment.attachmentId, 'sha256:abc')
  eq('...and the bytes, base64', readBack.data, 'aGVsbG8=')
  const attRpc = harness.seen.rpc.filter((r) => r.endpoint === 'session/attachment').at(-1)
  eq('session/attachment inner is {request:{sessionId,attachmentId}}',
    attRpc?.inner as Record<string, unknown>,
    { request: { sessionId: 'session-1', attachmentId: 'sha256:abc' } })

  const staged = await client.uploadFile('session-1', 'notes.txt', new TextEncoder().encode('hello'))
  eq('the staging route answers a receipt', staged.receiptId, 'receipt-1')
  const upload = harness.seen.uploads.at(-1)
  eq('staging posts application/octet-stream', upload?.mediaType, 'application/octet-stream')
  eq('...with the session and leaf name on the query',
    [upload?.sessionId, upload?.name], ['session-1', 'notes.txt'])
  eq('...and the exact bytes as the body', [upload?.bytes, upload?.head], [5, 'hello'])

  // 12c. Prompt content parts. Images ride the prompt inline (the host promotes
  //      them to durable refs during admission); files can only be referenced by
  //      the receipt minted above.
  await client.prompt('session-1', 'look at this', undefined, {
    images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
    files: [{ receiptId: 'receipt-1' }],
  })
  const promptWithParts = harness.seen.rpc.filter((r) => r.endpoint === 'session/prompt').at(-1)
    ?.inner as { request?: { content?: unknown } } | undefined
  eq('a prompt carries text, image and file parts in that order', promptWithParts?.request?.content, [
    { type: 'text', text: 'look at this' },
    { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
    { type: 'file', receiptId: 'receipt-1' },
  ])

  // The host refuses a prompt whose every part is blank, so a picture-only
  // message must not carry an empty text part alongside the image.
  await client.prompt('session-1', '', undefined, { images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }] })
  const imageOnly = harness.seen.rpc.filter((r) => r.endpoint === 'session/prompt').at(-1)
    ?.inner as { request?: { content?: unknown } } | undefined
  eq('an image-only prompt drops the empty text part', imageOnly?.request?.content,
    [{ type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }])

  // A text-only prompt keeps its single text part (no behaviour drift).
  await client.prompt('session-1', 'plain')
  const textOnly = harness.seen.rpc.filter((r) => r.endpoint === 'session/prompt').at(-1)
    ?.inner as { request?: { content?: unknown } } | undefined
  eq('a text-only prompt still sends a single text part', textOnly?.request?.content,
    [{ type: 'text', text: 'plain' }])

  // 12d. Reading the image back out of the log — the mirror image of 12c.
  //
  //      The two durable message record types nest DIFFERENTLY, and getting this
  //      wrong is silent: the image simply is not found and the message renders
  //      empty. Measured on a live host:
  //
  //        user/message      → data.content          ← the promoted image ref
  //        assistant/message → data.message.content
  //        system/message    → data.message.content
  //
  //      An integration-test assertion had this backwards (it looked for
  //      `data.message.content` everywhere) and passed only by accident, so the
  //      asymmetry is pinned here where it is cheap to check.
  const restoreModel = new ConversationModel('session-1')
  restoreModel.loadHistory([
    ev('user/message', {
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', attachment: { attachmentId: 'sha256:deadbeef', mediaType: 'image/png' } },
      ],
      role: 'user',
    }, 1) as never,
    ev('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Red' }] },
    }, 2) as never,
  ])
  const restored = restoreModel.snapshot().items
  eq('a durable user/message is read from data.content (not data.message.content)',
    [restored[0]?.kind, restored[0]?.kind === 'user' ? restored[0].text : undefined],
    ['user', 'look at this\n[image]'])
  eq('a durable assistant/message is read from data.message.content',
    [restored[1]?.kind, restored[1]?.kind === 'assistant' ? restored[1].text : undefined],
    ['assistant', 'Red'])

  // 12b. The `@` completion source. Unlike the search/attachment pair above,
  //      `fileReferences/list` declares (agentId, query) positionally: the inner
  //      args are BARE, with no `request` wrapper. The fake host rejects a
  //      wrapper with gateway/arguments-invalid, so a regression here shows up
  //      as a thrown error rather than a silently empty completion list.
  check('fileReferences/list is discovered as served', caps['fileReferences/list'] === true)
  const refHits = await client.listFileReferences('session-1', 'src')
  eq('fileReferences/list returns the raw candidate array',
    refHits.map((c) => c.path), ['src/foo.ts', 'docs notes'])
  eq('the directory candidate keeps its kind',
    refHits.find((c) => c.path === 'docs notes')?.kind, 'directory')
  const refRpc = harness.seen.rpc.filter((r) => r.endpoint === 'fileReferences/list').at(-1)
  eq('fileReferences/list inner is bare {agentId,query} — no request wrapper',
    refRpc?.inner as Record<string, unknown>,
    { agentId: 'session-1', query: 'src' })
  // The count is 2, not 1: the connect-time control-surface probe posts every
  // method once with `{request:{}}`, which the host answers with a shape
  // rejection (that is how the method is discovered as present at all). The
  // point of the assertion is that the *real* call did not have to be retried
  // under a different wrapper — the bare shape is tried first and wins.
  eq('fileReferences/list is reached on the first try (probe + one real call)',
    harness.seen.rpc.filter((r) => r.endpoint === 'fileReferences/list').length, 2)
  check('the real fileReferences/list call carries no wrapper key at all',
    refRpc !== undefined && !('request' in refRpc.inner) && !('_request' in refRpc.inner))
  // The whole point of the endpoint: picking a candidate attaches nothing. The
  // host's FILE_REFERENCE_PROMPT tells the model to open the file itself, so the
  // RPC must not carry a sessionId/attachment payload of our own invention.
  eq('the candidate list carries no inlined file content',
    Object.keys(refHits[0] ?? {}).sort(), ['kind', 'path'])

  client.dispose()
  await harness.stop()

  // B. Bare host: connects, but serves no control methods at all.
  {
    const bare = makeHarness('none', new Set())
    const barePort = await bare.start()
    const bareAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: barePort, store: { load: async () => undefined, save: async () => {} }, log: () => {},
    })
    await bareAuth.init()
    const bareClient = new HarnessClient({ host: '127.0.0.1', port: barePort, auth: bareAuth, log: () => {} })
    await bareClient.connect()
    check('a host with no control surface still connects', bareClient.getState().kind === 'connected')
    check('every control method is probed as absent',
      Object.values(bareClient.capabilities()).every((v) => v !== true),
      JSON.stringify(bareClient.capabilities()))
    let bareMsg = ''
    try { await bareClient.runCommand('session-1', '/plan') } catch (e) { bareMsg = (e as Error).message }
    check('a non-served control (commands/execute) is refused with a clear message',
      /commands\/execute/.test(bareMsg) && /does not serve/.test(bareMsg), bareMsg.slice(0, 120))
    bareClient.dispose()
    await bare.stop()
  }

  // C. Wire negotiation edge cases (exercised directly via negotiateWire).
  {
    // A dot-style (legacy) host: dot endpoints, /api/events.mux, no cookie.
    const legacy = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return }
      if (url.pathname !== '/api/session.list') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(okBody({ items: [] }))
    })
    legacy.on('upgrade', (req, socket, _head) => {
      const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
      if (pathname !== '/api/events.mux') {
        // A clean 404 + end (NOT socket.destroy()) so the shared HTTP server is
        // not corrupted for the next probe on this connection.
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        socket.end()
        return
      }
      wsAccept(socket, req.headers['sec-websocket-key'] as string | undefined)
      // Read the socket so the client's close frame is consumed and the HTTP
      // server can finish closing (otherwise `legacy.close()` never fires).
      wsReadFrames(socket, () => {})
      socket.on('close', () => {})
      socket.on('error', () => {})
    })
    await new Promise<void>((resolve) => { legacy.listen(0, '127.0.0.1', () => { resolve() }) })
    const legacyPort = (legacy.address() as { port: number }).port
    const result = await negotiateWire({ host: '127.0.0.1', port: legacyPort, cookie: () => undefined, log: () => {} })
    check('a dot-style host is detected', result.kind === 'ok' && result.profile.endpointStyle === 'dot')
    check('an unauthenticated legacy host is served without a cookie',
      result.kind === 'ok' && result.profile.auth === 'none')
    check('the legacy event socket is discovered',
      result.kind === 'ok' && result.profile.muxPath === '/api/events.mux',
      result.kind === 'ok' ? result.profile.muxPath : result.kind)
    await new Promise<void>((resolve) => { legacy.close(() => { resolve() }) })
  }

  {
    // A cookie-gated host we have no session for: every probe is refused 401.
    const gated = http.createServer((_req, res) => { res.writeHead(401); res.end('unauthorized') })
    await new Promise<void>((resolve) => { gated.listen(0, '127.0.0.1', () => { resolve() }) })
    const gatedPort = (gated.address() as { port: number }).port
    const result = await negotiateWire({ host: '127.0.0.1', port: gatedPort, cookie: () => undefined, log: () => {} })
    check('a cookie-gated host is reported as auth-required', result.kind === 'auth-required')
    await new Promise<void>((resolve) => { gated.close(() => { resolve() }) })
  }

  {
    const result = await negotiateWire({ host: '127.0.0.1', port: 1, cookie: () => undefined, log: () => {} })
    check('a dead port is reported as unreachable', result.kind === 'unreachable')
    check('the unreachable message says to start dsh web',
      result.kind === 'unreachable' && /dsh web/.test(result.message),
      result.kind === 'unreachable' ? result.message.slice(0, 60) : '')
  }

  // D. wireEndpoint rendering.
  eq('slash style is rendered with a slash separator', wireEndpoint('slash', 'session/follow'), 'session/follow')
  eq('dot style is rendered with a dot separator', wireEndpoint('dot', 'session/follow'), 'session.follow')
  eq('special endpoints keep their own separator', wireEndpoint('dot', '$events/result'), '$events/result')
  eq('an unqualified name is untouched', wireEndpoint('dot', 'session'), 'session')

  // D2. Telling "no such method" apart from "the host refused your arguments".
  //
  //     Both families are worded similarly, and conflating them is expensive: a
  //     namespaced business error would be reported as a missing capability
  //     ("upgrade your host"), which is the opposite of the truth. Measured on
  //     the live host: a genuinely absent method answers HTTP 404 (no envelope at
  //     all), while `session/not-found` and `workspace/not-found` come back as
  //     200 + ok:false. So the envelope-level classifier must only fire for
  //     dispatch-layer codes.
  for (const code of ['gateway/method-unavailable', 'unknown_method', 'method-not-found', 'unimplemented',
    'gateway/method-not-found', 'no-such-method']) {
    check(`"${code}" reads as a missing method`, isMissingMethodError(code))
  }
  for (const code of ['workspace/not-found', 'session/not-found', 'session/renamed-not-found', 'not-found',
    'gateway/arguments-invalid', 'gateway/input-invalid', 'gateway/internal',
    'provider/unsupported', 'workspace/method-unavailable']) {
    check(`"${code}" is NOT a missing method`, !isMissingMethodError(code))
  }
  // A shape rejection is the useful third bucket: proof the method exists.
  check('gateway/arguments-invalid reads as a shape rejection',
    isShapeRejection('gateway/arguments-invalid'))
  check('a business not-found is neither missing-method nor shape rejection',
    !isMissingMethodError('workspace/not-found') && !isShapeRejection('workspace/not-found'))
  // The distinction has to survive a full round trip, not just the predicate:
  // a stale workspace id must reach the caller with the host's own wording.
  {
    const stale = makeHarness('none', new Set(['session/create', 'workspace/create']))
    const stalePort = await stale.start()
    const staleAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: stalePort,
      store: { load: async () => undefined, save: async () => {} }, log: () => {},
      allowLocalMint: true,
    })
    await staleAuth.init()
    await staleAuth.tryMintLocalSession()
    const staleClient = new HarnessClient({ host: '127.0.0.1', port: stalePort, auth: staleAuth, log: () => {} })
    await staleClient.connect()
    let message = ''
    let code = ''
    try {
      await staleClient.createSession({ workspaceId: 'not-a-real-workspace' })
    } catch (e) {
      message = (e as Error).message
      code = e instanceof HarnessRpcError ? e.code : `(not HarnessRpcError: ${(e as Error).constructor.name})`
    }
    eq('a stale workspace id surfaces the host code, not a capability gap', code, 'workspace/not-found')
    check('the message quotes what the host actually said',
      /not found/i.test(message) && !/upgrade the host/i.test(message), message.slice(0, 120))
    staleClient.dispose()
    await stale.stop()
  }

  // D3. The `@` completion round trip, through the REAL controller.
  //
  //     Two regressions are pinned here, both of which left the completion menu
  //     permanently empty with no error to look at:
  //
  //       1. `queryFileReferences` guarded staleness against `UiState.refQuery` —
  //          the query the LAST REPLY answered — which starts `undefined`. So the
  //          first bare `@` (query `''`) failed its own guard and published
  //          nothing at all.
  //       2. On the success path the candidates were published WITHOUT `refQuery`,
  //          and the composer only accepts a batch whose query it can match. Even
  //          once the guard was satisfied, the menu stayed shut.
  //
  //     Asserting the *published* state is the point: no amount of protocol-level
  //     coverage catches a field that is simply never written.
  {
    const refHost = makeHarness('none', PRESENT_CONTROLS)
    const refPort = await refHost.start()
    const refAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: refPort,
      store: { load: async () => undefined, save: async () => {} }, log: () => {},
      allowLocalMint: true,
    })
    await refAuth.init()
    await refAuth.tryMintLocalSession()
    const refClient = new HarnessClient({ host: '127.0.0.1', port: refPort, auth: refAuth, log: () => {} })
    await refClient.connect()

    // AppController reaches `src/review/materializer.ts`, which calls
    // `vscode.Uri.file` at runtime — a module that only exists inside the
    // extension host. Stub it for this process and load the controller lazily;
    // nothing else in this file touches a VS Code API.
    const { AppController } = await loadControllerWithVscodeStub()

    let ui: Record<string, unknown> = { showSystemMessages: false }
    const ctrl = new AppController({
      client: refClient,
      vscodeAPI: {} as never,
      getState: () => ui as never,
      setState: (patch) => { ui = { ...ui, ...patch } },
      bump: () => {},
      pushState: () => {},
      notifyError: () => {},
      notifyInfo: () => {},
      autoDiscover: () => false,
      openHarnessHome: () => {},
      moveToSecondarySideBar: async () => {},
      log: { info: () => {}, error: () => {} },
    })
    await ctrl.selectSession('session-1')

    // The exact first keystroke: a bare `@`.
    await ctrl.queryFileReferences('')
    eq('the first bare-@ query publishes candidates',
      (ui['refCandidates'] as { path: string }[]).map((c) => c.path), ['src/foo.ts', 'docs notes'])
    eq('the reply publishes refQuery alongside the candidates (not undefined)', ui['refQuery'], '')

    // A later keystroke must republish BOTH fields.
    await ctrl.queryFileReferences('sr')
    eq('a later query advances refQuery', ui['refQuery'], 'sr')
    eq('the later candidates replace the earlier batch',
      (ui['refCandidates'] as { path: string }[]).length, 2)
    eq('the query actually reached the host as a bare {agentId,query}',
      refHost.seen.rpc.filter((r) => r.endpoint === 'fileReferences/list').at(-1)?.inner,
      { agentId: 'session-1', query: 'sr' })

    // A host that does not serve the endpoint must CLEAR the menu while still
    // publishing the query. Leaving the older batch in place would keep offering
    // paths for a prefix the host never answered — and because the composer
    // matches on the prefix, a stale batch is *accepted* and looks plausible.
    const quietHost = makeHarness('none', new Set())
    const quietPort = await quietHost.start()
    const quietAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: quietPort,
      store: { load: async () => undefined, save: async () => {} }, log: () => {},
      allowLocalMint: true,
    })
    await quietAuth.init()
    await quietAuth.tryMintLocalSession()
    const quiet = new HarnessClient({ host: '127.0.0.1', port: quietPort, auth: quietAuth, log: () => {} })
    await quiet.connect()
    ctrl.replaceClient(quiet)
    await ctrl.queryFileReferences('zzz')
    eq('a host without the endpoint still publishes the query (bumping it)', ui['refQuery'], 'zzz')
    eq('...and drops the batch it cannot stand behind', ui['refCandidates'], [])

    quiet.dispose()
    await quietHost.stop()
    refClient.dispose()
    await refHost.stop()
  }

  // E. Cookie-gated host: the autoSession / token-exchange auth machinery.
  {
    const gated = makeHarness('cookie', PRESENT_CONTROLS)
    const gatedPort = await gated.start()
    const authority = `127.0.0.1:${String(gatedPort)}`

    let persisted: string | undefined
    const auth = new BrowserSessionAuth({
      host: '127.0.0.1', port: gatedPort,
      store: { load: async () => persisted, save: async (v) => { persisted = v } },
      log: () => {},
    })
    const gatedClient = new HarnessClient({ host: '127.0.0.1', port: gatedPort, auth, log: () => {} })

    // E1. Without a session the connect must fail with actionable guidance.
    await auth.init()
    let refused = ''
    try { await gatedClient.connect() } catch (e) { refused = (e as Error).message }
    check('connect without a session is refused', /browser session/i.test(refused), refused.slice(0, 90))
    // The paste-a-launch-URL command is gone: the only path is the local mint
    // from $DSH_HOME/.credentials.yaml, so that is what the refusal must point
    // at. A regression that reintroduces the command name here would send the
    // user hunting for a menu item that no longer exists.
    check('the refusal points at the local credential store',
      /\.credentials\.yaml/.test(refused), refused.slice(0, 160))
    check('the refusal names the autoSession setting as the on/off switch',
      /autoSession/.test(refused))
    check('the refusal no longer names the removed paste-URL command',
      !/Set Session Token from Launch URL/.test(refused))

    // E2. A wrong token must be rejected.
    let wrong = ''
    try { await auth.adoptLaunchUrl(`dsh web: http://127.0.0.1:${String(gatedPort)}/?token=not-the-token`) }
    catch (e) { wrong = (e as Error).message }
    check('a stale token is rejected with an explanation', /401|current `dsh web` process/.test(wrong), wrong.slice(0, 80))

    // E3. Token exchange mints and persists the cookie.
    const origin = await auth.adoptLaunchUrl(`dsh web: http://127.0.0.1:${String(gatedPort)}/?token=${LAUNCH_TOKEN}`)
    eq('the launch origin is adopted', origin, { host: '127.0.0.1', port: gatedPort })
    eq('the cookie name matches upstream derivation', auth.cookieHeader()?.split('=')[0], cookieNameForAuthority(authority))
    check('the cookie is persisted', typeof persisted === 'string' && persisted.includes('dsh-auth-'))
    check('the auth reports itself ready', auth.isReady())

    // E4. Connect now succeeds (cookie accepted) and learns the host identity from the `ready` frame.
    await gatedClient.connect()
    const gconn = gatedClient.getState()
    check('connect succeeds with a session', gconn.kind === 'connected', gconn.kind)
    eq('home comes from the ready frame', gconn.kind === 'connected' ? gconn.info.home : '', HOME)
    check('no version is transmitted in rc.2', gconn.kind === 'connected' && gconn.info.version === undefined)
    gatedClient.dispose()

    // E5. The cookie survives a restart (signing secret persists) without a new token.
    const restartedAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: gatedPort,
      store: { load: async () => persisted, save: async (v) => { persisted = v } },
      log: () => {},
    })
    await restartedAuth.init()
    check('the cookie survives a restart without a new token', restartedAuth.isReady())
    const restartedClient = new HarnessClient({ host: '127.0.0.1', port: gatedPort, auth: restartedAuth, log: () => {} })
    await restartedClient.connect()
    check('reconnect after a restart succeeds', restartedClient.getState().kind === 'connected')
    restartedClient.dispose()

    // E6. A well-formed but wrongly-signed cookie means the signing secret rotated.
    const staleBody = Buffer.from(JSON.stringify({
      version: 1, authority, issuedAt: Date.now(), expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    }), 'utf8').toString('base64url')
    const rotatedCookie = `v1.${staleBody}.${createHmac('sha256', randomBytes(32)).update(staleBody).digest().toString('base64url')}`
    const rotatedStore = JSON.stringify({
      authority, name: cookieNameForAuthority(authority), value: rotatedCookie, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    })
    const rotatedAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: gatedPort,
      store: { load: async () => rotatedStore, save: async () => {} }, log: () => {},
    })
    await rotatedAuth.init()
    check('a rotated-secret cookie still looks usable to the client', rotatedAuth.isReady())
    const rotatedClient = new HarnessClient({ host: '127.0.0.1', port: gatedPort, auth: rotatedAuth, log: () => {} })
    let rotatedMsg = ''
    try { await rotatedClient.connect() } catch (e) { rotatedMsg = (e as Error).message }
    check('a rejected cookie is blamed on the signing secret, not expiry',
      /signing secret/.test(rotatedMsg) && !/expired/.test(rotatedMsg), rotatedMsg.slice(0, 150))
    rotatedClient.dispose()

    // E7. Automatic session: no pasted token. Reading the harness's own credential
    //     store must produce a cookie the gated host accepts.
    const fakeHome = mkdtempSync(join(tmpdir(), 'dsh-home-'))
    writeFileSync(join(fakeHome, '.credentials.yaml'), [
      'version: 1',
      'refs: {}',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      `      secret: ${gated.secret.toString('base64url')}`,
      '',
    ].join('\n'))
    const previousHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = fakeHome
    try {
      let autoStore: string | undefined
      const autoAuth = new BrowserSessionAuth({
        host: '127.0.0.1', port: gatedPort,
        store: { load: async () => autoStore, save: async (v) => { autoStore = v } },
        log: () => {}, allowLocalMint: true,
      })
      await autoAuth.init()
      check('a fresh auth with nothing stored starts unready', !autoAuth.isReady())
      await autoAuth.tryMintLocalSession()
      eq('the local secret mints a usable cookie', autoAuth.cookieHeader()?.split('=')[0], cookieNameForAuthority(authority))
      eq('the mint is reported as local-credential', autoAuth.sessionOrigin(), 'local-credential')
      const autoClient = new HarnessClient({ host: '127.0.0.1', port: gatedPort, auth: autoAuth, log: () => {} })
      await autoClient.connect()
      check('connect succeeds with a locally minted cookie', autoClient.getState().kind === 'connected')
      autoClient.dispose()
    } finally {
      if (previousHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previousHome
      rmSync(fakeHome, { recursive: true, force: true })
    }

    // E8. Mint gaps: absent credential store / missing browser-session record / mint disabled.
    const absentHome = mkdtempSync(join(tmpdir(), 'dsh-absent-'))
    process.env['DSH_HOME'] = absentHome
    try {
      const goneAuth = new BrowserSessionAuth({
        host: '127.0.0.1', port: gatedPort,
        store: { load: async () => undefined, save: async () => {} }, log: () => {}, allowLocalMint: true,
      })
      const minted = await goneAuth.tryMintLocalSession()
      check('an absent credential store cannot mint', !minted && !goneAuth.isReady())
      check('the failure says where it looked', /no \.credentials\.yaml/.test(goneAuth.describeMintGap() ?? ''), goneAuth.describeMintGap()?.slice(0, 90))
    } finally {
      rmSync(absentHome, { recursive: true, force: true })
    }

    const emptyHome = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    writeFileSync(join(emptyHome, '.credentials.yaml'), 'version: 1\nrefs: {}\nrecords: {}\n')
    process.env['DSH_HOME'] = emptyHome
    try {
      let bareStore: string | undefined
      const bareAuth = new BrowserSessionAuth({
        host: '127.0.0.1', port: gatedPort,
        store: { load: async () => bareStore, save: async (v) => { bareStore = v } }, log: () => {}, allowLocalMint: true,
      })
      const minted = await bareAuth.tryMintLocalSession()
      check('a store without the browser-session record cannot mint', !minted && !bareAuth.isReady())
      check('the failure names the missing record', /client-connection\/browser-session/.test(bareAuth.describeMintGap() ?? ''), bareAuth.describeMintGap()?.slice(0, 90))
      check('no cookie is persisted after a failed mint', bareStore === undefined)
    } finally {
      rmSync(emptyHome, { recursive: true, force: true })
    }

    {
      const gatedAuth = new BrowserSessionAuth({
        host: '127.0.0.1', port: gatedPort,
        store: { load: async () => undefined, save: async () => {} }, log: () => {}, allowLocalMint: false,
      })
      const minted = await gatedAuth.tryMintLocalSession()
      check('autoSession off refuses the mint without reading the credential store', !minted && !gatedAuth.isReady())
    }

    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    await gated.stop()
  }

  // F. The control-surface fold — every knob is a whole value, replayable from the log.
  const surface = new ControlSurface()
  check('events the fold does not know are ignored', surface.apply(ev('something/new', {})) === false)
  check('plan/mode is folded', surface.apply(ev('plan/mode', { active: true }, 1)) === true)
  check('restating the same value does not bump the version', surface.apply(ev('plan/mode', { active: true }, 2)) === false)
  check('permission/preset is folded', surface.apply(ev('permission/preset', { preset: 'workspace-write' }, 3)) === true)
  check('sandbox/mode is folded', surface.apply(ev('sandbox/mode', { mode: 'workspace-write' }, 4)) === true)
  check('approval/policy is folded', surface.apply(ev('approval/policy', { policy: 'ask' }, 5)) === true)
  surface.apply(ev('todo/write', {
    todos: [{ content: 'read the log', status: 'completed' }, { content: 'fix it', status: 'in_progress' }, { content: '', status: 'pending' }],
  }, 6))
  eq('todo/write keeps only well-formed entries', surface.snapshot().todos.map((t) => t.content), ['read the log', 'fix it'])
  surface.apply(ev('todo/write', { todos: [{ content: 'read the log', status: 'completed' }] }, 7))
  eq('a later todo/write replaces the whole list', surface.snapshot().todos.length, 1)
  check('request/header yields the effective model', (() => {
    surface.apply(ev('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' } } }, 8))
    return JSON.stringify(surface.snapshot().model) === JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
  })())
  surface.apply(ev('goal/change', {
    operation: 'create',
    goal: { id: 'goal-1', revision: 1, objective: 'ship the control surface', phase: 'active', maxGoalRounds: 5 },
    roundsStarted: 2,
  }, 9))
  eq('goal/change creates the goal', [surface.snapshot().goal?.objective, surface.snapshot().goal?.phase], ['ship the control surface', 'active'])
  check('goal rounds are folded', surface.snapshot().goal?.roundsStarted === 2)
  surface.apply(ev('goal/change', {
    operation: 'complete',
    goal: { id: 'goal-1', revision: 2, objective: 'ship the control surface', phase: 'complete', maxGoalRounds: 5 },
    roundsStarted: 2,
  }, 10))
  eq('a later goal whole value wins', surface.snapshot().goal?.phase, 'complete')
  surface.apply(ev('goal/change', { operation: 'clear', cleared: { id: 'goal-1', revision: 2 } }, 11))
  check('goal/clear removes the goal', surface.snapshot().goal === undefined)
  check('subagent/start marks a child running', surface.apply(ev('subagent/start', { id: 'sub-1', name: 'reviewer' }, 12)) === true)
  eq('the running child is listed', [surface.snapshot().subagents.length, surface.snapshot().subagents[0]?.running], [1, true])
  surface.apply(ev('subagent/end', { id: 'sub-1' }, 13))
  check('subagent/end settles it without losing its name',
    surface.snapshot().subagents[0]?.running === false && surface.snapshot().subagents[0]?.name === 'reviewer')
  surface.apply(ev('subagent/descriptor', { subagents: [{ id: 'sub-2', name: 'tester' }] }, 14))
  eq('a descriptor roster replaces whoever is left', surface.snapshot().subagents.map((s) => s.key), ['sub-2'])
  surface.apply(ev('compaction/start', { compactionId: 'c1', turn: null }, 15))
  check('compaction/start shows a compaction in flight', surface.snapshot().compaction?.running === true)
  surface.apply(ev('compaction/summary', { compactionId: 'c1', summary: 'earlier work compacted', shadowedTokenCount: 4096 }, 16))
  surface.apply(ev('compaction/end', { compactionId: 'c1', turn: null }, 17))
  eq('a finished compaction keeps its summary',
    [surface.snapshot().compaction?.running, surface.snapshot().compaction?.summary, surface.snapshot().compaction?.shadowedTokenCount],
    [false, 'earlier work compacted', 4096])
  surface.apply(ev('agent-preset/selected', { id: 'preset-deep-research' }, 18))
  eq('the selected agent preset is folded', surface.snapshot().agentPreset, 'preset-deep-research')
  const beforeReset = surface.snapshot().version
  surface.reset()
  check('reset clears the whole control surface',
    surface.snapshot().version > beforeReset && surface.snapshot().todos.length === 0
    && surface.snapshot().goal === undefined && surface.snapshot().planActive === undefined)

  // ─── G. webview script integrity ──────────────────────────────────────────
  // The client script ships as a template string, so tsc never looks inside it.
  // Nothing above would have caught a TypeScript annotation or a backslash the
  // template ate — and either one silently kills every control in the panel,
  // leaving the status frozen on its static "Disconnected" placeholder.
  {
    let parseError = ''
    try { new Function(CLIENT_SCRIPT) } catch (e) { parseError = (e as Error).message }
    check('the webview script parses as JavaScript (no TS in the template)', parseError === '', parseError)

    const definedIds = new Set([...HTML_SKELETON.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string))
    const usedIds = new Set([...CLIENT_SCRIPT.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1] as string))
    eq('every element id the script looks up exists in the HTML skeleton',
      [...usedIds].filter((id) => !definedIds.has(id)), [])

    const boot = bootWebview(CLIENT_SCRIPT, HTML_SKELETON)
    check('the webview boots and attaches a state listener', boot.handlerRegistered, boot.error)
    eq('a connected state renders the Connected label', boot.statusText, 'Connected')

    // Reconnect. The case that needs it most is the panel that still reads
    // "Connected" after the Host was restarted — the socket we are holding is
    // dead but nothing has told us. Hiding the button then was the bug: the only
    // recovery was reloading the window.
    check('a connected panel keeps the reconnect affordance', boot.connectVisible)
    eq('...labelled Reconnect', boot.connectLabel, '⟳ Reconnect')
    check('...and it can be pressed', !boot.connectDisabled)

    const offline = bootWebview(CLIENT_SCRIPT, HTML_SKELETON, undefined, 'disconnected')
    check('a disconnected panel offers a connect button', offline.connectVisible)
    eq('...labelled Connect', offline.connectLabel, 'Connect')
    check('...and it is clickable, not disabled', !offline.connectDisabled)

    const errored = bootWebview(CLIENT_SCRIPT, HTML_SKELETON, undefined, 'error')
    check('a failed connection offers a retry', errored.connectVisible)
    eq('...labelled Retry', errored.connectLabel, 'Retry')

    const inFlight = bootWebview(CLIENT_SCRIPT, HTML_SKELETON, undefined, 'connecting')
    eq('an in-flight connect is labelled Connecting…', inFlight.connectLabel, 'Connecting…')
    check('...and cannot be pressed twice', inFlight.connectDisabled)

    // The degraded path (no markdown-it UMD) must still boot: the extension
    // serves a stub, and an unguarded renderer override used to abort on it.
    const degraded = bootWebview(CLIENT_SCRIPT, HTML_SKELETON,
      function () { return { render: (s: string) => String(s ?? '') } })
    check('the no-markdown-it fallback still boots the panel', degraded.handlerRegistered, degraded.error)
    eq('the fallback still renders Connected', degraded.statusText, 'Connected')

    // ─── G2. the pending panel: approvals + ask_user_question ───────────────
    // Both block the Host, and a question used to be dropped on the floor by the
    // controller, so the agent's tool call waited on an answer nobody could give.
    const idle = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {})
    eq('with nothing pending the panel stays hidden',
      (idle.panel['style'] as Record<string, string>)['display'], 'none')

    const approvalState = {
      approvals: [{
        rpcId: 'wf-1', approvalId: 'wf-1', sessionId: 'session-1', toolName: 'fs_write',
        reason: 'writes outside the workspace', state: 'pending', canAllow: true, createdAt: 1,
      }],
    }
    const ap = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, approvalState)
    check('a pending approval draws a card instead of vanishing',
      (ap.panel['style'] as Record<string, string>)['display'] !== 'none')
    check('the card names the tool and the reason verbatim',
      stubText(ap.panel).includes('fs_write') && stubText(ap.panel).includes('writes outside the workspace'))
    const allowBtn = stubButtons(ap.panel).find((b) => String(b['textContent']) === 'Allow once')
    const denyBtn = stubButtons(ap.panel).find((b) => String(b['textContent']) === 'Deny')
    check('an allow-able approval offers both Allow once and Deny',
      allowBtn !== undefined && denyBtn !== undefined)
    fire(allowBtn, 'click')
    eq('Allow posts the decision the Host actually reads',
      lastOf(ap.actions), { type: 'approvalRespond', rpcId: 'wf-1', outcome: 'allowed-once' })
    fire(denyBtn, 'click')
    eq('Deny posts a rejected RESULT, not a transport error',
      lastOf(ap.actions), { type: 'approvalRespond', rpcId: 'wf-1', outcome: 'rejected' })

    // Risk gate: an escalation the sidebar refuses to grant must still be
    // visible, and must offer a way forward rather than a dead button or nothing.
    const risky = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {
      approvals: [{
        rpcId: 'wf-2', approvalId: 'wf-2', sessionId: 'session-1', toolName: 'pwsh',
        reason: 'escalate sandbox to danger-full-access: probe', state: 'pending',
        canAllow: false, blockedBy: 'high-risk', createdAt: 1,
      }],
    })
    check('a refused approval is still shown, with the reason',
      stubText(risky.panel).includes('danger-full-access'))
    check('...and offers no Allow button at all',
      stubButtons(risky.panel).every((b) => String(b['textContent']) !== 'Allow once'))
    const handOff = stubButtons(risky.panel).find((b) => String(b['textContent']).indexOf('Answer in Web UI') === 0)
    check('...but does offer the hand-off', handOff !== undefined)
    fire(handOff, 'click')
    eq('the hand-off posts a delegation, not an answer',
      lastOf(risky.actions), { type: 'waterfallDelegate', rpcId: 'wf-2' })

    // Single-select: one question, one choice, so choosing IS answering.
    const oneQ = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {
      questions: [{
        rpcId: 'wf-3', sessionId: 'session-1', callId: 'call-7', state: 'pending', createdAt: 1,
        questions: [{ id: 'q1', question: 'Pick a color', options: [{ label: 'red' }, { label: 'green' }] }],
      }],
    })
    check('a pending question draws a card with its text', stubText(oneQ.panel).includes('Pick a color'))
    const radios = walk(oneQ.panel).filter((n) => n['type'] === 'radio')
    eq('a single-select question renders one radio per option', radios.length, 2)
    check('the options carry the question id in their radio group name',
      radios.every((r) => String(r['name']) === 'q-wf-3-q1'))
    // Pick "green" (the second option) the way a browser would: set checked,
    // then fire change.
    const green = radios[1] as StubEl
    green['checked'] = true
    fire(green, 'change')
    eq('choosing an option answers with the LABEL, keyed by question id',
      lastOf(oneQ.actions),
      { type: 'questionAnswer', rpcId: 'wf-3', answers: [{ id: 'q1', selected: ['green'], custom: undefined }] })

    // Two questions in one request: the fast path must NOT fire, or the second
    // question would be answered with an empty selection.
    const twoQ = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {
      questions: [{
        rpcId: 'wf-4', sessionId: 'session-1', state: 'pending', createdAt: 1,
        questions: [
          { id: 'a', question: 'Which env?', options: [{ label: 'prod' }] },
          { id: 'b', question: 'Which branch?', options: [{ label: 'main' }] },
        ],
      }],
    })
    const firstRadio = walk(twoQ.panel).filter((n) => n['type'] === 'radio')[0] as StubEl
    firstRadio['checked'] = true
    fire(firstRadio, 'change')
    eq('a choice in a multi-question request does not submit on its own', twoQ.actions.length, 0)
    const answerBtn = stubButtons(twoQ.panel).find((b) => String(b['textContent']) === 'Answer')
    fire(answerBtn, 'click')
    check('an unanswered question blocks the batch instead of sending a blank',
      twoQ.actions.length === 0
      && stubText(twoQ.panel).includes('Which branch?'))
    const secondRadio = walk(twoQ.panel).filter((n) => n['type'] === 'radio')[1] as StubEl
    secondRadio['checked'] = true
    fire(secondRadio, 'change')
    fire(answerBtn, 'click')
    eq('answering every question sends one batch',
      lastOf(twoQ.actions),
      {
        type: 'questionAnswer', rpcId: 'wf-4',
        answers: [
          { id: 'a', selected: ['prod'], custom: undefined },
          { id: 'b', selected: ['main'], custom: undefined },
        ],
      })

    // Free text only: no options at all, so the Answer button is the only path.
    const freeText = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {
      questions: [{
        rpcId: 'wf-5', sessionId: 'session-1', state: 'pending', createdAt: 1,
        questions: [{ id: 'why', question: 'Why is the build failing?' }],
      }],
    })
    const box = walk(freeText.panel).find((n) => String(n['className']) === 'pending-other') as StubEl
    check('a question with no options still offers free text', box !== undefined)
    fire(stubButtons(freeText.panel).find((b) => String(b['textContent']) === 'Answer'), 'click')
    eq('free text alone still does not submit', freeText.actions.length, 0)
    box['value'] = 'the lockfile is stale'
    fire(box, 'input')
    fire(stubButtons(freeText.panel).find((b) => String(b['textContent']) === 'Answer'), 'click')
    eq('the typed answer rides `custom`, not `selected`',
      lastOf(freeText.actions),
      { type: 'questionAnswer', rpcId: 'wf-5', answers: [{ id: 'why', selected: [], custom: 'the lockfile is stale' }] })

    // A resolved request must leave the panel: 0.2.1 announces the verdict with a
    // `cancel` frame, and a card left behind is a button that cannot work.
    const resolved = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {
      questions: [{ rpcId: 'wf-6', sessionId: 'session-1', state: 'resolved', createdAt: 1, questions: [{ id: 'q', question: 'gone' }] }],
    })
    eq('a resolved request leaves the panel empty',
      (resolved.panel['style'] as Record<string, string>)['display'], 'none')
  }

  // ─── G3. reconnect: the panel must be able to force a fresh connection ────
  // The Host can restart, and the desktop app comes up on a new OS-assigned port
  // every launch. Before this the panel held a dead socket and said "Connected";
  // the only recovery was reloading the VS Code window.
  {
    const live = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {})

    // Opening the panel must not tear down a session the extension host already
    // established — the boot request is the non-destructive one.
    eq('the panel asks for a connection on boot', live.bootActions.at(-1), { type: 'ensureConnected' })
    check('...and that request is not the destructive one',
      live.bootActions.every((a) => a['type'] !== 'connect'))

    // The button, however, must force.
    fire(live.el('connect'), 'click')
    eq('clicking Reconnect posts a forced connect', live.actions.at(-1), { type: 'connect' })

    // ...and it stays on offer while connected, which is the whole point.
    eq('the button is visible while connected',
      (live.el('connect')['style'] as Record<string, string>)['display'], '')
    eq('...and reads as a reconnect', live.el('connect')['textContent'], '⟳ Reconnect')
  }

  // ─── H. Host discovery ─────────────────────────────────────────────────────
  // The desktop app starts its Host with `--port 0`, so the port is OS-assigned
  // on every launch and the configured one goes stale. Finding it again is what
  // makes Reconnect useful instead of just faster to fail.
  {
    // H1. Reading a pinned port out of a profile's user patch layer. The entry has
    //     to be matched by id, or a `port:` belonging to some other service
    //     becomes the answer.
    eq('a webserver entry contributes its port',
      parseWebserverPort('- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 3081\n'), 3081)
    eq('a port outside a webserver entry is not claimed',
      parseWebserverPort('- id: ui-layout\n  config:\n    port: 9012\n'), undefined)
    eq('the webserver port is found among other entries',
      parseWebserverPort('- id: ui-layout\n  config:\n    port: 9012\n- id: webserver\n  config:\n    port: 19387\n'), 19387)
    eq('a webserver entry with no port is not claimed',
      parseWebserverPort('- id: webserver\n  name: "@deepseek-ai/dsh-host-webserver"\n'), undefined)

    // H2. Listener tables, one shape per platform.
    eq('netstat: loopback and wildcard LISTEN rows only',
      parseNetstatListeners([
        '  TCP    127.0.0.1:3081         0.0.0.0:0              LISTENING       10660',
        '  TCP    [::1]:3080             [::]:0                 LISTENING       1234',
        '  TCP    0.0.0.0:445            0.0.0.0:0              LISTENING       4',
        '  TCP    192.168.1.20:139       0.0.0.0:0              LISTENING       4',
        '  TCP    127.0.0.1:53000        0.0.0.0:0              ESTABLISHED     999',
      ].join('\r\n')), [445, 3080, 3081])
    eq('lsof: LISTEN rows only',
      parseLsofListeners([
        'node    1234 me   21u  IPv4 0x1      0t0  TCP 127.0.0.1:3080 (LISTEN)',
        'node    1234 me   22u  IPv6 0x2      0t0  TCP [::1]:3081 (LISTEN)',
        'node    1234 me   23u  IPv4 0x3      0t0  TCP 127.0.0.1:53000->127.0.0.1:1 (ESTABLISHED)',
      ].join('\n')), [3080, 3081])
    eq('procfs v4: state 0A with a loopback address',
      parseProcNetListeners([
        '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid',
        '   0: 0100007F:0C08 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000',
        '   1: 00000000:01BD 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0',
        '   2: 0100007F:1F90 00000000:0000 01 00000000:00000000 00:00000000 00000000  1000',
      ].join('\n'), 4), [445, 3080])
    eq('procfs v6: ::1 in the kernel\'s word order',
      parseProcNetListeners([
        '  sl  local_address                         rem_address   st',
        '   0: 00000000000000000000000001000000:0C08 00000000000000000000000000000000:0000 0A',
      ].join('\n'), 6), [3080])

    // H3. The fingerprint itself. An anonymous request to a dsh Host is refused
    //     by the connection carrier — not the web frontend — so this sentence is
    //     emitted whichever entry point booted it.
    const fence = http.createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end(`${DSH_FENCE_FINGERPRINT}; reopen the URL printed by dsh web.\n`)
    })
    const fencePort = await new Promise<number>((r) => {
      fence.listen(0, '127.0.0.1', () => { r((fence.address() as { port: number }).port) })
    })
    const plain = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<!doctype html><html><body>hello</body></html>')
    })
    const plainPort = await new Promise<number>((r) => {
      plain.listen(0, '127.0.0.1', () => { r((plain.address() as { port: number }).port) })
    })

    eq('the Host is recognised by its refusal', await probeHost('127.0.0.1', fencePort), 'dsh-host')
    eq('a plain HTTP server is not mistaken for one', await probeHost('127.0.0.1', plainPort), 'foreign')
    const deadPort = await (async () => {
      const probe = http.createServer()
      const p = await new Promise<number>((r) => { probe.listen(0, '127.0.0.1', () => { r((probe.address() as { port: number }).port) }) })
      await new Promise<void>((r) => { probe.close(() => { r() }) })
      return p
    })()
    eq('a closed port is silent, not foreign', await probeHost('127.0.0.1', deadPort, 400), 'silent')

    // H4. Discovery end to end: a pinned port outranks an incidental listener,
    //     and the configured port is tried first.
    const home = mkdtempSync(join(tmpdir(), 'dsh-discovery-'))
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'desktop', 'cordis.patch.yml'),
      `- id: webserver\n  name: '@deepseek-ai/dsh-host-webserver'\n  config:\n    host: 127.0.0.1\n    port: ${String(fencePort)}\n`)
    const ranked = await discoverHosts({
      host: '127.0.0.1',
      port: deadPort,
      env: { DSH_HOME: home },
      listeners: async () => [plainPort, fencePort],
      probeTimeoutMs: 800,
    })
    eq('discovery returns only Hosts, pinned ones first',
      ranked.map((h) => ({ port: h.port, source: h.source, profile: h.profile })),
      [{ port: fencePort, source: 'pinned', profile: 'desktop' }])
    const incidental = await discoverHosts({
      host: '127.0.0.1',
      port: deadPort,
      env: { DSH_HOME: join(home, 'nope') },
      listeners: async () => [plainPort, fencePort],
      probeTimeoutMs: 800,
    })
    eq('with no pin, a listener is the answer',
      incidental.map((h) => ({ port: h.port, source: h.source })),
      [{ port: fencePort, source: 'listening' }])
    rmSync(home, { recursive: true, force: true })

    await new Promise<void>((r) => { fence.close(() => { r() }) })
    await new Promise<void>((r) => { plain.close(() => { r() }) })
  }

  // ─── I. one waterfall event = one push, and none of them a transcript rebuild ─
  // A waterfall event used to publish the whole state TWICE — once from the
  // ApprovalStore's own change listener and once from the caller that had just
  // mutated it. That is not merely wasteful: each accepted push makes the
  // webview tear down `#messages` and rebuild every item, markdown and all, and
  // both pushes land in the same tick so nothing can paint in between. Measured
  // on a 72-record session it was 2 pushes / ~70 KB / 2 full rebuilds per event,
  // four times over an answer round trip.
  //
  // The rebuild is also unnecessary: nothing about an approval or a question is
  // drawn in the transcript any more — `renderTool` says so in as many words,
  // and the `approvalRpcId` it used to read was written by nobody and read by
  // nobody. A review card IS drawn there, so reviews keep the right to touch the
  // model. That asymmetry is what these assertions pin down.
  {
    const wf = makeHarness('none', PRESENT_CONTROLS)
    const wfPort = await wf.start()
    const wfAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: wfPort,
      store: { load: async () => undefined, save: async () => {} }, log: () => {},
      allowLocalMint: true,
    })
    await wfAuth.init()
    await wfAuth.tryMintLocalSession()
    const wfClient = new HarnessClient({ host: '127.0.0.1', port: wfPort, auth: wfAuth, log: () => {} })
    await wfClient.connect()

    const { AppController } = await loadControllerWithVscodeStub()
    let ui: Record<string, unknown> = { showSystemMessages: false, eventLog: [] }
    let pushes = 0
    const wfCtrl = new AppController({
      client: wfClient,
      vscodeAPI: {
        window: {}, commands: {},
        workspace: { registerTextDocumentContentProvider: () => ({ dispose: () => undefined }) },
      } as never,
      getState: () => ui as never,
      setState: (patch) => { ui = { ...ui, ...patch } },
      bump: () => {},
      pushState: () => { pushes += 1 },
      notifyError: () => {},
      notifyInfo: () => {},
      autoDiscover: () => false,
      openHarnessHome: () => {},
      moveToSecondarySideBar: async () => {},
      log: { info: () => {}, error: () => {} },
    })
    wfCtrl.start()
    await wfCtrl.selectSession('session-1')
    const settle = (ms = 150): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
    // Let the follow stream open and its snapshot flush before anything is
    // measured — those pushes are real, they just belong to `selectSession`.
    await settle(400)

    const versionBefore = (ui['snapshot'] as { renderVersion: number }).renderVersion

    pushes = 0
    wf.pushEvent({
      type: 'waterfall', event: 'user-questions/request', eventId: 'evt-q', agentId: 'session-1',
      request: { wait: {}, questions: [{ id: 'q1', question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }] }] },
    })
    await settle()
    eq('a question arrival publishes exactly one state (not the store-notify + caller pair)',
      pushes, 1)
    eq('...and parks the card in the pending panel', (ui['questions'] as unknown[]).length, 1)
    eq('...without forcing a transcript rebuild',
      (ui['snapshot'] as { renderVersion: number }).renderVersion, versionBefore)

    pushes = 0
    await wfCtrl.dispatch({
      type: 'questionAnswer', rpcId: 'evt-q', answers: [{ id: 'q1', selected: ['yes'] }],
    } as never)
    await settle()
    // Two publishes, and both carry news: the first shows "Answering…", the
    // second settles the card. The settle is ours to make. A mux client is not
    // sent `question/resolved` — only a withdrawal `cancel` — so a card that
    // waited for one stayed under the composer for the rest of the session,
    // which is exactly what it did.
    eq('answering publishes the responding state and then the settled one', pushes, 2)
    eq('...so an answered question stops being parked in the panel',
      (ui['questions'] as unknown[]).length, 0)
    eq('...with no transcript rebuild either',
      (ui['snapshot'] as { renderVersion: number }).renderVersion, versionBefore)
    eq('the answer rode in outcome.value, as the Host waterfall expects',
      (wf.seen.responses.at(-1) as { outcome?: unknown } | undefined)?.outcome,
      { kind: 'result', value: { answers: [{ id: 'q1', selected: ['yes'] }] } })

    // Handing one back is the other exit: nothing is answered, and the card is
    // dropped because we no longer hold a delivery. Its own waterfall, because
    // the one above is settled.
    wf.pushEvent({
      type: 'waterfall', event: 'user-questions/request', eventId: 'evt-q2', agentId: 'session-1',
      request: { wait: {}, questions: [{ id: 'q1', question: 'Ship it?', options: [{ label: 'yes' }] }] },
    })
    await settle()
    pushes = 0
    await wfCtrl.dispatch({ type: 'waterfallDelegate', rpcId: 'evt-q2' } as never)
    await settle()
    eq('handing it back publishes exactly one state', pushes, 1)
    eq('a delegated waterfall is dropped from the pending panel',
      (ui['questions'] as unknown[]).length, 0)

    // The approval half of the same fix. Same store, same lifecycle, same missing
    // frame — asserted rather than assumed symmetric, because the failure mode is
    // a card that says "Allowing…" for good.
    wf.pushEvent({
      type: 'waterfall', event: 'approval/request', eventId: 'evt-a', agentId: 'session-1',
      request: { sessionId: 'session-1', toolName: 'write', callId: 'call-a', reason: 'outside workspace' },
    })
    await settle()
    eq('an approval arrival parks a card', (ui['approvals'] as unknown[]).length, 1)
    pushes = 0
    await wfCtrl.dispatch({
      type: 'approvalRespond', rpcId: 'evt-a', outcome: 'allowed-once',
    } as never)
    await settle()
    eq('allowing publishes the responding state and then the settled one', pushes, 2)
    eq('...so a granted approval stops being parked',
      (ui['approvals'] as unknown[]).length, 0)
    eq('...and the grant still rode in outcome.value',
      (wf.seen.responses.at(-1) as { outcome?: unknown } | undefined)?.outcome,
      { kind: 'result', value: 'allowed-once' })

    // The other half of the same lifecycle, which a controller test cannot reach:
    // a POST that FAILS. A card in flight stays listed — only 'resolved' is
    // filtered out of the panel, which is exactly why a stuck card was visible at
    // all, sitting under the composer reading "Answering…" — so walking the state
    // back is what makes its buttons clickable again.
    const store = new ApprovalStore()
    store.upsertQuestion({
      rpcId: 'q-revert', sessionId: 'session-1',
      questions: [{ id: 'q1', question: 'Ship it?', options: [{ label: 'yes' }] }],
    })
    eq('a question arrival starts out pending', store.getQuestion('q-revert')?.state, 'pending')
    store.setQuestionResponding('q-revert')
    eq('a click moves it to responding, which is what the card renders as "Answering…"',
      store.getQuestion('q-revert')?.state, 'responding')
    eq('...and a card in flight is still listed in the panel',
      store.pendingQuestions('session-1').length, 1)
    store.revertResponding('q-revert')
    eq('a failed answer walks it back to pending, with its buttons live again',
      store.getQuestion('q-revert')?.state, 'pending')
    store.setQuestionResponding('q-revert')
    store.resolveWaterfall('q-revert', 'answered')
    eq('an accepted answer is what actually clears the panel',
      store.pendingQuestions('session-1').length, 0)

    // The inspector ring buffer is filled either way — it must be, so opening
    // the panel can backfill — but only published while something can read it.
    // Riding every push regardless cost up to ~600 KB of structured clone per
    // push, on a push that fires for every streamed chunk.
    eq('nothing of the ring buffer is published while the inspector is closed',
      (ui['eventLog'] as unknown[]).length, 0)
    wf.pushFollow({
      type: 'session/event', sessionId: 'session-1',
      event: { type: 'turn/start', seq: 900, time: 1, data: { turn: 900 } },
    })
    await settle()
    eq('...still nothing, even though a frame just arrived',
      (ui['eventLog'] as unknown[]).length, 0)

    await wfCtrl.dispatch({ type: 'inspectorToggle', open: true } as never)
    eq('opening the inspector publishes what it kept',
      (ui['eventLog'] as unknown[]).length >= 1, true)
    await wfCtrl.dispatch({ type: 'inspectorToggle', open: false } as never)
    eq('closing it stops shipping the buffer', (ui['eventLog'] as unknown[]).length, 0)

    wfClient.dispose()
    await wf.stop()
  }

  // ─── J. live deltas: one stable row, and no zombie bubble after the close ──
  // The model stamps every item with a `uid` (stable DOM key) and a `rev`
  // (change signature). The webview's incremental renderer keys off those, so
  // the model has to keep the contract: uid survives a streaming update, rev
  // moves on it, and a delta that outlived its turn never opens a new bubble.
  {
    const m = new ConversationModel('session-j')
    m.applyStreamChunk(1, 1, { type: 'text-delta', index: 0, text: 'Hel' })
    const first = (m.snapshot().items as unknown as Record<string, unknown>[])
    const uid = first[0]?.['uid']
    check('a streamed delta gets a render identity', typeof uid === 'number', String(uid))
    m.applyStreamChunk(1, 1, { type: 'text-delta', index: 0, text: 'lo' })
    const second = (m.snapshot().items as unknown as Record<string, unknown>[])
    eq('...the identity survives the next delta, so the row is reused', second[0]?.['uid'], uid)
    check('...while its change signature advances',
      (second[0]?.['rev'] as number) > (first[0]?.['rev'] as number),
      `${String(first[0]?.['rev'])} → ${String(second[0]?.['rev'])}`)
    eq('...and the text is the accumulation', second[0]?.['text'], 'Hello')

    // The durable message closes the step. A delta still in flight for it is a
    // stale echo: it used to find no placeholder, rebuild the buffer from ''
    // and append a SECOND assistant bubble under the finished answer.
    m.applyEvent(ev('assistant/message', {
      turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Final answer.' }] },
    }, 10) as never)
    const closed = (m.snapshot().items as unknown as Record<string, unknown>[])
    eq('the durable message replaces the streaming row', closed.length, 1)
    eq('...and is no longer marked streaming', closed[0]?.['streaming'], false)
    m.applyStreamChunk(1, 1, { type: 'text-delta', index: 0, text: 'TAIL' })
    eq('a delta after the durable message starts no second bubble',
      m.snapshot().items.length, 1)
    check('...and its text never reaches the transcript',
      !JSON.stringify(m.snapshot()).includes('TAIL'))

    // `turn/end` closes the turn the same way — this is the path a straggler
    // takes when the stream's own `end` frame and the durable turn/end race.
    const m2 = new ConversationModel('session-j2')
    m2.applyEvent(ev('turn/start', { turn: 4 }, 1) as never)
    m2.applyStreamChunk(4, 1, { type: 'text-delta', index: 0, text: 'streamed' })
    m2.applyEvent(ev('turn/end', { turn: 4, reason: { kind: 'stop' } }, 2) as never)
    const ended = m2.snapshot().items.length
    m2.applyStreamChunk(4, 1, { type: 'text-delta', index: 0, text: 'LATE' })
    eq('a delta after turn/end does not reopen the bubble', m2.snapshot().items.length, ended)
    check('...and its text never reaches the transcript',
      !JSON.stringify(m2.snapshot()).includes('LATE'))
    m2.applyStreamChunk(5, 1, { type: 'text-delta', index: 0, text: 'next turn' })
    eq('the following turn still streams normally', m2.snapshot().items.length, ended + 1)

    // A uid must never be handed out twice, even by a different model. The
    // webview caches DOM nodes by it, and a session switch / reconnect builds a
    // fresh model for what may be the same session — a per-instance counter
    // would restart at 1 and match the previous transcript's cached rows.
    const a = new ConversationModel('session-j3')
    a.applyEvent(ev('user/message', { content: [{ type: 'text', text: 'one' }] }, 1) as never)
    const b = new ConversationModel('session-j4')
    b.applyEvent(ev('user/message', { content: [{ type: 'text', text: 'two' }] }, 1) as never)
    const uidA = (a.snapshot().items as unknown as Record<string, unknown>[])[0]?.['uid']
    const uidB = (b.snapshot().items as unknown as Record<string, unknown>[])[0]?.['uid']
    check('uid is not reused when the model is rebuilt for another session',
      uidA !== uidB, `${String(uidA)} vs ${String(uidB)}`)
  }

  // ─── K. the transcript is reconciled, not rebuilt ─────────────────────────
  // renderVersion changes on every streamed chunk. Tearing `#messages` down on
  // each of those made the per-chunk cost grow with the length of the
  // conversation — measured at 40 turns, every 40 characters of new text cost
  // ~42 markdown re-parses and ~290 fresh DOM nodes. These assertions pin the
  // incremental contract, so that regression is a red test rather than a
  // subjective "it feels laggy when the chat gets long".
  {
    const TURNS = 6
    const past: Record<string, unknown>[] = []
    for (let i = 0; i < TURNS; i++) {
      past.push({ kind: 'user', seq: 2 * i + 1, text: `question ${String(i)}`, uid: 2 * i + 1, rev: 1 })
      past.push({ kind: 'assistant', seq: 2 * i + 2, text: `answer ${String(i)}`, toolCallIds: [], streaming: false, uid: 2 * i + 2, rev: 1 })
    }
    const live: Record<string, unknown> = {
      kind: 'assistant', seq: -7001, text: 'Hel', toolCallIds: [], streaming: true, uid: 900, rev: 1,
    }
    let items = [...past, live]
    const state = (version: number): Record<string, unknown> => ({
      activeSessionId: 'session-k',
      snapshot: { sessionId: 'session-k', items, renderVersion: version, running: true, systemMessageCount: 0 },
    })

    const boot = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, state(1))
    eq('the reconciling webview boots at all', boot.error, '')
    const msgs = boot.el('messages')
    const firstPaint = boot.stats.nodes
    check('the first paint builds the whole transcript', firstPaint > past.length, String(firstPaint))
    eq('...with one markdown pass per assistant message + the live one',
      boot.stats.markdownCalls, TURNS + 1)

    // A push whose only difference is renderVersion must cost nothing. This is
    // the shape of a `session/follow` replay, or of a state push driven by a
    // field the transcript does not show.
    const nodes0 = boot.stats.nodes
    const md0 = boot.stats.markdownCalls
    boot.push(state(2))
    eq('a push with a new renderVersion but unchanged items builds no DOM',
      boot.stats.nodes - nodes0, 0)
    eq('...and re-parses no markdown', boot.stats.markdownCalls - md0, 0)
    eq('...leaving every row in place', (msgs['children'] as unknown[]).length, items.length)

    // A streamed chunk changes exactly one item. Only that row may be rebuilt.
    items = [...past, { ...live, text: 'Hello there', rev: 2 }]
    boot.push(state(3))
    const oneRow = boot.stats.nodes - nodes0
    check('a streamed chunk rebuilds one row, not the whole transcript',
      oneRow > 0 && oneRow < firstPaint / 2, `${String(oneRow)} node(s) vs ${String(firstPaint)} for the full paint`)
    eq('...and re-parses exactly that one message', boot.stats.markdownCalls - md0, 1)
    eq('...with the row count unchanged', (msgs['children'] as unknown[]).length, items.length)

    // A row that disappears (an optimistic echo being replaced by the durable
    // message) must still be repainted even though nothing new was drawn.
    items = items.slice(0, -1)
    boot.push(state(4))
    eq('a dropped row is removed from the container',
      (msgs['children'] as unknown[]).length, items.length)
  }

  // ─── L. one flush costs one projection of the model, not one per frame ────
  // `applyMuxFrame` used to fold the transcript into UiState per frame, and a
  // streaming flush carries a whole turn's worth of deltas — so a single batch
  // built the full snapshot once per delta. The publish itself is once per
  // batch either way; this pins the projection count to match it.
  {
    const wf = makeHarness('none', PRESENT_CONTROLS)
    const wfPort = await wf.start()
    const wfAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: wfPort,
      store: { load: async () => undefined, save: async () => {} }, log: () => {},
      allowLocalMint: true,
    })
    await wfAuth.init()
    await wfAuth.tryMintLocalSession()
    const wfClient = new HarnessClient({ host: '127.0.0.1', port: wfPort, auth: wfAuth, log: () => {} })
    await wfClient.connect()

    const { AppController } = await loadControllerWithVscodeStub()
    let ui: Record<string, unknown> = { showSystemMessages: false, eventLog: [] }
    let pushes = 0
    const wfCtrl = new AppController({
      client: wfClient,
      vscodeAPI: {
        window: {}, commands: {},
        workspace: { registerTextDocumentContentProvider: () => ({ dispose: () => undefined }) },
      } as never,
      getState: () => ui as never,
      setState: (patch) => { ui = { ...ui, ...patch } },
      bump: () => {},
      pushState: () => { pushes += 1 },
      notifyError: () => {},
      notifyInfo: () => {},
      autoDiscover: () => false,
      openHarnessHome: () => {},
      moveToSecondarySideBar: async () => {},
      log: { info: () => {}, error: () => {} },
    })
    wfCtrl.start()
    await wfCtrl.selectSession('session-1')
    const settle = (ms = 150): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
    await settle(400)

    // Count how many times the model is projected into UiState.
    const proto = ConversationModel.prototype as unknown as { snapshot: (...a: unknown[]) => unknown }
    const realSnapshot = proto.snapshot
    let builds = 0
    proto.snapshot = function (this: unknown, ...args: unknown[]): unknown {
      builds += 1
      return (realSnapshot as (...a: unknown[]) => unknown).apply(this, args)
    }
    try {
      pushes = 0
      builds = 0
      const N = 24
      wf.pushFollow({
        type: 'assistant-stream',
        frame: { type: 'start', attemptId: 'burst', revision: 1, turn: 9, step: 1 },
      })
      await settle(60)
      for (let i = 0; i < N; i++) {
        wf.pushFollow({
          type: 'assistant-stream',
          frame: { type: 'chunk', attemptId: 'burst', revision: 1, index: i, time: i, chunk: { type: 'text-delta', index: 0, text: 'word ' } },
        })
      }
      await settle(250)
      check(`a burst of ${String(N)} live deltas arrives in fewer batches than deltas`,
        pushes >= 1 && pushes < N, `${String(pushes)} batch(es)`)
      check('...and each publish costs at most one projection of the model',
        builds <= pushes, `${String(builds)} snapshot(s) for ${String(pushes)} publish(es)`)
      check('...with the whole burst folded into the transcript',
        JSON.stringify(ui['snapshot']).includes('word word'), 'burst text is missing from the snapshot')
    } finally {
      proto.snapshot = realSnapshot
    }

    wfClient.dispose()
    await wf.stop()
  }

  // ─── M. changed files: the report, and the undo ─────────────────────────────
  //
  // A turn's changed-files record is the ONE source that covers everything the
  // turn touched — including files a shell command edited, which no file tool
  // ever reports. Nothing here is a gate: the card exists so a person can SEE
  // what already happened and undo it.
  //
  // Its own harness: `main()`'s is already torn down by group L above, and this
  // group needs a live listener for the two new GET routes.
  {
    const cf = makeHarness('none', PRESENT_CONTROLS)
    const cfPort = await cf.start()
    const cfAuth = new BrowserSessionAuth({
      host: '127.0.0.1', port: cfPort,
      store: { load: async () => undefined, save: async () => {} }, log: () => {},
    })
    await cfAuth.init()
    const cfClient = new HarnessClient({ host: '127.0.0.1', port: cfPort, auth: cfAuth, log: () => {} })
    await cfClient.connect()

    // M1. The routes are plain authenticated GETs carrying query parameters.
    const summary = await cfClient.changesSummary('session-1', 42)
    const summaryGet = cf.seen.gets.find(g => g.path === '/api/changes.summary')
    check('changes.summary is a plain GET route, not an RPC envelope',
      summaryGet !== undefined, JSON.stringify(cf.seen.gets.map(g => g.path)))
    eq('...addressed by sessionId and the announcing event seq',
      JSON.stringify(summaryGet?.query ?? null), JSON.stringify({ sessionId: 'session-1', seq: '42' }))
    eq('...decoding into the summary the host served', summary?.total, 2)
    eq('...with per-file line counts intact', summary?.files[0]?.added, 10)
    check('...and both a durable path and a display path per file',
      summary?.files[0]?.path === 'src/app/controller.ts'
      && summary?.files[0]?.display === 'src/app/controller.ts')

    // A summary the host no longer holds is "no card", not a failure.
    const goneSummary = await cfClient.changesSummary('session-1', CHANGES_SUMMARY_MISSING_SEQ)
    eq('a summary the host no longer serves resolves to undefined (no card)',
      goneSummary, undefined)

    const diff = await cfClient.changesDiff('session-1', 42, 1)
    const diffGet = cf.seen.gets.find(g => g.path === '/api/changes.diff')
    eq('changes.diff addresses one listed file by its index',
      JSON.stringify(diffGet?.query ?? null), JSON.stringify({ sessionId: 'session-1', seq: '42', index: '1' }))
    check('...and answers a text comparison carrying hunks',
      diff?.kind === 'text' && diff.hunks.length === 1, diff?.kind)

    // M2. Hunks rebuild into two line-ALIGNED sides.
    const changesDoc = await import('../src/review/changesDocument.ts')
    const sides = changesDoc.hunksToSides(CHANGES_DIFF_BODY.hunks)
    const before = sides.before.split('\n')
    const after = sides.after.split('\n')
    // The fixture hunk is: context, a `-`, two `+`, context. Each side keeps the
    // context and its own half; the other half becomes '' so index N always
    // means the same source line on both columns.
    eq('a rebuilt comparison keeps both sides the same height', before.length, after.length)
    eq('...the before column holds the context and the deleted line',
      before, ['const a = 1', 'const b = 2', '', '', 'const d = 5'])
    eq('...the after column holds the context and both added lines',
      after, ['const a = 1', '', 'const b = 3', 'const c = 4', 'const d = 5'])
    check('...so a deletion leaves a blank rather than shifting the rest up',
      before[1] === 'const b = 2' && after[1] === '')
    check('...and every addition sits opposite a blank on the before side',
      after[2] === 'const b = 3' && before[2] === '' && after[3] === 'const c = 4' && before[3] === '')

    // M3. The virtual URI carries its id in the AUTHORITY. Reading it off the
    //     path yields '' — the bug that silently blanked every native diff.
    const virtualDoc = await import('../src/review/virtualDocument.ts')
    const fakeStore = {
      getById: (id: string) => (id === 'review-7'
        ? { files: [{ path: 'src/app/controller.ts', beforeText: 'OLD', afterText: 'NEW' }] }
        : undefined),
    }
    const provider = new virtualDoc.ReviewVirtualDocumentProvider(fakeStore as never)
    const reviewUri = (side: string): never => ({
      scheme: 'dsh-review', authority: 'review-7',
      path: '/src%2Fapp%2Fcontroller.ts/' + side,
    }) as never
    eq('the review id is read from the URI authority',
      provider.provideTextDocumentContent(reviewUri('after')), 'NEW')
    eq('...and the before side serves the captured original',
      provider.provideTextDocumentContent(reviewUri('before')), 'OLD')
    eq('...while a URI with no authority resolves to nothing',
      provider.provideTextDocumentContent({ scheme: 'dsh-review', authority: '', path: '/x/after' } as never), '')

    // M4. A `workspace/changes` announcement becomes exactly one card per turn.
    const model = new ConversationModel('session-1')
    const asked: { turn: number; seq: number }[] = []
    model.setChangesRequestHandler((turn, seq) => { asked.push({ turn, seq }) })
    model.applyEvent(ev('turn/start', { turn: 3 }, 10))
    model.applyEvent(ev('workspace/changes', { turn: 3 }, 11))
    const cards = () => model.snapshot().items.filter(i => i.kind === 'changes')
    eq('an announcement opens exactly one changed-files card', cards().length, 1)
    eq('...and asks the controller for its summary', asked.length, 1)
    eq('...naming the announcing event seq, which is what the route takes', asked[0]?.seq, 11)
    check('...starting out loading rather than claiming "no changes"',
      (cards()[0] as { loading?: boolean }).loading === true)

    model.setChangesSummary(3, CHANGES_SUMMARY_BODY as never)
    const settled = cards()[0] as { loading?: boolean; summary?: { total?: number } }
    eq('the served summary fills the card in', settled.summary?.total, 2)
    check('...and the card stops loading', settled.loading === false)

    // A turn may announce twice (a `turn/end` re-record). That REPLACES the
    // coordinate instead of stacking a second card on the same turn.
    model.applyEvent(ev('workspace/changes', { turn: 3 }, 14))
    eq('a repeat announcement does not stack a second card', cards().length, 1)
    eq('...it re-asks with the newer coordinate', asked[asked.length - 1]?.seq, 14)
    check('...and drops the now-stale summary until the new one lands',
      (cards()[0] as { summary?: unknown }).summary === undefined)

    // A gone summary resolves the card to nothing rather than to an error.
    model.setChangesSummary(3, undefined)
    const resolved = cards()[0] as { summary?: unknown; loading?: boolean }
    check('a gone summary leaves the card resolved with nothing to draw',
      resolved.summary === undefined && resolved.loading === false)

    // The v0.1.7 reconciliation contract holds for the new item kind too.
    const stamped = cards()[0] as { uid?: number; rev?: number }
    check('the card carries a render identity like every other item',
      typeof stamped.uid === 'number' && typeof stamped.rev === 'number',
      JSON.stringify([stamped.uid, stamped.rev]))

    cfClient.dispose()
    await cf.stop()
  }

  // ─── N. composer mention chips ──────────────────────────────────────────────
  //
  // The chip strip under the composer is the only place the `@` grammar becomes
  // visible, and it is a second, deliberately duplicated copy of that grammar —
  // the webview cannot import extension-host code. It was also silently wrong in
  // a way no type checker can see: the pattern lived in a plain string, and the
  // webview's own parser consumed the backslash before `RegExp` ever got it, so
  // '[^\\s"]' arrived as '[^s"]' — a class matching spaces, newlines and further
  // @s. One chip swallowed the whole prompt, and ':L' ranges stopped parsing
  // because '\\d' had degenerated to a literal 'd'. Nothing above would catch
  // that; these assertions drive the REAL emitted script, which is the only
  // layer that can.
  {
    const chat = bootWebviewInteractive(CLIENT_SCRIPT, HTML_SKELETON, {})
    check('the webview boots for the mention assertions', chat.error === '', chat.error)

    const input = chat.el('input') as { value: string }
    const strip = chat.el('context-files') as { children: Record<string, unknown>[] }
    const typed = (text: string): string[] => {
      input.value = text
      fire(input, 'input')
      return strip.children.map((c) => String(c['textContent']))
    }

    eq('a mention followed by prose chips the PATH alone',
      typed('@readmefor_human.md 这里多了文字'), ['readmefor_human.md'])
    eq('a mention on the next line is its own chip, not more of the first',
      typed('@readmefor_human.md 这里多了文字\n@RELEASE.md'),
      ['readmefor_human.md', 'RELEASE.md'])
    eq('a line range rides on the chip instead of the path absorbing it',
      typed('@src/app.ts:L10-L20'), ['src/app.ts:L10-L20'])
    eq('a quoted mention keeps its spaces and stops at the closing quote',
      typed('@"my notes/plan.md" and then prose'), ['my notes/plan.md'])
    eq('an @ inside a word is not a mention', typed('mail bob@example.com'), [])
    eq('and the strip goes away once nothing is referenced', typed('just prose'), [])
  }

  console.log(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} CHECK(S) FAILED`} (${String(step)} total)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nPROTOCOL TEST ERROR:', e)
  process.exit(1)
})
