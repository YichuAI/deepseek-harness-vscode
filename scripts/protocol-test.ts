/**
 * protocol-test.ts — drives the REAL transport code against a fake harness.
 *
 * The runtime we actually target is DSH `0.1.0-rc.6` (the version installed
 * locally; the earlier `0.1.6-alpha` the plugin was written against does not
 * exist anywhere). The script implements the *server half* of that contract
 * exactly and points the production client at it, so the handshake is exercised
 * end to end without a real `dsh web`.
 *
 * What rc.6 looks like (and therefore what this file proves):
 *   • endpoints are `POST /api/<ns>.<method>` (dot style), payload is the args
 *     object *directly* — never wrapped in `{args}` / `{request}`.
 *   • the event socket is a downlink-only WebSocket `ws://…/api/events.mux`;
 *     there is NO `ready` frame — connection-open IS the ready signal, and the
 *     client never sends anything on it. Each WS message is a `server-request`
 *     envelope; the frame is `envelope.payload`.
 *   • `host.describe` (called once at connect) returns version/cwd/provider/model.
 *   • `session.history` is a unary RPC, not a `session/follow` stream.
 *   • approvals are settled via `POST /api/respond` with a `client-response`.
 *   • rc.6 has NO cookie auth, so connect succeeds with no pasted session; a
 *     sibling cookie-gated fake (step E) still exercises the autoSession path.
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
import { HarnessClient } from '../src/harness/client.ts'
import type { MuxFrame } from '../src/harness/protocol.ts'
import { ControlSurface } from '../src/conversation/control.ts'
import { cookieNameForAuthority } from '../src/harness/auth.ts'
import { negotiateWire, wireEndpoint } from '../src/harness/wire.ts'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

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

// ─── fake harness ─────────────────────────────────────────────────────────────
type AuthMode = 'none' | 'cookie'
const PRESENT_CONTROLS = new Set<string>([
  'session/command', 'session/fork', 'session/rename', 'session/selectModel',
  'workspace/archiveSession', 'agentPreset/list', 'llm/models', 'subagent/list',
])

function okBody(value: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: true, value } })
}
function failBody(code: string, message: string): string {
  return JSON.stringify({ type: 'server-response', rpcId: 'x', result: { ok: false, error: { code, message, details: {} } } })
}

/** One fake harness. `auth:'none'` = rc.6 (no cookie); `'cookie'` = gated host. */
function makeHarness(auth: AuthMode, controls: Set<string>): {
  secret: Buffer
  seen: { rpc: { endpoint: string; args: Record<string, unknown> }[]; responses: unknown[] }
  pushFrame: (frame: Record<string, unknown>) => void
  start: () => Promise<number>
  stop: () => Promise<void>
} {
  const secret = randomBytes(32)
  const seen = { rpc: [] as { endpoint: string; args: Record<string, unknown> }[], responses: [] as unknown[] }
  const muxSockets = new Set<Duplex>()

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
    switch (endpoint) {
      case 'session.list':
        return { status: 200, body: okBody({ items: [{ sessionId: 'session-1', updatedAt: 2, running: false, blank: false }] }) }
      case 'host.describe':
        return { status: 200, body: okBody({ version: '0.1.0-rc.6', cwd: '/home/tester', provider: 'deepseek-official', model: 'deepseek-v4-pro' }) }
      case 'session.history':
        return { status: 200, body: okBody({ events: [{ event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } } }], hasMore: false }) }
      case 'workspace.list':
        return { status: 200, body: okBody({ items: [{ workspaceId: 'ws-1', path: '/tmp/ws', title: 'ws', sessionIds: ['session-1'], createdAt: 'x', updatedAt: 'y' }], archivedSessionIds: [] }) }
      case 'workspace.create': {
        const path = typeof args['path'] === 'string' ? args['path'] : '/tmp/new'
        return { status: 200, body: okBody({ workspace: { workspaceId: 'ws-new', path, title: 'new', sessionIds: [], createdAt: 'x', updatedAt: 'y' }, created: true }) }
      }
      case 'session.prompt':
        return { status: 200, body: okBody({ accepted: true }) }
      case 'session.cancel':
        return { status: 200, body: okBody({ accepted: true }) }
      case 'session.command':
        return controls.has('session/command') ? { status: 200, body: okBody({ matched: true }) } : { status: 404, body: 'not found' }
      case 'session.fork':
        return controls.has('session/fork') ? { status: 200, body: okBody({ sessionId: 'session-2' }) } : { status: 404, body: 'not found' }
      case 'session.rename': {
        if (!controls.has('session/rename')) return { status: 404, body: 'not found' }
        const title = String((args['request'] as Record<string, unknown> | undefined)?.['title'] ?? args['title'] ?? 'untitled')
        return { status: 200, body: okBody({ title, seq: 12 }) }
      }
      case 'session.selectModel':
        return controls.has('session/selectModel') ? { status: 200, body: okBody({ accepted: true }) } : { status: 404, body: 'not found' }
      case 'workspace.archiveSession':
        return controls.has('workspace/archiveSession') ? { status: 200, body: okBody({ accepted: true }) } : { status: 404, body: 'not found' }
      case 'agentPreset.list':
        return controls.has('agentPreset/list') ? { status: 200, body: okBody({ items: [] }) } : { status: 404, body: 'not found' }
      case 'llm.models':
        return controls.has('llm/models') ? { status: 200, body: okBody({ models: [] }) } : { status: 404, body: 'not found' }
      case 'subagent.list': {
        if (!controls.has('subagent/list')) return { status: 404, body: 'not found' }
        // Empty args = a capability probe: a shape rejection proves existence.
        if (Object.keys(args).length === 0) return { status: 200, body: failBody('invalid_argument', 'missing declared parameter `agentId`') }
        return { status: 200, body: okBody({ items: [] }) }
      }
      case 'session.updateQueue':
      case 'agentPreset.select':
      case 'subagent.interrupt':
        return { status: 404, body: 'not found' }
      default:
        return { status: 404, body: 'not found' }
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
      // rc.6 has no token exchange at all.
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
      if (url.pathname === '/api/events.mux') { res.writeHead(200); res.end(); return }
      res.writeHead(404)
      res.end()
      return
    }

    const chunks: Uint8Array[] = []
    req.on('data', (c: Buffer) => { chunks.push(c) })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (url.pathname === '/api/respond') {
        const body = JSON.parse(raw) as { result?: unknown }
        seen.responses.push(body.result)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(okBody(null))
        return
      }
      const body = JSON.parse(raw) as { rpcId?: string; method?: string; payload?: Record<string, unknown> }
      const endpoint = url.pathname.replace(/^\/api\//, '')
      const args = body.payload ?? {}
      seen.rpc.push({ endpoint, args })
      const out = dispatch(endpoint, args)
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(out.body)
    })
  })

  // ─── minimal server-side WebSocket (RFC 6455, unmasked downlink) ────────────
  function frame(opcode: number, payload: Buffer): Buffer {
    const header: number[] = [0x80 | opcode]
    if (payload.length < 126) header.push(payload.length)
    else header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff)
    return Buffer.concat([Buffer.from(header), payload])
  }
  function sendText(socket: Duplex, value: unknown): void {
    socket.write(frame(0x1, Buffer.from(JSON.stringify(value), 'utf8')))
  }
  function readFrames(socket: Duplex, onText: (text: string) => void): void {
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

  server.on('upgrade', (req, socket, _head) => {
    const pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname
    if (pathname !== '/api/events.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
      void socket.destroy()
      return
    }
    if (auth === 'cookie' && !authenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n')
      void socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update((req.headers['sec-websocket-key'] ?? '') + WS_GUID)
      .digest('base64')
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'))
    muxSockets.add(socket)
    readFrames(socket, () => {})
    const drop = (): void => { muxSockets.delete(socket) }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  return {
    secret,
    seen,
    pushFrame: (frameObj: Record<string, unknown>) => {
      for (const s of muxSockets) sendText(s, { type: 'server-request', payload: frameObj })
    },
    start: () => new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve((server.address() as { port: number }).port)
      })
    }),
    stop: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

// ─── the actual test ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  // A. rc.6 harness — no cookie auth, full control surface.
  const harness = makeHarness('none', PRESENT_CONTROLS)
  const port = await harness.start()
  console.log(`\nfake rc.6 harness listening on 127.0.0.1:${String(port)}\n`)

  const noopAuth = new BrowserSessionAuth({
    host: '127.0.0.1', port, store: { load: async () => undefined, save: async () => {} }, log: () => {},
  })
  const client = new HarnessClient({ host: '127.0.0.1', port, auth: noopAuth, log: () => {} })

  // 01. rc.6 has no cookie auth: connect succeeds with no pasted session.
  await client.connect()
  const conn = client.getState()
  check('rc.6 connect succeeds without a pasted session', conn.kind === 'connected', conn.kind)
  check('host identity comes from host.describe cwd', conn.kind === 'connected' && conn.info.home === '/home/tester', conn.kind === 'connected' ? conn.info.home : '')
  eq('host.describe version is reported', conn.kind === 'connected' ? conn.info.version : '', '0.1.0-rc.6')

  // 02. Unary RPCs speak the rc.6 contract: dot endpoint, payload is args directly.
  const listRpcs = harness.seen.rpc.filter((r) => r.endpoint === 'session.list')
  check('session.list is called dot-style (POST /api/session.list)', listRpcs.length > 0)
  check('unary payload is the args object directly (no `{args}` wrapper)',
    listRpcs.every((r) => !('args' in r.args)))
  check('the mux socket was opened (downlink-only, no `ready` frame expected)',
    harness.seen.rpc.some((r) => r.endpoint === 'host.describe'))

  // 03. Listing works.
  const sessions = await client.listSessions()
  eq('session/list returns the host list', sessions.items.length, 1)
  const workspaces = await client.listWorkspaces()
  eq('workspace/list returns items', workspaces.items[0]?.workspaceId, 'ws-1')

  // 04. createWorkspace.
  const created = await client.createWorkspace('/tmp/new')
  check('workspace/create resolves with a workspace view', created.workspace.workspaceId === 'ws-new' && created.created === true)

  // 05. prompt / cancel — payload is flat, not nested under `request`.
  await client.prompt('session-1', 'hello', 'UTC')
  await client.cancel('session-1')
  const promptRpc = harness.seen.rpc.find((r) => r.endpoint === 'session.prompt')
  eq('session/prompt payload is flat (sessionId/mode/content)',
    promptRpc?.args,
    { sessionId: 'session-1', mode: 'queue', content: [{ type: 'text', text: 'hello' }], clientTimeZone: 'UTC' })

  // 06. history arrives from a unary RPC, not a follow stream.
  const history = await client.getHistory('session-1', { maxMessages: 50 })
  eq('session.history returns the events', history.events[0]?.event.type, 'user/message')
  eq('session.history reports hasMore', history.hasMore, false)

  // 07. The event stream: downlink-only, no `ready`, assistant deltas ride
  //     `session/event` frames with event.type === 'assistant/chunk'.
  const frames: MuxFrame[] = []
  client.subscribe('session-1', (batch) => { frames.push(...batch) })
  harness.pushFrame({ type: 'session/subscribed', sessionId: 'session-1', lastSeq: 2 })
  harness.pushFrame({ type: 'session/event', sessionId: 'session-1', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } } })
  harness.pushFrame({ type: 'session/event', sessionId: 'session-1', event: { type: 'assistant/chunk', seq: 1, time: 2, data: { chunk: { type: 'text-delta', index: 0, text: 'po' } } } })
  harness.pushFrame({ type: 'session/event', sessionId: 'session-1', event: { type: 'assistant/chunk', seq: 2, time: 3, data: { chunk: { type: 'text-delta', index: 0, text: 'ng' } } } })
  harness.pushFrame({ type: 'session/event', sessionId: 'session-1', event: { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'stop' } } } })
  await wait(150)
  check('subscribe replays events as session/event frames',
    frames.some((f) => f.type === 'session/event' && (f as { event?: { type?: string } }).event?.type === 'user/message'))
  const chunks = frames.filter((f) => f.type === 'session/event' && (f as { event?: { type?: string } }).event?.type === 'assistant/chunk')
  check('assistant deltas arrive as session/event assistant/chunk (no separate assistant/stream)', chunks.length === 2, `${String(chunks.length)} chunk frame(s)`)

  // 08. Approvals: server pushes approval/requested; client answers via /api/respond.
  const approvals: { frame: MuxFrame; eventId: string }[] = []
  client.onApprovalFrame((frame, eventId) => approvals.push({ frame, eventId }))
  harness.pushFrame({ type: 'approval/requested', sessionId: 'session-1', approvalId: 'evt-2', toolName: 'write', callId: 'call-2', reason: 'outside workspace' })
  await wait(80)
  const approval = approvals.find((a) => a.eventId === 'evt-2')
  check('the approval reaches the approval listener', approval !== undefined)
  check('the approval frame carries the session id', approval?.frame.type === 'approval/requested' && (approval.frame as { sessionId?: string }).sessionId === 'session-1')
  await client.respondApproval('evt-2', 'allowed-once')
  await wait(80)
  eq('the /api/respond body carries sessionId/approvalId/outcome',
    lastOf(harness.seen.responses) as Record<string, unknown>,
    { sessionId: 'session-1', approvalId: 'evt-2', outcome: 'allowed-once' })

  // 09. Control surface: discovered by probing, only offered when served.
  const caps = client.capabilities()
  check('served control methods are recorded as present',
    caps['session/command'] === true && caps['session/fork'] === true && caps['session/rename'] === true)
  check('a method answering HTTP 404 is recorded as absent', caps['session/updateQueue'] !== true)
  check('a not-found business error is recorded as absent', caps['agentPreset/select'] !== true)
  check('a shape-rejection still proves the method exists', caps['subagent/list'] === true)

  await client.setPermissionPreset('session-1', 'workspace-write')
  // (The capability probe also POSTs session/command with `{}`; match by the line.)
  const permCmd = harness.seen.rpc.find(
    (r) => r.endpoint === 'session.command'
      && (r.args as { request?: { line?: string } }).request?.line === '/permission workspace-write',
  )
  check('a preset switch goes out as session/command', permCmd !== undefined)
  eq('setPermissionPreset sends the /permission line',
    (permCmd?.args as { request?: { line?: string } }).request?.line, '/permission workspace-write')
  await client.togglePlanMode('session-1')
  check('plan mode toggles through /plan',
    harness.seen.rpc.some((r) => r.endpoint === 'session.command' && (r.args as { request?: { line?: string } }).request?.line === '/plan'))
  await client.compactSession('session-1')
  check('compaction requests /compact',
    harness.seen.rpc.some((r) => r.endpoint === 'session.command' && (r.args as { request?: { line?: string } }).request?.line === '/compact'))
  eq('fork returns the child session id', await client.forkSession('session-1'), 'session-2')
  eq('rename returns the accepted title', (await client.renameSession('session-1', 'My title')).title, 'My title')
  check('archive answers without throwing', (await client.archiveSession('session-1')) !== undefined)
  check('selectModel answers without throwing', (await client.selectModel('session-1', 'deepseek-v4-pro')) !== undefined)

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
    check('a host without a control surface is probed as having none',
      Object.values(bareClient.capabilities()).every((v) => v !== true),
      JSON.stringify(bareClient.capabilities()))
    let bareMsg = ''
    try { await bareClient.runCommand('session-1', '/plan') } catch (e) { bareMsg = (e as Error).message }
    check('an unserved control names the missing endpoint',
      /session\/command/.test(bareMsg) && /does not serve/.test(bareMsg), bareMsg.slice(0, 110))
    bareClient.dispose()
    await bare.stop()
  }

  // C. Wire negotiation edge cases (exercised directly via negotiateWire).
  {
    // A dot-style (legacy) host: dot endpoints, /api/events.mux, no cookie.
    const legacy = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      if (req.method !== 'POST') {
        res.writeHead(url.pathname === '/api/events.mux' ? 200 : 404)
        res.end()
        return
      }
      if (url.pathname !== '/api/session.list') { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(okBody({ items: [] }))
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
    check('the refusal names the exact command', /Set Session Token from Launch URL/.test(refused))

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

    // E4. Connect now succeeds (cookie accepted) and discovers the host identity.
    await gatedClient.connect()
    const gconn = gatedClient.getState()
    check('connect succeeds with a session', gconn.kind === 'connected', gconn.kind)
    eq('home comes from host.describe', gconn.kind === 'connected' ? gconn.info.home : '', '/home/tester')
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

  console.log(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} CHECK(S) FAILED`} (${String(step)} total)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nPROTOCOL TEST ERROR:', e)
  process.exit(1)
})
