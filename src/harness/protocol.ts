/**
 * Wire protocol types — a faithful, dependency-free mirror of the DeepSeek
 * Harness Remote contract as implemented by the installed `dsh web` runtime
 * (observed against the bundled `@deepseek-ai/dsh-client-connection` 0.1.0-rc.6).
 *
 * This file is the single source of truth for everything that crosses the
 * network. Authoritative shapes (read from the installed runtime, not guessed):
 *
 *   packages/client/connection/src/client.js        envelope + `/api/<method>`
 *   packages/client/connection/src/client.js        `api.events.mux`  (downlink)
 *   packages/client/connection/src/client.js        `api.events.host` (downlink)
 *   packages/client/connection/src/client.js        `muxFrameSchema` / `hostFrameSchema`
 *
 * Three shape rules are load-bearing and were wrong in earlier plugin versions:
 *
 *   1. Endpoints are `namespace/method` rendered dot-style on the wire:
 *      `POST /api/session.list` (never `session/list`). The Host splits the
 *      path after `/api/` and the gateway resolves `namespace` + `method`.
 *   2. Request payloads are the *args object directly* — NOT wrapped in
 *      `{ args: … }`. `callUnary(method, payload)` posts
 *      `{ type:'client-request', rpcId, method, payload }` where `payload` is
 *      the declared-parameter object (e.g. `{ request: { sessionId } }`).
 *   3. The event socket is a **downlink-only WebSocket**. The browser opens
 *      `ws://host:port/api/events.mux` (or `/api/events.host`) and the Host
 *      pushes `server-request` envelopes; each frame is `envelope.payload`.
 *      There is NO `ready` frame and the client never sends anything on it —
 *      connection-open IS the ready signal.
 *
 * The harness protocol is merge-extensible: unknown event/frame types MUST be
 * ignored by callers, so every union here is treated as open.
 *
 * No runtime code lives here — types only (plus a few narrowing guards).
 */

// ─── brands (opaque string ids; structural, same as upstream) ─────────────────
export type RpcId = string
export type SessionId = string
export type WorkspaceId = string
export type CallId = string
export type MessageId = string

// ─── RPC envelope (the four-quadrant message model) ──────────────────────────
export interface ClientRequest<P = unknown> {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: P
}

export interface ServerResponse<V = unknown> {
  type: 'server-response'
  rpcId: RpcId
  result: { ok: true; value: V } | { ok: false; error: RpcError }
}

/** Server-initiated message — delivered on the downlink event WebSockets. */
export interface ServerRequest<P = unknown> {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: P
}

/** Client answer to a ServerRequest (used by `POST /api/respond`). */
export interface ClientResponse<V = unknown> {
  type: 'client-response'
  rpcId: RpcId
  result: V
}

export interface RpcError {
  code: string
  message: string
  details: unknown
}

// ─── harness identity ────────────────────────────────────────────────────────
/**
 * What the plugin knows about the host. rc.6 serves `host.describe` (called once
 * at connect) which returns version/cwd/provider/model. The event stream has no
 * `ready` frame — connection-open is the ready signal.
 */
export interface HarnessInfo {
  /** Host account home, used only to abbreviate displayed paths. */
  home: string
  /** Opaque id of this client event generation (from `host.describe`, if any). */
  clientId?: string
  version?: string
  provider?: string
  model?: string
}

// ─── event socket routes (from the runtime's `api-path.js`) ───────────────────
/** Browser mux-frame WebSocket pathname (downlink-only). */
export const EVENTS_MUX_PATH = '/api/events.mux'
/** Browser host-frame WebSocket pathname (downlink-only). */
export const EVENTS_HOST_PATH = '/api/events.host'

// ─── mux frames (the runtime's `muxFrameSchema`) ─────────────────────────────
/**
 * One frame on `/api/events.mux`. Each is the `payload` of a `server-request`
 * envelope pushed by the Host. `sessionId` scopes the per-session frames; the
 * conversation model and control surface consume these directly.
 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { type: 'question/requested'; sessionId: SessionId; questions: unknown[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: SessionId; items: unknown[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; [k: string]: unknown }

// ─── host frames (the runtime's `hostFrameSchema`) ───────────────────────────
/** One frame on `/api/events.host` — host-wide, not session-scoped. */
export type HostFrame =
  | { type: 'host/session-added'; sessionId: SessionId; blank: boolean; parentSessionId?: SessionId; origin?: 'subagent'; cwd?: string; agentPreset?: string }
  | { type: 'host/session-removed'; sessionId: SessionId }
  | { type: 'host/session-status'; sessionId: SessionId; running: boolean }
  | { type: 'host/agent-error'; sessionId: SessionId; message: string }
  | { type: 'host/workspace-changed'; workspace: WorkspaceView }
  | { type: 'host/workspace-removed'; workspaceId: WorkspaceId }
  | { type: 'host/workspace-order-changed'; workspaceIds: WorkspaceId[] }
  | { type: 'host/archived-sessions-changed'; archivedSessionIds: SessionId[] }
  | { type: 'host/remote-event'; event: string; args: unknown[] }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; [k: string]: unknown }

// ─── approvals ───────────────────────────────────────────────────────────────
/** Host-side outcome of one approval waterfall (mirrors the runtime union). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Body POSTed to `/api/respond` to settle an approval (a `client-response`). */
export interface ApprovalRespondRequest {
  sessionId: SessionId
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
}

// ─── host.describe ──────────────────────────────────────────────────────────
/** Response of `host.describe` (called once at connect). */
export interface HostDescribeValue {
  version: string
  cwd: string
  provider?: string
  model?: string
  reasoningEffort?: string
  [k: string]: unknown
}

// ─── session domain ──────────────────────────────────────────────────────────
/** Durable identity selecting an ordinary Session or one direct subagent child. */
export type SessionAddress =
  | { kind: 'session'; sessionId: SessionId }
  | {
    kind: 'subagent'
    parentSessionId: SessionId
    childSessionId: SessionId
    mode: 'one-shot' | 'continuable'
  }

/** The address the plugin uses for everything it does (top-level sessions only). */
export function sessionAddress(sessionId: SessionId): SessionAddress {
  return { kind: 'session', sessionId }
}

export interface SessionSummary {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: SessionId
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
  /** Server-side projections (title, stats, …) — the same view the web UI renders. */
  projections?: {
    asOfSeq: number
    values: {
      /** AI-generated session title. null for blank sessions. */
      title?: string | null
      [k: string]: unknown
    }
  }
}

export interface SessionListValue {
  items: readonly SessionSummary[]
}

export interface SessionCreateRequest {
  workspaceId?: WorkspaceId
  cwd?: string
  sessionId?: SessionId
  agentPreset?: string
}

export interface SessionCreateValue {
  sessionId: SessionId
  agentPreset?: string
}

export interface SessionRenameRequest {
  sessionId: SessionId
  title: string
}

export interface SessionRenameValue {
  title: string
  seq: number
}

export interface SessionForkRequest {
  sessionId: SessionId
  atSeq?: number
  increaseTitle?: boolean
}

export interface SessionForkValue {
  sessionId: SessionId
}

export interface SessionHistoryRequest {
  sessionId: SessionId
  beforeSeq?: number
  maxMessages?: number
}

/** One session.history item: the session event plus its optional host-computed tool view. */
export interface SessionHistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

/** `session.history` response value (unary RPC in rc.6). */
export interface SessionHistoryValue {
  events: SessionHistoryEntry[]
  hasMore: boolean
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

/** Model selection resolved by the Host for an unconfigured session. */
export interface ModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  routableProviders: readonly string[]
  groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
  failures: readonly { id: string; name: string; message: string }[]
}

/** `session.models` response value (current selection + catalog). */
export interface SessionModelsValue {
  current: { provider: string; model: string; reasoningEffort?: string }
  routable: boolean
  groups: ModelCatalog['groups']
  failures: ModelCatalog['failures']
}

// ─── workspace domain ────────────────────────────────────────────────────────
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceListValue {
  items: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
}

/** `workspace.create` response value (rc.6: `{ workspace, created }`). */
export interface WorkspaceCreateValue {
  workspace: WorkspaceView
  created: boolean
}

// ─── prompt content ──────────────────────────────────────────────────────────
/** One content part of a prompt. The plugin only sends text. */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }
  | { type: 'file'; receiptId: string }

export interface SessionPromptRequest {
  /** Client-minted identity persisted on the accepted user message. */
  requestId: string
  sessionId: SessionId
  mode: 'queue' | 'steer'
  content: readonly PromptContentPart[]
  clientTimeZone?: string
}

export interface SessionPromptValue {
  accepted: true
}

/** A file reference extracted from `@file:path` or `@file:path:L10-L20` syntax. */
export interface FileReference {
  path: string
  lineStart?: number
  lineEnd?: number
}

/** A text selection from the active editor. */
export interface SelectionContext {
  text: string
  path: string
  lineStart: number
  lineEnd: number
}

/** The active file at the moment the prompt is sent. */
export interface ActiveFileContext {
  path: string
}

/**
 * Structured editor context attached to a prompt. The prompt request is
 * `{requestId, sessionId, mode, content, clientTimeZone}` only; the plugin
 * renders this context into the prompt text itself (see `AppController.sendPrompt`),
 * which keeps the KV cache deterministic because the block is a stable prefix.
 */
export interface PromptContext {
  files?: FileReference[]
  selection?: SelectionContext
  activeFile?: ActiveFileContext
}

// ─── SessionEvent — the merge-extensible append-only log entry ───────────────
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: true
  sourceEventSeqs?: number[]
  surfaceOp?: unknown
}

/** One history entry as the conversation model consumes it. */
export interface HistoryEntry {
  event: SessionEvent
  view?: ToolEventView
}

export interface ToolEventView {
  for: 'call' | 'result'
  view: { card: string; [k: string]: unknown }
}

// ─── content-block shapes we render (defensive — upstream is merge-extensible) ─
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id?: string; name?: string; arguments?: string }
  | { type: 'tool-result'; toolCallId?: string; content?: ContentBlock[]; isError?: boolean }
  | { type: 'reasoning'; text?: string }
  | { type: string; [k: string]: unknown }

export interface UserMessageData {
  content?: ContentBlock[]
  source?: { kind?: string; plugin?: string }
  role?: string
  id?: string
}

export interface AssistantMessageData {
  turn: number
  step: number
  message: { role: string; content?: ContentBlock[]; source?: { kind?: string; provider?: string; model?: string }; id?: string }
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number }
}

export interface ToolCallData {
  turn: number
  step: number
  callId: CallId
  name: string
  arguments: string
}

export interface ToolResultData {
  turn: number
  step: number
  message: { content?: ContentBlock[]; source?: { callId?: string }; role?: string; id?: string }
  error?: { name: string; code: string }
  meta?: unknown
}

export interface TurnEndData {
  turn: number
  reason: { kind: string; [k: string]: unknown }
}

// ─── StreamChunk — assistant streaming deltas (text-delta carries the text) ────
export type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; argumentsDelta: string }
  | { type: 'block-start'; index: number; blockType: string; id?: string; name?: string }
  | { type: 'block-end'; index: number; block?: unknown }
  | { type: 'message-end'; message?: unknown }
  | { type: 'usage'; usage?: unknown }
  | { type: 'finish'; reason?: string }
  | { type: string; [k: string]: unknown }

export interface AssistantChunkData {
  turn: number
  step: number
  chunk: StreamChunk
}

// ─── narrowing guards (the only runtime code in this file) ───────────────────
export function isSessionEventFrame(f: MuxFrame): f is { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView } {
  return f.type === 'session/event'
}

/** Endpoint string for a Remote method: `namespace/method`. */
export function endpointOf(namespace: string, method: string): string {
  return `${namespace}/${method}`
}
