/**
 * protocol-test.ts — drives the REAL transport code against a fake harness.
 *
 * DSH 0.1.6-alpha changed three things at once (cookie auth, `ns/method`
 * endpoints, and a logical-stream mux), and the machine that reported the bug
 * runs the old release, so there is nothing local to test against. This script
 * therefore implements the server half of the new contract exactly as the
 * upstream source specifies and points the production client at it.
 *
 * Run:  npx tsx scripts/protocol-test.ts
 *
 * What it proves:
 *   • `dsh-auth-<b64url(sha256(authority))>` derivation matches upstream byte for byte
 *   • the `GET /?token=…` → 303 + Set-Cookie exchange is parsed and persisted
 *   • connect() refuses to proceed without a session and explains how to get one
 *   • `/api/<ns>/<method>` + `payload:{args:{…}}` is what we actually send
 *   • the removed `host.describe` surfaces as our actionable 404 message
 *   • `$events` ready frame, waterfall delivery and `$events/result` answering
 *   • `session/follow` snapshot/dtream frames fold into the legacy frame shapes
 */

import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { BrowserSessionAuth } from '../src/harness/auth.ts'
import { HarnessClient } from '../src/harness/client.ts'
import type { MuxFrame } from '../src/harness/protocol.ts'

const LAUNCH_TOKEN = 'launch-token-abcdefghijklmnopqrstuvwxyz0123456789A'
const SECRET = randomBytes(32)

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

// ─── fake harness ─────────────────────────────────────────────────────────────
const seen: { rpc: { endpoint: string; args: unknown }[]; results: unknown[] } = { rpc: [], results: [] }
const muxStreams = new Map<string, { endpoint: string; socket: Duplex }>()

function cookieNameFor(authority: string): string {
  return 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url')
}

function mintCookie(authority: string): string {
  const payload = {
    version: 1,
    authority,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', SECRET).update(body).digest().toString('base64url')
  return `v1.${body}.${signature}`
}

function readCookie(req: IncomingMessage): string | undefined {
  const authority = req.headers.host
  if (authority === undefined) return undefined
  const name = cookieNameFor(authority)
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at === -1 || part.slice(0, at).trim() !== name) continue
    return part.slice(at + 1).trim()
  }
  return undefined
}

/** Accept only a cookie this server minted for this authority (mirrors BrowserAuth). */
function authenticated(req: IncomingMessage): boolean {
  const value = readCookie(req)
  if (value === undefined) return false
  const [version, body, signature] = value.split('.')
  if (version !== 'v1' || body === undefined || signature === undefined) return false
  const expected = createHmac('sha256', SECRET).update(body).digest().toString('base64url')
  if (expected !== signature) return false
  const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { authority?: string }
  return decoded.authority === req.headers.host
}

function sendJson(res: ServerResponse, rpcId: string, result: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://dsh.invalid')
  const authority = req.headers.host ?? ''

  // Root: token exchange, or the authenticated index.
  if (url.pathname === '/') {
    const token = url.searchParams.get('token')
    if (token !== null) {
      if (token !== LAUNCH_TOKEN) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('dsh web authentication required; reopen the URL printed by dsh web.\n')
        return
      }
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${cookieNameFor(authority)}=${mintCookie(authority)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
      })
      res.end()
      return
    }
    res.writeHead(authenticated(req) ? 200 : 401)
    res.end()
    return
  }

  if (!authenticated(req)) {
    res.writeHead(401, { 'content-type': 'text/plain' })
    res.end('unauthorized')
    return
  }

  const chunks: Uint8Array[] = []
  req.on('data', (c: Buffer) => { chunks.push(c) })
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      rpcId: string
      method: string
      payload: { args?: Record<string, unknown> }
    }
    const endpoint = url.pathname.replace(/^\/api\//, '')
    if (body.method !== endpoint) {
      sendJson(res, body.rpcId, {
        ok: false,
        error: { code: 'gateway/bad-request', message: 'method does not match endpoint', details: {} },
      })
      return
    }
    const args = body.payload.args ?? {}
    seen.rpc.push({ endpoint, args })

    switch (endpoint) {
      case 'session/list':
        eq('session/list args carry the declared `_request` parameter', args, { _request: {} })
        sendJson(res, body.rpcId, { ok: true, value: { items: [{ sessionId: 'session-1', updatedAt: 2, running: false, blank: false }] } })
        return
      case 'session/modelCatalog':
        sendJson(res, body.rpcId, { ok: true, value: { default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, routableProviders: [], groups: [], failures: [] } })
        return
      case 'session/prompt': {
        const request = (args as { request?: Record<string, unknown> }).request
        check('session/prompt nests its request object', typeof request === 'object' && request !== null)
        eq('session/prompt mode', request?.['mode'], 'queue')
        eq('session/prompt content', request?.['content'], [{ type: 'text', text: 'hello' }])
        check('session/prompt mints a requestId', typeof request?.['requestId'] === 'string' && (request['requestId'] as string).length > 0)
        sendJson(res, body.rpcId, { ok: true, value: { accepted: true } })
        return
      }
      case 'session/cancel':
        eq('session/cancel args', args, { request: { sessionId: 'session-1' } })
        sendJson(res, body.rpcId, { ok: true, value: { accepted: true } })
        return
      case '$events/result': {
        seen.results.push(args)
        sendJson(res, body.rpcId, { ok: true, value: undefined })
        return
      }
      case 'host.describe':
        // Deleted upstream: the RPC route answers 404, which is what the client
        // turns into its "endpoint does not exist" guidance.
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      default:
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
    }
  })
})

// ─── minimal server-side WebSocket (RFC 6455) ────────────────────────────────
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

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url ?? '/', 'http://dsh.invalid').pathname !== '/api/remote.mux' || !authenticated(req)) {
    socket.end([
      'HTTP/1.1 401 Unauthorized',
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Length: 12',
      '',
      'unauthorized',
    ].join('\r\n'))
    return
  }
  const accept = createHash('sha1')
    .update((req.headers['sec-websocket-key'] ?? '') + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))

  let readySent = false
  readFrames(socket, (text) => {
    const message = JSON.parse(text) as { type: string; streamId: string; endpoint?: string; payload?: { args?: Record<string, unknown> } }
    if (message.type === 'cancel') {
      muxStreams.delete(message.streamId)
      return
    }
    if (message.type !== 'open' || message.endpoint === undefined) return
    const args = message.payload?.args ?? {}
    muxStreams.set(message.streamId, { endpoint: message.endpoint, socket })

    if (message.endpoint === '$events') {
      eq('$events is opened with empty args', args, {})
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'ready', clientId: 'client-1', host: { home: '/home/tester' } } })
      readySent = true
      // Deliver one approval waterfall so the client can be asked to answer it.
      setTimeout(() => {
        sendText(socket, {
          type: 'item',
          streamId: message.streamId,
          value: {
            type: 'waterfall',
            event: 'approval/request',
            eventId: 'evt-1',
            agentId: 'session-1',
            request: { toolName: 'write', callId: 'call-1', reason: 'write outside the workspace' },
          },
        })
      }, 30)
      return
    }

    if (message.endpoint === 'workspace/follow') {
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'baseline', value: { items: [{ workspaceId: 'ws-1', path: '/tmp/ws', title: 'ws', sessionIds: ['session-1'], createdAt: 'x', updatedAt: 'y' }], archivedSessionIds: [] } } })
      return
    }

    if (message.endpoint === 'session/follow') {
      const request = (args as { request?: { address?: { kind?: string; sessionId?: string }; assistantStream?: boolean } }).request
      eq('session/follow addresses the session', request?.address, { kind: 'session', sessionId: 'session-1' })
      // The history probe omits every optional field; the live subscription opts in.
      if (request?.assistantStream !== undefined) {
        eq('session/follow opts into the assistant stream', request.assistantStream, true)
      }
      sendText(socket, {
        type: 'item',
        streamId: message.streamId,
        value: {
          type: 'snapshot',
          header: { version: 1, id: 'session-1', createdAt: 1, isSeeded: false },
          cursor: 2,
          records: [{ type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'hi' }] } } }],
          hasMore: false,
        },
      })
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'event', event: { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } } })
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'assistant-stream', frame: { type: 'start', attemptId: 'a1', revision: 1, startedAfterSeq: 1, turn: 1, step: 0 } } })
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 3, chunk: { type: 'text-delta', index: 0, text: 'po' } } } })
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 4, chunk: { type: 'text-delta', index: 0, text: 'ng' } } } })
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'event', event: { type: 'assistant/message', seq: 2, time: 5, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }] } } } } })
      sendText(socket, { type: 'item', streamId: message.streamId, value: { type: 'event', event: { type: 'turn/end', seq: 3, time: 6, data: { turn: 1, reason: { kind: 'stop' } } } } })
      return
    }

    sendText(socket, { type: 'error', streamId: message.streamId, error: { code: 'gateway/bad-request', message: `unknown endpoint`, details: {} } })
  })

  socket.on('close', () => { void readySent })
  void head
})

// ─── the actual test ─────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  console.log(`\nfake harness listening on 127.0.0.1:${String(port)}\n`)

  let persisted: string | undefined
  const auth = new BrowserSessionAuth({
    host: '127.0.0.1',
    port,
    store: { load: async () => persisted, save: async (v) => { persisted = v } },
    log: () => {},
  })
  const client = new HarnessClient({ host: '127.0.0.1', port, auth, log: () => {} })

  // 01. Without a session the connect must fail with actionable guidance.
  await auth.init()
  let refused = ''
  try { await client.connect() } catch (e) { refused = (e as Error).message }
  check('connect without a session is refused', /browser session/i.test(refused), refused.slice(0, 90))
  check('the refusal names the exact command', /Set Session Token from Launch URL/.test(refused))

  // 02. A wrong token must be rejected, not silently accepted.
  let wrong = ''
  try { await auth.adoptLaunchUrl(`dsh web: http://127.0.0.1:${String(port)}/?token=not-the-token`) }
  catch (e) { wrong = (e as Error).message }
  check('a stale token is rejected with an explanation', /401|current `dsh web` process/.test(wrong), wrong.slice(0, 80))

  // 03. Token exchange mints and persists the cookie.
  const origin = await auth.adoptLaunchUrl(`dsh web: http://127.0.0.1:${String(port)}/?token=${LAUNCH_TOKEN}`)
  eq('the launch origin is adopted', origin, { host: '127.0.0.1', port })
  eq('the cookie name matches upstream derivation', auth.cookieHeader()?.split('=')[0], cookieNameFor(`127.0.0.1:${String(port)}`))
  check('the cookie is persisted', typeof persisted === 'string' && persisted.includes('dsh-auth-'))
  check('the auth reports itself ready', auth.isReady())

  // 04. Connect now succeeds and learns the host identity from the ready frame.
  await client.connect()
  const conn = client.getState()
  check('connect succeeds with a session', conn.kind === 'connected', conn.kind)
  eq('home comes from the $events ready frame', conn.kind === 'connected' ? conn.info.home : '', '/home/tester')

  // 05. Unary RPCs speak the new endpoint/payload contract.
  const sessions = await client.listSessions()
  eq('session/list returns the host list', sessions.items.length, 1)
  const workspaces = await client.listWorkspaces()
  eq('workspace/follow yields the baseline items', workspaces.items[0]?.workspaceId, 'ws-1')
  await client.prompt('session-1', 'hello', 'UTC')
  await client.cancel('session-1')

  // 06. History arrives from the follow snapshot.
  const history = await client.getHistory('session-1', { maxMessages: 50 })
  eq('getHistory returns the snapshot records', history.events[0]?.event.type, 'user/message')
  eq('getHistory reports hasMore', history.hasMore, false)

  // 07. The approval waterfall is delivered and answerable.
  const approvals: { frame: MuxFrame; eventId: string }[] = []
  client.onApprovalFrame((frame, eventId) => approvals.push({ frame, eventId }))
  client.subscribe('session-1', () => {})
  // Ask again so the waterfall is delivered while our listener is attached.
  await new Promise((r) => setTimeout(r, 200))
  const portal = muxStreams.values()
  for (const s of portal) sendText(s.socket, { type: 'item', streamId: [...muxStreams.keys()].find(k => muxStreams.get(k) === s) ?? '', value: { type: 'waterfall', event: 'approval/request', eventId: 'evt-2', agentId: 'session-1', request: { toolName: 'write', callId: 'call-2', reason: 'outside workspace' } } })
  await new Promise((r) => setTimeout(r, 120))
  const approval = approvals.find(a => a.eventId === 'evt-2')
  check('the waterfall reaches the approval listener', approval !== undefined)
  check('the approval frame carries the session id', approval?.frame.type === 'approval/requested' && approval.frame.sessionId === 'session-1')
  await client.respondApproval('evt-2', 'allowed-once')
  await new Promise((r) => setTimeout(r, 60))
  eq('$events/result carries the clientId/eventId/outcome', seen.results.at(-1), {
    clientId: 'client-1',
    eventId: 'evt-2',
    outcome: { kind: 'result', value: 'allowed-once' },
  })

  // 08. session/follow folds into the legacy frame shapes the UI consumes.
  const frames: MuxFrame[] = []
  client.subscribe('session-1', (batch) => { frames.push(...batch) })
  await new Promise((r) => setTimeout(r, 250))
  check('subscribe replays the snapshot as session/event frames',
    frames.some(f => f.type === 'session/event' && (f as { event?: { type?: string } }).event?.type === 'user/message'))
  check('subscribe marks the subscription', frames.some(f => f.type === 'session/subscribed'))
  check('durable events arrive', frames.some(f => f.type === 'session/event' && (f as { event?: { type?: string } }).event?.type === 'turn/end'))
  const chunks = frames.filter(f => f.type === 'assistant/stream') as { turn?: number; chunk?: { type?: string; text?: string } }[]
  check('assistant deltas arrive out of band', chunks.length === 2, `${String(chunks.length)} chunk frame(s)`)
  eq('assistant deltas keep their turn/step', [chunks[0]?.turn, chunks[0]?.chunk?.text], [1, 'po'])

  // 09. The deleted endpoint produces guidance rather than a bare 401.
  let gone = ''
  try { await (client as unknown as { rpc: (e: string, a: Record<string, unknown>) => Promise<unknown> }).rpc('host.describe', {}) }
  catch (e) { gone = (e as Error).message }
  check('a deleted endpoint reports 404 with guidance', /404/.test(gone) && /0\.1\.6-alpha/.test(gone), gone.slice(0, 80))

  // 35. The cookie outlives the `dsh web` process. Only the launch *token* is
  //     per-process; the cookie is signed by a secret persisted in
  //     $DSH_HOME/.credentials.yaml, so a fresh auth object (as after a restart)
  //     restoring the same stored cookie must still connect without a new token.
  const restartedAuth = new BrowserSessionAuth({
    host: '127.0.0.1',
    port,
    store: { load: async () => persisted, save: async (v) => { persisted = v } },
    log: () => {},
  })
  await restartedAuth.init()
  check('the cookie survives a restart without a new token', restartedAuth.isReady())
  const restartedClient = new HarnessClient({ host: '127.0.0.1', port, auth: restartedAuth, log: () => {} })
  await restartedClient.connect()
  check('reconnect after a restart succeeds', restartedClient.getState().kind === 'connected')
  restartedClient.dispose()

  // 36. A cookie that is well-formed, unexpired and authority-correct but fails
  //     the host's signature check means the signing secret rotated. Reporting
  //     "expired" here would send the user after the wrong fix.
  const authority = `127.0.0.1:${String(port)}`
  const staleBody = Buffer.from(JSON.stringify({
    version: 1,
    authority,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  }), 'utf8').toString('base64url')
  const rotatedCookie = `v1.${staleBody}.${createHmac('sha256', randomBytes(32)).update(staleBody).digest().toString('base64url')}`
  let rotatedStore: string | undefined = JSON.stringify({
    authority,
    name: cookieNameFor(authority),
    value: rotatedCookie,
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
  })
  const rotatedAuth = new BrowserSessionAuth({
    host: '127.0.0.1',
    port,
    store: { load: async () => rotatedStore, save: async (v) => { rotatedStore = v } },
    log: () => {},
  })
  await rotatedAuth.init()
  check('a rotated-secret cookie still looks usable to the client', rotatedAuth.isReady())
  const rotatedClient = new HarnessClient({ host: '127.0.0.1', port, auth: rotatedAuth, log: () => {} })
  let rotatedMsg = ''
  try { await rotatedClient.connect() } catch (e) { rotatedMsg = (e as Error).message }
  check(
    'a rejected cookie is blamed on the signing secret, not expiry',
    /signing secret/.test(rotatedMsg) && !/expired/.test(rotatedMsg),
    rotatedMsg.slice(0, 150),
  )
  rotatedClient.dispose()

  client.dispose()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })

  console.log(`\n${failures === 0 ? 'all checks passed' : `${String(failures)} CHECK(S) FAILED`} (${String(step)} total)\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('\nPROTOCOL TEST ERROR:', e)
  process.exit(1)
})
