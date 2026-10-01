/**
 * events.ts — the Remote event downlink layer (0.2.0-rc.2 Typert Remote Stream).
 *
 * `dsh web` 0.2.0-rc.2 exposes ONE multiplexed WebSocket:
 *
 *   ws://host:port/api/remote.mux
 *
 * The client opens it, then sends a single `open` frame to subscribe to the
 * `$events` logical stream:
 *
 *   { type:'open', streamId:'<id>', endpoint:'$events', payload:{args:{}} }
 *
 * The Host pushes frames of the shape `{ type:'item'|'end'|'error', streamId, value }`.
 * For the `$events` stream, `value` is a MuxFrame — except the FIRST item, whose
 * `value` is the `ready` frame `{ type:'ready', clientId, host:{ home } }`. That
 * `ready` frame is the only host-identity message; there is no `host.describe`.
 *
 * This is a deliberate break from the pre-0.2 "downlink-only server-request
 * envelope" mental model that the rc.6 rewrite implemented and that made the
 * connect hang waiting for a `ready` frame that never arrived.
 */

import { randomUUID } from 'node:crypto'
import type { Disposable } from '../disposable.ts'
import { openWebSocket, WebSocketUpgradeError, type WebSocketHandle } from './ws.ts'
import type { MuxFrame, ReadyFrame, RemoteStreamServerMessage } from './protocol.ts'

export type MuxStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'ready' }
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
  /** The `ready` frame (host identity) — delivered once, before any MuxFrame. */
  onReady: (ready: ReadyFrame) => void
  /** One decoded MuxFrame (everything after `ready`) from the Host. */
  onFrame: (frame: Frame) => void
  onStatus: (status: MuxStatus) => void
  log: (msg: string) => void
}

/**
 * One multiplexed Remote-stream WebSocket carrying the `$events` logical stream,
 * with automatic reconnect. Callers consume frames through `onReady`/`onFrame`
 * and never touch the socket.
 */
export class DownlinkSocket<Frame> implements Disposable {
  private ws: WebSocketHandle | undefined
  private disposed = false
  private backoff = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private status: MuxStatus = { kind: 'idle' }
  /** Stable id for the single `$events` stream we open on this socket. */
  private readonly streamId = `harness-connector-${randomUUID()}`
  private readySeen = false

  constructor(private readonly opts: DownlinkSocketOptions<Frame>) {}

  getStatus(): MuxStatus { return this.status }

  /** Open (or reopen) the socket. Idempotent while connecting/open. */
  open(): void {
    if (this.disposed) return
    if (this.ws !== undefined && this.ws.readyState !== 'closed') return
    this.setStatus({ kind: 'connecting' })
    this.readySeen = false
    const ws = openWebSocket(this.opts.url(), this.opts.headers(), {
      onOpen: () => {
        this.backoff = 0
        this.setStatus({ kind: 'open' })
        this.opts.log('downlink: socket open; subscribing to $events')
        // Subscribe to the $events stream immediately.
        ws.send(JSON.stringify({
          type: 'open',
          streamId: this.streamId,
          endpoint: '$events',
          payload: { args: {} },
        }))
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
    const msg = message as Partial<RemoteStreamServerMessage> & { type?: unknown }
    if (msg.type === 'item' && (msg as { streamId?: unknown }).streamId === this.streamId) {
      const value = (msg as { value?: unknown }).value
      if (value === undefined || typeof value !== 'object') return
      const v = value as { type?: unknown }
      if (!this.readySeen && v.type === 'ready') {
        this.readySeen = true
        const ready = value as ReadyFrame
        this.setStatus({ kind: 'ready' })
        try { this.opts.onReady(ready) } catch (e) {
          this.opts.log(`downlink: ready handler error — ${e instanceof Error ? e.message : String(e)}`)
        }
        return
      }
      try {
        this.opts.onFrame(value as Frame)
      } catch (e) {
        this.opts.log(`downlink: frame handler error — ${e instanceof Error ? e.message : String(e)}`)
      }
      return
    }
    if (msg.type === 'error' && (msg as { streamId?: unknown }).streamId === this.streamId) {
      const err = (msg as { error?: unknown }).error
      this.opts.log(`downlink: stream error — ${JSON.stringify(err)?.slice(0, 200)}`)
      return
    }
    // 'end' or frames for other streams: ignore.
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

/** Convenience alias for the $events stream frame type. */
export type MuxSocket = DownlinkSocket<MuxFrame>
export type HostSocket = DownlinkSocket<MuxFrame>

/**
 * The ws:// URL for the Remote event socket on a loopback target.
 *
 * `path` comes from the negotiated WireProfile: it is `/api/remote.mux` for the
 * 0.2.0-rc.2 runtime we target.
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
