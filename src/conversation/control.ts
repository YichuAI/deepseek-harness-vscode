/**
 * control.ts — the control-surface projection.
 *
 * Everything in this file is READ side. The harness has always shipped these
 * knobs to web clients, and until now the plugin dropped every one of them:
 *
 *   plan/mode            { active }                      — plan-first execution
 *   permission/preset    { preset }                      — selected preset name
 *   sandbox/mode         { mode }                        — filesystem confinement
 *   approval/policy      { policy }                      — when to ask the user
 *   todo/write           { todos }                       — whole-list snapshot
 *   goal/change          { operation, goal | cleared }   — last-wins fold
 *   subagent/start|end                                   — child agent activity
 *   subagent/descriptor                                  — child roster
 *   compaction/start|end|summary                         — context compaction
 *   request/header       { header: { config: … } }       — effective model config
 *   agent-preset/selected                                — active agent preset
 *
 * Every one is a WHOLE-VALUE log-only record (upstream invariant: the latest
 * occurrence wins and replay must be able to recompute state from the log
 * alone). That makes the fold trivial — no merge logic, just "last one wins" —
 * and it is why this module can be replayed from history without any catch-up
 * channel.
 *
 * Upstream types (authoritative):
 *   packages/core/session/src/types.ts                  event payloads
 *   packages/interaction/permission-presets/src/index.ts knobs + preset table
 *   packages/goal/goal/src/domain.ts                    goal snapshot shape
 *
 * Merge-extensibility rule still applies: unknown event types are ignored, and
 * every payload is read defensively — a host that grows a field must not break
 * a client that does not know about it.
 */

import type { SessionEvent } from '../harness/protocol.ts'

export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface ControlTodo {
  content: string
  status: TodoStatus
}

/** Upstream `GoalSnapshot` — a durable goal's full value at one revision. */
export interface ControlGoal {
  id: string
  /** The user-facing objective text (`objective`, not `title`, upstream). */
  objective: string
  phase: 'active' | 'paused' | 'blocked' | 'complete' | string
  revision?: number
  roundsStarted?: number
  maxGoalRounds?: number
}

export interface ControlSubagent {
  key: string
  name?: string
  running: boolean
}

export interface ControlCompaction {
  running: boolean
  /** Text of the most recent compaction summary, when the host recorded one. */
  summary?: string
  shadowedTokenCount?: number
}

export interface ControlModel {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface ControlState {
  /** Bumped on every mutation; the webview's render signature. */
  version: number
  /** Undefined until the log says something — distinguishes "off" from "unknown". */
  planActive?: boolean
  preset?: string
  sandbox?: string
  approvalPolicy?: string
  agentPreset?: string
  model?: ControlModel
  todos: ControlTodo[]
  goal?: ControlGoal
  subagents: ControlSubagent[]
  compaction?: ControlCompaction
}

/** Read `data` as a plain record — every guard in this module goes through it. */
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/** Fold todo/write payloads. Malformed entries are dropped, not fatal. */
function readTodos(raw: unknown): ControlTodo[] {
  const list = record(raw).todos
  if (!Array.isArray(list)) return []
  const out: ControlTodo[] = []
  for (const entry of list) {
    const r = record(entry)
    const content = str(r.content)
    if (content === undefined) continue
    const status = str(r.status)
    out.push({
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    })
  }
  return out
}

/** `request/header` → the model config actually used for the next call. */
function readModel(data: Record<string, unknown>): ControlModel | undefined {
  const header = record(data.header)
  const config = record(header.config)
  const provider = str(config.provider)
  const model = str(config.model)
  const reasoningEffort = str(config.reasoningEffort)
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** `subagent/start` and `subagent/end` carry a scoped identity, not a payload. */
function subagentKey(data: Record<string, unknown>, event: SessionEvent): string {
  return str(data.id)
    ?? str(data.subagentId)
    ?? str(data.key)
    ?? str(record(data.agent).id)
    ?? `seq:${String(event.seq)}`
}

/**
 * One session's control surface.
 *
 * Lives alongside `ConversationModel`: this is the answer to "what is the agent
 * allowed to do, and what is it working on" rather than "what did it say".
 */
export class ControlSurface {
  private version = 0
  private planActive: boolean | undefined
  private preset: string | undefined
  private sandbox: string | undefined
  private approvalPolicy: string | undefined
  private agentPreset: string | undefined
  private model: ControlModel | undefined
  private todos: ControlTodo[] = []
  private goal: ControlGoal | undefined
  private subagents = new Map<string, ControlSubagent>()
  private compaction: ControlCompaction | undefined

  /** Clear everything (called when the active session changes). */
  reset(): void {
    this.planActive = undefined
    this.preset = undefined
    this.sandbox = undefined
    this.approvalPolicy = undefined
    this.agentPreset = undefined
    this.model = undefined
    this.todos = []
    this.goal = undefined
    this.subagents.clear()
    this.compaction = undefined
    this.version++
  }

  /**
   * Fold one durable session event.
   * @returns true when something the UI renders actually changed.
   */
  apply(event: SessionEvent): boolean {
    const data = record(event.data)
    switch (event.type) {
      case 'plan/mode': {
        const active = bool(data.active)
        if (active === undefined || active === this.planActive) return false
        this.planActive = active
        this.version++
        return true
      }
      case 'permission/preset': {
        const preset = str(data.preset)
        if (preset === undefined || preset === this.preset) return false
        this.preset = preset
        this.version++
        return true
      }
      case 'sandbox/mode': {
        const mode = str(data.mode)
        if (mode === undefined || mode === this.sandbox) return false
        this.sandbox = mode
        this.version++
        return true
      }
      case 'approval/policy': {
        const policy = str(data.policy)
        if (policy === undefined || policy === this.approvalPolicy) return false
        this.approvalPolicy = policy
        this.version++
        return true
      }
      case 'todo/write': {
        const next = readTodos(data)
        if (sameTodos(next, this.todos)) return false
        this.todos = next
        this.version++
        return true
      }
      case 'goal/change': return this.applyGoal(data)
      case 'subagent/start': return this.applySubagent(data, event, true)
      case 'subagent/end': return this.applySubagent(data, event, false)
      case 'subagent/descriptor': return this.applyDescriptor(data)
      case 'compaction/start': return this.applyCompaction({ running: true })
      case 'compaction/end': return this.applyCompaction({ running: false })
      case 'compaction/summary': return this.applyCompaction({
        running: false,
        summary: str(data.summary),
        shadowedTokenCount: num(data.shadowedTokenCount),
      })
      case 'request/header': {
        const next = readModel(data)
        if (next === undefined) return false
        this.model = next
        this.version++
        return true
      }
      case 'agent-preset/selected': return this.applyAgentPreset(data)
      default: return false
    }
  }

  snapshot(): ControlState {
    return {
      version: this.version,
      ...(this.planActive === undefined ? {} : { planActive: this.planActive }),
      ...(this.preset === undefined ? {} : { preset: this.preset }),
      ...(this.sandbox === undefined ? {} : { sandbox: this.sandbox }),
      ...(this.approvalPolicy === undefined ? {} : { approvalPolicy: this.approvalPolicy }),
      ...(this.agentPreset === undefined ? {} : { agentPreset: this.agentPreset }),
      ...(this.model === undefined ? {} : { model: { ...this.model } }),
      todos: this.todos.map(t => ({ ...t })),
      ...(this.goal === undefined ? {} : { goal: { ...this.goal } }),
      subagents: [...this.subagents.values()].map(s => ({ ...s })),
      ...(this.compaction === undefined ? {} : { compaction: { ...this.compaction } }),
    }
  }

  /** The render signature the webview compares against. */
  get currentVersion(): number { return this.version }

  // ─── folds ─────────────────────────────────────────────────────────────────

  /**
   * Fold one scalar knob. Every scalar behaves identically — undefined means
   * "the log has not spoken yet", and a repeat of the current value is not a
   * change — so they share one implementation and one change detector.
   */
  private setPreset(value: string | undefined): boolean {
    if (value === undefined || value === this.preset) return false
    this.preset = value
    this.version++
    return true
  }

  private applyGoal(data: Record<string, unknown>): boolean {
    const operation = str(data.operation) ?? 'create'
    if (operation === 'clear') {
      if (this.goal === undefined) return false
      this.goal = undefined
      this.version++
      return true
    }
    const g = record(data.goal)
    const id = str(g.id)
    const objective = str(g.objective)
    if (id === undefined && objective === undefined) return false
    const next: ControlGoal = {
      id: id ?? this.goal?.id ?? 'unknown',
      objective: objective ?? this.goal?.objective ?? '(no objective recorded)',
      phase: str(g.phase) ?? this.goal?.phase ?? 'active',
      ...(num(g.revision) === undefined ? {} : { revision: num(g.revision) }),
      ...(num(data.roundsStarted) === undefined ? {} : { roundsStarted: num(data.roundsStarted) }),
      ...(num(g.maxGoalRounds) === undefined ? {} : { maxGoalRounds: num(g.maxGoalRounds) }),
    }
    if (sameGoal(next, this.goal)) return false
    this.goal = next
    this.version++
    return true
  }

  private applySubagent(data: Record<string, unknown>, event: SessionEvent, running: boolean): boolean {
    const key = subagentKey(data, event)
    const existing = this.subagents.get(key)
    if (existing !== undefined && existing.running === running) return false
    this.subagents.set(key, {
      key,
      ...(str(data.name) === undefined ? (existing?.name === undefined ? {} : { name: existing.name }) : { name: str(data.name) }),
      running,
    })
    this.version++
    return true
  }

  /** `subagent/descriptor` publishes a roster whole value; reconcile by name. */
  private applyDescriptor(data: Record<string, unknown>): boolean {
    const raw = Array.isArray(data.subagents) ? data.subagents : Array.isArray(data.items) ? data.items : undefined
    if (raw === undefined) {
      const single = str(data.name) ?? str(data.id)
      if (single === undefined) return false
      const key = str(data.id) ?? str(data.name) ?? single
      if (this.subagents.has(key)) return false
      this.subagents.set(key, { key, name: single, running: false })
      this.version++
      return true
    }
    let changed = false
    const seen = new Set<string>()
    for (const entry of raw) {
      const r = record(entry)
      const name = str(r.name) ?? str(r.title)
      const key = str(r.id) ?? str(r.key) ?? name
      if (key === undefined) continue
      seen.add(key)
      const existing = this.subagents.get(key)
      if (existing === undefined) { this.subagents.set(key, { key, ...(name === undefined ? {} : { name }), running: false }); changed = true }
      else if (name !== undefined && existing.name !== name) { existing.name = name; changed = true }
    }
    for (const key of [...this.subagents.keys()]) {
      if (seen.has(key)) continue
      this.subagents.delete(key)
      changed = true
    }
    if (changed) this.version++
    return changed
  }

  private applyCompaction(patch: ControlCompaction): boolean {
    const prev = this.compaction
    const next: ControlCompaction = {
      running: patch.running,
      ...(patch.summary ?? prev?.summary ? { summary: patch.summary ?? prev?.summary } : {}),
      ...(patch.shadowedTokenCount ?? prev?.shadowedTokenCount
        ? { shadowedTokenCount: patch.shadowedTokenCount ?? prev?.shadowedTokenCount }
        : {}),
    }
    if (prev !== undefined && prev.running === next.running
      && prev.summary === next.summary && prev.shadowedTokenCount === next.shadowedTokenCount) return false
    this.compaction = next
    this.version++
    return true
  }

  /**
   * `agent-preset/selected` has shipped the chosen preset under several field
   * names (and once nested), so read whichever is present. First match wins —
   * the fields are alternatives, not a precedence chain.
   */
  private applyAgentPreset(data: Record<string, unknown>): boolean {
    const value = str(data.id) ?? str(data.name) ?? str(data.preset) ?? str(data.value)
      ?? str(record(data.agentPreset).id)
    if (value === undefined || value === this.agentPreset) return false
    this.agentPreset = value
    this.version++
    return true
  }
}

function sameTodos(a: ControlTodo[], b: ControlTodo[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.content !== b[i]?.content || a[i]?.status !== b[i]?.status) return false
  }
  return true
}

function sameGoal(a: ControlGoal, b: ControlGoal | undefined): boolean {
  if (b === undefined) return false
  return a.id === b.id && a.objective === b.objective && a.phase === b.phase
    && a.revision === b.revision && a.roundsStarted === b.roundsStarted
}
