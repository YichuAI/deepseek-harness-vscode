/**
 * events.ts — the Remote event downlink layer.
 *
 * `dsh web` exposes ONE multiplexed WebSocket that carries every logical
 * stream:
 *
 *   ws://host:port/api/remote.mux
 *
 * The client opens it, then sends one `open` frame to subscribe to a logical
 * stream by endpoint name:
 *
 *   { type:'open', streamId:'<id>', endpoint:'<name>', payload:{ args:{…} } }
 *
 * The Host pushes frames of the shape `{ type:'item'|'end'|'error', streamId, value }`.
 * Client messages are otherwise a protocol violation — the Host answers any
 * further traffic with close code 1008 `downlink only`.
 *
 * Two endpoints matter to this plugin, and they carry DIFFERENT vocabularies:
 *
 *  1. `$events` — the forwarded-Host-event stream. Its FIRST item's value is
 *     `{ type:'ready', clientId, host:{ home } }` (the only host-identity frame,
 *     and the correlation id later approval answers need). Every later item is
 *     one forwarded event: `{ type:'emit', event, args }` or a waterfall
 *     `{ type:'waterfall', event, eventId, agentId, request }`. The forwarded
 *     set is a fixed allowlist (`alpha-session/*`, `approval/request`,
 *     `user-questions/request`, plugin-inventory events, …):
 *     it does NOT carry conversation traffic.
 *
 *  2. `session/follow` — one session's conversation. Opening it with
 *     `{ request: { address:{ kind:'session', sessionId }, assistantStream:true } }`
 *     yields an opening `{ type:'snapshot', … }`, then durable
 *     `{ type:'event', event }` records, then live
 *     `{ type:'assistant-stream', frame }` deltas (start / chunk / end).
 *     Chunks are process-local, so they never appear in the durable log.
 *
 * History: this file used to model a single `$events` stream carrying MuxFrames
 * (`session/event`, `approval/requested`, …). That was the pre-0.2 shape. On
 * 0.2.1-alpha.2 the conversation moved to `session/follow`, which is why the
 * sidebar connected but never received a reply.
 */

import { randomUUID } from 'node:crypto'
import type { Disposable } from '../disposable.ts'
import { openWebSocket, WebSocketUpgradeError, type WebSocketHandle } from './ws.ts'
import type { ReadyFrame, RemoteStreamServerMessage } from './protocol.ts'

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

/** The endpoint name of the forwarded-Host-event stream. */
export const EVENTS_ENDPOINT = '$events'
/** The endpoint name of one session's conversation stream. */
export const SESSION_FOLLOW_ENDPOINT = 'session/follow'

export interface DownlinkSocketOptions<Frame> {
  /** Build the ws:// URL for this socket. Called on every (re)connect. */
  url: () => string
  /** Handshake headers (the browser-session cookie). Called per attempt. */
  headers: () => Record<string, string>
  /** Logical stream this socket subscribes to on open (e.g. `session/follow`). */
  endpoint: string
  /** Inner `args` of the `open` frame. Called per attempt (it may name a session). */
  openArgs: () => Record<string, unknown>
  /** Distinguishes concurrent connections' stream ids in logs/traces. */
  streamIdPrefix?: string
  /**
   * Whether to wait for a `ready` item before treating frames as traffic.
   * Only the `$events` stream publishes one; a follow stream starts straight
   * into its `snapshot`.
   */
  expectReady?: boolean
  /** The `ready` frame (host identity) — delivered once, before any other frame. */
  onReady?: (ready: ReadyFrame) => void
  /** One decoded frame (the `value` of an `item`) from the Host. */
  onFrame: (frame: Frame) => void
  /** A transport-level `{ type:'error' }` frame for this stream. */
  onStreamError?: (error: unknown) => void
  onStatus: (status: MuxStatus) => void
  log: (msg: string) => void
}

/**
 * One multiplexed Remote-stream WebSocket carrying a single logical stream,
 * with automatic reconnect. Callers consume frames through `onReady`/`onFrame`
 * and never touch the socket.
 */
export class DownlinkSocket<Frame> implements Disposable {
  private ws: WebSocketHandle | undefined
  private disposed = false
  private backoff = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private status: MuxStatus = { kind: 'idle' }
  /** Stable id for the one logical stream this socket subscribes to. */
  private readonly streamId: string
  private readySeen = false

  constructor(private readonly opts: DownlinkSocketOptions<Frame>) {
    this.streamId = `${opts.streamIdPrefix ?? 'harness-connector-'}${randomUUID()}`
  }

  getStatus(): MuxStatus { return this.status }

  /** Open (or reopen) the socket. Idempotent while connecting/open. */
  open(): void {
    if (this.disposed) return
    if (this.ws !== undefined && this.ws.readyState !== 'closed') return
    this.setStatus({ kind: 'connecting' })
    this.readySeen = false
    const expected = this.opts.expectReady === true
    const ws = openWebSocket(this.opts.url(), this.opts.headers(), {
      onOpen: () => {
        this.backoff = 0
        this.setStatus({ kind: 'open' })
        this.opts.log(`downlink[${this.opts.endpoint}]: socket open; subscribing`)
        // Subscribe to our logical stream immediately. This is the ONLY frame
        // this socket may ever send: the Host closes any further client traffic
        // with 1008 `downlink only`.
        ws.send(JSON.stringify({
          type: 'open',
          streamId: this.streamId,
          endpoint: this.opts.endpoint,
          payload: { args: this.opts.openArgs() },
        }))
      },
      onText: (text) => { this.onMessage(text, expected) },
      onClose: (code, reason) => {
        if (this.disposed) return
        this.opts.log(`downlink[${this.opts.endpoint}]: closed (code=${String(code)} reason=${reason || '—'})`)
        this.setStatus({ kind: 'closed', reason: reason || `code ${String(code)}` })
        this.scheduleReconnect()
      },
      onError: (err) => {
        if (this.disposed) return
        this.opts.log(`downlink[${this.opts.endpoint}]: error — ${err.message}`)
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

  private onMessage(text: string, expected: boolean): void {
    let message: unknown
    try {
      message = JSON.parse(text) as unknown
    } catch {
      this.opts.log(`downlink[${this.opts.endpoint}]: dropped non-JSON frame`)
      return
    }
    if (typeof message !== 'object' || message === null) return
    const msg = message as Partial<RemoteStreamServerMessage> & { type?: unknown }
    if (msg.type === 'item' && (msg as { streamId?: unknown }).streamId === this.streamId) {
      const value = (msg as { value?: unknown }).value
      if (value === undefined || typeof value !== 'object') return
      const v = value as { type?: unknown }
      if (expected && !this.readySeen && v.type === 'ready') {
        this.readySeen = true
        const ready = value as ReadyFrame
        this.setStatus({ kind: 'ready' })
        try { this.opts.onReady?.(ready) } catch (e) {
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
      this.opts.log(`downlink[${this.opts.endpoint}]: stream error — ${JSON.stringify(err)?.slice(0, 200)}`)
      try { this.opts.onStreamError?.(err) } catch { /* listener errors must not break the socket */ }
      return
    }
    // 'end' or frames for other streams: ignore.
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const delay = BACKOFF_STEPS[Math.min(this.backoff, BACKOFF_STEPS.length - 1)]
    this.backoff += 1
    this.opts.log(`downlink[${this.opts.endpoint}]: reconnecting in ${String(delay)}ms (attempt ${String(this.backoff)})`)
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
