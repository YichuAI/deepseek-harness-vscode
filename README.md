# DeepSeek Harness Connector for VS Code (v0.1.5)

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.svg)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![Version](https://img.shields.io/badge/version-0.1.5-blue.svg)](https://github.com/YichuAI/deepseek-harness-vscode/releases/tag/v0.1.5)

> Native VS Code client for DeepSeek Harness.
>
> Connect to your existing local Harness instance and continue the same workspaces and sessions directly inside VS Code.

**Same Harness. Same Workspace. Same Session. VS Code Client.**

This is **not** a Cursor replacement, a Claude Code replacement, or a full coding agent. It connects VS Code to your already-running local `dsh web` instance:

```
Browser ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘
```

VS Code reads the workspaces and sessions the browser already has, and continues the **same** session — so a browser refresh of that session sees exactly what VS Code sent.

## What's new in v0.1.5

**A Reconnect button that actually reconnects — and a plugin that can find the Host after it moves.**

- **Reconnect, without reloading VS Code.** The button is always on offer (status row and panel header). It always tears the old session down and negotiates a fresh one — which is the whole point, because the case that needs it most is the one where the panel still says *Connected*: the Host was restarted, the socket we hold is dead, and nothing has told us. A plain connect would short-circuit on that stale state, which is exactly why "reload the window" used to be the only recovery. Attempts are serialised, so a second click queues rather than fighting the first.
- **Host auto-discovery.** When the configured port answers nothing, the plugin reads `webserver.port` pinned in `$DSH_HOME/profiles/<name>/cordis.patch.yml`, then enumerates the OS loopback listener table and confirms each candidate with the Host's own anonymous refusal (`401` + `dsh web authentication required; reopen the URL printed by dsh web.` — that sentence comes from the connection carrier, not the web frontend, so any entry point produces it). This is what the **desktop app** needs: it spawns its Host with `--port 0`, so the port is OS-assigned afresh on every launch and reported only to Electron over Node IPC. Measured here: 46 loopback listeners, exactly one answer, correctly attributed to the pinned `desktop` profile. The discovered port is session-local and **never written to your settings** — it changes on every launch, so persisting it would only leave a stale pin behind.
- **Fixed: a forced reconnect lost the session you were looking at.** `disconnect()` drops the `session/follow` subscription while leaving `activeSessionId` set, so the transcript stayed on screen with nothing feeding it. Reconnect now re-selects the same session (rebuild model, re-subscribe, refetch history — the documented *rebuild*, not cursor-resume), and only falls back to the newest session when the Host genuinely no longer has it.
- **Fixed: one leaked `session/follow` subscription per session switch.** They were parked in a disposable bag and never released; reconnect now re-selects on every attempt, so the leak would have accelerated.
- **Fixed: "the signing secret was rotated" reported when we never sent a cookie.** `authRequired()` recorded a rejection unconditionally, so "no session at all" (the `autoSession` switch off, or no `$DSH_HOME/.credentials.yaml` yet) was described as "the running harness rejected the stored cookie". That sends you after the wrong problem.

See [CHANGELOG.md](./CHANGELOG.md) for the full diff.

## What's new in v0.1.4

**Approvals and agent questions can now be answered from the sidebar — and "Allow" actually allows.**

The bug report was one line: *"when the cloud asks a question, I can't answer it in VS Code."* Answering it meant pinning down the one contract everything else hung on — **`outcome.value` on `POST /api/$events/result` is the Host waterfall's return value.** Three of the fixes below are that single fact, seen from three angles.

- **Fixed: agent questions (`user-questions/request`) had no way out of VS Code.** The client translated them into `question/requested` correctly and then the controller dropped the frame on the floor — no card, no way to answer. The damage was worse than a missing card: on the Host side `ask_user_question` **blocks** that tool call, so with nobody answering, the turn simply sat there. Questions now share the same pending panel as approvals.
  - Single question, single choice: clicking an option answers immediately (same as the Web UI's option cards). Multiple questions or multi-select: hit **Answer** to submit the whole batch at once; anything unanswered is flagged in place instead of being sent up as a batch of empty answers.
  - Free text is always available and rides the `custom` field (not `selected`).
- **Fixed: clicking "Allow" had never actually allowed anything.** The approval response body was `{ kind: 'result' }` — **with no `value`**. But `value` *is* the Host waterfall's return value, so omitting it settles the waterfall with `undefined`, and `ApprovalService.decide` normalizes every non-vocabulary return (including `undefined`) to `'unavailable'` — a **silent fail-closed denial**, complete with a perfectly normal-looking `approval/decided` audit line. Measured against a live host: the bare shape → `outcome: "unavailable"` and the tool reports *"requires approval, but no approval channel is available"*; the shape with a value → `outcome: "allowed-once"` and the command genuinely runs.
- **Fixed: clicking "Deny" was also recorded as "no approval channel available".** Denial was encoded as `{ kind: 'rejected', error: … }`, which *cancels* the Host waterfall; the containment in `decide` then normalized it to `'unavailable'` too. A denial is a **result** carrying a vocabulary string, not a transport error.
- **Fixed: after answering in the Web UI, the VS Code card stayed clickable forever.** For mux clients the host signals withdrawal with **one** `cancel` frame (0.2.1 does not forward `approval/resolved` or `question/resolved`), and the old code only logged it. `cancel` is now translated into `waterfall/resolved` and the card is withdrawn.
- **Fixed: approval cards only rendered when a tool row happened to match.** The card lived inside a ToolItem keyed by `callId`, so with no matching row (session not in the foreground, tool row not folded in yet) it effectively did not exist. Pending items now have their own panel above the composer — where you are looking when you are about to type.
- **Changed: the approval gate now reads the *reason*, not the tool name.** The old allowlist was `write/edit/read/grep/…`, and this host has none of those names (its shell tool is `pwsh`), so **every real shell escalation was rejected** — which is the most common path by far. Names never described how much power was being asked for anyway; the reason does (*"escalate sandbox to danger-full-access: …"* is the Host's own risk statement), and that reason is now shown verbatim next to the buttons. Inline Allow is withheld only when the reason declares full/unrestricted access; that card still renders, can still be denied, and gains an **Answer in Web UI** button. Blocked buttons are no longer unexplained — `blockedBy` states why.
- **Added `delegateWaterfall`** — hands a still-open waterfall back to the Host chain (`outcome: {kind:'next'}`). This is a real hand-off, not an ignore: we give up our delivery and the request stays with the Web UI; the Host only settles with `next()` once no delivery remains.
- Resolved requests no longer render in the panel.

Verification: the regression gate is now **211 assertions** (was 190), including a new G2 group covering panel rendering, the *exact* Allow/Deny payloads, high-risk cards offering hand-off instead of Allow, single-click answering by *label*, explicit submission for multi-question, empty answers caught in place, free text via `custom`, and resolved items leaving the panel. Live integration is **25/25** (was 21), two of them new: the host delivers `user-questions/request` to a mux client and the answer reaches the blocked tool call, and the host delivers `approval/request` with "Allow" *actually granting* an out-of-bounds escalation.

See [CHANGELOG.md](./CHANGELOG.md) for the full diff.

## What's new in v0.1.3

**Replies finally arrive, images finally work, and `@` file references now speak the host's own grammar.**

- **Fixed: the sidebar connected and then went silent.** The transport was modelled as "one `$events` stream carries everything". On a real host (`0.2.1-alpha.2`) `$events` is a fixed forwarded-event allowlist: it sends `ready` (so the panel honestly reported *Connected*) and then **no conversation traffic at all**. Conversation rides a *second* logical stream, `session/follow` (`snapshot` → `event` → live `assistant-stream`). Both streams are now opened and translated on their own vocabularies.
- **Images work: paste, drag-and-drop, or attach.** A clipboard image, a drag onto the composer, or `DeepSeek Harness: Attach File to Session` stages the attachment as a chip above the input — with a local thumbnail — and it rides `session/prompt` as an inline image part. Sending an image with no text is fine; so is sending several. (The composer's chip is a *staging* area: nothing is sent until you hit send.)
- **Non-image files now actually reach the agent.** The old build pushed bytes at `session/attachment`, which is not the upload route — it is *read an attachment by id*. Real uploads go over `POST /api/session/uploadFileBinary` (raw bytes) and the prompt references the returned receipt. One caveat the UI states plainly: a receipt is bound to the session *and* the `dsh web` process, so it does not survive a host restart.
- **`@` references no longer paste file bodies.** It used to be `@file:path` plus `readFileSync` inlining — a plugin invention. Now: `@path`, `@"path with spaces"`, `@dir/`, optionally with a `:L<n>` or `:L<n>-L<m>` line-range suffix, completed from the host's own `fileReferences/list`. Picking a candidate attaches nothing; the agent reads the file itself. (Besides aligning with the host, inlining was poisoning the KV cache: it changed the prompt prefix on every send.)
- **Fixed: history was permanently empty — and worse, reconnects erased your conversation.** `session/page` was called with a hard-coded `throughSeq: 0`, which is a *journal cursor*, not a count. The cursor is only published in the opening frame of `session/follow`; the client now learns it from there. The empty page was then folded as fact, so every socket reconnect blanked the transcript. An empty page no longer clears the screen.
- **Fixed: a `Connect` button exists when auto-connect fails.** Auto-connect is best-effort and has been observed to fail locally (`auth` comes back not-ready) on a host that is otherwise healthy — which left the panel with nothing to click. The status row now shows `Connect` / `Retry` / `Connecting…`, and a plug icon appears in the panel header only while disconnected. (v0.1.5 replaced that gate with an always-visible **Reconnect** button — the stale-connection case, where the panel still reads *Connected*, is exactly when the old gate hid it.)
- **Removed `DeepSeek Harness: Set Session Token from Launch URL`.** Minting locally from `$DSH_HOME/.credentials.yaml` is the only path anyone actually uses; a token that rotates with every `dsh web` process was pure maintenance cost.
- **Fixed a misdiagnosis.** "No such method" (HTTP 404) and "that workspace does not exist" (200 + `workspace/not-found`) were collapsed into one bucket, so an ordinary business error advised you to *upgrade the host*.
- **Fixed an argument-shape retry that made every call slower.** The remembered-correct endpoint shape was being tried *last*, so each call burned two failing round-trips first and the wire shape could drift depending on host leniency. Remembered shapes are now tried first.

See [CHANGELOG.md](./CHANGELOG.md) for the full diff.

### Previous releases

- **v0.0.3** — Diff review & inline code application, approval workflow, and context-menu integration (right-click → **Add to Harness Chat** / **Send Selection to Harness**, now inserting host-syntax mentions).
- **v0.0.9** — Interaction loop: model + reasoning-effort picker, approval auto-approve, sandbox switching, queued/steer messages, slash-command palette, token-usage panel with cache-hit %.
- **v0.0.2** — Conversation UX & Architecture Baseline: Assistant Markdown rendering, tool card merging, system message collapsing, lazy workspace/session creation, streaming render fix, architecture hardening.
- **v0.0.1** — First public release: prove VS Code and the browser share the same Harness session.

## What v0.1.1 fixes

**The panel could sit at "Disconnected" forever, with a perfectly healthy connection.** Workspace discovery was a hard-coded empty array, so binding never resolved and no session list ever appeared on activation. v0.1.1 derives the workspace registry from the `cwd` on every `session/list` row (rc.2 has no `workspace/list`), so an existing harness workspace is now found on connect and the binding survives a reload. Full notes: [CHANGELOG](CHANGELOG.md).

## What v0.1.2 fixes

**The sidebar had never actually booted.** The webview script is a template string, so TypeScript never looks inside it — and a stray TS annotation (`const bits: string[] = [];`) had been sitting in it since v0.0.4. Browsers threw a `SyntaxError` on the very first line of the file, so *none* of the panel logic ran: the status stayed on the static `Disconnected` placeholder and every button was dead. A second instance of the same trap (a regex whose backslashes the template literal ate) broke slash-command completion.

- Fixed both, and made this class of failure impossible to ship again: the regression gate now parses the webview script, cross-checks every `$('id')` against the HTML skeleton, and **boots the real script against a DOM stub** to assert it renders `Connected` (in both normal and no-markdown-it modes).
- A boot-time `error` listener now prints any future startup failure into the message area instead of leaving a silently dead panel.
- The no-markdown-it fallback path was itself a crash (its stub had no `renderer`); it now degrades as advertised.

> If you installed any version between v0.0.4 and v0.1.1, the panel was not functional. Install v0.1.2 and reload the window.

## What v0.1.0 adds

- **Session search (F6, `session/search`)** — a 🔍 panel in the sidebar: type a full-text query, get matching sessions with title + hit snippet, click one to jump straight into it. Request shape `{ request: { query } }`, empirically confirmed against a live host.
  - **Deployment honesty**: some `dsh web` deployments ship with search **disabled** (the local one does — the host answers `gateway/internal: session search is disabled`). There the panel shows a clear notice instead of an error; on a search-enabled deployment it just works.
- **Live event inspector (F7, zero new protocol)** — a 📡 panel that lists **every mux frame** the plugin receives (`session/event`, `assistant/stream`, `stream/error`, …) with seq / time / type / one-line summary. Click any row to copy the full raw JSON (truncated to 2 KB). A 300-frame ring buffer with a Clear button. Data comes entirely from the event stream the plugin already consumes — no extra host traffic — so debugging "why did the agent do X" no longer requires the Web UI.
- **Attachments (F8)** — a 📎 toolbar button and the command `DeepSeek Harness: Attach File to Session` (multi-select).
  - **Correction (v0.1.3):** this bullet used to claim attachments were sent base64-encoded through `{ request: { sessionId, attachments: [{ name, content }] } }`. That wire never existed. `session/attachment` is *read an attachment by id*; images ride `session/prompt` inline and real files go through `POST /api/session/uploadFileBinary`. See [What's new in v0.1.3](#whats-new-in-v013).
- Search and the inspector are capability-gated: a host that does not serve the endpoint shows the why, never a dead button.

## What v0.0.9 adds

- **Model + reasoning-effort picker** — the sidebar fetches `session/modelCatalog` and switches via `session/selectModel`; the effective model renders from `request/header`.
- **Approval auto-approve** — optional setting `deepseekHarness.autoApproveApprovals` answers incoming `approval/request` frames with `allowed-once` automatically (off by default).
- **Sandbox switching** — the sandbox-mode control now writes, not just renders.
- **Queued messages / steer** — a queue bar renders the host's `inbox.next-turn` projection; you can steer a queued item into the running turn or remove it (`session/updateQueue`), and send prompts in steer mode while a turn is running.
- **Slash-command palette** — typing `/` opens completion from `commands/list`; execution goes through the real rc.2 write path `commands/execute`.
- **Token usage panel** — per-session input/output/cache-read/cache-write/reasoning tokens, totals and **cache-hit percentage** (same formula as the official Web UI), folded from `assistant/message.usage` events and reconciled with host projections.

## What v0.0.3 does

- Connect to a **local** `dsh web` (loopback only — `127.0.0.1` / `localhost`).
- Match the active VS Code folder to a Harness workspace. If none exists, the workspace is created **lazily on first prompt** — no modal.
- List the workspace's existing sessions.
- Open a session and render its history.
- Send a plain-text prompt to that session. If no session exists, one is created automatically.
- Stream the assistant's reply with **Markdown rendering** (code blocks, lists, tables, links).
- Show tool calls as **collapsed cards** with name-aware titles (`Read src/foo.ts`, `Search "pattern"`, `Run npm test`).
- **Review agent code changes** — diff cards with per-file Accept/Reject, native VS Code diff editor, bulk Accept All / Reject All.
- **Approve or deny agent actions** — a pending panel above the composer with Allow once / Deny buttons (the gate reads the Host's stated reason, not a tool-name allowlist).
- **Attach file context** — use `@file:path` or `@file:path:L10-L20` in your prompt; file content is read and inlined automatically. Right-click in explorer or editor for quick insertion.
- Hide plugin-injected system messages by default; toggle with the `SYS` button.
- Stop the active turn.
- Reopen the stream and refetch history on disconnect.
- "Open in Harness Web UI" command.
- Dock the view in the right side bar (like Chat) via the ⇲ button.

## What v0.0.3 deliberately does NOT do

For your safety, the following remain out of scope:

- No `credentials` or `settings` API; no auto-approve of high-risk tools beyond the opt-in `autoApproveApprovals` switch.
- No inline completion, terminal/LSP integration.
- Approvals whose stated reason declares full/unrestricted access cannot be allowed inline — the card offers Deny and an **Answer in Web UI** hand-off instead.
- No second session database — the Harness Session is the **only** source of truth.
- No auto-install / auto-start / auto-upgrade of `dsh`.
- Does not fork or modify the Harness source.

## Requirements

- VS Code ≥ 1.85
- A running local `dsh web` (default port `3080`). This extension does **not** start it for you.

## Quick start

1. Start Harness locally:

   ```bash
   dsh web
   # → http://127.0.0.1:3080/?token=<43-char token>
   ```

   Recent Harness builds print a **launch URL with a one-shot token**. You do not
   need it for VS Code — use it to open the Web UI in a browser if you want both
   surfaces side by side.

   Older builds serve `/api/*` unauthenticated and need no token at all — the
   plugin detects which it is talking to, so if no launch URL appears you can
   simply ignore this step.

2. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) or via command line:

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   Or install the VSIX from [GitHub Releases](https://github.com/YichuAI/deepseek-harness-vscode/releases):

   ```bash
   code --install-extension harness-connector-deepseek-0.1.5.vsix
   ```

3. Nothing to configure. The extension auto-connects: it reads the browser-session
   signing secret that `dsh web` keeps in `$DSH_HOME/.credentials.yaml` and mints the
   same `dsh-auth-…` cookie itself. No token to paste.

4. Open a folder in VS Code that you want to bind to a Harness workspace.

5. The DeepSeek Harness activity-bar icon appears; the extension auto-connects. If your folder matches an existing Harness workspace, its sessions appear in the dropdown. Pick one and continue the conversation.

6. **No matching workspace?** Just type a prompt and hit Send — the workspace and session are created automatically.

7. **Reference a file with `@`** — type `@` in the input and a completion list appears; pick one and it is inserted as a mention (`@src/main.ts`). Right-click a file in the explorer and choose **Add to Harness Chat**, or select text in the editor and choose **Send Selection to Harness** to insert `@src/main.ts:L10-L20`. Nothing is pasted into your message: the mention is a *pointer*, and the host tells the agent to open the file itself. That keeps your prompt text (and its KV cache) stable no matter how large the file is.

8. Open the same session in your browser at `http://127.0.0.1:3080/` — both surfaces see the same turn.

> There is no "set session token" command. The cookie is minted locally from
> `$DSH_HOME/.credentials.yaml` on every connect — nothing to paste (see below).

### How the session is obtained

Cookie-gated Harness builds reject every `/api/*` call without a browser-session
cookie. Upstream, the sanctioned way to get one is exchanging the per-process
launch token — but nothing writes that token to disk, so officially you have to
copy it out of the terminal by hand, and it rotates every time `dsh web` starts.

The cookie itself carries no trace of the token: it is an HMAC over
`{version, authority, issuedAt, expiresAt}` keyed by a secret persisted in
`$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`), created once
and reused by every later `dsh web` process. Anything that can read that file can
therefore mint a byte-identical cookie — so the extension does, and you never
have to paste anything. This is the **only** path the plugin offers: the
paste-the-launch-URL command was removed, because a token that rotates per
process is a support burden with no upside once the local mint works.

**Is this safe?** The file is written owner-only (`0600`) and holds your model API
keys, so being able to read it already implies full authority over this harness
home. Minting from it is *permission-equivalent*, not an escalation. It does skip
the per-process token gate, but that gate defends against remote callers
(rebinding, CSRF) — not against code already running as you.

The plugin log records the mint on every connect.

### When the local mint cannot run

The extension says so in the connect error, naming the file it looked for. There
is no manual fallback any more; fix the cause instead.

| Situation | What to do |
| --- | --- |
| `$DSH_HOME` points elsewhere and the env var is not set | set `DSH_HOME` for the VS Code process, or start `dsh web` with the default home |
| `dsh web` has never run in this harness home | run it once — the `client-connection/browser-session` record is created then |
| You set `deepseekHarness.autoSession = false` | turn it back on: that setting now means "refuse to mint", not "ask me for a token" |

A cookie minted this way still lives its own life: the extension stores it in VS
Code's secret storage (OS keychain — never `settings.json`), it survives `dsh web`
restarts, and it is only re-derived when it expires or you change `host`/`port`
(the cookie name is `dsh-auth-<sha256(host:port)>`, so it is bound to the
authority that minted it).

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | **v0.0.x only allows `127.0.0.1` or `localhost`.** Any other value is refused. |
| `deepseekHarness.port` | `3080` | The default `dsh web` port. Override if you started `dsh web --port <n>`. |
| `deepseekHarness.showSystemMessages` | `false` | Show plugin-injected system messages (runtime context, approval notices). Hidden by default; toggle live with the `SYS` button in the webview header. |
| `deepseekHarness.autoSession` | `true` | Mint the browser-session cookie locally from `$DSH_HOME/.credentials.yaml`. Turning it off leaves the extension unauthenticated — it is a security switch, not a convenience toggle. |
| `deepseekHarness.autoApproveApprovals` | `false` | **v0.0.9+** Automatically answer incoming approval requests with `allowed-once`. Off by default — enabling it means tools run without per-call confirmation. |
| `deepseekHarness.autoDiscover` | `true` | **v0.1.5+** When the configured port answers nothing, look for a dsh Host elsewhere on loopback (pinned `webserver.port` first, then the OS listener table, confirmed by the Host's own refusal text). Needed by the desktop app, which starts its Host on an OS-assigned port. The discovered port is session-local and never written to your settings. |

## Commands

- `DeepSeek Harness: Connect` / `Reconnect` / `Disconnect` — **Reconnect** (also the ⟳ button in the panel header, and the always-visible button in the status row) drops whatever is live and negotiates a fresh session
- `DeepSeek Harness: Clear Session Token` — drop the stored cookie and reconnect (a fresh one is minted; use it before switching `dsh web` instances)
- `DeepSeek Harness: New Session` (in the active workspace)
- `DeepSeek Harness: Refresh Sessions`
- `DeepSeek Harness: Move to Right Side Bar` — dock the view in the secondary side bar (like Chat) so it stops competing with the file explorer. Also available via the ⇲ button in the webview header.
- `DeepSeek Harness: Toggle Plan Mode` — flip `/plan` on the active session
- `DeepSeek Harness: Set Permission Preset` — pick (or type) a preset such as `read-only` / `workspace-write` / `danger-full-access`
- `DeepSeek Harness: Compact Session Context` — request `/compact`
- `DeepSeek Harness: Fork Session` — branch off the current session and switch to the fork
- `DeepSeek Harness: Rename Session` — pin a title (stops automatic regeneration)
- `DeepSeek Harness: Archive Session` — archive it out of the active workspace list
- `DeepSeek Harness: Attach File to Session` — stage local images/files for the next prompt (images ride `session/prompt` as inline parts; other files upload to `POST /api/session/uploadFileBinary` and are referenced by receipt) — also available via the 📎 button and by pasting or dropping into the composer
- `DeepSeek Harness: Open Web UI`
- `DeepSeek Harness: Show Logs` (the `DeepSeek Harness` output channel)

The same six controls also live in the sidebar's **Controls** panel, which
additionally shows what arrived from the host: plan state, sandbox mode,
approval policy, agent preset, effective model, todos, the active goal,
subagent activity and the last compaction summary.

Every control is **offered only when this host actually serves it** — capability
probing happens at connect time, so an older `dsh web` simply shows fewer knobs
instead of buttons that would fail.

### Context menu actions

- **Add to Harness Chat** (explorer right-click) — inserts an `@<relative-path>` mention into the chat input.
- **Send Selection to Harness** (editor right-click, requires selection) — inserts `@<relative-path>:L<start>-L<end>`.

Both insert a *mention*, not file content: the host's mention grammar is
`@path`, `@"path with spaces"`, `@dir/`, with an optional `:L<n>`/`:L<n>-L<m>`
suffix. Picking a candidate from the `@` completion list attaches nothing either —
the agent reads the file itself.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the one-page design and the protocol contract. (中文版: [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md))

## Protocol fixtures

`test/fixtures/` holds sanitized captures of the live wire format, useful for detecting upstream Harness protocol drift:

- `host-describe.json`, `workspace-list.json`, `session-list.json`, `session-history.json`, `session-prompt.json`, `session-event.json` — **note:** these are pre-0.1.6 captures, kept only as historical drift references. `host-describe` / `session-history` / `workspace-list` no longer exist upstream.

No credentials, API keys, or real prompt content are stored — only the JSON shapes (text fields are redacted).

## Protocol test

A standalone Node script drives the real client code against a **fake** harness
that implements the `0.2.1-alpha.2` server half exactly — so no `dsh web` is
needed:

```bash
npm run protocol-test    # 231 assertions: the two-stream transport split
                         # ($events allowlist vs session/follow), wire negotiation
                         # (dot/slash, cookie gating, event socket), auth and cookie
                         # derivation, {args} payloads (wrapped vs bare), the approval
                         # and question waterfalls (exact Allow/Deny envelopes,
                         # withdrawing on cancel, delegating with next), assistant
                         # stream start/chunk/end (including orphan-chunk rejection),
                         # missing-method vs business-not-found classification,
                         # removed-endpoint 404 handling, control-surface capability
                         # probing, the whole-value control fold, the @-completion
                         # state contract through the real controller, the pending
                         # panel driven through a scriptable DOM stub, the
                         # reconnect button's exact posts, Host-discovery parsing
                         # (pinned ports, three listener-table dialects, the
                         # fingerprint's three verdicts), and the webview
                         # script's integrity
```

To ask your **real** `dsh web` what it actually serves (endpoint style, event
socket, and which of 30 candidate methods exist):

```bash
npm run protocol-probe            # defaults to 127.0.0.1:3080
npm run protocol-probe 127.0.0.1 3080
```

For a closed loop against your **real** `dsh web`, use the integration test
(start `dsh web` first — it mints the cookie locally, no token to paste):

```bash
npm run integration-test
# or exercise the token exchange instead:
DSH_LAUNCH_URL='http://127.0.0.1:3080/?token=<token>' npm run integration-test
```

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # rebuild on change
npm run typecheck
npm run package      # → harness-connector-deepseek-0.1.5.vsix
npm run protocol-test      # 231 protocol assertions against a fake harness
npm run protocol-probe     # report what your real dsh web exposes
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Verified against

- Default `dsh web` port `3080`; the host must be on loopback.
- **The wire is negotiated, not assumed.** Endpoint style (`session/list` vs
  `session.list`), cookie gating, and the event socket (`/api/remote.mux` on
  0.2.0-rc.2, `/api/events.mux` on older hosts) are all discovered at connect
  time, so one build works across host releases. Run `npm run protocol-probe` to
  see what your host actually serves.
- **Conversation traffic is not on the event socket.** On `0.2.1-alpha.2` the
  multiplexed socket carries *two* logical streams with different vocabulary:
  `$events` (a fixed allowlist of forwarded host events — session status,
  approvals, plugin inventory) and `session/follow` (one session's records and
  live assistant deltas). Coding against a single "everything arrives on
  `$events`" stream is what made an earlier build connect and then go silent.
  Both streams are opened separately; the shapes are pinned in
  `scripts/protocol-test.ts`.
- **The Host can be found without being told where it is.** An anonymous request
  to a dsh Host is refused by the connection carrier with a fixed sentence
  (`dsh web authentication required; reopen the URL printed by dsh web.`), which
  no other local server emits — so it doubles as an identity check. That is what
  `deepseekHarness.autoDiscover` uses, after first reading any `webserver.port`
  pinned in a profile's user patch layer. Measured on this machine: 46 loopback
  listeners probed, one Host found, attributed to the pinned `desktop` profile.

## Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- **Images depend on the model.** Whether a model accepts images is not published in `session/modelCatalog`, so the plugin can only pass the host's verdict through: a non-vision model fails the prompt with `MODEL_DOES_NOT_SUPPORT_IMAGES`, and the panel tells you to switch models in Controls. Your staged attachments are kept for the retry.
- **Staged files are process-bound.** An upload receipt is tied to the session *and* the running `dsh web` process, so a file staged across a host restart must be re-picked.
- History loads the last ~50 messages; "load older" is a future feature.
- Session deep-links in "Open Web UI" are intentionally not guessed — only the Harness home opens.
- Unknown harness event types are ignored (the protocol is merge-extensible); they do not crash the client but also do not render.
- Diff review revert uses `git checkout` — uncommitted changes to the target file will be lost on Reject.

## Roadmap (v0.1.6+)

- Inspector: filter box / type highlight / export as JSONL
- Search: scope to workspace, pagination, highlight rendering
- Inline Completion
- VS Code filesystem provider
- Terminal integration
- LSP / ACP integration

## License

MIT
