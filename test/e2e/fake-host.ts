/**
 * A real HTTP + WebSocket harness host, for the end-to-end chains that need one.
 *
 * Why a socket server rather than a stubbed module
 * -------------------------------------------------
 * `scripts/protocol-test.ts` already drives the client against a fake harness,
 * but it does so *in process*, by patching the module loader and handing the
 * client a scripted object. That is the right tool for pinning the projection
 * model, and it is the wrong tool for the two chains written here: "does the
 * panel come up after a Host restart" and "does Allow actually let the call
 * through" are questions about **sockets, cookies and process lifetimes**, and a
 * stubbed transport answers them by agreeing with the implementation.
 *
 * So this is a genuine `http.Server` on a real loopback port, speaking the wire
 * as `src/harness/protocol.ts` documents it — including the WebSocket half, in
 * the same shape `src/harness/ws.ts` hand-rolls on the client side. Nothing is
 * simulated about the parts that broke before: the 401 fence, the launch-token
 * exchange, the mux upgrade, and the POST that settles a waterfall.
 *
 * Deliberately narrow. It serves exactly the routes the client probes during
 * connect plus the waterfall sink, and answers 404 for everything else, so a
 * chain cannot pass by accident on a route nobody implemented.
 */

import http from 'node:http'
import type { Duplex } from 'node:stream'
import { createHash, randomBytes } from 'node:crypto'
import { authorityOf, cookieNameForAuthority } from '../../src/harness/auth.ts'

/** The 401 body `src/harness/discovery.ts` treats as the harness fingerprint. */
export const FENCE_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export interface RecordedRequest {
  method: string
  path: string
  cookie: string | undefined
  body: string
}

/** One `POST /api/$events/result`, as the Host would have received it. */
export interface RecordedEventResult {
  clientId: unknown
  eventId: unknown
  outcome: unknown
  /** The envelope's own `type`, so a test can catch a wrong shape, not only a missing field. */
  envelopeType: unknown
  /** The envelope's `method` — `$events/result` or something else entirely. */
  method: unknown
  /** The whole parsed envelope. */
  envelope: Record<string, unknown>
}

/**
 * A waterfall frame's declared scope.
 *
 * A string is the session the frame belongs to. `null` omits `agentId`
 * altogether, which is what a frame that names no session looks like on the
 * wire — the shape a pre-0.2 Host sends, and the only way to exercise the
 * "decline rather than guess" rule without hand-writing a frame.
 */
export type WaterfallScope = string | null

export interface FakeHarnessHost {
  readonly host: string
  readonly port: number
  /** The line `dsh web` prints — token and all. */
  readonly launchUrl: string
  readonly requests: RecordedRequest[]
  readonly eventResults: RecordedEventResult[]
  /** Mux sockets accepted so far. A reconnect must open a new one. */
  readonly muxConnections: number
  /** Sockets currently open. */
  readonly liveMuxSockets: number
  /** Make `POST /api/$events/result` answer 500 — "the Host refused the answer". */
  failEventResults: boolean
  /**
   * Answer `POST /api/$events/result` with a **200** whose envelope says
   * `result.ok === false`.
   *
   * A refusal arrives in this shape too, and the two are easy to conflate with
   * "settled" if only the status line is read — which is what this knob is for.
   */
  declineEventResults: boolean
  /** Push an approval waterfall to every connected mux client. */
  emitApproval(eventId: string, request?: Record<string, unknown>, scope?: WaterfallScope): number
  /** Push a `user-questions/request` waterfall. */
  emitQuestion(eventId: string, request?: Record<string, unknown>, scope?: WaterfallScope): number
  /**
   * Tell clients the Host withdrew a waterfall.
   *
   * `cancel` is the only frame that announces this, and without it a card sits
   * pending forever — so a chain that never sends one is not testing the path
   * that clears it.
   */
  withdrawWaterfall(eventId: string): void
  /**
   * Stop accepting connections and destroy every live socket.
   *
   * This is "the Host was killed", and it is deliberately abrupt: a graceful
   * close would let the client's reconnect backoff look like recovery instead of
   * like the failure it is testing.
   */
  kill(): Promise<void>
}

interface MuxSocket {
  socket: Duplex
  streamId: string | undefined
}

/** Token the launch URL carries. Anything non-empty is accepted. */
function mintToken(): string {
  return randomBytes(32).toString('base64url')
}

export async function startFakeHarness(): Promise<FakeHarnessHost> {
  const token = mintToken()
  let clientId = `fake-client-${randomBytes(4).toString('hex')}`
  const requests: RecordedRequest[] = []
  const eventResults: RecordedEventResult[] = []
  const muxSockets: MuxSocket[] = []

  const fenceOn = true
  /**
   * Mutable knobs the HTTP handler reads.
   *
   * Kept separate from the object this function returns, so the handler never
   * closes over a `const` that is still being defined — and so a test flipping a
   * switch cannot be defeated by a stale copy of the object.
   */
  const state = { failEventResults: false, declineEventResults: false }

  const json = (res: http.ServerResponse, status: number, value: unknown): void => {
    const body = JSON.stringify(value)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) })
    res.end(body)
  }

  /** The port actually bound. Read per request: `listen(0)` decides it later. */
  const boundPort = (): number => {
    const addr = server.address()
    return typeof addr === 'object' && addr !== null ? addr.port : 0
  }

  /** A unary RPC answer, echoing the caller's rpcId as the envelope requires. */
  const rpcOk = (res: http.ServerResponse, rpcId: string, value: unknown): void => {
    json(res, 200, { type: 'server-response', rpcId, result: { ok: true, value } })
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const cookie = req.headers.cookie

    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ method: req.method ?? '', path: url.pathname, cookie, body })

      // ── the launch-token exchange ─────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('token')) {
        const presented = url.searchParams.get('token')
        if (presented !== token) {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end(FENCE_BODY)
          return
        }
        // The real Host answers 303 and sets a cookie derived from the authority
        // it was reached under — which is why auth.ts binds the stored session
        // to `authorityOf(host, port)` rather than to the token.
        const name = cookieNameForAuthority(authorityOf('127.0.0.1', boundPort()))
        res.writeHead(303, {
          location: '/',
          'set-cookie': `${name}=v1.${randomBytes(12).toString('base64url')}.sig; Path=/; Max-Age=2592000; HttpOnly`,
        })
        res.end()
        return
      }

      // ── the fence ─────────────────────────────────────────────────────────
      if (req.method === 'GET' && url.pathname === '/') {
        if (fenceOn && cookie === undefined) {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end(FENCE_BODY)
          return
        }
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><html><body>fake harness</body></html>')
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }

      // The fence covers the RPC routes too, which is what makes a session-less
      // connect fail as an *auth* problem instead of reaching the mux and dying
      // there. `negotiateWire` reads this 401 and reports `auth-required`.
      if (fenceOn && cookie === undefined) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end(FENCE_BODY)
        return
      }

      let envelope: { type?: unknown; rpcId?: unknown; method?: unknown; payload?: { args?: unknown } } | undefined
      try { envelope = JSON.parse(body) as typeof envelope } catch { /* answered as bad request below */ }
      if (envelope === undefined || typeof envelope.rpcId !== 'string') {
        json(res, 400, { type: 'server-response', rpcId: '', result: { ok: false, error: { code: 'bad-request', message: 'unparseable envelope', details: null } } })
        return
      }
      const rpcId = envelope.rpcId

      // ── the waterfall sink: the whole point of chain 4 ────────────────────
      if (url.pathname === '/api/$events/result') {
        const args = (envelope.payload?.args ?? {}) as Record<string, unknown>
        eventResults.push({
          clientId: args['clientId'],
          eventId: args['eventId'],
          outcome: args['outcome'],
          envelopeType: envelope.type,
          method: envelope.method,
          envelope: envelope as Record<string, unknown>,
        })
        if (state.failEventResults) {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('the Host refused the answer')
          return
        }
        if (state.declineEventResults) {
          json(res, 200, {
            type: 'server-response',
            rpcId,
            result: { ok: false, error: { code: 'approval/not-delivered', message: 'this client no longer holds a delivery for that waterfall', details: null } },
          })
          return
        }
        rpcOk(res, rpcId, { accepted: true })
        return
      }

      // ── connect-time probes ───────────────────────────────────────────────
      // `session/list` is what negotiateWire uses to confirm the endpoint style,
      // and it is the only method this host claims. Everything else 404s, which
      // is how a real Host reports a method it does not serve.
      if (url.pathname === '/api/session/list') {
        rpcOk(res, rpcId, { items: [] })
        return
      }

      json(res, 404, {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: 'gateway/method-unavailable', message: `no such method: ${url.pathname}`, details: null } },
      })
    })
  })

  // ─── the WebSocket half ────────────────────────────────────────────────────
  //
  // Hand-rolled for the same reason the client is: the mux upgrade carries a
  // Cookie header, and no browser-shaped server API lets a test set one. Only
  // text frames are handled — the protocol is JSON — plus the close handshake.
  server.on('upgrade', (req, socket: Duplex) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    // `/api/events.mux` is the older path and is answered too, so a chain can
    // assert the client discovered the *new* one rather than defaulting to it.
    if (url.pathname !== '/api/remote.mux' && url.pathname !== '/api/events.mux') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (fenceOn && req.headers.cookie === undefined) {
      const body = FENCE_BODY
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\ncontent-type: text/plain\r\ncontent-length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`,
      )
      socket.destroy()
      return
    }

    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'upgrade: websocket\r\n'
      + 'connection: Upgrade\r\n'
      + `sec-websocket-accept: ${accept}\r\n\r\n`,
    )

    const conn: MuxSocket = { socket, streamId: undefined }
    muxSockets.push(conn)

    socket.on('data', (chunk: Buffer) => {
      for (const frame of decodeClientFrames(chunk)) {
        if (frame.opcode === 0x8) { socket.end(); return }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(0xa, frame.payload)); continue }
        if (frame.opcode !== 0x1) continue
        let msg: { type?: unknown; streamId?: unknown } | undefined
        try { msg = JSON.parse(frame.payload.toString('utf8')) as typeof msg } catch { continue }
        if (msg?.type === 'open' && typeof msg.streamId === 'string') {
          conn.streamId = msg.streamId
          // The first item on `$events` is the host identity frame. Nothing else
          // in this protocol carries it, so a chain that never sees one is a
          // chain that never proved the socket was really subscribed.
          socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({
            type: 'item', streamId: conn.streamId, value: { type: 'ready', clientId, host: { home: '/fake/dsh-home' } },
          }), 'utf8')))
        }
      }
    })
    socket.on('error', () => { /* the test killed us, or the client did */ })
  })

  const host = await new Promise<FakeHarnessHost>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = boundPort()
      resolve({
        host: '127.0.0.1',
        port,
        launchUrl: `http://127.0.0.1:${String(port)}/?token=${token}`,
        requests,
        eventResults,
        get muxConnections() { return muxSockets.length },
        get liveMuxSockets() { return muxSockets.filter((m) => !m.socket.destroyed).length },
        get failEventResults() { return state.failEventResults },
        set failEventResults(v: boolean) { state.failEventResults = v },
        get declineEventResults() { return state.declineEventResults },
        set declineEventResults(v: boolean) { state.declineEventResults = v },
        emitApproval(eventId, request = { toolName: 'bash', reason: 'needs to run a command' }, scope) {
          return emitWaterfall('approval/request', eventId, request, scope)
        },
        emitQuestion(eventId, request = { questions: [{ id: 'q1', header: 'Q', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }] }, scope) {
          return emitWaterfall('user-questions/request', eventId, request, scope)
        },
        withdrawWaterfall(eventId) {
          for (const m of muxSockets) {
            if (m.streamId !== undefined && !m.socket.destroyed) {
              m.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({
                type: 'item', streamId: m.streamId, value: { type: 'cancel', eventId },
              }), 'utf8')))
            }
          }
        },
        async kill() {
          for (const m of muxSockets) { try { m.socket.destroy() } catch { /* already gone */ } }
          muxSockets.length = 0
          await new Promise<void>((done) => { server.close(() => { done() }) })
        },
      })
    })
  })

  /**
   * Push one forwarded waterfall to every connected mux client.
   *
   * `agentId` defaults to a fixed value so shapes stay comparable across runs,
   * and `null` omits it entirely — which is what a frame that names no session
   * looks like on the wire, and the only way to exercise the "decline rather
   * than guess" rule without hand-writing a frame.
   */
  function emitWaterfall(
    event: string,
    eventId: string,
    request: Record<string, unknown>,
    agentId: WaterfallScope = 'agent-1',
  ): number {
    const scope = agentId === null ? {} : { agentId }
    let sent = 0
    for (const m of muxSockets) {
      if (m.streamId === undefined || m.socket.destroyed) continue
      m.socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify({
        type: 'item',
        streamId: m.streamId,
        value: { type: 'waterfall', event, eventId, ...scope, request },
      }), 'utf8')))
      sent++
    }
    return sent
  }

  return host
}

// ─── RFC 6455, the parts a test needs ────────────────────────────────────────

interface DecodedFrame {
  opcode: number
  payload: Buffer
}

/**
 * Decode whatever complete frames are in `chunk`.
 *
 * A partial frame is dropped rather than buffered: the client sends one small
 * JSON message per frame and never fragments, so buffering would add state that
 * could only ever hide a bug. If that assumption ever breaks, a chain fails
 * loudly instead of half-working.
 */
function decodeClientFrames(chunk: Buffer): DecodedFrame[] {
  const out: DecodedFrame[] = []
  let off = 0
  while (off + 2 <= chunk.length) {
    const b1 = chunk[off]!
    const b2 = chunk[off + 1]!
    const opcode = b1 & 0x0f
    const masked = (b2 & 0x80) !== 0
    let len = b2 & 0x7f
    let cursor = off + 2
    if (len === 126) {
      if (cursor + 2 > chunk.length) break
      len = chunk.readUInt16BE(cursor)
      cursor += 2
    } else if (len === 127) {
      if (cursor + 8 > chunk.length) break
      len = Number(chunk.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask: Buffer | undefined
    if (masked) {
      if (cursor + 4 > chunk.length) break
      mask = chunk.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + len > chunk.length) break
    const payload = Buffer.from(chunk.subarray(cursor, cursor + len))
    if (mask !== undefined) {
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!
    }
    out.push({ opcode, payload })
    off = cursor + len
  }
  return out
}

/** Encode one unmasked server frame (the direction RFC 6455 leaves unmasked). */
function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10)
  head[0] = 0x80 | opcode
  if (payload.length < 126) {
    head[1] = payload.length
  } else if (payload.length < 65536) {
    head[1] = 126
    head.writeUInt16BE(payload.length, 2)
  } else {
    head[1] = 127
    head.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([head, payload])
}
