/**
 * events.ts / remote.ts — the Remote stream layer.
 *
 * 0.1.6-alpha replaced the downlink-only `events.mux` socket with a
 * *bidirectional logical-stream mux* at `/api/remote.mux`:
 *
 *   upgrade:  GET /api/remote.mux   (WebSocket; a browser-session cookie is required)
 *   client →  { type:'open', streamId, endpoint, payload: { args: {…} } }
 *             { type:'cancel', streamId }
 *   host   →  { type:'item',  streamId, value }
 *             { type:'error', streamId, error: { code, message, details } }
 *             { type:'end',   streamId }
 *
 * Two logical streams matter to this plugin:
 *   • `$events`        — forwarded Host events, incl. the approval waterfall
 *   • `session/follow` — one Session's durable journal + assistant stream
 *
 * On reconnect every live stream is reopened. The plugin treats reconnect as
 * "rebuild": `onReopen` lets the caller refetch state rather than replay a
 * cursor we no longer hold.
 */

import type { Disposable } from '../disposable.ts'
import { openWebSocket, WebSocketUpgradeError, type WebSocketHandle } from './ws.ts'
import type { RemoteStreamFailure } from './protocol.ts'
import { REMOTE_STREAM_MUX_PATH } from './protocol.ts'

export type MuxStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'open' }
  | { kind: 'closed'; reason: string }
  /** `status` is present when the WebSocket *upgrade* was answered with that HTTP code. */
  | { kind: 'error'; message: string; status?: number }

/** Reconnect backoff: 250ms, 500ms, 1s, 2s, 5s (capped). */
const BACKOFF_STEPS = [250, 500, 1000, 2000, 5000] as const

export interface StreamHandlers {
  /** One `item` frame from the Host. */
  onItem: (value: unknown) => void
  /** The Host ended the stream normally. */
  onEnd?: () => void
  /** The Host reported a business/carrier failure for this stream. */
  onError?: (error: RemoteStreamFailure) => void
  /** The socket was re-established after a drop; the stream was reopened. */
  onReopen?: () => void
}

export interface StreamHandle {
  readonly id: string
  readonly endpoint: string
  cancel(): void
}

interface LiveStream {
  id: string
  endpoint: string
  args: Record<string, unknown>
  handlers: StreamHandlers
  /** Set once after the first successful reopen (not on the initial open). */
  opened: boolean
}

export interface RemoteStreamMuxOptions {
  /**
   * Build the ws:// URL for the mux. Called on every (re)connect so a config or
   * authority change is picked up.
   */
  url: () => string
  /** Handshake headers (the browser-session cookie). Called per attempt. */
  headers: () => Record<string, string>
  onStatus: (status: MuxStatus) => void
  log: (msg: string) => void
}

/**
 * One WebSocket carrying every logical stream, with automatic reconnect.
 * Callers never touch the socket — they open logical streams through `request`.
 */
export class RemoteStreamMux implements Disposable {
  private ws: WebSocketHandle | undefined
  private readonly streams = new Map<string, LiveStream>()
  private counter = 0
  private backoff = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false
  private status: MuxStatus = { kind: 'idle' }

  constructor(private readonly opts: RemoteStreamMuxOptions) {}

  getStatus(): MuxStatus { return this.status }

  /** Open (or reopen) the socket. Idempotent while connecting/open. */
  open(): void {
    if (this.disposed) return
    if (this.ws !== undefined && this.ws.readyState !== 'closed') return
    this.setStatus({ kind: 'connecting' })
    const url = this.opts.url()
    const ws = openWebSocket(url, this.opts.headers(), {
      onOpen: () => {
        this.backoff = 0
        this.setStatus({ kind: 'open' })
        this.opts.log(`mux: open (${String(this.streams.size)} logical stream(s))`)
        for (const stream of this.streams.values()) {
          const reopened = stream.opened
          stream.opened = true
          this.sendOpen(stream)
          if (reopened) {
            try { stream.handlers.onReopen?.() } catch { /* handler errors must not break the mux */ }
          }
        }
      },
      onText: (text) => { this.onMessage(text) },
      onClose: (code, reason) => {
        if (this.disposed) return
        this.opts.log(`mux: closed (code=${String(code)} reason=${reason || '—'})`)
        this.setStatus({ kind: 'closed', reason: reason || `code ${String(code)}` })
        this.scheduleReconnect()
      },
      onError: (err) => {
        if (this.disposed) return
        this.opts.log(`mux: error — ${err.message}`)
        this.setStatus({
          kind: 'error',
          message: err instanceof WebSocketUpgradeError && err.status === 401
            ? 'unauthorized: the harness requires a browser session cookie'
            : err.message,
          ...(err instanceof WebSocketUpgradeError ? { status: err.status } : {}),
        })
        // A refused upgrade never fires 'close'; keep the socket from leaking.
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
    for (const stream of this.streams.values()) {
      try { this.sendCancel(stream.id) } catch { /* socket may already be gone */ }
    }
    this.streams.clear()
    try { this.ws?.close() } catch { /* noop */ }
    this.ws = undefined
    this.setStatus({ kind: 'closed', reason: 'closed' })
  }

  dispose(): void { this.close() }

  /**
   * Open one logical stream. It stays open (and is reopened on reconnect) until
   * the caller cancels it.
   *
   * @param endpoint - Remote endpoint, e.g. `session/follow` or `$events`.
   * @param args - the method's named arguments.
   */
  request(endpoint: string, args: Record<string, unknown>, handlers: StreamHandlers): StreamHandle {
    this.counter += 1
    const id = `s${String(this.counter)}-${Math.random().toString(36).slice(2, 10)}`
    const stream: LiveStream = { id, endpoint, args, handlers, opened: false }
    this.streams.set(id, stream)
    if (this.ws?.readyState === 'open') {
      stream.opened = true
      this.sendOpen(stream)
    } else {
      this.open()
    }
    return {
      id,
      endpoint,
      cancel: () => {
        if (!this.streams.delete(id)) return
        this.sendCancel(id)
      },
    }
  }

  /** Drop every stream for `endpoint` without closing the socket. */
  cancelEndpoint(endpoint: string): void {
    for (const [id, stream] of [...this.streams]) {
      if (stream.endpoint !== endpoint) continue
      this.streams.delete(id)
      this.sendCancel(id)
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────
  private onMessage(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text) as unknown
    } catch (e) {
      this.opts.log(`mux: dropped non-JSON frame (${e instanceof Error ? e.message : String(e)})`)
      return
    }
    if (typeof message !== 'object' || message === null) return
    const frame = message as { type?: unknown; streamId?: unknown; value?: unknown; error?: unknown }
    if (typeof frame.streamId !== 'string') return
    const stream = this.streams.get(frame.streamId)
    if (stream === undefined) return
    switch (frame.type) {
      case 'item':
        try { stream.handlers.onItem(frame.value) } catch { /* handler errors must not break the mux */ }
        break
      case 'end':
        this.streams.delete(frame.streamId)
        try { stream.handlers.onEnd?.() } catch { /* noop */ }
        break
      case 'error': {
        this.streams.delete(frame.streamId)
        const error = normaliseFailure(frame.error)
        try { stream.handlers.onError?.(error) } catch { /* noop */ }
        break
      }
      default:
        // Unknown frame types are ignored: the protocol is merge-extensible.
        break
    }
  }

  private sendOpen(stream: LiveStream): void {
    this.send({ type: 'open', streamId: stream.id, endpoint: stream.endpoint, payload: { args: stream.args } })
  }

  private sendCancel(streamId: string): void {
    this.send({ type: 'cancel', streamId })
  }

  private send(message: unknown): void {
    if (this.ws?.readyState !== 'open') return
    this.ws.send(JSON.stringify(message))
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer !== undefined) return
    const delay = BACKOFF_STEPS[Math.min(this.backoff, BACKOFF_STEPS.length - 1)]
    this.backoff += 1
    this.opts.log(`mux: reconnecting in ${String(delay)}ms (attempt ${String(this.backoff)})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.open()
    }, delay)
  }

  private setStatus(s: MuxStatus): void {
    this.status = s
    try { this.opts.onStatus(s) } catch { /* listener errors must not break the stream */ }
  }
}

/**
 * The ws:// URL for the mux on one loopback target.
 *
 * `path` comes from the negotiated WireProfile: the socket has shipped as both
 * `/api/events.mux` and `/api/remote.mux`.
 */
export function muxUrl(host: string, port: number, path: string = REMOTE_STREAM_MUX_PATH): string {
  const literal = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  return `ws://${literal}:${String(port)}${path}`
}

function normaliseFailure(value: unknown): RemoteStreamFailure {
  if (typeof value === 'object' && value !== null) {
    const v = value as Record<string, unknown>
    return {
      code: typeof v['code'] === 'string' ? v['code'] : 'gateway/internal',
      message: typeof v['message'] === 'string' ? v['message'] : String(value),
      details: typeof v['details'] === 'object' && v['details'] !== null ? v['details'] as object : {},
    }
  }
  return { code: 'gateway/internal', message: String(value), details: {} }
}

/**
 * EventBuffer — coalesces high-frequency assistant chunks into periodic flushes
 * so the webview does not render once per token (§14). Default flush: 30ms.
 *
 * Usage: call `push(event)` for every session event; the buffer invokes
 * `onFlush` at most every `flushMs` with the batched events. `flushNow()`
 * forces a drain (used on turn/end or dispose).
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
