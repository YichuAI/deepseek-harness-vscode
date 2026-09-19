# Architecture — DeepSeek Harness VS Code v0.0.2

One page. Three stable boundaries: **wiring** (`extension.ts`), **orchestration** (`AppController`), **semantics** (`ConversationModel`). Future feature PRs extend outward from these boundaries, not inward.

## Layers (high cohesion, low coupling)

```
┌──────────────────────────────────────────────────────────────────┐
│ extension.ts              — wiring ONLY (activate, commands, cfg)│
├──────────────────────────────────────────────────────────────────┤
│ app/controller.ts         — AppController: connect/ws/session/   │
│ app/state.ts              — UiState shape + pure mapping helpers │
├──────────────────────────────────────────────────────────────────┤
│ conversation/model.ts     — ConversationModel: event → conv item │
│ conversation/types.ts     — ConversationItem union (5 kinds)     │
│ workspace/binding.ts      — findHarnessWorkspace / ensureHarness │
├──────────────────────────────────────────────────────────────────┤
│ view/provider.ts          — webview composition (HTML + CSP)     │
│ view/styles.ts            — CSS                                 │
│ view/html.ts              — HTML skeleton                       │
│ view/client.ts            — webview-side JS (render + markdown)  │
│ view/toolPresentation.ts  — tool name → human title             │
├──────────────────────────────────────────────────────────────────┤
│ harness/client.ts         — HarnessClient: the ONLY network edge │
│ harness/events.ts         — RemoteStreamMux + EventBuffer (30ms) │
│ harness/ws.ts             — minimal RFC6455 client (Cookie-capable)│
│ harness/auth.ts           — browser session cookie (token → cookie)│
│ harness/http.ts           — node:http wrapper (exact Cookie/Set-Cookie)│
│ harness/protocol.ts       — wire types (mirror of upstream Remote)│
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` is **types only** — zero runtime, zero dependencies. It mirrors the DSH 0.1.6-alpha Remote (Typert Gateway) contract: `packages/client/connection/src/rpc-host.ts`, `packages/api/gateway/src/stream-protocol.ts`, `packages/api/session-controller/src/types.ts`, `packages/api/workspace-controller/src/types.ts`, `packages/api/remotes/src/remote-events.ts`.
- `harness/client.ts` is the **single** module allowed to make HTTP requests or open sockets. Everything above it goes through `HarnessClient`.
- `harness/ws.ts` implements the handshake and frame codec itself rather than using the platform `WebSocket`: a browser-shaped WebSocket cannot set arbitrary request headers, and the mux upgrade now requires a `Cookie`.
- `harness/auth.ts` is the only credential source. It takes the process token out of the `dsh web` launch URL, exchanges it via `GET /?token=…` for a `Set-Cookie`, and keeps the cookie in VS Code SecretStorage (`context.secrets`) — never in settings.json.
- `conversation/model.ts` is a pure fold (`SessionEvent[] → ConversationItem[]`); it has no network and no VS Code dependency, so it is unit-testable under plain Node.
- `app/controller.ts` owns all orchestration (connect/disconnect, workspace lifecycle, session lifecycle, prompt/cancel, mux dispatch, UiState push). `extension.ts` is pure wiring.
- `view/provider.ts` is a **pure composition layer**: it assembles HTML from `styles.ts` + `html.ts` + `client.ts` + markdown-it UMD, and bridges state/actions. No state lives in the provider.

## ConversationItem projection (v0.0.2 upgrade)

The old `SessionModel` mapped events 1:1 to render tiles (`tool-call` → one card, `tool/result` → another card). v0.0.2 replaces this with a **conversation-semantic projection**:

```ts
type ConversationItem =
  | UserMessageItem      // kind: 'user'
  | AssistantMessageItem // kind: 'assistant' (streaming flag, usage, reasoning)
  | SystemItem           // kind: 'system' (own type, not UserItem + flag)
  | ToolItem             // kind: 'tool' (call + result MERGED by callId)
  | StatusItem           // kind: 'status' (turn start/end)
```

Key changes:
- **Tool call + result merged**: `tool/call` creates a `ToolItem`; `tool/result` updates the **same** `ToolItem` by `callId` (state → `completed`/`error`). No more separate result tiles.
- **SystemItem is its own kind**: no `UserItem { system: true }` flag. Filtering is `item.kind === 'system'`, not `user && system`.
- **`renderVersion`**: monotonically increments on EVERY model mutation (including streaming text deltas). The webview uses this as the sole change-detection signature — fixes the "streaming text changed but same seq → no re-render" bug.

### Event fold

`ConversationModel.applyEvent` switches on `event.type`:

| Event | Fold |
| --- | --- |
| `user/message` | → `user` or `system` item (system if `source.kind !== 'user'`); optimistic echo reconciled |
| `assistant/chunk` (`text-delta` / `reasoning-delta`) | accumulate into streaming `assistant` item at tail |
| `assistant/message` | finalize the `assistant` item (authoritative — replaces streaming text) |
| `tool/call` | → create `ToolItem` (state: `running`) |
| `tool/result` | → **update** existing `ToolItem` by `callId` (state: `completed`/`error`) |
| `turn/start` / `turn/end` | → `status` line; sets `running` |
| `session/title` | updates the snapshot title |
| **any other type** | **ignored** (the harness protocol is merge-extensible) |

Replays are idempotent (`seq`-guarded), so reconnect → refetch history is safe.

> **Assistant deltas left the durable log in 0.1.6.** They now arrive on the
> process-local assistant stream and carry no real `seq`, so they **bypass** the
> monotonic-seq guard in `applyEvent` and go through
> `ConversationModel.applyStreamChunk(turn, step, chunk)`. Folding them into
> `applyEvent` with synthetic seqs makes each delta suppress the previous one,
> leaving only the first visible.

## Wire contract (negotiated at connect; validated by `scripts/protocol-test.ts`)

Three things have drifted between host releases, and hardcoding any of them is
what broke earlier versions. `harness/wire.ts` therefore *discovers* the wire on
every connect rather than assuming a release:

| # | Axis | Variants seen | How it is discovered |
| --- | --- | --- | --- |
| 1 | Auth | none / browser-session cookie | every probe answering 401 ⇒ cookie-gated |
| 2 | Endpoint naming | `session.prompt` vs `session/prompt` | POST both shapes; a `server-response` wins, 404 ⇒ not this shape |
| 3 | Event channel | `/api/events.mux` vs `/api/remote.mux` | header-only GET; anything but 404 exists |

A fourth axis is negotiated too: `session/list` has shipped with three different
declared-parameter spellings (`_request`, `request`, none), so each is tried
until one returns `ok`. The result is a `WireProfile`, cached for the session and
routed through `HarnessClient.ep()` — no other module writes an endpoint literal.

A fifth axis answers a different question: **which control methods exist at
all?** `probeCapabilities()` asks once per connect and records the answer on
`WireProfile.capabilities`, so the sidebar offers a control only when the host
serves its write path (see *Control surface* below).

Run `npm run protocol-probe` against a live `dsh web` to print what that host
actually serves.

### Auth: browser session cookie

```
dsh web prints: dsh web: http://127.0.0.1:3080/?token=<43-char base64url>   ← per process, never on disk
GET /?token=<token>           → 303 See Other + Set-Cookie
every later request:          Cookie: dsh-auth-<b64url(sha256("<host>:<port>"))>=v1.<payload>.<hmac>
```

- The cookie name derives from the **authority** (the `Host` header, i.e.
  `host:port`), so changing the port invalidates it.
- The signing secret is persisted in `$DSH_HOME/.credentials.yaml` under
  `client-connection/browser-session`, so the cookie survives `dsh web` restarts
  (30 days by default).
- We never mint a cookie ourselves: the token exchange is the sanctioned path,
  and self-signing would bypass the gate rather than satisfy it.
- See `harness/auth.ts`; the cookie lives in `context.secrets`, not settings.json.

### Unary RPC — `POST /api/<namespace>/<method>`

```jsonc
// headers
Cookie: dsh-auth-…=v1.…
Content-Type: application/json
// body: payload must be exactly one `args` field, holding a plain object
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
  "payload": { "args": { "request": { "requestId": "…", "sessionId": "…", "mode": "queue",
                                     "content": [{ "type": "text", "text": "…" }] } } } }
// response
{ "type": "server-response", "rpcId": "<same>", "result": { "ok": true, "value": { … } } }
```

**`args` field names are the declared parameter names upstream**, and one extra or
missing field is rejected by `assertExactArguments` (`gateway/arguments-invalid`).
Two traps:

- `session/list`'s parameter is literally named `_request`, so the payload is
  `{ "_request": {} }`.
- A cancellation `AbortSignal` is a **transport** parameter (its name must be
  exactly `signal`) and is **not** a JSON field.

Business errors are `200` + `{ ok: false, error: { code, message, details } }`;
HTTP status expresses only the carrier (`401` unauthenticated / `404` no such
endpoint / `415` not JSON).

### Event channel — `WS /api/remote.mux` *(negotiated)*

`remote.mux` is what recent builds serve; older ones served `events.mux`. The
path actually used comes from `WireProfile.muxPath`, never from a literal here.
On a cookie-gated host the upgrade requires the cookie too; on `401` the server
writes a plain HTTP response and never sends `101`.

```jsonc
// client → host
{ "type": "open", "streamId": "s1", "endpoint": "session/follow", "payload": { "args": { … } } }
{ "type": "cancel", "streamId": "s1" }
// host → client
{ "type": "item",  "streamId": "s1", "value": { … } }
{ "type": "end",   "streamId": "s1" }
{ "type": "error", "streamId": "s1", "error": { "code": "…", "message": "…", "details": {} } }
```

This plugin uses three logical streams:

| endpoint | args | Purpose |
| --- | --- | --- |
| `$events` | `{}` | Forwarded host events (including approval waterfalls); the first item is `ready`, carrying `clientId` and `host.home` |
| `session/follow` | `{ request: { address: { kind:'session', sessionId }, maxMessages, assistantStream: true } }` | Journal snapshot + later durable events + assistant-stream frames |
| `workspace/follow` | `{}` | First item is `baseline`; replaces the deleted `workspace/list` |

`session/follow` items are `{ type:'snapshot', header, cursor, records, hasMore, projections }`,
`{ type:'event', event: SessionEvent }` and `{ type:'assistant-stream', frame }`.

### How the client translates the new transport back

`HarnessClient` projects the new transport into the legacy frame shapes the UI
already consumes, so `conversation/model.ts` and `approval/store.ts` are unchanged:

| New transport | Frame handed to the UI |
| --- | --- |
| `session/follow` snapshot records | `{ type:'session/event', sessionId, event }` (idempotent replay) |
| `session/follow` `event` item | same |
| `assistant-stream` `chunk` | `{ type:'assistant/stream', turn, step, chunk }` |
| `$events` `waterfall` (`approval/request`) | `{ type:'approval/requested', sessionId: agentId, approvalId: eventId, toolName, callId, reason }` |

**Answering an approval** is `POST /api/$events/result` with `args`
`{ clientId, eventId, outcome: { kind:'result', value: 'allowed-once' | 'rejected' } }`.
`agentId` *is* the SessionId upstream (`agent.id`), which is what makes the
per-session filtering work.

`user-questions/request` is a waterfall too, but the sidebar cannot render a
question form, so we **deliberately do not answer it** — the host settles on the
first answer, and replying `next` would pre-empt the web UI.

**Trust fence** (`api-request-trust.ts` / `browser-auth.ts` upstream): the `Host`
header must be loopback or in `--trusted-host`, and the cookie must verify. We
only ever connect to loopback, so the first half passes naturally.

## Method allowlist

Transport and messaging — always called:

`session/list`, `session/create`, `session/prompt`, `session/cancel`,
`session/follow`, `session/modelCatalog`, `workspace/create`,
`workspace/follow`, `$events`, `$events/result`.

Control surface — called only when capability probing confirmed the host serves
them (see {@link probeCapabilities} in `harness/wire.ts`), and therefore safe to
leave enabled against an older host:

`session/command`, `session/fork`, `session/rename`, `session/selectModel`,
`workspace/archiveSession`.

Never called, ever: `settings/*`, `credentials/*`, `commands/*`, `terminal/*`,
`directoryPicker/*`, or any approval/permission mutation outside the list above.


## Control surface (`src/conversation/control.ts`)

The harness ships its knobs as durable session events, every one of them a
**whole value**: the latest occurrence wins, and replay must reconstruct state
from the log alone with no catch-up channel. That makes `ControlSurface` a pure
fold — apply every event in order and you have the truth, whether it came from
`session/page` history or a live `session/follow` frame.

| Event | Payload | What the panel shows |
| --- | --- | --- |
| `plan/mode` | `{ active }` | plan-mode toggle |
| `permission/preset` | `{ preset }` | preset picker selection |
| `sandbox/mode` | `{ mode }` | confinement badge |
| `approval/policy` | `{ policy }` | approval badge |
| `todo/write` | `{ todos }` | checklist (replaces the list wholesale) |
| `goal/change` | `{ operation, goal \| cleared }` | objective + phase + rounds |
| `subagent/start` / `end` / `descriptor` | scoped identity | running children |
| `compaction/start` / `end` / `summary` | provenance + summary | compaction state |
| `request/header` | `{ header: { config } }` | effective provider / model / effort |

Write paths are split by what upstream actually exposes: plan mode, permission
presets and compaction go through the **command registry** (`session/command`
with `/plan`, `/permission <name>`, `/compact`), while fork / rename /
archive / model selection have dedicated endpoints. Every write first checks the
negotiated capability (`requireControl`) and otherwise throws
`HarnessUnsupportedError`, whose message names the missing endpoint — the UI then
shows fewer controls rather than dead ones.

## Workspace lifecycle (v0.0.2: lazy create)

```
connect
  ↓
pickVsCodeFolder()              — resolve the active VS Code folder
  ↓
findHarnessWorkspace()          — read-only: match folder ↔ harness workspace
  ↓
found?  → load sessions, select first non-blank
not found? → binding stays pending, UI shows "Not registered yet"
                ↓
          user sends first prompt
                ↓
          ensureHarnessWorkspace() — create-on-demand (no modal)
                ↓
          createSession() → selectSession() → prompt()
```

No confirmation modals. The workspace is a **send-time lazily ensured resource**, not a connect-time resource.

## Markdown rendering

`markdown-it` (`html: false`, `linkify: true`, `breaks: false`) runs **inside the webview** — not in the extension host. This keeps `ConversationModel` semantic-only (it sends raw markdown text; the webview does presentation).

- Assistant messages: `body.innerHTML = md.render(item.text)`
- User / System messages: `body.textContent = item.text` (no markdown)
- Tool results: `<pre>` (no markdown)
- Links: `target=_blank rel=noopener`; `javascript:` / `data:` URLs stripped
- `markdown-it.umd.min.js` is bundled in `media/` for VSIX packaging

## Streaming performance

`EventBuffer` coalesces high-frequency `assistant/chunk` frames and flushes at most every **30 ms**. `turn/end` and `assistant/message` force an immediate flush so the UI settles at once. The webview re-renders on `renderVersion` change only — never per token.

## Reconnect

`MuxStream` retries with backoff (250 ms → 5 s). On a `closed → open` transition, `AppController` calls `refetchHistory(activeSessionId)` and reloads the model — the documented Harness resume semantic is **rebuild**, not cursor-resume.

## Security boundary

`HarnessClient.connect()` rejects any host not in `{127.0.0.1, localhost, ::1}` with:

> v0.0.x only supports local DeepSeek Harness instances.

`approval/requested` and `question/requested` frames surface **only** an information message ("Action requires approval in DeepSeek Harness Web UI") and never call `/api/respond`.

## Directory

```
src/
├── extension.ts              # wiring ONLY (activate, commands, config)
├── disposable.ts             # CompositeDisposable helper
├── app/
│   ├── controller.ts         # AppController — orchestration
│   └── state.ts              # UiState shape + mapping helpers
├── conversation/
│   ├── model.ts              # ConversationModel fold
│   └── types.ts              # ConversationItem union (5 kinds)
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── harness/
│   ├── protocol.ts           # wire types (mirror of upstream)
│   ├── client.ts             # HarnessClient — only network edge
│   └── events.ts             # MuxStream (WS) + EventBuffer (30ms)
└── view/
    ├── provider.ts           # webview composition (HTML + CSP + state bridge)
    ├── styles.ts             # CSS
    ├── html.ts               # HTML skeleton
    ├── client.ts             # webview-side JS (render + markdown + actions)
    └── toolPresentation.ts   # tool name → human title
media/
├── icon.png                  # Marketplace + webview brand icon
├── icon.svg                  # Activity Bar icon (currentColor)
├── origin.png                # source material (excluded from VSIX)
└── markdown-it.umd.min.js    # bundled for VSIX (114 KB)
scripts/
├── protocol-test.ts          # fake-harness protocol test, 98 assertions (no dsh web)
├── protocol-probe.ts         # asks a live `dsh web` what it actually serves
├── probe-shapes.ts           # scratch probe for `{args}` spellings
├── integration-test.ts       # closed-loop test against real dsh
└── gen-icon.ts               # icon generation from origin.png
test/fixtures/                # sanitized protocol captures
```

## KV-cache / stability note

The extension holds no model state of its own across reconnects — every reconnect re-derives from the `session/follow` snapshot, which is the Harness source of truth (`session.history` no longer exists on current builds, and the negotiated profile is what tells us which names apply). The only long-lived client state is the event-socket downlink plus the two in-memory folds, `ConversationModel` and `ControlSurface`, all three rebuilt from the snapshot on resume. This keeps cache consistency trivial: there is one cache (the Harness session log), and VS Code is a view onto it.
