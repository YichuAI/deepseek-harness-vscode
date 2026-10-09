/**
 * Wire protocol types — a faithful, dependency-free mirror of the DeepSeek
 * Harness Remote contract as implemented by the installed `dsh web` runtime
 * (observed against the bundled `@deepseek-ai/dsh-*` 0.2.0-rc.2 packages).
 *
 * This file is the single source of truth for everything that crosses the
 * network. Authoritative shapes (read from the installed runtime, not guessed):
 *
 *   dsh-api-gateway/lib/types/stream-protocol.js   REMOTE_STREAM_MUX_PATH,
 *                                                   remote stream frame shapes
 *   dsh-api-gateway/lib/client.js                  remoteStreamUrl(), openStream
 *   dsh-client-connection/lib/client.js            createWebConnectionRpc.call
 *   dsh-api-remotes/lib/client.js                 per-method arg `wire` names
 *
 * Load-bearing facts that differ from the earlier (broken) rc.6 model:
 *
 *   1. Endpoints are `namespace/method` rendered **slash-style** on the wire:
 *      `POST /api/session/list` (never `session.list`). The Host maps the path
 *      `/api/<endpoint>` to a Typert service+method.
 *   2. Request payloads are wrapped: `payload: { args: <inner> }`. The `<inner>`
 *      object's field name is the Typert parameter wire name — `session/list`
 *      uses `_request`, almost every other method uses `request`, and a few
 *      (modelCatalog, listProviders) take no args at all (`{ args: {} }`).
 *   3. The event socket is a **multiplexed Remote stream WebSocket**. The client
 *      opens `ws://host:port/api/remote.mux`, then sends one `open` frame
 *      `{ type:'open', streamId, endpoint:'$events', payload:{args:{}} }`. The
 *      Host pushes frames `{ type:'item'|'end'|'error', streamId, value }`; for
 *      the `$events` stream each `item.value` is a MuxFrame. The FIRST item's
 *      value is `{ type:'ready', clientId, host:{ home } }` — that is the only
 *      host-identity frame; there is NO `host.describe` in 0.2.0-rc.2.
 *   4. Approvals arrive as `approval/request` (a "waterfall" event) and are
 *      answered by the unary RPC `POST /api/$events/result` with
 *      `{ clientId, eventId, outcome }` — NOT by `POST /api/respond`.
 *   5. History is `session/page` (unary), not `session/history`:
 *      `{ address:{kind:'session',sessionId}, throughSeq, beforeSeq?, maxMessages? }`
 *      → `{ records:[{type:'event',event}], hasMore }`.
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

/** Server-initiated message — delivered on the downlink event WebSocket. */
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

// ─── harness identity ────────────────────────────────────────────────────────
/**
 * What the plugin knows about the host. 0.2.0-rc.2 supplies this from the
 * `ready` frame only (`host.home` + `clientId`). `version` is a build-time
 * constant the host never transmits; `provider`/`model` are per-session and are
 * best-effort populated from `session/list` projections when present.
 */
export interface HarnessInfo {
  /** Host account home, used only to abbreviate displayed paths. */
  home: string
  /** Opaque id of this client event generation (from the `ready` frame). */
  clientId?: string
  /** Unavailable in 0.2.0-rc.2 (host never sends it); kept optional. */
  version?: string
  provider?: string
  model?: string
}

// ─── Remote stream (multiplexed event WebSocket) ─────────────────────────────
/** Browser Remote-stream WebSocket pathname. */
export const REMOTE_MUX_PATH = '/api/remote.mux'
/** Logical stream the client opens to receive forwarded harness events. */
export const REMOTE_EVENT_STREAM_ENDPOINT = '$events'

/** Client→Host: open a logical stream. */
export interface RemoteStreamOpen {
  type: 'open'
  streamId: string
  endpoint: string
  payload: { args: Record<string, unknown> }
}

/** Host→Client: a frame on a logical stream. */
export type RemoteStreamServerMessage =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: RpcError }

/** The `ready` item — the only host-identity frame (always first on `$events`). */
export interface ReadyFrame {
  type: 'ready'
  clientId: string
  host: { home: string }
}

/** Body of `POST /api/$events/result` — the approval/question answer. */
export interface RemoteEventResult {
  clientId: string
  eventId: string
  outcome:
    | { kind: 'next' }
    | { kind: 'result'; value?: unknown }
    | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } }
}

// ─── mux frames (the runtime's forwarded event union) ────────────────────────
/**
 * One event on the `$events` stream. Each is the `value` of a Remote stream
 * `item`. `sessionId` scopes the per-session frames; the conversation model and
 * control surface consume these directly. This is the plugin's INTERNAL
 * vocabulary: the harness client translates the wire event names
 * (`approval/request`, `user-questions/request`, …) into these before they
 * reach the UI, so the rest of the extension never sees the raw wire names.
 */
export type MuxFrame =
  | { type: 'session/event'; sessionId: SessionId; event: SessionEvent; view?: ToolEventView }
  | { type: 'session/subscribed'; sessionId: SessionId; lastSeq: number }
  | { type: 'approval/requested'; sessionId: SessionId; approvalId: string; toolName?: string; callId?: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: SessionId; approvalId: string; outcome: 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' }
  | { type: 'question/requested'; sessionId: SessionId; questions: unknown[] }
  | { type: 'question/resolved'; sessionId: SessionId; questionRpcId: RpcId; outcome: 'answered' | 'cancelled' }
  | { type: 'session/queue'; sessionId: SessionId; items: unknown[] }
  | { type: 'session/jobs'; sessionId: SessionId; jobs: unknown[] }
  | { type: 'session/projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { type: 'stream/error'; error: RpcError }
  | { type: string; [k: string]: unknown }

// ─── approvals ───────────────────────────────────────────────────────────────
/** Host-side outcome of one approval waterfall (mirrors the runtime union). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Wire outcome sent to `POST /api/$events/result`. */
export type RemoteEventOutcome =
  | { kind: 'result' }
  | { kind: 'rejected'; error: { name: string; message: string; code?: string; details?: unknown } }

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
  agentAvailable?: boolean
  cwd?: string
  agentPreset?: string
  /** Server-side projections (title, stats, plan, todos, permissions, model…). */
  projections?: {
    kind: string
    asOfSeq: number
    values: Record<string, unknown>
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

/** Request of `session/page` (unary RPC in 0.2.0-rc.2). */
export interface SessionPageRequest {
  address: SessionAddress
  throughSeq: number
  beforeSeq?: number
  maxMessages?: number
}

/** One `session.page` record: the session event (the same shape the web UI renders). */
export interface SessionPageRecord {
  type: 'event'
  event: SessionEvent
}

/** `session.page` response value (unary RPC in 0.2.0-rc.2). */
export interface SessionPageValue {
  records: readonly SessionPageRecord[]
  hasMore: boolean
  projections?: { asOfSeq: number; values: Record<string, unknown> }
}

/** Model selection resolved by the Host for an unconfigured session. */
export interface ModelCatalog {
  default: { provider: string; model: string; reasoningEffort?: string }
  routableProviders: readonly string[]
  groups: readonly {
    id: string
    name: string
    models: readonly {
      id: string
      name: string
      description?: string
      /** Reasoning-effort ladder for this model, with the host default. */
      reasoning?: {
        efforts: readonly { id: string; name: string; description?: string }[]
        defaultEffort: string
      }
    }[]
  }[]
  failures: readonly { id: string; name: string; message: string }[]
}

/** `session/selectModel` response value (rc.2: `{ request: … }` args). */
export interface ModelSelectionValue {
  selected: { provider: string; model: string; reasoningEffort?: string }
}

/** One entry of the `commands/list` registry (rc.2 slash commands). */
export interface CommandDescriptor {
  definitionId: string
  name: string
  description: string
  input?: { hint?: string; attachments?: boolean }
}

/** One pending queued message from the `inbox.next-turn` projection. */
export interface QueueItemView {
  id: string
  text: string
}

/** Result of `session/search` (`{ request: { query } }`). */
export interface SessionSearchResult {
  results?: Array<{
    sessionId: string
    title?: string
    snippet?: string
    updatedAt?: number
    workspaceId?: string
  }>
  total?: number
}

/**
 * Raster formats the host's attachment store admits for inline images.
 * Mirrors upstream `ImageMediaType` (attachment-local pins the same four).
 */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** A durable image the host has already stored (created by prompt admission). */
export interface ImageAttachmentRef {
  /** `sha256:<hex>` — the host's content address, used for read-back. */
  attachmentId: string
  mediaType: string
  width?: number
  height?: number
  bytes?: number
  name?: string
}

/**
 * Result of `session/attachment`.
 *
 * Despite the name this is a durable image **read**, not an upload:
 * `{ request: { sessionId, attachmentId } }` → the stored ref plus its bytes,
 * base64. Uploading is a two-step affair and does not ride this method at all
 * (see {@link FileUploadValue}).
 */
export interface SessionAttachmentValue {
  attachment: ImageAttachmentRef
  /** Base64 of the exact stored bytes (the host may have normalized/rescaled). */
  data: string
}

/**
 * Value of `POST /api/session/uploadFileBinary?sessionId=&name=`.
 *
 * The route takes raw `application/octet-stream` bytes and answers a receipt;
 * the receipt is then referenced from a prompt as `{ type: 'file', receiptId }`.
 * The receipt is scoped to the receiving session and to the current process.
 */
export interface FileUploadValue {
  /** A base64 payload in the Remote fallback shape (unused by the raw route). */
  readonly data?: string
  readonly name?: string
  readonly receiptId?: string
  readonly file?: { attachmentId?: string; name?: string; bytes?: number }
}

/** Session-level token/usage projection (`projections.values`). */
export interface SessionUsageProjection {
  tokenUsage?: {
    uncachedInputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  sessionStats?: {
    turns?: number
    steps?: number
    llmMs?: number
    toolMs?: number
    ttftMs?: number
    ttftSteps?: number
    decodeMs?: number
    decodeTokens?: number
  }
  contextBreakdown?: {
    systemTokens?: number
    toolsTokens?: number
    messageTokens?: number
  }
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

/** `workspace.create` response value (rc.2: `{ workspace, created }`). */
export interface WorkspaceCreateValue {
  workspace: WorkspaceView
  created: boolean
}

// ─── prompt content ──────────────────────────────────────────────────────────
/**
 * One content part of a prompt.
 *
 * `image` carries the bytes inline (base64) and the host promotes them to a
 * durable `ImageAttachmentRef` during admission; `file` carries only the opaque
 * receipt from an earlier `uploadFileBinary`, because a file's bytes travel on
 * their own route. Admission limits (upstream defaults): 20 images per message,
 * 20 MiB per image, 200 MiB per message, `png`/`jpeg`/`webp`/`gif` only, and the
 * host normalizes/rescales before storing.
 *
 * Images are refused with `session/attachment-invalid` + `reason:
 * MODEL_DOES_NOT_SUPPORT_IMAGES` when the session's current model is text-only.
 * The model catalog does not publish that capability, so it cannot be checked
 * up front — the host's verdict is the only authority.
 */
export type PromptContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: ImageMediaType; data: string; name?: string }
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

// File references have no wire representation any more. A prompt is
// `{requestId, sessionId, mode, content, clientTimeZone}` and an `@path` is
// carried inside `content` as ordinary text — the host resolves it against the
// session cwd and tells the model to read the file itself. The removed
// `PromptContext` / `FileReference` shapes fed a plugin-side inliner that pasted
// file bytes into every message.

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
  /**
   * Usage sample for this step (rc.2, mirrors the official UI's `normalizeUsage`).
   * `inputTokens` is the UNCACHED prompt portion; cached prompt tokens travel
   * separately as `cacheReadTokens` (hits) / `cacheWriteTokens` (writes).
   */
  usage?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    reasoningTokens?: number
    totalTokens?: number
    routes?: { provider?: string; model?: string }[]
  }
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

// ─── $events stream: forwarded Host events (0.2.1-alpha.2) ───────────────────
/**
 * One forwarded Host event. The `$events` stream carries a fixed allowlist of
 * these — `api-session/status`, `api-session/activity`, `approval/request`,
 * `user-questions/request`, plugin-inventory changes, … — and never
 * conversation traffic, which rides its own `session/follow` stream.
 */
export interface RemoteEmitFrame {
  type: 'emit'
  event: string
  args: readonly unknown[]
}

/** One pending Host waterfall (the answerable frames: approvals, questions). */
export interface RemoteWaterfallFrame {
  type: 'waterfall'
  event: string
  eventId: string
  agentId?: string
  request?: Readonly<Record<string, unknown>>
}

/** Cancellation of a pending waterfall previously delivered under the same id. */
export interface RemoteCancellationFrame {
  type: 'cancel'
  eventId: string
}

/** Every item the `$events` stream can publish, `ready` first. */
export type RemoteEventFrame =
  | ReadyFrame
  | RemoteEmitFrame
  | RemoteWaterfallFrame
  | RemoteCancellationFrame

// ─── session/follow stream: one session's conversation (0.2.1-alpha.2) ───────
/** One durable event as it appears in a follow stream or a history page. */
export interface FollowEventFrame {
  type: 'event'
  event: SessionEvent
}

/** Opening window of a follow stream: history prefix + the live log cut. */
export interface FollowSnapshotFrame {
  type: 'snapshot'
  header: { id: string; cwd?: string; createdAt?: number; agentPreset?: string; [k: string]: unknown }
  /** Inclusive log cut this stream opened at. */
  cursor: number
  records: FollowEventFrame[]
  hasMore: boolean
  /** Host projections (title, usage, …) at the cut. */
  projections?: unknown
}

/** One live assistant attempt opening (carries the turn/step its chunks belong to). */
export interface AssistantStreamStart {
  type: 'start'
  attemptId: string
  revision: number
  turn: number
  step: number
}

/** One live delta. These are process-local: they never appear in the durable log. */
export interface AssistantStreamChunk {
  type: 'chunk'
  attemptId: string
  revision: number
  index: number
  time: number
  chunk: StreamChunk
}

/** Terminal marker for one attempt (`outcome.committed` names the durable event). */
export interface AssistantStreamEnd {
  type: 'end'
  attemptId: string
  revision: number
  index: number
  outcome?: { kind: 'committed' | 'abandoned'; eventType?: string; seq?: number }
}

export type AssistantStreamFrame = AssistantStreamStart | AssistantStreamChunk | AssistantStreamEnd

/** An opted-in process-local assistant frame (`assistantStream: true`). */
export interface FollowAssistantFrame {
  type: 'assistant-stream'
  frame: AssistantStreamFrame
}

/** One frame of a `session/follow` stream. */
export type SessionFollowFrame = FollowSnapshotFrame | FollowEventFrame | FollowAssistantFrame

// ─── file references (`fileReferences/list`) ─────────────────────────────────
/** One path-only `@` completion candidate inside the addressed session's cwd. */
export interface FileReferenceCandidate {
  path: string
  kind: 'file' | 'directory'
}


/** Endpoint string for a Remote method: `namespace/method`. */
export function endpointOf(namespace: string, method: string): string {
  return `${namespace}/${method}`
}
