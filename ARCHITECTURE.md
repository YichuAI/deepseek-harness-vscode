# Architecture — DeepSeek Harness VS Code v0.2.0

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
│ harness/events.ts         — RemoteMuxSocket (remote.mux WS) + EventBuffer (30ms) │
│ harness/ws.ts             — minimal RFC6455 client (Cookie-capable)│
│ harness/auth.ts           — browser session cookie (token → cookie)│
│ harness/http.ts           — node:http wrapper (exact Cookie/Set-Cookie)│
│ harness/discovery.ts      — find the Host on loopback (401 fence)  │
│ harness/protocol.ts       — wire types (mirror of 0.2.0-rc.2 Remote)│
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` is **types only** — zero runtime, zero dependencies. It mirrors the DSH **`0.2.0-rc.2`** Remote contract actually served by the host this plugin connects to: slash-style `POST /api/<ns>/<method>` with a `{ type:'client-request', payload:{ args } }` envelope, the `/api/remote.mux` bidirectional event socket (with a `ready` frame carrying `clientId` + `host.home`), `$events/result` for approvals, and `session/page` for history.
- `harness/client.ts` is the **single** module allowed to make HTTP requests or open sockets. Everything above it goes through `HarnessClient`.
- `harness/ws.ts` implements the handshake and frame codec itself rather than using the platform `WebSocket`: a browser-shaped WebSocket cannot set arbitrary request headers, and the mux upgrade now requires a `Cookie`.
- `harness/auth.ts` is the only credential source. It takes the process token out of the `dsh web` launch URL, exchanges it via `GET /?token=…` for a `Set-Cookie`, and keeps the cookie in VS Code SecretStorage (`context.secrets`) — never in settings.json. autoSession can instead mint the same cookie locally from `$DSH_HOME/.credentials.yaml`.
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
  | ToolItem             // kind: 'tool' (call + result MERGED by callId, + reviewId)
  | StatusItem           // kind: 'status' (turn start/end)
  | ChangesItem          // kind: 'changes' (v0.2.0: one card per turn's changed files)
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
| `workspace/changes` | → `changes` card (v0.2.0); one per turn, repeat replaces the coordinate |
| `session/title` | updates the snapshot title |
| **any other type** | **ignored** (the harness protocol is merge-extensible) |

Replays are idempotent (`seq`-guarded), so reconnect → refetch history is safe.

> **Assistant deltas are ordinary durable `session/event` frames.** In 0.2.0-rc.2 the
> streaming text arrives as `session/event` whose `event.type === 'assistant/chunk'`,
> carrying a real `seq`, so it flows through the normal `applyEvent` fold — there is
> no separate `assistant/stream` frame and no synthetic-seq bypass.

## Wire contract (negotiated at connect; validated by `scripts/protocol-test.ts`)

Three things have drifted between host releases, and hardcoding any of them is
what broke earlier versions. `harness/wire.ts` therefore *discovers* the wire on
every connect rather than assuming a release:

| # | Axis | Variants seen | How it is discovered |
| --- | --- | --- | --- |
| 1 | Auth | none / browser-session cookie | every probe answering 401 ⇒ cookie-gated |
| 2 | Endpoint naming | `session.prompt` vs `session/prompt` | POST both shapes; a `server-response` wins, 404 ⇒ not this shape |
| 3 | Event channel | `/api/remote.mux` (0.2.0-rc.2) vs `/api/events.mux` (older) | header-only GET; anything but 404 exists |

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
- autoSession (default on) mints the **same** cookie locally from that secret — no
  launch URL paste. Turning it off forces the sanctioned token exchange. The cookie
  lives in `context.secrets`, never in settings.json.

### Unary RPC — `POST /api/<namespace>/<method>`

```jsonc
// headers
Cookie: dsh-auth-…=v1.…          // required on cookie-gated hosts (0.2.0-rc.2 gates /api/*)
Content-Type: application/json
// body: `payload` wraps the args in `{ args: … }`
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
  "payload": { "args": { "sessionId": "…", "mode": "queue",
               "content": [{ "type": "text", "text": "…" }] } } }
// response
{ "type": "server-response", "rpcId": "<same>", "result": { "ok": true, "value": { … } } }
```

The endpoint is `namespace/method` **slash-style** on 0.2.0-rc.2
(`POST /api/session/prompt`); `harness/wire.ts` negotiates slash vs dot and renders
every call through `HarnessClient.ep()`, so no module writes an endpoint literal.
`payload` is `{ args: <declared-param-object> }` — this is the `client-request`
envelope the host expects. One trap remains: `session/list` has shipped with three
declared-parameter spellings (`_request`, `request`, none), so `negotiateWire`
tries each and caches the one the host accepts.

Business errors are `200` + `{ ok: false, error: { code, message, details } }`;
a **missing endpoint** is `HTTP 404 + plain-text "not found"` (not a JSON
envelope), which is how capability probing tells "absent" from "wrong arg
shape". HTTP status otherwise expresses only the carrier (`401` unauthenticated
/ `404` no such endpoint / `415` not JSON).

### Event channel — `WS /api/remote.mux` *(bidirectional logical-stream mux)*

0.2.0-rc.2 exposes a **bidirectional** WebSocket. The client opens
`ws://<host>:<port>/api/remote.mux` (the path comes from `WireProfile.muxPath`,
never a literal), then sends one `open` frame to subscribe to the `$events`
logical stream:

```jsonc
{ "type": "open", "streamId": "<uuid>", "endpoint": "$events", "payload": { "args": {} } }
```

The host answers with a `ready` frame (carried as the first `server-request`
envelope value) that carries `clientId` and `host.home`:

```jsonc
{ "type": "server-request",
  "payload": { "type": "ready", "clientId": "…", "host": { "home": "/home/tester" } } }
```

Subsequent frames are `server-request` envelopes whose `payload` is the event
(`type: 'session/event'` and friends). Assistant streaming arrives **as
`session/event` frames whose `event.type === 'assistant/chunk'`** — there is no
separate `assistant/stream` frame, so `conversation/model.ts`'s existing
`assistant/chunk` fold handles streaming with no change. Durable history is **not**
delivered on this socket: `getHistory()` calls the `session/page` unary RPC
(`{ request: { address, throughSeq, beforeSeq?, maxMessages? } }`) instead.

`throughSeq` is a **journal cursor, not a count** — and it is not guessable.
Upstream (`history.ts`) resolves `-1` to an empty page, `0` to "just record #0",
and a value past the end to `gateway/bad-request … past cursor N`. The only
sanctioned source is the `snapshot.cursor` published in the **opening frame of
`session/follow`** — the `SessionPageRequest.throughSeq` doc comment says exactly
that ("obtained from the corresponding follow opening frame"). So the client
records every cursor the follow stream hands it (`HarnessClient.noteFollowCursor`,
monotonic — never walks backwards) and `getHistory()` returns an empty page
*without issuing a request* when no cursor has been learned yet. Getting this
wrong is not a cosmetic bug: the previous hard-coded `0` made history
permanently empty, and because the caller then folded an empty page it *erased*
the live conversation on every mux reconnect.

**Answering an approval** is `POST /api/$events/result` with a `client-request`
envelope:

```jsonc
{ "type": "client-request", "rpcId": "<uuid>", "method": "$events/result",
  "payload": { "args": { "clientId": "…", "eventId": "…",
                         "outcome": { "kind": "result", "value": "allowed-once" | "rejected" } } } }
```

**`outcome.value` *is* the Host waterfall's return value**, and that one fact is
the whole contract:

- Omitting `value` (bare `{ kind: 'result' }`) settles the waterfall with
  `undefined`. `ApprovalService.decide` normalizes every non-vocabulary return —
  `undefined` included — to `'unavailable'`: a **silent fail-closed denial** that
  still writes a perfectly normal-looking `approval/decided` audit line. That was
  the v0.1.4 bug: "Allow" had never allowed anything.
- A denial must therefore also be a **result** carrying a vocabulary string
  (`value: 'rejected'`). Encoding it as `{ kind: 'rejected', error }` *cancels*
  the waterfall, and the containment in `decide` normalizes that to
  `'unavailable'` as well — which is why a deny used to be recorded as "no
  approval channel available".
- `{ kind: 'next' }` gives up *this* client's delivery and leaves the request to
  the other clients; the Host only settles with `next()` once no delivery
  remains. `delegateWaterfall()` is that, and nothing else.

The vocabulary is `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`; the
UI can only produce the first two (typed as `ApprovalDecision`).

The `approval/request` frame carries a `sessionId` + `eventId` (the waterfall
event, observed on the mux); `respondApproval()` looks it up and POSTs the pair
together with our `clientId`. `agentId` *is* the SessionId upstream, which is what
makes per-session filtering work.

**`user-questions/request` is the same waterfall on the same transport** — a
`{ type: 'waterfall', event, eventId, agentId, request }` frame, with `request`
shaped `{ questions: AskUserQuestionItem[], agent?, signal?, wait?: { callId } }`.
Note there is **no `sessionId`**: session identity comes from the Agent's scope,
and `wait.callId` is the only link back to a tool row. `respondQuestion()` answers
with `{ answers: [{ id, selected: string[], custom? }] }`, where `selected` holds
option **labels**, not indices. Until v0.1.4 the controller dropped this frame on
the floor, which did not merely cost a card: `ask_user_question` **blocks** that
tool call on the Host, so the turn stalled with nobody able to answer it.

**Withdrawal is `cancel`, and nothing else.** For mux clients `0.2.1` does not
forward `approval/resolved` or `question/resolved`; the only signal that a request
is no longer answerable is a `cancel` frame. The client translates it into
`waterfall/resolved` and withdraws the card — otherwise a request answered in the
browser stayed clickable forever in VS Code.

**Trust fence** (`api-request-trust.ts` / `browser-auth.ts` upstream): the `Host`
header must be loopback or in `--trusted-host`, and — on cookie-gated hosts — the
cookie must verify. We only ever connect to loopback, so the first half passes
naturally.

## Method allowlist

Transport and messaging — always called (routed through the negotiated profile):

`session/list`, `session/create`, `session/prompt`, `session/cancel`,
`session/page`, `session/modelCatalog`, `workspace/create`.
Control surface — called only when capability probing confirmed the host serves
them (see {@link probeCapabilities} in `harness/wire.ts`), and therefore safe to
leave enabled against an older host. On 0.2.0-rc.2 the **present** set is:

`session/fork`, `session/rename`, `session/selectModel`, `session/updateQueue`,
`workspace/archiveSession`, `commands/execute`, `commands/list`,
`session/search`, `session/attachment`.

One trap worth naming: **`session/attachment` does not upload anything.** It is
"read an attachment by id" — `{ request: { sessionId, attachmentId } }` →
`{ attachment: ImageAttachmentRef, data: base64 }`. An earlier build treated it
as the upload route and guessed inner descriptors at it, which is why it answered
`boundary validation failed` no matter what was sent. Uploading a *new* file is
not an RPC at all and never appears in this list — see F8 below.

(`agentPreset/*`, `subagent/*`, `host/describe`,
`workspace/list`, `llm/models` and `goal/*` are likewise absent and gated off.)

Never called, ever: `settings/*`, `credentials/*`, `terminal/*`,
`directoryPicker/*`, or any approval/permission mutation outside the list above.

The changed-files routes (`changes.summary`, `changes.diff`) are **not RPCs at all**
and never appear in this list — see [Change reporting and undo](#change-reporting-and-undo-v018).


## Control surface (`src/conversation/control.ts`)

The harness ships its knobs as durable session events, every one of them a
**whole value**: the latest occurrence wins, and replay must reconstruct state
from the log alone with no catch-up channel. That makes `ControlSurface` a pure
fold — apply every event in order and you have the truth, whether it came from
`session/page` history or a live `session/event` frame.

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

Write paths are split by what upstream actually exposes. On 0.2.0-rc.2 the
**slash-command write path** is `commands/execute` (`{agentId, line,
submittedAttachments:[]}`) with the registry at `commands/list` — the earlier
`session/command` RPC does not exist in rc.2. Plan mode, permission presets and
compaction ride `commands/execute`; fork / rename / archive / model selection /
queue steering have dedicated endpoints (`session/fork`, `session/rename`,
`workspace/archiveSession`, `session/selectModel`, `session/updateQueue`) — each
gated by a live capability probe; if the host does not serve it,
`requireControl` throws `HarnessUnsupportedError` whose message names the missing
endpoint, and the UI shows fewer controls rather than dead ones.

## Token usage (`src/conversation/usage.ts`, v0.0.9)

Usage is a two-channel fold, like the control surface:

1. **Events** — every `assistant/message` may carry `data.usage`
   (`inputTokens`, `outputTokens`, `cacheReadTokens?`, `cacheWriteTokens?`,
   `reasoningTokens?`). `SessionUsage` sums them per session live.
2. **Projection (authoritative)** — `session/list` rows carry
   `projections.values` with `tokenUsage`, `sessionStats` (turns, steps,
   llmMs, toolMs, decode tokens) and `contextBreakdown`; `applyProjection`
   overwrites the folded numbers after each turn end and on session select.

Cache-hit percentage follows the official Web UI formula:
`cacheReadTokens / (uncachedInput + cacheRead + cacheWrite)` — rendered in the
sidebar's usage panel.

## Session tooling (v0.1.0: search / inspector / attachments)

Three sidebar panels extend the session beyond the conversation itself. All
three are capability-gated like the control surface: the UI offers a control
only when `probeCapabilities()` saw the host serve it, and a refusal degrades
to a readable notice, never a dead button.

### F6 — session search (`session/search`)

A unary read: `{ request: { query } }` → `{ results: [{ sessionId, title?,
snippet?, … }] }`. The shape was pinned against a live rc.2 host (bare fields
answer `arguments-invalid: missing "request"`; the wrapped shape passes arg
validation and reaches the search service). One deployment nuance is surfaced
honestly: the host may have search **disabled** — the local `dsh web` does,
answering `gateway/internal: session search is disabled`. The controller
recognizes that class of message and the panel renders "Search is disabled on
this host deployment" instead of a stack-trace-style error.

### F7 — live event inspector (zero protocol)

`AppController.captureFrame()` hooks the mux subscribe callback **before** any
folding, so the inspector sees exactly what the wire delivered: every
`session/event`, `assistant/stream`, `stream/error` frame, with seq / arrival
time / type / one-line summary. Frames live in a 300-entry ring buffer
(each `raw` JSON truncated to 2 KB) held in extension-host memory only —
nothing is written to disk. Clicking a row copies the raw JSON to the
clipboard. Because it rides the existing subscribe path, it costs zero extra
host requests and cannot desynchronize from what the conversation model
actually saw.

The buffer is **filled unconditionally but published only while the panel is on
screen**. The panel is pure webview DOM, so that side is the only one that knows
whether it is showing; it reports the transition with the `inspectorToggle`
action. Riding every `UiState` push instead cost up to 300 × 2 KB ≈ 600 KB of
structured clone per push — measured at 1,318,580 bytes for a single push once
the buffer was full — to feed a panel that is closed by default and reads none
of it. Opening the panel publishes the retained buffer in one go, so the history
is there the moment you ask for it.

Rendering appends nothing: the list is rebuilt whenever the tail frame changes.
The buffer is a ring, so its head moves as it fills; appending the whole array
each time (as it used to) piled on another full copy of every row per frame and
grew without bound.

### F8 — attachments (images inline, files two-step)

The picker runs in the extension host (the webview cannot read local disk), but
staging happens on two completely different wires. The v0.1.0 guess — "everything
goes through `session/attachment` as base64" — was wrong in both directions; the
real contract was read out of `deepseek-harness@0.2.1-alpha.2`'s own source and
then confirmed on a live host.

**Images ride `session/prompt` inline.** `content` is a part union, and an image
part is `{ type: 'image', mediaType, data, name? }` with `mediaType` one of
`image/png | image/jpeg | image/webp | image/gif`. The upstream admission limits
are 20 MiB per image, 20 images per message, 200 MiB total per message.

**Files do not ride RPC at all.** A non-image attachment is uploaded over a raw
HTTP route:

```
POST /api/session/uploadFileBinary?sessionId=<id>&name=<leaf>
content-type: application/octet-stream
<raw bytes>                          → { ok: true, value: { receiptId, file } }
```

The prompt then references the upload as `{ type: 'file', receiptId }`. Note the
receipt is bound to **both** the session and the `dsh web` process — it does not
survive a host restart, so a staged-but-unsent file must be re-uploaded.

**`session/attachment` is the read-back path, not the write path.** Given an
`attachmentId` (`sha256:<hex>`) it returns `{ attachment, data }` — that is how
the plugin can thumb a stored image again without re-sending bytes.

Finding that ref in the journal is where the shapes bite, and they bite
silently. The three durable message records do **not** nest the same way
(measured on a live host):

| record | content lives at |
| --- | --- |
| `user/message` | `data.content` — this is where a promoted image ref lands |
| `assistant/message` | `data.message.content` |
| `system/message` | `data.message.content` |

Read only the nested form and a picture-bearing user message simply looks empty;
nothing errors, the ref is just never found. `blocksToText` in
`conversation/model.ts` reads `data.content` for user records for exactly this
reason, and `scripts/protocol-test.ts` step 12d pins all three shapes.

Two consequences the UI has to own:

- **The host may promote, not store.** `admitPromptContent` turns an inline image
  into an `ImageAttachmentRef` (normalizing and possibly rescaling it), so the
  durable message carries `sha256:…`, not the bytes the client sent. Live check:
  a 73-byte PNG came back byte-identical over `session/attachment`, but that is
  the host's copy, not ours.
- **Model capability is not published, so it cannot be pre-checked.** A model
  that does not accept images fails the prompt with
  `session/attachment-invalid` + `details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES`
  (`packages/api/session-controller/src/commands.ts`). `session/modelCatalog`
  says nothing about it, so the only honest design is to pass the host's verdict
  through — `describePromptFailure()` turns that one code into "switch to an
  image-capable model in Controls", and the staged attachments are **kept** so
  the retry doesn't cost the user a re-pick.

**Bytes never touch `UiState`.** `pushState` fires on every streaming chunk, so
`pending` carries only chip metadata (id / kind / name / bytes-count / mediaType)
while the base64 lives in the controller. The webview builds its own thumbnail
from a local `URL.createObjectURL` and the controller reuses the webview's `key`
as the chip id, so previewing an image never round-trips it through the state
bridge (which would also trip the CSP).

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

### Where the workspace list comes from (v0.1.1)

rc.2 serves **no `workspace/list`** — verified three ways: HTTP 404 on a live host,
zero occurrences in the harness source, and the capability probe reporting it
absent. `listWorkspaces()` therefore **reconstructs the registry from
`session/list`**, grouping rows on their host-canonical `cwd`:

- every `session/list` row carries `cwd`; those directories are 1:1 with the
  workspace registry, because a workspace is keyed by its path —
  `workspace/create` on an existing path returns that workspace with
  `created:false` rather than making a second one;
- `workspaceId` is therefore **synthetic**: it is the canonical path, not a
  host-issued id. It is safe for matching and display, and must never be handed
  to `session/create`;
- so anything that writes goes through `ensureHarnessWorkspace()`, which
  confirms the derived workspace with one idempotent `workspace/create` and
  caches the authoritative id on `WorkspaceBinding.confirmed`;
- `newSession()` and `sendPrompt()` both route through that helper, so no write
  path can observe an unconfirmed id.

An empty result here is never benign: `findHarnessWorkspace()` would find
nothing, the binding would never resolve, and the UI would sit at
"Disconnected" while the handshake looked perfectly healthy.

## Change reporting and undo (v0.2.0)

There are two independent records of "what changed", and they are not
interchangeable:

| | per-call review | per-turn changed files |
|---|---|---|
| built from | a file tool's own `before`/`after` | Host-side, at turn boundaries |
| covers | what that one file tool wrote | everything the turn touched |
| sees a `sed -i` in a shell command | **no** | **yes** |
| can be reverted | yes — it carries the text | only via a review it overlaps |

A **review** is created when a `tool/call` + `tool/result` pair completes, from the
before/after text the file tool itself reported. It is the only source that keeps
enough text to restore a file.

A **turn record** is not built by this plugin at all. The Host's
`@deepseek-ai/dsh-workspace-changes` plugin snapshots the working tree at turn start
and again at turn end — through a **private git index** into a temporary object
directory (`GIT_OBJECT_DIRECTORY` + `GIT_ALTERNATE_OBJECT_DIRECTORIES`), with git run
through its `subprocess` capability — and additionally takes whole-file copies around
`write`/`edit`/mutating-`str_replace_editor` calls. That is why it also covers a file
changed by `sed -i` inside a shell command, which no tool result ever mentions, and why
it is the only source that describes a whole turn rather than one call in it. It
records **hunks**, not whole-file text — it is a diff, not a backup.

### The announcement, and the two routes

At the end of every top-level turn that changed something, the Host appends a durable
Session event:

```json
{ "type": "workspace/changes", "seq": 412, "data": { "turn": 7 } }
```

The event's own `seq` **is** the coordinate — the routes are addressed by it, not by
the turn number:

```
GET /api/changes.summary?sessionId=<sid>&seq=<seq>          → ChangesSummary
GET /api/changes.diff?sessionId=<sid>&seq=<seq>&index=<n>   → ChangesDiff
```

Three properties matter:

- They are **plain authenticated GETs** taking query parameters, sitting beside the
  gateway rather than behind it. There is no `{args}` envelope and no `/api/<ns>/<method>`
  path. `getRoute()` in `harness/client.ts` handles this shape:
  `401` throws (and feeds the auth-required path), **`404` returns `undefined`**,
  an empty body returns `undefined`, and a gateway-shaped `{ok, value}` body is unwrapped
  if a future host decides to wrap it.
- **`404` means "no card", not "error".** The Host keeps summaries in memory for the
  Session's lifetime only, so a host restart drops them. A `undefined` answer resolves
  the card to nothing, matching the Web UI. A *thrown* error is different and keeps the
  row, because a transient failure must not read as "this turn changed nothing".
- There is a third route, `POST /api/changes.open`, which asks the **desktop app** to
  open the file. It is deliberately not used: VS Code's own editor is a better target,
  and the route is Windows/desktop-centric.

### Card placement and model semantics

The card is a `ConversationItem` of kind `changes`, living in the **transcript's tool
row** next to the call that produced it — not in a separate tree view. It carries the
usual `uid`/`rev` render identity, so the v0.1.7 reconciler treats it like any other
item.

One card per turn, enforced by a `Map<turn, index>` rather than by appending:

- a **repeat** announcement for a turn already on screen **replaces** the coordinate
  (`seq`, `summary`) instead of stacking a second card — a turn can announce twice when
  `turn/end` re-records;
- a summary resolving to `undefined` **resolves** the row to present-but-hidden rather
  than removing it, because removing an item would invalidate `toolIndexByCallId` and
  `changesIndex`;
- fetches are **serialized** (`changesFetchChain`) and bounded to the last
  `MAX_CHANGES_TURNS` (10) turns, and re-check the active session id after the `await`,
  so a session switch mid-flight cannot land a summary in the wrong transcript.

### Hunk rebuild, and the URI authority contract

`hunksToSides()` rebuilds both sides from the hunk list: `+` lands only on the after
side, `-` only on the before side, context on both, and the side a line does not belong
to emits `''`. That blank is the point — without it the two columns drift apart and a
comparison reads as if everything moved.

Both virtual-document providers now read the id from **`uri.authority`**:

```
dsh-review://<reviewId>/<encoded-path>/before|after
dsh-changes://<id>/before|after
```

Reading it off `path` was the bug fixed in v0.2.0: `Uri.parse('dsh-review://review-1/foo/before').path`
is `/foo/before` — a hierarchical URI keeps the leading slash — so
`path.split('/')[0]` is the empty string and the store lookup never matched. Every diff
opened through the provider rendered blank.

### The undo, and why there is no "accept"

A review row offers **Revert** only. There is no accept counterpart, because a mutation
reaches disk *before* a review can be built from its result — "accept" could only ever
mark a fact as acknowledged, and a button that does nothing but imply the change had
been waiting for permission is worse than no button. This is the design position
(documented in the README): **DSH is the only writer, and the plugin observes rather
than gates.**

The revert itself is a **write of the captured `before` text**, with a drift guard: it
first checks that the file on disk still matches the `after` captured at review time,
and refuses (marking the file conflicted) if it has moved on. That guard is what makes an
undo safe to offer without asking, and what lets it say no.

Undo from a turn card is **scoped to the reviews that turn produced**, because a summary
carries paths and line counts but not restorable text. Mapping a summary path to a review
file is tried in three passes — exact, then unique-suffix, then unique-basename — and the
last two only count when exactly **one** candidate matches, since guessing among several
would revert the wrong file. A turn that changed files only through shell commands says
so rather than pretending to act.

Hunk-level revert exists in `ReviewMaterializer` (`rejectHunk`, with the same drift
guard) but no UI reaches it any more — a revert is all-or-nothing per file. Restoring it
is the "partial revert" item on the roadmap.

### How this is verified

Two layers, and they are not redundant. The protocol test's **group M** pins the shapes
against a fake harness: that the two routes are plain authenticated GETs rather than RPC
methods, that a hunk list rebuilds into two line-aligned sides, that the id comes off
`uri.authority`, and that the card semantics hold (one card per turn, a repeat announcement
replacing the coordinate, a gone summary resolving to no card).

The live integration test then measures the two things a fixture cannot. A real turn is
driven through the real model, because the part that can silently break is the **handoff**:
the announcement names a *turn*, the summary route is addressed by an *event seq*, and only
the model converts one into the other. And the hunk **prefix format** — the `+`/`-`/space
column that `hunksToSides()` splits on — is observed rather than assumed, together with
each hunk header agreeing with its own body. A `404` is likewise measured to resolve to
"no card" rather than to a throw, which is the difference between a dropped summary and a
broken panel.

## Markdown rendering

`markdown-it` (`html: false`, `linkify: true`, `breaks: false`) runs **inside the webview** — not in the extension host. This keeps `ConversationModel` semantic-only (it sends raw markdown text; the webview does presentation).

- Assistant messages: `body.innerHTML = md.render(item.text)`
- User / System messages: `body.textContent = item.text` (no markdown)
- Tool results: `<pre>` (no markdown)
- Links: `target=_blank rel=noopener`; `javascript:` / `data:` URLs stripped
- `markdown-it.umd.min.js` is bundled in `media/` for VSIX packaging
- When the UMD read fails, `provider.getMarkdownItSource()` serves a stub. That stub must mirror markdown-it's public shape closely enough that the client's link-renderer override does not throw — v0.1.2 gave it `renderer.rules` and made the override feature-detected, because a "graceful fallback" that crashes the boot sequence is not graceful.

## Webview script integrity (v0.1.2)

`src/view/client.ts` exports the entire renderer as **one template string**. TypeScript
type-checks the file but never looks *inside* that string, which makes two mistakes
invisible to every build step and fatal at runtime:

1. **TS syntax leaking in.** `const bits: string[] = [];` sat in the script from v0.0.4
   to v0.1.1. The webview threw `SyntaxError` on load, so the script never ran: the
   status stayed on the static `Disconnected` placeholder in `html.ts` and every control
   was inert. The panel did not merely look disconnected — it had never booted.
2. **Eaten backslashes.** A template literal consumes escapes: `\/` → `/`, `\S` → `S`.
   Regexes must double them (`\\s`), as the `AT_FILE_RE` comment documents. A single
   `\S` turned the slash-completion test into `/^/S*$/`.

Both are now covered by step **G** of `scripts/protocol-test.ts`:

- the script must be parseable by `new Function(CLIENT_SCRIPT)`;
- every `$('id')` it looks up must exist in `HTML_SKELETON`;
- the script is **booted against a DOM stub** and fed one state, asserting it registers
  a `message` listener and renders `Connected` — once with a real markdown-it and once
  with the no-markdown-it stub.

At runtime, a boot-time `window.addEventListener('error', …)` prints any future startup
failure into the message area, so a broken panel is self-evident instead of silent.

## Streaming performance

`EventBuffer` coalesces high-frequency `assistant/chunk` frames and flushes at most every **30 ms**. `turn/end` and `assistant/message` force an immediate flush so the UI settles at once.

The push budget below says a push must have something to publish. That was never
enough on its own: a streaming push *does* have something to publish, and the
webview still made that cost grow with the length of the conversation. The two
sections are the two halves of the same problem.

### The push budget (v0.1.6)

`pushState()` is not cheap, and it is not idempotent in the way that matters: the
webview answers an accepted push whose `snapshot.renderVersion` moved by tearing
down `#messages`, rebuilding every item, and re-parsing every assistant message
as markdown. So the rule this codebase holds itself to is **a push must have
something to publish.** Three places broke it, all in the waterfall path:

- **Waterfall events published twice.** `ApprovalStore` notifies its own change
  listener, which calls `pushReviewApprovalState()`; the caller that had just
  mutated the store then called it again. Both landed in the same tick, so
  nothing could paint between them — the second push was pure main-thread time.
  `pushReviewApprovalState()` now computes a signature of `(sessionId, model
  version, reviews, approvals, questions)` and returns early when it has not
  changed.
- **It also touched the model unconditionally.** `model.touch()` bumps
  `renderVersion`, which *is* the webview's rebuild signal. But nothing about an
  approval or a question is drawn in the transcript — `renderTool` says so — so
  the rebuild was for a diff of nothing. Only the **review** slice earns a touch
  now: review cards do live inside transcript tool rows. The dead
  `ToolItem.approvalRpcId` (written by nobody, read by nobody) went with it.
- **The `session/follow` callback pushed unconditionally.** A batch carries
  frames for the whole session, so an ordinary flush can be a replay of what is
  already on screen. It now compares field identities across the batch and
  publishes only if something moved.

Measured on a 72-record session: one waterfall event went from 2 pushes /
~70 KB / 2 full transcript rebuilds to **1 push / 35 KB / 0 rebuilds**, and an
answer round trip from 6 pushes / ~212 KB / 6 rebuilds to 3 / ~106 KB / 0. Group
I of `scripts/protocol-test.ts` asserts the push count and the unchanged
`renderVersion`, so a regression here fails the gate rather than merely feeling
slow.

### Incremental transcript rendering (v0.1.7)

`renderVersion` moves on every streamed chunk — that is by design, it is how the
webview learns there is something new. The mistake was on the *consumer* side:
any change meant `msgs.innerHTML = ''` followed by `renderItem()` for every item,
so one chunk re-ran markdown-it over every assistant message on screen and
rebuilt every row. The cost of a chunk therefore scaled with the transcript, and
the cost of a turn scaled with the square of it. Measured on a 40-turn
transcript, per 40 characters of new text:

| | before | after |
|---|---|---|
| DOM nodes built | 291 | 4 |
| markdown passes | ~42 | 1 |
| markdown bytes re-parsed | 43 KB | 1.4 KB |

Two fields on `ConversationItem` (see `ItemIdentity`) are what make the fix
possible, and both are stamped by `ConversationModel.stamp()`:

- **`uid`** — the DOM key. Assigned once and kept, so it survives a streaming
  text update and a tool row gaining its result. It changes only when the item is
  *replaced* (the streaming placeholder becoming the durable `assistant/message`),
  which is exactly when a fresh node is warranted. The counter is module-level,
  not per-model: the webview caches a node per `uid`, and a model rebuilt for the
  same session (reconnect, fork, switch) would otherwise restart at 1 and match
  the previous transcript's cached rows.
- **`rev`** — the change signature. Advanced on every mutation of the item, so
  "did this row change?" is an integer comparison rather than a content diff.

`renderTranscript()` reconciles `snap.items` against a `Map<uid, {el, sig}>`. An
item whose `sig` is unchanged keeps the element it was given — and therefore its
subtree and its parsed markdown. Reused elements are detached and re-attached in
order rather than rebuilt, which costs pointer operations instead of a parse plus
a DOM construction. A tool row's signature also folds in the review attached to
it (`reviewSigFor`), because a review card is drawn *inside* a tool row and the
review store can change without touching any item.

The guard also has a second, larger effect: a push whose only difference is
`renderVersion` — a `session/follow` replay, or state driven by a field the
transcript does not show — now builds **zero** DOM and re-parses **zero**
markdown. Group K of `scripts/protocol-test.ts` drives the real `CLIENT_SCRIPT`
against a counting DOM stub and asserts exactly that, plus that one streamed
chunk rebuilds one row.

Two smaller contributors to the same class of bug went with it:

- **`applyMuxFrame()` projected the model once per frame.** It built a full
  `snapshot()` (a filter plus a spread over every item) inside the per-frame
  loop, and a flush carries a whole turn's worth of deltas. The projection now
  happens once per batch, and only when `model.version` actually moved — the
  caller already published once per batch, so the two counts now agree.
- **The session `<select>` was rebuilt on every push.** Recreating the options
  discarded the user's selection mid-interaction. It is signature-guarded.

#### Known remaining cost

The transcript is still shipped whole on every streaming push: ~52 KB per push on
a 40-turn session, cloned across `postMessage`. The renderer no longer rebuilds
it, so the constant is small, but its size still tracks the conversation. Cutting
it needs a per-item delta on the wire (`UiState.snapshotPatch` or similar), which
is a protocol change and is not in 0.1.7.

#### Measured and deliberately not changed

`captureFrame()` calls `JSON.stringify` per frame to fill the inspector ring
buffer, and 0.1.6 only stopped *publishing* it while the panel is closed.
Measured: **~1.2 µs** for a typical `assistant/stream` delta and **~47 µs** for a
20 KB `assistant/message` — tens of microseconds per second at a streaming
cadence of ~33 frames/s. Computing the raw lazily would mean retaining up to 300
live frame objects instead of 300 truncated 2 KB strings, trading bounded memory
for a rounding error. Left alone.

## Reconnect

`MuxStream` retries with backoff (250 ms → 5 s). On a `closed → open` transition, `AppController` calls `refetchHistory(activeSessionId)` and reloads the model — the documented Harness resume semantic is **rebuild**, not cursor-resume.

Two guards make that rebuild safe. `refetchHistory()` **never clears the
transcript on an empty page**: if `session/page` returns nothing (no cursor
learned yet, or actually empty) it logs and returns, because the previous
behaviour wiped the visible conversation on every reconnect. And because
`session/follow` re-publishes its snapshot, the model ends up folded from the
host's journal rather than from whatever happened to be on screen.

### Reconnect (why the button is always visible and always forces)

`AppController.doConnect()` is a **forced** reconnect, and it is the only path
that establishes a connection: activation, the `Reconnect` command, the button
in the status row, and the icon in the panel header all call it.

Forced is the point. When a Host restarts, the client's own state stays
`connected` — the stream simply stopped, and nothing has told us — and
`HarnessClient.connect()` short-circuits on that state. That gap is what made
"reload the VS Code window" the only recovery. `connect({force:true})` therefore
tears the socket down *before* negotiating.

Two structural rules keep that safe:

- **Attempts are serialised.** `doConnect()` appends to a promise chain, so a
  second click queues a fresh attempt instead of negotiating a second socket on
  top of the first, where the loser's teardown would kill the winner's stream.
- **The open session survives.** `disconnect()` drops the `session/follow`
  subscription while `activeSessionId` stays set, so the transcript would remain
  on screen with nothing feeding it. `runConnect()` captures the id up front and
  re-selects it afterwards — rebuild the model, re-subscribe, refetch history,
  which is the rebuild-not-cursor semantic above. It only falls back to the
  newest session when the Host genuinely no longer has that one.

The webview's boot request is deliberately **not** this path. Opening the panel
posts `ensureConnected` (`doConnect({force:false})`), because merely showing the
panel must not tear down a session the extension host already established; the
button is what forces.

`package.json` contributes `deepseekHarness.reconnect` to `view/title`
unconditionally. It used to be gated on `deepseekHarness.offline`, which hid it
exactly in the case it was needed — a panel that still reads *Connected* over a
dead socket.

### Host discovery (why the port can be wrong)

`dsh web` defaults to `127.0.0.1:3080`, so a fixed port is right most of the
time. The desktop app is the exception, and it is built in: it spawns its Host
with `--port 0` (`apps/desktop-host/src/index.ts`), so the port is OS-assigned
afresh on every launch and reported only to Electron over Node IPC. Nothing lands
on disk, so "the panel is stuck until I reload VS Code" was really "the plugin is
still aimed at last launch's port".

When `connect()` fails for a reason **other than** an auth refusal (that means we
found a Host and it said no; answering a credential problem with a port problem
would be wrong), `AppController.attachToDiscovered()` runs
`harness/discovery.ts`:

1. **Pinned ports** — `webserver.port` in
   `$DSH_HOME/profiles/<name>/cordis.patch.yml`, read by hand because the user
   layer may carry `!!js` tags no generic YAML parser can evaluate.
2. **The Host's own refusal** — the OS listener table (netstat / lsof /
   `/proc/net/tcp`) is enumerated and each candidate gets one anonymous `GET /`.
   A dsh Host answers `401` + `dsh web authentication required; reopen the URL
   printed by dsh web.`; that text comes from the connection carrier's fence, not
   the web frontend, so it is emitted whichever entry point booted the Host — and
   no other local server says it. A `200` carrying `--dsh-boot-bg` is accepted as
   a second-best, for a Host deployed with the browser fence disabled.

Probing the listener table rather than sweeping a port range is deliberate: a few
dozen listeners resolve in about a second, while sweeping 16k ephemeral ports
would be both slow and rude. `deepseekHarness.autoDiscover` (default on) gates
the whole thing.

The adopted port is **session-local and never written to settings** — an
OS-assigned port changes on every launch, so persisting it would only leave a
stale pin for the user to debug later. Measured on this machine: 46 loopback
listeners probed, one Host found, correctly attributed to the pinned `desktop`
profile; a plain HTTP listener on the same scan is *not* adopted.

## Security boundary

`HarnessClient.connect()` rejects any host not in `{127.0.0.1, localhost, ::1}` with:

> v0.0.x only supports local DeepSeek Harness instances.

`approval/request` frames are answered from the sidebar's pending panel via `POST /api/$events/result` (see above). A request whose stated reason declares full/unrestricted access withholds inline Allow and offers a **Answer in Web UI** hand-off instead; the gate reads the reason, not a tool-name allowlist. Nothing here calls `/api/respond`.

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
│   └── types.ts              # ConversationItem union (6 kinds)
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── approval/
│   ├── store.ts              # pending-answer lifecycle for both waterfalls
│   └── types.ts              # PendingApproval / pending question shapes
├── review/
│   ├── controller.ts         # review lifecycle (store ↔ materializer)
│   ├── store.ts              # captured before/after per file + hunk
│   ├── materializer.ts       # the only module that writes a revert
│   ├── virtualDocument.ts    # dsh-review:// before|after provider
│   ├── changesDocument.ts    # dsh-changes:// provider + hunksToSides
│   └── types.ts              # Review / ReviewFile / ReviewHunk
├── context/
│   └── collector.ts          # editor context (active file, selection)
├── harness/
│   ├── protocol.ts           # wire types (mirror of 0.2.0-rc.2 Remote)
│   ├── client.ts             # HarnessClient — only network edge
│   ├── discovery.ts          # find the Host: pinned ports + the 401 fence fingerprint
│   └── events.ts             # RemoteMuxSocket (WS) + EventBuffer (30ms)
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
├── protocol-test.ts          # fake-harness protocol test, 295 assertions (no dsh web)
├── protocol-probe.ts         # asks a live `dsh web` what it actually serves
├── integration-test.ts       # closed-loop test against real dsh
└── gen-icon.ts               # icon generation from origin.png
test/fixtures/                # sanitized protocol captures
```

## KV-cache / stability note

The extension holds no model state of its own across reconnects — every reconnect re-derives from `session/page` (a unary RPC returning the journal page), which is the Harness source of truth; the negotiated `WireProfile` is what tells us which endpoint names and args shapes apply. The only long-lived client state is the event-socket downlink plus the two in-memory folds, `ConversationModel` and `ControlSurface`, both rebuilt from `session/page` on resume. This keeps cache consistency trivial: there is one cache (the Harness session log), and VS Code is a view onto it.
