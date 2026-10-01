/**
 * Shared UI state shape — pushed from AppController to the Webview provider.
 * Same fields as old UiState, but renderVersion is promoted to the top level
 * (every SessionSnapshot mutation bumps it; webview compares renderVersion
 * as the sole change-detection key).
 */

import type { MuxStatus } from '../harness/events.ts'
import type { CommandDescriptor, ModelCatalog, QueueItemView, SessionSearchResult, SessionSummary, WorkspaceView } from '../harness/protocol.ts'
import type { SessionSnapshot } from '../conversation/types.ts'
import type { ControlState } from '../conversation/control.ts'
import type { SessionUsageState } from '../conversation/usage.ts'
import type { ReviewSummary } from '../review/types.ts'
import type { ApprovalSummary } from '../approval/types.ts'

/** One raw frame captured for the live event inspector (F7). */
export interface InspectorFrame {
  /** Monotonic sequence for display. */
  seq: number
  /** Wall-clock time the frame arrived at the client. */
  at: number
  /** Frame type (`session/event`, `assistant/stream`, `stream/error`, …). */
  kind: string
  /** For `session/event` frames: the inner event type. */
  eventType?: string
  /** One-line human summary (title/tool/usage delta…). */
  summary: string
  /** Truncated JSON of the frame for copy/inspect. */
  raw: string
}

/** Search results from `session/search` plus the UI state for the F6 panel. */
export interface SearchState {
  query: string
  results: NonNullable<SessionSearchResult['results']>
  error?: string
  /** Host reported search as disabled for this deployment. */
  disabled?: boolean
}

export type ConnectionKind = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface UiState {
  connection: ConnectionKind
  /** Host identity. `home` comes from the `$events` ready frame; provider/model
   *  are best-effort (the removed `host.describe` used to supply them). */
  hostInfo?: { version?: string; home?: string; provider?: string; model?: string }
  errorMessage?: string
  muxStatus?: string
  /** Workspace:
   *   undefined → not resolved yet
   *   null      → resolved but no matching Harness workspace (pending create)
   *   object    → registered Harness workspace
   */
  workspace?: { workspaceId: string; title: string; path: string } | null
  sessions: Array<{ sessionId: string; label: string; running: boolean; blank: boolean }>
  activeSessionId?: string
  snapshot?: SessionSnapshot
  sending: boolean
  canStop: boolean
  showSystemMessages: boolean
  systemMessageCount: number
  brandIconUri?: string
  /** Active diff review transactions for the current session. */
  reviews?: ReviewSummary[]
  /** Pending approvals for the current session. */
  approvals?: ApprovalSummary[]
  /** Control surface folded from the session's knob/goal/todo events. */
  control?: ControlState
  /** `ns/method` → served by this host. Absent key means "probed and missing". */
  capabilities?: Record<string, boolean>
  /** Model catalog (rc.2 `session/modelCatalog`) — gated by capability. */
  modelCatalog?: ModelCatalog
  /** Slash-command registry (rc.2 `commands/list`) for the active session. */
  commands?: CommandDescriptor[]
  /** Queued messages (rc.2 `inbox.next-turn` projection) for the active session. */
  queue?: QueueItemView[]
  /** Session token/usage totals (folded events + host projections). */
  sessionUsage?: SessionUsageState
  /** F6: session search panel state. */
  search?: SearchState | null
  /** F7: ring buffer of recently observed mux frames (newest last). */
  eventLog?: InspectorFrame[]
  /** Auto-approve incoming approval requests (setting mirror). */
  autoApprove: boolean
  /** Monotonically increasing. Bumps whenever any UiState field changes,
   *  including sub-object mutations inside snapshot. Webview re-renders on
   *  renderVersion change only (solves streaming no-render bug). */
  renderVersion: number
}

export interface AppStateCallbacks {
  pushState: () => void
  showError: (msg: string) => void
  showInfo: (msg: string) => void
  approveInWebUi: () => void
  openHarnessHome: () => void
  moveToSecondarySideBar: () => void
  log: { info: (m: string) => void; error: (m: string) => void }
}

/** Build UiState.workspace from a workspace-or-null-or-pending binding. */
export function workspaceToUi(ws: WorkspaceView | null | undefined): UiState['workspace'] {
  if (ws === null) return null
  if (!ws) return undefined
  return { workspaceId: ws.workspaceId, title: ws.title, path: ws.path }
}

/** Build the UiState sessions list from SessionSummary[]. */
export function sessionsToUi(
  sessions: SessionSummary[],
  labelFor: (s: SessionSummary, i: number) => string,
): UiState['sessions'] {
  return sessions.map((s, i) => ({
    sessionId: s.sessionId,
    label: labelFor(s, i + 1),
    running: s.running,
    blank: s.blank,
  }))
}

import type { ConnectionState } from '../harness/client.ts'

/** Map a ConnectionState + mux status into the UiState connection fields. */
export function connectionToUi(
  conn: ConnectionState,
  mux?: MuxStatus,
): Pick<UiState, 'connection' | 'hostInfo' | 'errorMessage' | 'muxStatus'> {
  switch (conn.kind) {
    case 'disconnected': return { connection: 'disconnected', muxStatus: undefined }
    case 'connecting': return { connection: 'connecting', muxStatus: undefined }
    case 'connected':
      return {
        connection: 'connected',
        hostInfo: {
          version: conn.info.version,
          home: conn.info.home,
          provider: conn.info.provider,
          model: conn.info.model,
        },
        muxStatus: mux ? muxLabel(mux) : undefined,
      }
    case 'error': return { connection: 'error', errorMessage: conn.message, muxStatus: undefined }
  }
}

function muxLabel(s: MuxStatus): string {
  switch (s.kind) {
    case 'idle': return 'idle'
    case 'connecting': return 'connecting…'
    case 'open': return 'live'
    case 'ready': return 'ready'
    case 'closed': return 'closed (' + s.reason + ')'
    case 'error': return 'error: ' + s.message
  }
}
