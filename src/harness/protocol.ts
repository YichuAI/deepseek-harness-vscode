/**
 * Wire protocol types — a faithful, dependency-free mirror of the DeepSeek
 * Harness Remote (Typert Gateway) contract as shipped in 0.1.6-alpha.
 *
 * This file is the single source of truth for everything that crosses the
 * network. Authoritative upstream paths (all under `deepseek-harness/`):
 *
 *   packages/client/connection/src/rpc-host.ts        envelope + `/api/<ns>/<method>`
 *   packages/client/connection/src/browser-auth.ts    cookie authentication
 *   packages/api/gateway/src/index.ts                 endpoint resolution, `{args}`
 *   packages/api/gateway/src/stream-protocol.ts       `/api/remote.mux` frames
 *   packages/api/session-controller/src/types.ts      session/page, session/follow
 *   packages/api/workspace-controller/src/types.ts    workspace/follow
 *   packages/api/remotes/src/remote-events.ts         forwarded Host events
 *
 * Two shape rules changed in that release and both are load-bearing:
 *
 *   1. Endpoints are `namespace/method` (`session/list`), not `a.b`
 *      (`session.list`). `HostConnectionService` splits the path after `/api/`
 *      on `/`, and `claimsEndpoint()` asserts exactly two segments.
 *   2. Request payloads are `{ args: { <wireName>: value, … } }` — exactly one
 *      key, a plain object, whose fields are the *declared parameter names* of
 *      the Remote method. `signal` is transport cancellation, never a field.
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

/** Server-initiated message — frames on the mux WebSocket, or any push. */
export interface ServerRequest<P = unknown> {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: P
}

export interface RpcError {
  code: string
  message: string
  details: unknown
}

/**
 * The named-argument payload every Remote RPC expects. `args` must be a plain
 * object holding the method's declared parameter names — no more, no fewer.
 */
export interface RemoteArgs {
  args: Record<string, unknown>
}

// ─── harness identity ────────────────────────────────────────────────────────
/**
 * What the plugin knows about the host it is talking to. `host.describe` was
 * removed in 0.1.6-alpha; identity now comes from the `$events` ready frame
 * (`home`) plus `session/modelCatalog` (`provider`/`model`).
 */
export interface HarnessInfo {
  /** Host account home, used only to abbreviate displayed paths. */
  home: string
  /** Opaque id of this client event generation. */
  clientId?: string
  version?: string
  provider?: string
  model?: string
}

// ─── remote.mux  (packages/api/gateway/src/stream-protocol.ts) ───────────────
/** Exact WebSocket route carrying every Remote stream. */
export const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'
/** Gateway-internal logical stream carrying forwarded Cordis events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'
/** Gateway-internal unary endpoint accepting one Remote Event outcome. */
export const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

/** Browser → Host logical-stream request. */
export type RemoteStreamClientMessage =
  | { type: 'open'; streamId: string; endpoint: string; payload: RemoteArgs }
  | { type: 'cancel'; streamId: string }

/** Carrier-safe failure delivered by the Host. */
export interface RemoteStreamFailure {
  code: string
  message: string
  details: object
}

/** Host → browser logical-stream frame. */
export type RemoteStreamServerMessage =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'error'; streamId: string; error: RemoteStreamFailure }
  | { type: 'end'; streamId: string }

// ─── forwarded Remote events ─────────────────────────────────────────────────
/** Opening item that binds later HTTP results to this event generation. */
export interface RemoteEventReadyFrame {
  type: 'ready'
  clientId: string
  host: { home: string }
}

/** One Host notification. */
export interface RemoteEventEmitFrame {
  type: 'emit'
  event: string
  args: readonly unknown[]
}

/** One pending agent-scoped waterfall awaiting a Client answer. */
export interface RemoteEventInvocationFrame {
  type: 'waterfall'
  event: string
  eventId: string
  agentId: string
  request: Record<string, unknown>
}

/** Cancellation of a pending waterfall previously delivered under the same id. */
export interface RemoteEventCancellationFrame {
  type: 'cancel'
  eventId: string
}

export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventInvocationFrame
  | RemoteEventCancellationFrame

/** Client answer to one scoped Remote Event delivery (POST `$events/result`). */
export interface RemoteEventResult {
  clientId: string
  eventId: string
  outcome:
    | { kind: 'next' }
    | { kind: 'result'; value?: unknown }
    | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } }
}

/** Event names this deployment forwards (`packages/api/remotes/src/remote-events.ts`). */
export const APPROVAL_REQUEST_EVENT = 'approval/request'
export const USER_QUESTIONS_REQUEST_EVENT = 'user-questions/request'

/** Host-side outcome of one approval waterfall. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

// ─── session domain (packages/api/session-controller/src/types.ts) ───────────
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

export interface SessionCancelRequest {
  sessionId: SessionId
}

export interface SessionCancelValue {
  accepted: true
}

export interface SessionRenameRequest {
  sessionId: SessionId
  title: string
}

/** One message-aligned backwards-history request. */
export interface SessionPageRequest {
  address: SessionAddress
  /** Inclusive log cut. `-1` yields an empty page, so a real cursor is required. */
  throughSeq: number
  beforeSeq?: number
  maxMessages?: number
}

/** One live event request for a durable Session address. */
export interface SessionFollowRequest {
  address: SessionAddress
  maxMessages?: number
  /** Include process-local assistant presentation frames (needed for streaming). */
  assistantStream?: true
}

/** Current logical Session metadata carried on the browser wire. */
export interface SessionWireHeader {
  version: number
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

/** One history page record: a durable event, optionally with a tool presentation view. */
export interface SessionEventEntry {
  type: 'event'
  event: SessionEvent
  view?: ToolEventView
}

export interface SessionPage {
  records: readonly SessionEventEntry[]
  hasMore: boolean
}

/** One active assistant attempt in a reconnect opening snapshot. */
export interface SessionAssistantStreamAttempt {
  attemptId: string
  startedAfterSeq: number
  turn: number
  step: number
  nextIndex: number
  stream: readonly unknown[]
}

export interface SessionAssistantStreamBaseline {
  revision: number
  activeAttempt?: SessionAssistantStreamAttempt
}

/** Browser wire form of one process-local assistant frame. */
export type SessionAssistantStreamFrame =
  | {
    type: 'start'
    attemptId: string
    revision: number
    startedAfterSeq: number
    turn: number
    step: number
  }
  | {
    type: 'chunk'
    attemptId: string
    revision: number
    index: number
    time: number
    chunk: StreamChunk
  }
  | {
    type: 'end'
    attemptId: string
    revision: number
    index: number
    outcome:
      | { kind: 'committed'; eventType: string; seq: number }
      | { kind: 'abandoned' }
  }

/** Complete opening window followed by ordered durable events and assistant frames. */
export type SessionFollowFrame =
  | {
    type: 'snapshot'
    header: SessionWireHeader
    cursor: number
    records: readonly SessionEventEntry[]
    hasMore: boolean
    projections?: { asOfSeq: number; values: Record<string, unknown> }
    assistantStream?: SessionAssistantStreamBaseline
  }
  | SessionEventEntry
  | { type: 'assistant-stream'; frame: SessionAssistantStreamFrame }

/** Model selection resolved by the Host for unconfigured sessions. */
export interface ModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  routableProviders: readonly string[]
  groups: readonly { id: string; name: string; models: readonly { id: string; name: string }[] }[]
  failures: readonly { id: string; name: string; message: string }[]
}

// ─── workspace domain (packages/api/workspace-controller/src/types.ts) ───────
export interface WorkspaceView {
  workspaceId: WorkspaceId
  /** Canonical directory path (host-side realpath canon). */
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}

/** Complete reconnect baseline for Workspace browser state. */
export interface WorkspaceBaseline {
  items: readonly WorkspaceView[]
  archivedSessionIds: readonly SessionId[]
}

/** One ordered Workspace change after a generation's baseline. */
export type WorkspaceFollowIncrement =
  | { type: 'upsert'; workspace: WorkspaceView }
  | { type: 'remove'; workspaceId: WorkspaceId }
  | { type: 'order'; workspaceIds: readonly WorkspaceId[] }
  | { type: 'archived'; archivedSessionIds: readonly SessionId[] }

export type WorkspaceFollowFrame =
  | { type: 'baseline'; value: WorkspaceBaseline }
  | WorkspaceFollowIncrement

// ─── prompt content (packages/api/session-controller/src/types.ts) ───────────
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
 * Structured editor context attached to a prompt.
 *
 * NOTE: 0.1.6-alpha dropped the old `payload.context` escape hatch — the prompt
 * request is `{requestId, sessionId, mode, content, clientTimeZone}` only. The
 * plugin therefore renders this context into the prompt text itself (see
 * `AppController.sendPrompt`), which keeps the KV cache deterministic because
 * the block is a stable prefix.
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

// ─── Legacy-shaped frames the UI layers consume ──────────────────────────────
/**
 * The conversation model and approval store were written against the pre-0.1.6
 * `events.mux` frame union. `HarnessClient` synthesizes these shapes from
 * `session/follow` items and forwarded Remote events, so no UI code has to
 * learn the new transport. Unknown frame types are still ignored.
 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName: string; callId?: CallId; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: string }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; [k: string]: unknown }

// ─── narrowing guards (the only runtime code in this file) ───────────────────
export function isSessionEventFrame(f: MuxFrame): f is { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView } {
  return f.type === 'session/event'
}

/** Endpoint string for a Remote method: `namespace/method`. */
export function endpointOf(namespace: string, method: string): string {
  return `${namespace}/${method}`
}
