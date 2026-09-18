/**
 * ws.ts — a minimal RFC 6455 WebSocket client built on node:http.
 *
 * Why not the platform `WebSocket`?
 *   The harness mux socket now requires a browser-session `Cookie` header on the
 *   upgrade request (see auth.ts / DSH `browser-auth.ts`). Browsers — and the
 *   browser-shaped `WebSocket` global — cannot set arbitrary request headers, so
 *   we own the handshake instead of hoping the runtime exposes a `headers` init.
 *
 * Scope: text messages only (the mux carries JSON), plus ping/pong and the close
 * handshake. Frames are masked on send as the RFC requires for clients.
 *
 * Non-101 handshake responses (401/403 from the trust fence) surface as an
 * `http-status` error so the caller can distinguish "needs a cookie" from
 * "server is down".
 */

import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OPCODE_CONTINUATION = 0x0
const OPCODE_TEXT = 0x1
const OPCODE_BINARY = 0x2
const OPCODE_CLOSE = 0x8
const OPCODE_PING = 0x9
const OPCODE_PONG = 0xa

/** Thrown when the upgrade is answered with a non-101 HTTP status. */
export class WebSocketUpgradeError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`websocket upgrade refused with HTTP ${String(status)}: ${body.trim() || '(no body)'}`)
    this.name = 'WebSocketUpgradeError'
  }
}

export interface WebSocketCallbacks {
  onOpen: () => void
  onText: (text: string) => void
  onClose: (code: number, reason: string) => void
  onError: (err: Error) => void
}

export interface WebSocketHandle {
  send(text: string): void
  close(code?: number, reason?: string): void
  /** Hard teardown without a close handshake (used on dispose). */
  destroy(): void
  readonly readyState: 'connecting' | 'open' | 'closed'
}

/**
 * Open a WebSocket to `url` (ws://host:port/path) with extra handshake headers.
 * Returns immediately; outcome is reported through `callbacks`.
 */
export function openWebSocket(
  url: string,
  headers: Record<string, string>,
  callbacks: WebSocketCallbacks,
): WebSocketHandle {
  const parsed = new URL(url)
  const key = randomBytes(16).toString('base64')
  const expectedAccept = createHash('sha1').update(key + WS_GUID).digest('base64')

  let state: 'connecting' | 'open' | 'closed' = 'connecting'
  let socket: Duplex | undefined
  let settled = false

  const fail = (err: Error): void => {
    if (state === 'closed') return
    state = 'closed'
    if (settled) return
    settled = true
    callbacks.onError(err)
  }

  const req = http.request({
    hostname: parsed.hostname.startsWith('[') ? parsed.hostname.slice(1, -1) : parsed.hostname,
    port: parsed.port === '' ? 80 : Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
    method: 'GET',
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': key,
      ...headers,
    },
  })

  req.on('upgrade', (res, sock, head) => {
    if (res.headers['sec-websocket-accept'] !== expectedAccept) {
      sock.destroy()
      fail(new Error('websocket handshake failed: bad Sec-WebSocket-Accept'))
      return
    }
    socket = sock
    state = 'open'
    settled = true
    sock.setNoDelay(true)
    const reader = new FrameReader(
      (text) => { callbacks.onText(text) },
      () => {
        // Peer-initiated close: echo it and finish.
        try { sock.write(buildFrame(OPCODE_CLOSE, Buffer.alloc(0), true)) } catch { /* peer gone */ }
        sock.destroy()
        if (state !== 'closed') { state = 'closed'; callbacks.onClose(1000, 'peer closed') }
      },
      (payload) => { try { sock.write(buildFrame(OPCODE_PONG, payload, true)) } catch { /* peer gone */ } },
      (err) => { sock.destroy(); fail(err) },
    )
    if (head.length > 0) reader.push(head)
    sock.on('data', (chunk: Buffer) => { reader.push(chunk) })
    sock.on('error', (err) => { fail(err) })
    sock.on('close', () => {
      if (state !== 'closed') { state = 'closed'; callbacks.onClose(1006, 'connection closed') }
    })
    callbacks.onOpen()
  })

  // A rejected upgrade arrives as an ordinary response, never as `upgrade`.
  req.on('response', (res) => {
    const chunks: Uint8Array[] = []
    res.on('data', (c: Buffer) => { chunks.push(c) })
    res.on('end', () => {
      fail(new WebSocketUpgradeError(
        res.statusCode ?? 0,
        Buffer.concat(chunks).toString('utf8'),
      ))
    })
  })
  req.on('error', (err) => { fail(err instanceof Error ? err : new Error(String(err))) })
  req.end()

  return {
    get readyState() { return state },
    send(text: string): void {
      if (state !== 'open' || socket === undefined) return
      try { socket.write(buildFrame(OPCODE_TEXT, Buffer.from(text, 'utf8'), true)) } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    },
    close(code = 1000, reason = ''): void {
      if (state === 'closed') return
      if (socket === undefined) { state = 'closed'; try { req.destroy() } catch { /* noop */ } return }
      state = 'closed'
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason, 'utf8'))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2, 'utf8')
      try { socket.write(buildFrame(OPCODE_CLOSE, payload, true)) } catch { /* peer gone */ }
      socket.end()
      setTimeout(() => { try { socket?.destroy() } catch { /* noop */ } }, 500)
      callbacks.onClose(code, reason)
    },
    destroy(): void {
      state = 'closed'
      try { req.destroy() } catch { /* noop */ }
      try { socket?.destroy() } catch { /* noop */ }
    },
  }
}

/** Build one client frame. Clients MUST mask; `mask` is explicit for clarity. */
function buildFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const header: number[] = [0x80 | opcode]
  const length = payload.length
  if (length < 126) {
    header.push((mask ? 0x80 : 0) | length)
  } else if (length < 0x10000) {
    header.push((mask ? 0x80 : 0) | 126, (length >> 8) & 0xff, length & 0xff)
  } else {
    header.push((mask ? 0x80 : 0) | 127, 0, 0, 0, 0,
      (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff)
  }
  if (!mask) return Buffer.concat([Buffer.from(header), payload])
  const key = randomBytes(4)
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) masked[i] = (payload[i] as number) ^ (key[i % 4] as number)
  return Buffer.concat([Buffer.from(header), key, masked])
}

/** Incremental frame parser: reassembles fragmented text messages. */
class FrameReader {
  private buffer = Buffer.alloc(0)
  private fragments: Buffer[] = []
  private fragmented = false

  constructor(
    private readonly onMessage: (text: string) => void,
    private readonly onClose: () => void,
    private readonly onPing: (payload: Buffer) => void,
    private readonly onError: (err: Error) => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    try {
      while (this.readFrame()) { /* keep draining */ }
    } catch (e) {
      this.onError(e instanceof Error ? e : new Error(String(e)))
    }
  }

  private readFrame(): boolean {
    const buf = this.buffer
    if (buf.length < 2) return false
    const b0 = buf[0] as number
    const b1 = buf[1] as number
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let length = b1 & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < offset + 2) return false
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return false
      const high = buf.readUInt32BE(offset)
      const low = buf.readUInt32BE(offset + 4)
      if (high !== 0) throw new Error('websocket frame exceeds 4 GiB')
      length = low
      offset += 8
    }
    let maskKey: Buffer | undefined
    if (masked) {
      if (buf.length < offset + 4) return false
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + length) return false
    let payload = Buffer.from(buf.subarray(offset, offset + length))
    if (maskKey !== undefined) {
      const key = maskKey
      for (let i = 0; i < payload.length; i++) {
        payload[i] = (payload[i] as number) ^ (key[i % 4] as number)
      }
    }
    this.buffer = buf.subarray(offset + length)

    switch (opcode) {
      case OPCODE_TEXT:
      case OPCODE_BINARY:
        if (fin) {
          if (opcode === OPCODE_TEXT) this.onMessage(payload.toString('utf8'))
        } else {
          this.fragmented = true
          this.fragments = [payload]
        }
        break
      case OPCODE_CONTINUATION:
        this.fragments.push(payload)
        if (fin) {
          this.fragmented = false
          this.onMessage(Buffer.concat(this.fragments).toString('utf8'))
          this.fragments = []
        }
        break
      case OPCODE_PING:
        this.onPing(payload)
        break
      case OPCODE_PONG:
        break
      case OPCODE_CLOSE:
        this.onClose()
        break
      default:
        break
    }
    return this.buffer.length > 0
  }
}
