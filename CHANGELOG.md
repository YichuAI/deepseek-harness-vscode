# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
