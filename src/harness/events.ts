/**
 * events.ts — the Remote downlink event layer.
 *
 * rc.6 `dsh web` exposes two **downlink-only** WebSockets:
 *
 *   ws://host:port/api/events.mux    → `MuxFrame` stream (per-session events)
 *   ws://host:port/api/events.host   → `HostFrame` stream (host-wide events)
 *
 * The browser opens each socket and the Host pushes `server-request` envelopes;
 * the frame is `envelope.payload`. There is NO `ready` frame and the client
 * never sends anything on the socket — connection-open IS the ready signal.
 *
 * This is a deliberate break from the pre-rc.6 "logical-stream mux" mental
 * model (`{type:'open', streamId, …}` / `{type:'item', streamId, …}`): that
 * protocol does not exist in the runtime we target, and implementing it is what
 * made every connect time out waiting for a `ready` frame that never arrives.
 */

import type { Disposable } from '../disposable.ts'
import { openWebSocket, WebSocketUpgradeError, type WebSocketHandle } from './ws.ts'
import type { HostFrame, MuxFrame } from './protocol.ts'

export type MuxStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'closed'; reason: string }
  /** `status` is present when the WebSocket *upgrade* was answered with that HTTP code. */
  | { kind: 'error'; message: string; status?: number }

/** Reconnect backoff: 250ms, 500ms, 1s, 2s, 5s (capped). */
const BACKOFF_STEPS = [250, 500, 1000, 2000, 5000] as const

export interface DownlinkSocketOptions<Frame> {
  /** Build the ws:// URL for this socket. Called on every (re)connect. */
  url: () => string
  /** Handshake headers (the browser-session cookie). Called per attempt. */
  headers: () => Record<string, string>
  /** One decoded frame from the Host. */
  onFrame: (frame: Frame) => void
  onStatus: (status: MuxStatus) => void
  log: (msg: string) => void
}

/**
 * One downlink-only WebSocket carrying a stream of Host-pushed frames, with
 * automatic reconnect. Callers consume frames through `onFrame` and never touch
 * the socket — there is no request/response on this transport.
 */
export class DownlinkSocket<Frame> implements Disposable {
  private ws: WebSocketHandle | undefined
  private disposed = false
  private backoff = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private status: MuxStatus = { kind: 'idle' }

  constructor(private readonly opts: DownlinkSocketOptions<Frame>) {}

  getStatus(): MuxStatus { return this.status }

  /** Open (or reopen) the socket. Idempotent while connecting/open. */
  open(): void {
    if (this.disposed) return
    if (this.ws !== undefined && this.ws.readyState !== 'closed') return
    this.setStatus({ kind: 'connecting' })
    const ws = openWebSocket(this.opts.url(), this.opts.headers(), {
      onOpen: () => {
        this.backoff = 0
        this.setStatus({ kind: 'open' })
        this.opts.log('downlink: open')
      },
      onText: (text) => { this.onMessage(text) },
      onClose: (code, reason) => {
        if (this.disposed) return
        this.opts.log(`downlink: closed (code=${String(code)} reason=${reason || '—'})`)
        this.setStatus({ kind: 'closed', reason: reason || `code ${String(code)}` })
        this.scheduleReconnect()
      },
      onError: (err) => {
        if (this.disposed) return
        this.opts.log(`downlink: error — ${err.message}`)
        this.setStatus({
          kind: 'error',
          message: err instanceof WebSocketUpgradeError && err.status === 401
            ? 'unauthorized: the harness requires a browser session cookie'
            : err.message,
          ...(err instanceof WebSocketUpgradeError ? { status: err.status } : {}),
        })
        try { this.ws?.destroy() } catch { /* noop */ }
        this.ws = undefined
        this.scheduleReconnect()
      },
    })
    this.ws = ws
  }

  /** Stop the socket permanently (used on disconnect/dispose). */
  close(): void {
    this.disposed = true
    if (this.reconnectTimer !== undefined) { clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined }
    try { this.ws?.close() } catch { /* noop */ }
    this.ws = undefined
    this.setStatus({ kind: 'closed', reason: 'closed' })
  }

  dispose(): void { this.close() }

  private onMessage(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text) as unknown
    } catch {
      this.opts.log('downlink: dropped non-JSON frame')
      return
    }
    if (typeof message !== 'object' || message === null) return
    const envelope = message as { type?: unknown; payload?: unknown }
    // rc.6 pushes `server-request` envelopes; the frame is `payload`.
    if (envelope.type !== 'server-request') return
    if (typeof envelope.payload !== 'object' || envelope.payload === null) return
    try {
      this.opts.onFrame(envelope.payload as Frame)
    } catch (e) {
      this.opts.log(`downlink: frame handler error — ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const delay = BACKOFF_STEPS[Math.min(this.backoff, BACKOFF_STEPS.length - 1)]
    this.backoff += 1
    this.opts.log(`downlink: reconnecting in ${String(delay)}ms (attempt ${String(this.backoff)})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, delay)
  }

  private setStatus(s: MuxStatus): void {
    this.status = s
    try { this.opts.onStatus(s) } catch { /* listener errors must not break the socket */ }
  }
}

/** Convenience aliases for the two downlink streams. */
export type MuxSocket = DownlinkSocket<MuxFrame>
export type HostSocket = DownlinkSocket<HostFrame>

/**
 * The ws:// URL for one event socket on a loopback target.
 *
 * `path` comes from the negotiated WireProfile: it is `/api/events.mux` (or
 * `/api/events.host`) for the rc.6 runtime we target.
 */
export function muxUrl(host: string, port: number, path: string): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `ws://${literal}:${String(port)}${path}`
}

/**
 * EventBuffer — coalesces high-frequency assistant chunks into periodic flushes
 * so the webview does not render once per token. Default flush: 30ms.
 */
export class EventBuffer implements Disposable {
  private pending: unknown[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(
    private readonly onFlush: (events: unknown[]) => void,
    private readonly flushMs = 30,
  ) {}

  push(event: unknown): void {
    if (this.disposed) return
    this.pending.push(event)
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.drain(), this.flushMs)
    }
  }

  /** Drain immediately (e.g. on turn/end so the final state renders at once). */
  flushNow(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.drain()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.drain()
  }

  private drain(): void {
    this.timer = undefined
    if (this.pending.length === 0) return
    const batch = this.pending
    this.pending = []
    try { this.onFlush(batch) } catch { /* a flush failure must not kill the buffer */ }
  }
}
