# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-10-01

Tagline: **会话级工具链 — 全文搜索、实时事件检查器、附件上传。**
Tagline (EN): **session tooling — full-text search, live event inspector, file attachments.**

v0.0.9 补齐了交互闭环；v0.1.0 把三类"会话级工具"接入侧栏：搜回旧会话、看清线上
每一帧、把本地文件交给 agent。三个功能都走 rc.2 已证实存在的端点，且全部由能力
探测门控——宿主不提供时按钮照常显示但动作给出明确解释，绝不渲染死按钮。

### Added

- **F6 会话搜索（`session/search`）。** 侧栏新增 🔍 面板：输入全文关键词，返回
  会话标题 + 命中摘要，点击直接跳转到该会话。请求形状为
  `{ request: { query } }`（真机实证）。
  ⚠️ **部署开关**：本机 `dsh web` 当前**禁用**了 session search（宿主回答
  `gateway/internal: session search is disabled`）。此时面板显示
  "Search is disabled on this host deployment" 而非报错崩溃；在启用搜索的
  部署上开箱即用。
  *EN:* full-text session search panel (query → title + snippet → click to
  jump). Gated by capability probing; a deployment with search disabled shows
  a clear notice instead of an error.
- **F7 实时事件检查器。** 侧栏新增 📡 面板：把插件收到的**每一帧** mux 消息
  （`session/event`、`assistant/stream`、`stream/error`…）按序号/时间/类型/
  摘要流水展示，点击任意一行复制该帧的完整 JSON（截断至 2 KB）。环形缓冲
  保留最近 300 帧，可一键清空。**零新协议**——数据完全来自插件已在消费的
  事件流，对宿主零额外请求；排查"为什么 agent 做了这件事"时不必再开 Web UI。
  *EN:* live event inspector — every mux frame the plugin sees, listed with
  seq/time/type/summary; click a row to copy its raw JSON. 300-frame ring
  buffer, one-click clear, zero extra host traffic.
- **F8 附件上传（`session/attachment`）。** 侧栏新增 📎 按钮与命令
  `DeepSeek Harness: Attach File to Session`：选择本地文件（可多选）后以
  base64 经 `{ request: { sessionId, attachments: [{ name, content }] } }`
  发给宿主，由 agent 在后续回合消费。
  ⚠️ **形状坦白**：宿主确认该端点为 JSON + `{request}` 包裹，但**内部
  descriptor 未能通过盲探钉死**（所有猜测形状均答 `boundary validation
  failed`，multipart 被 415 拒绝即排除）。本实现采用最可能的内部形状并在
  错误时把宿主原文透传；在本部署上若形状不符会得到明确报错而非静默失败，
  待上游 schema 可读后一处常量即可修正。
  *EN:* attach local files (multi-select, base64) to the active session.
  The `{request}` wrapper is empirically confirmed; the inner descriptor could
  not be pinned by blind probing and is documented as best-known-shape with
  verbatim error passthrough.

### Changed

- **能力探测集合扩容。** `session/search`、`session/attachment` 加入
  `CONTROL_METHODS`，连接时与其它控制面方法一起探测；侧栏据此门控。
  *EN:* both endpoints join the probed control set and gate the new UI.
- **回归门扩到 95 项断言。** 假 harness 新增 `session/search`、
  `session/attachment` 端点；覆盖两方法的返回值解析与 `{request}` 信封形状。
  *EN:* regression gate grown to **95 assertions**.

### Notes

- F7 的检查器帧缓冲在扩展宿主内存中（每帧截断 2 KB、上限 300 帧），不落盘、
  不外发；重启侧栏即清空。
- F6/F8 在不提供端点的旧宿主上自动隐藏为不可用提示——与 fork/rename 等
  既有控制面的门控策略一致。

## [0.0.9] — 2026-10-01

Tagline: **交互闭环 — 模型选择器、审批自动通过、排队/转向、Slash 命令、Token 用量面板。**
Tagline (EN): **the interaction loop — model picker, auto-approve, queue/steer, slash commands, token usage panel.**

v0.0.8 把线缆钉死到了真实契约（`0.2.0-rc.2`）但控制面只读；本版本补齐 P1 交互闭环，
并新增 Token 用量统计（含官方网页同款的缓存命中率）。

### Added

- **F1 模型 + 推理强度选择器。** `session/modelCatalog` 拉取目录（分组/模型/推理档位），
  `session/selectModel` 下发切换；UI 按能力探测门控。
  *EN:* model + reasoning-effort picker backed by `session/modelCatalog` /
  `session/selectModel`, capability-gated.
- **F2 审批自动通过。** 新设置 `deepseekHarness.autoApproveApprovals`（默认 `false`）：
  开启后插件对 `approval/request` 自动回 `allowed-once`（走既有 `/api/$events/result`）。
  *EN:* auto-approve incoming approval requests via the new setting (off by default).
- **F3 沙箱模式切换。** v0.0.8 只渲染 `sandbox/mode`，本版本可切换（与 permission 面板同构）。
  *EN:* the sandbox-mode control now switches, not just renders.
- **F4 排队 / 转向消息。** 队列条渲染 `inbox.next-turn` 投影；运行中可 steer 注入当前回合
  （`session/prompt` mode:'steer'）或 `session/updateQueue` 转向/移除队列项。
  *EN:* queued-message bar with steer/remove (`session/updateQueue`) and
  steer-mode prompts (`session/prompt`).
- **F5 Slash 命令面板。** 输入 `/` 弹出 `commands/list` 注册表补全；执行走 **`commands/execute`**
  （`{agentId, line, submittedAttachments:[]}`）。
  *EN:* slash-command completion popup from `commands/list`; execution goes through
  `commands/execute`.
- **Token 用量面板。** 双通道数据：`assistant/message.data.usage` 事件折叠 +
  `session/list` 投影（权威全量）。展示输入/输出/缓存读/缓存写/推理 token、
  总量与**缓存命中率**（官方网页同口径），以及回合/步数/LLM 耗时等会话统计。
  *EN:* token-usage panel (input/output/cache-read/cache-write/reasoning, totals,
  cache-hit percentage) folded from events and reconciled with host projections.

### Fixed

- **`session/command` → `commands/execute`。** v0.0.8 的 `runCommand`（plan/permission/compact
  命令路径）依赖 rc.2 **不存在**的 `session/command`，对真机永远是 404。现改为真机写路径
  `commands/execute`。*EN:* slash-command execution moved from the non-existent
  `session/command` to the real rc.2 write path `commands/execute`.
- **`session/prompt` 补 `requestId`**（rc.2 必填的客户端自签身份），并支持 `mode` 参数。
  *EN:* prompts now carry the required client-minted `requestId` and a `mode`.
- **`session/selectModel` 参数修正**：`{request:{sessionId, provider, model, reasoningEffort?}}`
  （provider 必填）；`session/updateQueue` 走 `{request:{sessionId, itemId, action}}`。
  *EN:* corrected arg shapes for `selectModel` (provider required) and `updateQueue`.

### Changed

- 回归门扩到 **91 项断言**（假 harness 新增 `commands/execute`、`commands/list`、
  rc.2 形状的 `modelCatalog`；覆盖 selectModel/updateQueue/prompt-requestId/commands 形状）。
  *EN:* regression gate grown to **91 assertions** covering the new methods and shapes.

## [0.0.8] — 2026-09-19

Tagline: **the real wire contract — DeepSeek Harness `0.2.0-rc.2`.**

v0.0.7 was released against an inferred `0.1.0-rc.6` model that still did not match
the host actually running on the machine (which is **`0.2.0-rc.2`**). The handshake was
verified live against that host, and the transport layer is now rewritten to its real
shape. This release pins the documented contract to what the host truly serves.

### Fixed (wire contract corrected to 0.2.0-rc.2)

- **Unary RPC envelope.** Calls are `POST /api/<ns>/<method>` (slash style) with body
  `{ type:'client-request', rpcId, method, payload:{ args:<inner> } }` — `payload` **must**
  wrap `{args}`. The inner field is `_request` for `session/list`, `request` for most
  methods, and `{}` for the few no-arg ones.
- **Response envelope.** `{ type:'server-response', rpcId, result:{ ok, value|error } }`.
  A missing method returns **HTTP 404 + plain-text `not found`** (not a JSON error), so
  capability probing distinguishes "absent" from "wrong arg shape".
- **Event socket.** `ws://host:port/api/remote.mux` — a **bidirectional** logical-stream
  mux. The client opens it and sends `{ type:'open', streamId, endpoint:'$events',
  payload:{args:{}} }`; the host's first frame is `{ type:'ready', clientId, host:{ home } }`.
- **Approval flow.** The wire event is `approval/request` (rendered as
  `approval/requested`); it is settled by `POST /api/$events/result` with body
  `{ clientId, eventId, outcome }` — not the old `/api/respond`.
- **History.** Fetched via the unary `session/page` RPC, **not** `session/history`.
- **Auth.** The host requires the browser-session cookie on every `/api/*` call (401
  without it). autoSession still mints it locally from `$DSH_HOME/.credentials.yaml`.

### Changed

- **Transport rewrite (rc.2).** `harness/protocol.ts` (envelope + arg spellings),
  `harness/events.ts` (`RemoteMuxSocket` + `ready`-frame handling), `harness/client.ts`
  (slash endpoints, `{args}` payload, `$events/result` approval, `session/page` history),
  and `harness/wire.ts` (negotiation + capability probing) now target `0.2.0-rc.2`.
- **Control-surface capability set (rc.2).** Present: `session/fork`,
  `session/rename`, `session/selectModel`, `session/updateQueue`,
  `workspace/archiveSession`, `session/page`, `workspace/create`, `session/modelCatalog`.
  **Absent** in rc.2: `session/command`, `agentPreset/*`, `subagent/*`, `host/describe`,
  `workspace/list`, `llm/models`, `session/history`, `goal/*`. The UI gates each control
  on a live probe, so older/newer hosts simply show fewer controls.
- **Regression gate rewritten.** `scripts/protocol-test.ts` now drives a real rc.2 fake
  harness (slash endpoints, `{args}` wrapper, `/api/remote.mux` + `ready` frame,
  `$events/result` approval, `session/page` history, 404-not-found probing, rc.2 control
  gating) — **83 assertions pass**, no `dsh web` required.
- `scripts/protocol-probe.ts` reports the negotiated rc.2 control surface.

### Notes

- Endpoint strings still go through `WireProfile` (negotiated slash/dot + arg spelling),
  so a future host that flips any axis keeps working without a code change.

## [0.0.7] — 2026-09-30

> ⚠️ **Protocol correction.** This release targeted an *inferred* `0.1.0-rc.6` model that
> still did not match the host actually running on the machine. The real contract is
> **`0.2.0-rc.2`** — see [0.0.8] for the corrected transport layer.

Tagline: **握手成功——连上真实的 `dsh web`（rc.6）。**

插件此前按一个并不存在的线缆契约（`0.1.6-alpha`）实现，而本机真正安装的运行时是
`0.1.0-rc.6`，两者并不兼容：rc.6 没有 `ready` 帧、没有 `$events` 逻辑流 mux、没有
`session/follow` 流、也没有 `$events/result` RPC。于是 v0.0.6 在 **Windows 和 Ubuntu**
上都卡在死等一个永远不会到达的 `ready` 帧（10 秒超时）。本版本用真实的 rc.6 传输模型
替换掉那套虚构模型。

### Fixed

- **握手不再超时。** 事件套接字改为下行单向 WebSocket（`ws://…/api/events.mux`）；连接打开即就绪信号，
  因此 `connect()` 在套接字一打开就继续，而不再死等某个帧。
- **正确的 RPC 信封。** 一元调用发送 `POST /api/<ns>.<method>`，`payload` 就是参数对象本身
  （`callUnary` 的契约）——绝不再包一层 `{args}` / `{request}`。整套 `RemoteStreamMux` /
  `session/follow` / `$events/result` 机制已删除。
- **历史改回一元 RPC。** `getHistory()` 调用 `session.history`（`{ sessionId, maxMessages? }`）
  并折叠返回的事件；已删除的 `session/follow` 快照路径被移除。
- **审批改走 `POST /api/respond`。** `approval/requested` 帧携带 `sessionId` + `approvalId`；
  `respondApproval()` 用这对信息 POST 一个 `client-response` 信封。
- **恢复 `host.describe`。** 该端点在 rc.6 中存在，连接时调用一次以获知 host 身份
  （version/cwd/provider/model）。

### Changed

- **`harness/client.ts` 按 rc.6 契约重写**；`events.ts` / `protocol.ts` / `wire.ts` 修正为真实的帧形状
  （`server-request` 信封、`session/event` 以 `assistant/chunk` 承载流式）。UI 层
  （`controller` / `view` / `control`）未改动——它们消费的本来就是正确的 `MuxFrame` 联合类型。
- **回归门已更新。** `scripts/protocol-test.ts` 现在用真实的 rc.6 假 harness 驱动真实传输
  （86 项断言：协商、mux 下行、host.describe、session.history、/api/respond、控制面，以及对受限
  host 跑 autoSession cookie 机制）。

## [0.0.6] — 2026-09-19

Tagline: **the control surface — the knobs the harness has always shipped.**

The host has been sending `plan/mode`, `permission/preset`, `sandbox/mode`,
`todo/write`, `goal/change`, `subagent/*` and `compaction/*` all along, and the
plugin rendered none of them. That made the sidebar look half-finished next to
the official Web UI even though the session itself was shared. This release
shows them and — where the host allows — lets you change them.

### Added

- **`src/conversation/control.ts` — the control-surface fold.** Those events are
  *whole values* upstream (the latest occurrence wins, and replay must
  reconstruct state from the log alone), so the fold is a pure last-write-wins
  projection over history plus live frames. `request/header` additionally yields
  the effective provider / model / reasoning effort.
- **Capability probing.** `wire.ts` now asks the host which control methods it
  serves (`session/command`, `session/fork`, `session/rename`,
  `session/selectModel`, `workspace/archiveSession`, `agentPreset/*`,
  `subagent/list`, `llm/models`) and caches the answer on the profile. Probes
  send empty args on purpose: parameter validation runs before any handler, so a
  rejection proves the method exists and can never mutate session state.
- **Control writes** on `HarnessClient`: `runCommand` (the shared write path —
  upstream routes plan, permission and compaction through the command registry),
  `togglePlanMode`, `setPermissionPreset`, `compactSession`, `forkSession`,
  `renameSession`, `selectModel`, `archiveSession`.
- **`rpcVariants()`** — tolerates the several `{args}` spellings upstream has
  shipped (`request`, `_request`, bare fields) by treating an argument-shape
  rejection as "wrong spelling", not "missing method". The winning *spelling* is
  cached, never the argument values.
- **A Controls panel** in the sidebar: plan toggle, permission-preset picker,
  sandbox/approval/model badges, todos, the active goal, subagent activity, the
  last compaction summary, and Fork / Rename / Compact / Archive actions — each
  offered only when this host serves its write path.
- Six commands: `Toggle Plan Mode`, `Set Permission Preset`,
  `Compact Session Context`, `Fork Session`, `Rename Session`,
  `Archive Session`.
- `npm run protocol-probe` now prints the negotiated control surface.

### Changed

- `protocol-test` grew from 64 to **98 assertions**, covering capability probing
  (present / HTTP-404 absent / not-found-code absent / shape-rejection present),
  the control writes, a host with no control surface at all, and the whole-value
  fold semantics including goal clear, subagent roster reconciliation and reset.

### Notes

- `HarnessUnsupportedError` is raised when a control's endpoint is absent; its
  message names what is missing rather than failing as a bare 404.

## [0.0.5] — 2026-09-19

Tagline: **the wire is negotiated, not assumed.**

v0.0.4 hardcoded a single wire shape (slash endpoints, `/api/remote.mux`,
cookie auth). None of the artifacts on the machine agreed with it: the installed
runtime (`0.1.0-rc.6`) serves `/api/session.list` over `/api/events.mux` with no
cookie at all, while the host that produced the original 401 clearly *is*
cookie-gated. Guessing lost; this release measures instead.

### Added

- **`src/harness/wire.ts` — protocol negotiation.** On every connect the client
  discovers: endpoint style (`session/list` vs `session.list`), whether `/api/*`
  is cookie-gated, the event-socket path, and the declared-parameter spelling
  `session/list` actually accepts. The result is cached in a `WireProfile` and
  every endpoint string in the client now goes through it.
- **`npm run protocol-probe`** — asks a live `dsh web` what it serves: endpoint
  style, event socket, and which of 29 candidate methods exist. This is now the
  authoritative way to settle any wire question.
- `httpStatus()` and `httpRequest({ timeoutMs })` — header-only probing with a
  bounded wait, so an event stream cannot hold a probe open.

### Changed

- `rpc()` no longer demands a cookie unless the negotiated profile says the host
  is cookie-gated, so unauthenticated hosts no longer fall into the paste flow.
- A `404` now names the negotiated wire style instead of a hardcoded upstream
  version.
- `session/list` args come from negotiation rather than the `_request` literal.
- `protocol-test` grew from 50 to **64 assertions**, including a dot-style host,
  an unauthenticated host, a cookie-gated host, and a dead port.

### Fixed

- Removed the last hardcoded `0.1.6-alpha` assumptions from the client.

## [0.0.4] — 2026-09-18

Tagline: **DeepSeek Harness 0.1.6-alpha wire-protocol migration.**

Harness 0.1.6-alpha made three breaking changes to the wire protocol that
returned `401` / `404` for every call this extension made. Every one of them
is now implemented natively.

### Breaking changes upstream (the reason for this release)

1. **`/api/*` now requires a browser session cookie.** The cookie is named
   `dsh-auth-<b64url(sha256(host:port))>`. Without it every call 401s — which
   is what the old `host.describe` failure looked like.
2. **RPC endpoints were renamed** from `a.b` (`host.describe`) to
   `namespace/method` (`session/list`). `host.describe` itself was deleted
   outright (`packages/host/apiproxy` removed), along with `session.history`
   and `workspace/list`.
3. **The event channel became bidirectional.** The downlink-only
   `/api/events.mux` WebSocket was replaced by `/api/remote.mux`, a logical
   stream multiplexer: RPC and subscriptions both run as streams over one
   socket.

### New features

- **Browser-session authentication.** New `src/harness/auth.ts` adopts a
  `dsh web` launch URL, follows the 303 `Set-Cookie` exchange, and persists the
  cookie. Cookies live in VS Code `context.secrets` (OS keychain) — never in
  `settings.json`.
- **New commands** — `DeepSeek Harness: Set Session Token from Launch URL` and
  `DeepSeek Harness: Clear Session Token`. Both are also reachable from the
  session-view title bar.
- **Actionable errors.** A missing/stale session now reports *why* and names the
  exact command to run, instead of surfacing a bare `401`. A deleted endpoint
  reports `HTTP 404 on /api/host.describe — the running harness does not expose
  that endpoint` with upgrade guidance.
- **Connectivity is proven by `$events` readiness.** `connect()` no longer
  trusts a successful HTTP probe; it waits for the `$events` `ready` frame,
  which also carries `clientId` and `host.home`.

### Protocol mapping (old → new)

| Old | New |
| --- | --- |
| `host.describe` | `$events` ready frame (`home`, `clientId`) + `session/modelCatalog` (`provider`, `model`) |
| `events.mux` (downlink only) | `remote.mux` (bidirectional logical streams) |
| `session.history` | `session/follow` snapshot (or `session/page`) |
| `workspace/list` | `workspace/follow` baseline frame |
| `POST /api/respond` | `$events/result` RPC — `{clientId, eventId, outcome:{kind:'result', value:'allowed-once'\|'rejected'}}` |
| `assistant/chunk` (durable log) | out-of-band assistant stream frames via `session/follow` |
| `{...params}` RPC payload | `{args:{<declaredParamName>: value}}` — e.g. `{_request:{}}` for `session/list` |

### New modules

- `src/harness/auth.ts` — `BrowserSessionAuth`, cookie derivation, launch-URL adoption, persistence, optional local mint
- `src/harness/local-credentials.ts` — reads the harness signing secret to mint a cookie without a paste
- `src/harness/http.ts` — `node:http` client (platform `fetch` has no cookie jar)
- `src/harness/ws.ts` — minimal RFC 6455 WebSocket client, because browser-shaped `WebSocket` cannot send the `Cookie` header required by the mux upgrade
- `scripts/protocol-test.ts` — fake-harness protocol test, 50 assertions

### Bug fixes

- Streaming assistant deltas moved out of the durable log in 0.1.6 and have no
  real `seq`, so they were silently dropped by the model's seq guard. Added
  `ConversationModel.applyStreamChunk(turn, step, chunk)` to bypass it.
- Approval replies are keyed by `eventId` (the waterfall event), not the old
  `approvalId`; `agentId` is used as the session id.
- Changed `host`/`port` now calls `client.retarget()` + reconnect instead of
  rebuilding the client (which leaked the old mux socket).
- Editor context is rendered into the prompt text via `renderContextBlock()`
  because the new `session/prompt` has no `context` field.
- A cookie that is well-formed, unexpired and authority-correct but still
  rejected by the host was reported as "expired", sending users after the wrong
  fix. It now reports that the host's signing secret was rotated.
- A refused `/api/remote.mux` upgrade sat until the open timeout and then blamed
  a generic timeout. It now fails fast with the actionable auth error (the mux
  status carries the HTTP status of the refused upgrade).
- **Zero-paste connection.** With `deepseekHarness.autoSession` on (default), the
  extension mints the browser-session cookie from the harness's own persisted
  signing secret in `$DSH_HOME/.credentials.yaml` — byte-identical to one `dsh web`
  would issue — so no launch URL is ever pasted. Set it to `false` to force the
  sanctioned token exchange. The path used is logged on every connect.

### Session lifetime

The launch **token** dies with the `dsh web` process, but the **cookie** it buys
is signed with a secret persisted in `$DSH_HOME/.credentials.yaml` and is valid
for **30 days** by default. The extension stores that cookie, so restarting
`dsh web` does **not** require re-running Set Session Token. Re-entry is only
needed after the 30-day expiry, a `host`/`port` change (the cookie name is
`dsh-auth-<sha256(host:port)>`), or a wiped/regenerated credentials file.

### Verification

- `tsc --noEmit` — 0 errors
- Production build — `dist/extension.js` 98.4 kb
- `scripts/protocol-test.ts` — 50/50 assertions pass against a fake 0.1.6 harness
  (includes local mint from the credential store, autoSession-off guard, cookie-survives-restart and rotated-secret reporting)

## [0.0.3] — 2026-08-16

Tagline: **Diff Review, Approval Workflow & File Context Inlining.**

Closes the biggest experience gap with Cursor/Cline: code changes can now be
reviewed and approved entirely inside VS Code, without switching to the Web UI.

### New features

- **Diff Review & Inline Code Application.** When the agent writes or edits
  files, a review card appears in the sidebar showing each changed file with
  `+added`/`-removed` line counts. Click **Diff** to open VS Code's native
  diff editor (via `dsh-review://` virtual documents). Accept (keep changes)
  or Reject (safe revert via `git checkout`) per-file or all at once. Review
  transactions are tracked by `callId` and linked to the originating tool call.
- **Approval Workflow Integration.** `approval/requested` events now render
  inline as cards with **Allow once** / **Deny** buttons — no more switching to
  the browser. A security allowlist restricts which tools can be approved from
  VS Code; high-risk operations still require the Web UI. Responses are sent
  via `POST /api/respond`.
- **@file Content Inlining.** File references (`@file:path` or
  `@file:path:L10-L20`) now have their content read and inlined directly into
  the user message text (wrapped in `<file path="…">` tags), guaranteeing the
  agent can see file content even when the backend doesn't process the
  `context` field. The `context` metadata (active file, selection) is only
  attached on the **first prompt** of a session to avoid redundant sends.
- **Context Menu Integration.** Right-click a file in the explorer →
  **Add to Harness Chat** inserts an `@file:` reference. Select text in the
  editor → right-click → **Send Selection to Harness** inserts
  `@file:path:L10-L20`. Both use workspace-relative paths for readability.

### Bug fixes

- **@file regex on Windows.** Added negative lookahead `(?!L\d)` to prevent
  `:L<digits>` line ranges from being consumed as part of the file path
  (critical for Windows paths like `e:\folder\file.ts:L10`).
- **Webview regex escaping.** Template literal double-escaping for `\s`/`\d`
  in the webview's `parseAtFilePreview` — without it, `[^\s:]` became
  `[^s:]` which does not exclude whitespace.
- **Skip non-file documents.** `collectEditorContext` now skips documents
  whose URI scheme is not `file` (Output panel, Settings, etc.).
- **Input clearing on @file-only input.** When the input contains only
  `@file:` references, the chat now shows a readable summary like
  `(See: file.ts:L10-L20)` instead of being cleared.

### New modules

- `src/review/` — `ReviewController`, `ReviewStore`, `ReviewVirtualDocumentProvider`,
  `ReviewMaterializer` (6 files, ~500 lines)
- `src/approval/` — `ApprovalStore`, types (2 files, ~150 lines)

---

## [0.0.2] — 2026-08-15

Tagline: **Conversation UX & Architecture Baseline.**

The "main-branch last direct-push release": hardens structure, rendering
correctness, and interaction UX so that v0.0.3+ can be developed entirely via
feature PRs onto stable boundaries.

### Architecture (structural boundary hardening)

- **`src/app/controller.ts` + `state.ts`** — new `AppController` owns all
  orchestration (connect/disconnect, workspace lifecycle, session lifecycle,
  prompt/cancel, mux dispatch, UiState push). `extension.ts` stays as pure
  wiring: `activate() / deactivate()`, `readConfig()`, command registration,
  and dependency instantiation only.
- **`src/conversation/`** — `ConversationModel` replaces the flat `SessionModel`.
  Events no longer map 1:1 to renderable items; instead they project into
  conversation-semantic `ConversationItem[]` (`user`, `assistant`, `system`,
  `tool`, `status`).
- **`src/workspace/binding.ts`** — workspace creation is split into
  `findHarnessWorkspace()` (discovery, connect-time) and `ensureHarnessWorkspace()`
  (create-on-demand, send-time). The old `resolveHarnessWorkspace()` that
  eagerly prompted for creation inside the connect flow has been removed.
- **`src/view/` split** — `provider.ts` (composition only) is now joined by
  sibling modules: `styles.ts`, `html.ts`, `client.ts` (webview-side JS), and
  `toolPresentation.ts`. React/Preact/Vite are deliberately NOT introduced;
  vanilla DOM continues to carry a couple more releases.

### UX fixes

- **Lazy workspace + session on first Send.** When the user opens a repo
  without a matching Harness workspace, the sidebar stays usable and shows a
  *"Not registered yet — will be created lazily on first send"* banner. The
  first `Send` implicitly creates workspace → creates session → sends the
  prompt, with no confirmation modals. The input textarea is only cleared
  after the optimistic echo reaches the snapshot; prompt text is not lost on
  creation failure.
- **Tool cards are now one item.** `tool/call` + matching `tool/result` are
  merged into a single `ToolItem` owned by `callId`. The sidebar renders a
  collapsed header `🔧 read src/session.ts → ✓ done` that you click to expand
  Arguments + Result. This eliminates the "pink tool-result block" noise.
  `toolPresentation.ts` provides a name-aware pretty title (read, grep, bash,
  write, edit, git_*, …).
- **System messages are their own item kind.** `SystemItem` no longer reuses
  `UserItem` with a `system: true` flag. All downstream filtering is based on
  `item.kind === 'system'` — no more `if user && system` spreads. Default UI
  is a single collapsed line `▸ Runtime context · @deepseek-ai/dsh-system-prompt`.
- **Assistant Markdown rendering.** `markdown-it` (with `html: false`,
  `linkify: true`) runs **inside the webview**, not the extension host, so
  `ConversationModel` stays semantic-only. User/System messages still render
  with `textContent`. Links open with `target=_blank rel=noopener` and
  `javascript:`/`data:` URLs are stripped. Tool results stay `<pre>` for now.
- **Streaming text now always re-renders.** Each model mutation bumps a
  monotonically increasing `renderVersion`. The webview rebuilds the message
  list **solely** on `snapshot.renderVersion` change — previously, an
  assistant streaming update would often fall through stale `lastSeq` /
  `items.length` signature checks and skip the re-render entirely.

### Test coverage

- Integration test upgraded to exercise `ConversationModel`. New assertions:
  - `renderVersion` strictly increases after a prompt run (1 → 19 in the
    standard "pong" flow).
  - No `tool-call` / `tool-result` kinds leak into `ConversationItem` (they
    are merged; this is enforced both at the type level and at runtime).
  - `systemMessageCount` is tracked separately from user items.

### Discipline

- Explicit **NOT in v0.0.2**: Diff review, approval/respond, inline
  completion, context injection, filesystem provider, terminal integration,
  LSP/ACP/SDK abstractions, transport interfaces. All of these start life as
  feature branches / PRs from v0.0.3 onward.

---

## [0.0.1] — 2026-08-15

The first public release. This version proves **one** thing: VS Code and the
browser share the same DeepSeek Harness session.

```
Browser ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘

Same Workspace. Same Session. Same Agent Runtime.
```

### Added

- **Connect** to a local `dsh web` instance via `HTTP /api/*` + `WebSocket /api/events.mux`.
  Loopback-only trust fence (`127.0.0.1` / `localhost` / `::1`); any other host
  is refused with a clear message.
- **Workspace mapping** — match the active VS Code folder to an existing Harness
  workspace by canonical path; offer to create one if absent (no second workspace ID).
- **Session list** filtered by the resolved workspace, with `+ New Session`.
- **Session history** loaded from the Harness (the single source of truth — no
  local session DB, no `.vscode/deepseek-sessions.json`).
- **Plain-text prompt** sent to the active session.
- **Live streaming** of `assistant/chunk` deltas and tool activity, coalesced by
  an `EventBuffer` that flushes at most every ~30 ms (no per-token re-render).
- **Stop / cancel** the active turn.
- **Reconnect** — on WebSocket close→open, the stream reopens and history is
  refetched (the documented Harness resume semantic is *rebuild*, not cursor-resume).
- **Open Web UI** command (opens `http://127.0.0.1:<port>`; session deep-links are
  intentionally not guessed).
- **Show Logs** command → the `DeepSeek Harness` output channel.
- **Sidebar webview** (vanilla JS, no React) with connection status, workspace,
  session dropdown, message list, input + Send/Stop.
- **Right-side docking** — a "Move to Right Side Bar" command (⇲ button in the
  webview header) relocates the view to the secondary side bar so it no longer
  competes with the file explorer.
- **System-message hiding** — plugin-injected `user/message` frames (e.g.
  `@deepseek-ai/dsh-system-prompt` runtime context, `user-approval` notices)
  are detected via `source.kind !== 'user'` and hidden by default. A `SYS`
  toggle in the header reveals them; the `deepseekHarness.showSystemMessages`
  setting controls the default.
- **Brand icon** — a generated 128×128 PNG (`media/icon.png`) serves as the
  Marketplace icon and the webview header logo; the SVG activity-bar icon uses
  `currentColor` to adapt to the theme. Regenerate with `npm run gen-icon`.
- **Protocol fixtures** (`test/fixtures/`) — sanitized captures of the live wire
  format for detecting upstream protocol drift.
- **Protocol spike** (`scripts/protocol-spike.ts`) and **integration test**
  (`scripts/integration-test.ts`) — standalone Node validation of the full loop
  against a running `dsh web`.

### Security

- Method allowlist: only `host.describe`, `workspace.{list,create}`,
  `session.{list,history,create,prompt,cancel}`.
- Never calls `/api/respond`, `settings.*`, `credentials.*`, `commands.*`, or any
  approval / permission mutation.
- `approval/requested` and `question/requested` frames surface **only** an
  information message ("Action requires approval in DeepSeek Harness Web UI") and
  never respond on the user's behalf.

### Verified against

- DeepSeek Harness host `v0.0.1` (`@deepseek-ai/dsh-root`), default `dsh web`
  port `3080`.
- Wire contract source: `packages/host/apiproxy/src/api/` (authoritative).
- Integration test: 11/11 checks pass against a live local `dsh web`.

### Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- Text prompts only (no image attachments).
- History loads the last ~50 messages; "load older" is deferred.
- Session deep-links in "Open Web UI" are intentionally not guessed.
- Unknown harness event types are ignored (the protocol is merge-extensible);
  they do not crash the client but also do not render.

[0.0.1]: https://github.com/liangwythu/deepseek-harness-vscode/releases/tag/v0.0.1
