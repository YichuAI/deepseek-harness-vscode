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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { BrowserSessionAuth } from '../src/harness/auth.ts'
import { HarnessClient, HarnessRpcError } from '../src/harness/client.ts'
import type { MuxFrame, ReadyFrame, RemoteEventResult } from '../src/harness/protocol.ts'
// The webview script is a plain template string, so tsc never looks inside it.
// These two give the regression gate eyes on it (see step G).
import { CLIENT_SCRIPT } from '../src/view/client.ts'
import { HTML_SKELETON } from '../src/view/html.ts'
import { ControlSurface } from '../src/conversation/control.ts'
import { ConversationModel } from '../src/conversation/model.ts'
import { cookieNameForAuthority } from '../src/harness/auth.ts'
import { isMissingMethodError, isShapeRejection, negotiateWire, wireEndpoint } from '../src/harness/wire.ts'
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
    id, value: '', textContent: '', className: '', src: '',
    disabled: false, checked: false, style: {}, children: [] as unknown[],
    listeners: {} as Record<string, StubListener[]>,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener(type: string, fn: StubListener) {
      const map = el['listeners'] as Record<string, StubListener[]>
      ;(map[type] ??= []).push(fn)
    },
    appendChild(c: unknown) { (el['children'] as unknown[]).push(c) },
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
): { error: string; panel: StubEl; actions: Record<string, unknown>[]; push: (patch: Record<string, unknown>) => void; el: (id: string) => StubEl } {
  const ids = [...skeleton.matchAll(/id="([^"]+)"/g)].map((m) => m[1] as string)
  const els = new Map(ids.map((id) => [id, makeStubEl(id)]))
  let handler: ((e: unknown) => void) | undefined
  const actions: Record<string, unknown>[] = []
  const g = globalThis as unknown as Record<string, unknown>
  g.document = { getElementById: (id: string) => els.get(id) ?? null, createElement: (t: string) => { const e = makeStubEl(t); e['tag'] = t; return e } }
  g.window = { addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'message') handler = fn } }
  g.acquireVsCodeApi = () => ({
    postMessage: (m: Record<string, unknown>) => { actions.push(m) },
    getState() { return undefined },
    setState() {},
  })
  g.MarkdownIt = function () { return { renderer: { rules: {} as Record<string, unknown> }, render: (s: string) => String(s ?? '') } }
  try {
    new Function(script)()
  } catch (e) {
    return { error: (e as Error).message, panel: makeStubEl('pending-panel'), actions, push: () => {}, el: () => makeStubEl('x') }
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
  // The script auto-connects on boot; that is not what these assertions are
  // about, and leaving it in would offset every count.
  actions.length = 0
  return {
    error: '',
    panel: els.get('pending-panel') as StubEl,
    actions,
    push: (patch: Record<string, unknown>) => { actions.length = 0; push(patch) },
    el: (id: string) => els.get(id) as StubEl,
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

    // Manual connect: auto-connect fires once at activation, so if dsh web was
    // not up yet there is nothing left to retry with unless the panel offers it.
    check('a connected panel hides the manual connect button', !boot.connectVisible)

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

  console.log(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} CHECK(S) FAILED`} (${String(step)} total)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nPROTOCOL TEST ERROR:', e)
  process.exit(1)
})
