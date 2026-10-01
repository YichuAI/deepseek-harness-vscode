/**
 * protocol-test.ts — drives the REAL transport code against a fake harness.
 *
 * The runtime we actually target is DSH `0.2.0-rc.2` (the version installed
 * locally; verified against the bundled `@deepseek-ai/dsh-*` source and a live
 * `dsh web` on this machine). The script implements the *server half* of that
 * contract exactly and points the production client at it, so the handshake is
 * exercised end to end without a real `dsh web`.
 *
 * What rc.2 looks like (and therefore what this file proves):
 *   • endpoints are `POST /api/<ns>/<method>` (slash style), payload is wrapped:
 *     `{ args: <inner> }`. The `<inner>` field is the Typert parameter wire name —
 *     `session/list` uses `_request`, almost everything else uses `request`, and a
 *     few arg-less methods take `{}`.
 *   • the event socket is a multiplexed Remote-stream WebSocket
 *     `ws://…/api/remote.mux`. The client opens it, sends ONE `open` frame
 *     `{ type:'open', streamId, endpoint:'$events', payload:{args:{}} }`, and the
 *     Host replies with frames `{ type:'item'|'end'|'error', streamId, value }`.
 *     The FIRST item's value is `{ type:'ready', clientId, host:{home} }` — that
 *     is the only host-identity frame; there is NO `host.describe` in rc.2.
 *   • history is `session/page` (unary), not `session/history`.
 *   • approvals arrive as `approval/request` (a "waterfall" event) and are settled
 *     via `POST /api/$events/result` with `{ clientId, eventId, outcome }` —
 *     NOT `/api/respond`.
 *   • rc.2 REQUIRES a browser-session cookie (401 without one); the autoSession /
 *     token-exchange auth machinery is exercised in step E.
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
import type { MuxFrame, ReadyFrame, RemoteEventResult } from '../src/harness/protocol.ts'
import { ControlSurface } from '../src/conversation/control.ts'
import { cookieNameForAuthority } from '../src/harness/auth.ts'
import { negotiateWire, wireEndpoint } from '../src/harness/wire.ts'

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
  'commands/execute', 'commands/list',
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
  readySent: boolean
  pending: Record<string, unknown>[]
}

/** One fake harness. `auth:'none'` = no cookie needed; `'cookie'` = gated host. */
function makeHarness(auth: AuthMode, controls: Set<string>): {
  secret: Buffer
  seen: {
    rpc: { endpoint: string; payload: Record<string, unknown>; inner: Record<string, unknown> }[]
    responses: RemoteEventResult[]
    muxOpened: boolean
    muxPath: string | undefined
  }
  pushFrame: (frame: Record<string, unknown>) => void
  start: () => Promise<number>
  stop: () => Promise<void>
} {
  const secret = randomBytes(32)
  const seen = {
    rpc: [] as { endpoint: string; payload: Record<string, unknown>; inner: Record<string, unknown> }[],
    responses: [] as RemoteEventResult[],
    muxOpened: false,
    muxPath: undefined as string | undefined,
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
        return { status: 200, body: okBody({ items: [{ sessionId: 'session-1', updatedAt: 2, running: false, blank: false }] }) }
      case 'session/page':
        return controls.has('session/page') ? { status: 200, body: okBody({ records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } } }], hasMore: false }) } : missing()
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
    const st: FakeMuxState = { open: true, readySent: false, pending: [] }
    muxSockets.set(socket, st)
    wsReadFrames(socket, (text) => {
      let msg: { type?: unknown; streamId?: unknown }
      try { msg = JSON.parse(text) as { type?: unknown; streamId?: unknown } } catch { return }
      if (msg.type === 'open' && typeof msg.streamId === 'string') {
        st.streamId = msg.streamId
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

  return {
    secret,
    seen,
    pushFrame: (frameObj: Record<string, unknown>) => {
      for (const [socket, st] of muxSockets) {
        if (!st.open) continue
        if (st.streamId === undefined) { st.pending.push(frameObj); continue }
        wsSend(socket, { type: 'item', streamId: st.streamId, value: frameObj })
      }
    },
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
  eq('session/list returns the host list', sessions.items.length, 1)
  const workspaces = await client.listWorkspaces()
  eq('rc.2 has no workspace/list: listWorkspaces is empty', workspaces.items.length, 0)

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

  // 06. history arrives from session/page (a unary RPC), not session/history.
  const history = await client.getHistory('session-1', { maxMessages: 50 })
  eq('session/page returns the events (no session/history)', history.events[0]?.event.type, 'user/message')
  eq('session/page reports hasMore', history.hasMore, false)
  check('the history RPC is session/page, not session/history',
    harness.seen.rpc.some((r) => r.endpoint === 'session/page') && !harness.seen.rpc.some((r) => r.endpoint === 'session/history'))

  // 07. The event stream: multiplexed Remote stream; the client opens `$events`
  //     and receives `session/event` frames (assistant chunks ride them too).
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

  // 08. Approvals: server pushes the WIRE event `approval/request`; the client
  //     translates it to `approval/requested` and the answer goes to
  //     POST /api/$events/result (not /api/respond).
  const approvals: { frame: MuxFrame; eventId: string }[] = []
  client.onApprovalFrame((frame, eventId) => approvals.push({ frame, eventId }))
  harness.pushFrame({ type: 'approval/request', eventId: 'evt-2', request: { sessionId: 'session-1', toolName: 'write', callId: 'call-2', reason: 'outside workspace' } })
  await wait(80)
  const approval = approvals.find((a) => a.eventId === 'evt-2')
  check('the wire approval/request reaches the listener as approval/requested', approval?.frame.type === 'approval/requested')
  check('the translated frame carries the session id', (approval?.frame as { sessionId?: string } | undefined)?.sessionId === 'session-1')
  await client.respondApproval('evt-2', 'allowed-once')
  await wait(80)
  eq('the /api/$events/result body carries clientId/eventId/outcome{kind:result}',
    lastOf(harness.seen.responses) as unknown as Record<string, unknown>,
    { clientId: READY_CLIENT_ID, eventId: 'evt-2', outcome: { kind: 'result' } })

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

  console.log(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} CHECK(S) FAILED`} (${String(step)} total)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nPROTOCOL TEST ERROR:', e)
  process.exit(1)
})
