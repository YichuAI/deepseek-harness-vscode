# DeepSeek Harness Connector for VS Code

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/lucasliang.harness-connector-deepseek)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![Installs](https://badgen.net/vs-marketplace/i/lucasliang.harness-connector-deepseek)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![Latest release](https://img.shields.io/github/v/release/YichuAI/deepseek-harness-vscode)](https://github.com/YichuAI/deepseek-harness-vscode/releases)
[![License](https://img.shields.io/github/license/YichuAI/deepseek-harness-vscode)](./LICENSE)

> Native VS Code client for DeepSeek Harness.
>
> Connect to your existing local Harness instance and continue the same workspaces and sessions directly inside VS Code.

**Same Harness. Same Workspace. Same Session. VS Code Client.**

![The browser Web UI and the VS Code panel showing the same session at the same turn](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/01-shared-session.png)

*Same session, two windows. Browser on the left, VS Code on the right — nothing imported, mirrored or forked.*

## What it does

- **Continues the session you already have.** Workspaces and sessions are read from the running Host. Refresh that session in a browser and you see exactly what VS Code sent.
- **Answers approvals and agent questions from VS Code.** Both waterfalls are settled by this plugin, so a run is never blocked on a browser tab you have closed.
- **Reports what each turn changed, and can undo it.** Fed by the Host's own turn record, so it covers a file a shell command edited — not only what a file tool reported. The undo checks the file's current bytes first and refuses rather than overwriting you.
- **Opens VS Code's own editor for anything that is code.** A diff is a real diff editor; a path opens the file. Nothing is reimplemented in the webview.
- **Finds the Host by itself**, including the desktop app, which starts its Host on an OS-assigned port that changes on every launch.
- **Three ways to obtain a session, and you choose which.** Mint one from the harness's own credential store (zero configuration, but it means reading a file that also holds your API keys), let the extension start `dsh web` and take the launch URL it prints, or paste a launch URL yourself. See [How the session is obtained](#how-the-session-is-obtained).
- **Starts no process unless you ask it to.** The default attaches to the Host you already have running.

## How it connects

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

## Screenshots

| | |
| --- | --- |
| ![The VS Code sidebar showing a conversation](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/03-editor-sidebar.png) | ![A native VS Code diff of a file the agent changed](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/04-native-diff.png) |

*Left: the conversation lives in the sidebar, tool rows and changed-files card included. Right: "Diff" is VS Code's own diff editor, not a webview imitation.*

![The Harness browser UI on its own](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/02-browser-web-ui.png)

## What's new in v0.2.2

**You no longer have to let it read a file full of your API keys, and `autoSession: false` finally means something.**

- **Managed launch — opt in, and the extension starts the Host itself.** Until now the only way to authenticate was to read `$DSH_HOME/.credentials.yaml`, which also holds your model API keys. That was the single biggest reason not to install this. With `deepseekHarness.sessionMode: "managed"` the extension runs `dsh web` and reads the launch URL off the console it owns, so it needs neither the credential file nor a paste. It is deliberately off by default: starting no process for you is still the default promise.
- **`sessionMode` replaces the `autoSession` boolean.** The old setting could only turn authentication *off* — "false" meant "do not authenticate", because the command that would have offered the other route had been removed. It is now a three-way choice: `credentials` (mint from the credential store — the previous behaviour and still the default), `managed` (start the Host), `paste` (you start it and hand over the URL, via the restored **Use Launch URL** command). Upgrading changes nothing unless you change it.
- **A failed connection now tells you what to do about it.** If nothing is listening, the panel offers exactly one install button — a download page on Windows and macOS, the build commands on Linux — and it only appears in the failed state. If the desktop app is already on disk it says to open that instead. There is no button telling you to install something you already have.
- **The README has screenshots.** It had badges and no images, which is a strange way to describe a visual product.
- **`dsh web` no longer has to be running before VS Code starts.** Related to the above, not a separate feature: with managed launch on, the first connect starts it.

Verification: **381 assertions** (was 342) — the new ones pinning the mode vocabulary and its invariants, the install route per platform, the classifier's new inputs, and the launcher's two guarantee-shaped functions (finding a launch URL anywhere in a child's output, and never letting the token survive into a log). The launcher's process handling is *not* asserted there, because it needs a real machine: `scripts/launch-probe.ts` runs it for real and reports whether the token can be redeemed twice, whether the Host outlives the child we spawned, and whether the port is quiet afterwards.

See [CHANGELOG.md](./CHANGELOG.md) for the full diff, and for the notes of every earlier release.

## Requirements

- VS Code ≥ 1.85
- A local `dsh web` (default port `3080`), either already running or started for you by `sessionMode: "managed"`.

## Quick start

1. Start Harness locally, unless you would rather the extension did it:

   ```bash
   dsh web
   # → http://127.0.0.1:3080/?token=<43-char token>
   ```

   Recent Harness builds print a **launch URL carrying a per-process token**. You
   do not need it for the default setup — use it to open the Web UI in a browser if
   you want both surfaces side by side. (The token is a per-process secret compared
   on every request, not a single-use grant, so reloading that URL keeps working.)

   Skipping this step is a supported choice: set
   `deepseekHarness.sessionMode` to `"managed"` and the extension starts the Host
   itself and takes the URL off its console. See
   [How the session is obtained](#how-the-session-is-obtained).

   Older builds serve `/api/*` unauthenticated and need no token at all — the
   plugin detects which it is talking to, so if no launch URL appears you can
   simply ignore this step.

2. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) or via command line:

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   Or install the VSIX from [GitHub Releases](https://github.com/YichuAI/deepseek-harness-vscode/releases):

   ```bash
   code --install-extension harness-connector-deepseek-0.2.2.vsix
   ```

3. Nothing to configure. In the default `sessionMode: "credentials"` the extension
   auto-connects by reading the browser-session signing secret out of
   `$DSH_HOME/.credentials.yaml` and minting the cookie itself — no token to paste.
   Read [How the session is obtained](#how-the-session-is-obtained) for what that
   implies, and for the two modes that never open that file.

4. Open a folder in VS Code that you want to bind to a Harness workspace.

5. The DeepSeek Harness activity-bar icon appears; the extension auto-connects. If your folder matches an existing Harness workspace, its sessions appear in the dropdown. Pick one and continue the conversation.

6. **No matching workspace?** Just type a prompt and hit Send — the workspace and session are created automatically.

7. **Reference a file with `@`** — type `@` in the input and a completion list appears; pick one and it is inserted as a mention (`@src/main.ts`). Right-click a file in the explorer and choose **Add to Harness Chat**, or select text in the editor and choose **Send Selection to Harness** to insert `@src/main.ts:L10-L20`. Nothing is pasted into your message: the mention is a *pointer*, and the host tells the agent to open the file itself. That keeps your prompt text (and its KV cache) stable no matter how large the file is.

8. Open the same session in your browser at `http://127.0.0.1:3080/` — both surfaces see the same turn.

### How the session is obtained

The harness authenticates `/api/*` with a browser-session cookie, and there are
exactly three ways to get one here. `deepseekHarness.sessionMode` picks which.

**`credentials` (default) — mint it locally.** `dsh web` keeps a persistent
signing secret in `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`).
The cookie is an HMAC over `{version, authority, issuedAt, expiresAt}` keyed by that
secret, the cookie carries no trace of the launch token, and the secret is created
once and reused by every later `dsh web` process — so anything that can read the file
can mint a byte-identical cookie. The extension reads it and mints the cookie itself.
That is why there is nothing to paste.

**`managed` — let the extension start the Host.** It runs `deepseekHarness.launchCommand`
(`dsh web --port 0` by default), reads the launch URL off the console of a process it
owns, and redeems that token. No credential file, no paste. The Host it started is
stopped when the window closes.

**`paste` — start it yourself and hand over the URL.** Run `dsh web`, copy the
`dsh web: http://…` line, and run **DeepSeek Harness: Use Launch URL**. Nothing is read
from disk and nothing is started.

About `credentials`, since it is the default and it is a real privilege:

- **That same file holds your model API keys.** Reading it is **permission-equivalent**
  to full authority over this harness home. It is not an escalation, and it does not
  defeat a boundary that protects you from yourself — but the extension's process can
  then see secrets that have nothing to do with a VS Code client.
- It skips the per-process launch-token gate. That gate defends against *remote*
  callers (DNS rebinding, CSRF), not against code already running as you.
- **`managed` is the answer to both of those.** If reading that file is not a trade you
  want to make, switch modes — you lose nothing but the process the extension starts.
- **No credential material is logged, sent to the webview, or put in a diagnostics
  report.** The log records that a mint happened, never the material. The launch URL is
  held in memory for the one thing it is for and is redacted in every log line that
  mentions it. The cookie lives in VS Code's secret storage — the OS keychain — never in
  `settings.json`. `DeepSeek Harness: Diagnostics` exports a report you can read in full
  before sending it anywhere.

**This is a workaround, and we would rather it were not necessary.** The sanctioned
flow is exchanging the per-process launch token, and `managed`/`paste` do exactly
that — but nothing writes the token to disk, so a client that did not start the Host
itself had no way to obtain it, which is what made reading the signing secret the only
zero-configuration path. A first-class local-client authorization flow would close the
gap properly: a socket, or a one-shot token file written `0600` and scoped to a single
client. Until Harness ships one, the three modes above are the honest menu.

### When a route cannot run

The connect error names the cause and the file or command it looked for. There is no
silent fallback.

| Situation | What to do |
| --- | --- |
| `$DSH_HOME` points elsewhere and the env var is not set | set `DSH_HOME` for the VS Code process, or start `dsh web` with the default home |
| `dsh web` has never run in this harness home | run it once — the `client-connection/browser-session` record is created then, or switch to `sessionMode: "managed"` |
| No `dsh` command on `PATH` under `managed` | the panel offers the install route for your platform; on Windows and macOS the desktop app also registers `dsh` for you |
| `managed` ran but `dsh` exited immediately | usually the port is already taken — the log carries the child's own last lines |
| You are in `paste` mode and have not pasted yet | run **DeepSeek Harness: Use Launch URL** |

A cookie obtained this way still lives its own life: the extension stores it in VS
Code's secret storage (OS keychain — never `settings.json`), it survives `dsh web`
restarts, and it is only re-derived when it expires or you change `host`/`port`
(the cookie name is `dsh-auth-<sha256(host:port)>`, so it is bound to the
authority that minted it).

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | Only `127.0.0.1` or `localhost` is allowed. Any other value is refused. |
| `deepseekHarness.port` | `3080` | The default `dsh web` port. Override if you started `dsh web --port <n>`. |
| `deepseekHarness.showSystemMessages` | `false` | Show plugin-injected system messages (runtime context, approval notices). Hidden by default; toggle live with the `SYS` button in the webview header. |
| `deepseekHarness.sessionMode` | `credentials` | How a session is obtained. `credentials` mints the cookie locally from `$DSH_HOME/.credentials.yaml`; `managed` starts `dsh web` and takes its launch URL; `paste` waits for you to supply one. See [How the session is obtained](#how-the-session-is-obtained). |
| `deepseekHarness.launchCommand` | `dsh web --port 0` | The command `sessionMode: "managed"` runs. The default binds an OS-assigned port, because managed launch reads the real port off the launch URL and pinning one only adds a way to fail. Run through a shell, so wrappers and `npx` work. Read only when a Host is started; changing it does not disturb a running one. |
| `deepseekHarness.autoApproveApprovals` | `false` | Automatically answer incoming approval requests with `allowed-once`. Off by default — enabling it means tools run without per-call confirmation. |
| `deepseekHarness.autoDiscover` | `true` | When the configured port answers nothing, look for a dsh Host elsewhere on loopback (pinned `webserver.port` first, then the OS listener table, confirmed by the Host's own refusal text). Needed by the desktop app, which starts its Host on an OS-assigned port. The discovered port is session-local and never written to your settings. |

## Commands

- `DeepSeek Harness: Connect` / `Reconnect` / `Disconnect` — **Reconnect** (also the ⟳ button in the panel header, and the always-visible button in the status row) drops whatever is live and negotiates a fresh session
- `DeepSeek Harness: Diagnostics` — one document with the runtime version, this extension's version, connection state, which capabilities the Host actually serves, and the last error. Offers a **Copy redacted report** action; nothing credential-bearing is included
- `DeepSeek Harness: Clear Session Token` — drop the stored cookie and reconnect (a fresh one is minted under `credentials`, or a fresh Host is started under `managed`; use it before switching `dsh web` instances)
- `DeepSeek Harness: Use Launch URL` — paste the `dsh web: http://…` line a Host printed and adopt its session. The `paste` route, usable in any mode
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
- `DeepSeek Harness: Open Web UI` — opens the token-bearing launch URL in your browser. Under `sessionMode: "managed"` the extension started that Host, so it has the URL and this command just works; otherwise it tells you where to find the line
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
npm run protocol-test    # 381 assertions: the two-stream transport split
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
                         # fingerprint's three verdicts), the publish budget of a
                         # waterfall event, the streaming model contract (stable
                         # uid, advancing rev, no bubble after turn/end), the
                         # webview's incremental reconciliation (a no-op push
                         # builds zero DOM and re-parses zero markdown; one chunk
                         # rebuilds one row), the batch projection budget, the
                         # changed-files routes (plain authenticated GETs, a gone
                         # summary as "no card"), the hunk-to-sides line alignment,
                         # the virtual URI authority contract, the one-card-per-turn
                         # model semantics, and the webview script's integrity
```

What the protocol test deliberately does **not** cover is the whole product. It
pins the wire contract and the model — not a user's sequence of actions. See
[End-to-end tests](#end-to-end-tests) for the layer above it.

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
# the desktop app works too, but it starts its Host on an OS-assigned port:
DSH_PORT=3081 npm run integration-test
```

## End-to-end tests

Protocol assertions are cheap and they passed all the way through the release
that broke the mention chip. What they cannot see is a *sequence*: connect,
restart the Host, reconnect; send from the browser, observe here; approve,
reject, time out. That is the layer this project is now building out.

`test/e2e/` is where those chains live. **This table is the honest state of it, not a
roadmap of intent** — a chain that is not written says so, in the suite's own output as
well as here, because a suite that quietly omits four of five chains looks identical to one
that passes.

| # | Chain | State |
| --- | --- | --- |
| 1 | Connect and auth — Host up → VS Code connects → Host restarts → recovers | ⬜ not written — needs a Host that can be killed and restarted between two connects |
| 2 | Session consistency — browser sends → VS Code sees it → switch → reload → history intact | ⬜ not written — needs a real Extension Host |
| 3 | Streaming — long reply → tool call → drop the socket → no duplicate, loss or reorder | ⬜ not written — needs a Host that can kill one connection without dying itself |
| 4 | Approvals — allow, reject, time out, Host error → every card reaches a terminal state | ⬜ not written — needs a real Extension Host to click in |
| 5 | File changes — agent edits → user re-edits → revert must not clobber the user | ✅ **15 assertions passing**, on a real filesystem |

Chain 5 is the one with a hazard rather than a bug, and it is the only one that does not
need an Extension Host to be tested honestly: `ReviewMaterializer` takes the workspace API
as a constructor argument, so it runs against a stub whose `fs` is the **real** filesystem
and a real temp directory. A simulated one would let the test agree with the implementation
instead of catching it. It covers the ordinary revert, the checklist case (file edited after
the turn → revert refuses → your bytes survive), unsaved editor changes, a created file
removed, a created file edited, and a deleted file restored.

`npm run e2e-test` reports `1 of 5 chains covered, 4 not written` and exits non-zero only
for a chain that ran and failed. The OS matrix (`ubuntu-latest`, `windows-latest`,
`macos-latest`) is wired in `.github/workflows/e2e.yml` and already earns its keep: the
protocol test parses three different OS listener-table dialects, so running it on all three
is the only way those parsers meet their real target.

## Development

```bash
npm install
npm run build            # esbuild → dist/extension.js
npm run watch            # rebuild on change
npm run typecheck
npm run check-versions   # every version surface must agree with package.json
npm run protocol-test    # 381 protocol assertions against a fake harness
npm run protocol-probe   # report what your real dsh web exposes
npm run package          # → harness-connector-deepseek-0.2.2.vsix
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

Two habits this repo now enforces rather than requests:

- **`package.json` is the only place a version is authored.** Everything else — the
  README's "what's new" heading, the install command's VSIX filename, the CHANGELOG's
  newest entry, the release baseline, the assertion counts quoted in the docs — is
  compared against it by `npm run check-versions`. Add a surface that mentions a
  version and you add a check; do not add a number and hope.
- **Release history goes in the CHANGELOG.** The README describes the current state
  of the product and keeps exactly one release's notes.

## Design: DSH owns the write; the plugin observes and tells

Two facts about how DSH works decide almost everything else here.

**DSH writes to disk and reads it back on the next step.** That ordering is not an implementation detail you can route around — it is what each step is built on. A file tool reports its change, and the following step opens the file as it now is. So the tempting move, intercepting the write — buffering it, proxying it, turning it into a `WorkspaceEdit` for VS Code to apply — buys a tidier-looking review flow at the price of breaking step-to-step consistency. And it breaks late and sideways: a wrong result several steps on, with no visible thread back to the interception. This plugin does not intercept writes. **DSH is the only writer.**

**The plugin is an observer, not a gatekeeper.** By the time you see a change, it is already on disk. That made "Accept" a button that did nothing except imply the change had been waiting for permission, so it is gone. What is left is a report: here is what changed, here is the diff, here is the undo. This is the same relationship two people have on one repository — you do not ask permission to save a file, you look at what the other person did.

Three consequences, all deliberate:

- **Human and AI are equals at the file level.** DSH writes, you write, and neither is asked to confirm the other. What keeps you from colliding is not a lock — it is that both of you can see the diff and either of you can undo. The plugin's job is to make that record visible in the conversation stream, next to the call that produced it, rather than standing between the two of you.
- **There is no reflow mechanism, and none is needed.** DSH re-reads the file every step, so it is never working from a stale copy of something you edited underneath it. If you want the AI to know about your edit, you say so in the conversation, or it reads git history. Nothing has to be pushed at it.
- **What the browser can show, VS Code shows natively.** Where the plugin has something to present — a diff, a file the AI pointed at — it opens VS Code's own editor instead of reimplementing a viewer in the webview. The webview is for the conversation; the editor is for the code.

What is ruled out is as much a part of the design as what is included. Registering DSH as a **Copilot language model provider** would put a dropdown entry in the picker and put *something else's* agent loop behind it — no tool calling, no approvals, no context management, none of the orchestration that is the actual product. Trading the harness for a model entry is a bad trade. Driving DSH over **ACP** instead of the web transport is the same shape of mistake in miniature: the `acp` profile is a stdio JSON-RPC server that describes itself as automation-only, and it carries neither elicitation nor the DSH display cards — so it would lose the approval/question waterfall and the changed-files record that the HTTP+WS transport already delivers.

**Starting no process remains the default.** The one place this design was softened is managed launch, and it is softened in the same spirit: it is opt-in, the extension only ever starts the Host it was asked to start, and it stops that Host on the way out. The default still attaches to what you already have.

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
- **A launch URL is a per-process secret, not a one-shot grant.** Upstream's
  `authorizeIndex` compares the `token` query parameter against the process secret with
  `timingSafeEqual` on *every* request to `/`, so the same URL can be redeemed more than
  once and a reconnect does not need a new Host. Measured, not inferred:
  `scripts/launch-probe.ts` redeems the URL twice and expects `303` both times.
- **`dsh web` does not daemonise.** The process this extension spawns is the one holding
  the port — sampled over several seconds, with the Host still answering `401` while the
  child is alive and the port refusing connections once it is stopped. That is the
  invariant `stop()` rests on: if `dsh` re-exec'd itself into the background, killing our
  child would leave a Host running that the user could not account for.
- **The Host can be found without being told where it is.** An anonymous request
  to a dsh Host is refused by the connection carrier with a fixed sentence
  (`dsh web authentication required; reopen the URL printed by dsh web.`), which
  no other local server emits — so it doubles as an identity check. That is what
  `deepseekHarness.autoDiscover` uses, after first reading any `webserver.port`
  pinned in a profile's user patch layer. Measured on this machine: 46 loopback
  listeners probed, one Host found, attributed to the pinned `desktop` profile.
- **A state push is expensive, so there are as few of them as there are changes.**
  The webview used to answer an accepted push by tearing down `#messages` and
  rebuilding every item, so anything that published had to have something to
  publish. Measured on a 72-record session, one approval/question event used to
  cost 2 pushes, ~70 KB and 2 full rebuilds; it now costs 1 push and no rebuild.
  The event inspector's frame ring buffer — up to ~600 KB of truncated frames — is
  published only while that panel is on screen, which took a single push from
  1,318,580 bytes to 35,399 on the same session. The figures are asserted, not
  asserted-to: see group I of `scripts/protocol-test.ts`.

## Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- **Under `sessionMode: "credentials"` the extension can read a file that contains your
  API keys.** It has to, to mint the session cookie — which is why that mode is no
  longer the only one. See [How the session is obtained](#how-the-session-is-obtained).
- **Managed launch only covers "nothing is listening".** A Host somebody else started —
  a terminal, the desktop app — never shows us its launch URL, so that case still ends in
  the `paste` route. The two cover different halves and neither replaces the other.
- **The Host started by `managed` is stopped when the window closes.** That is deliberate
  (a stray Host holding a port is exactly the mess this extension avoids), but it means
  the Web UI tab you had open stops working when you quit VS Code.
- **Managed launch needs a `dsh` that can actually boot.** An out-of-date global `dsh` can
  be too old for the credential file the desktop app wrote, and it will exit on startup —
  the panel's advice in that case is to open the log, because the reason is always in the
  child's own last lines. Updating it fixes it.
- **Images depend on the model.** Whether a model accepts images is not published in `session/modelCatalog`, so the plugin can only pass the host's verdict through: a non-vision model fails the prompt with `MODEL_DOES_NOT_SUPPORT_IMAGES`, and the panel tells you to switch models in Controls. Your staged attachments are kept for the retry.
- **Staged files are process-bound.** An upload receipt is tied to the session *and* the running `dsh web` process, so a file staged across a host restart must be re-picked.
- History loads the last ~50 messages; "load older" is a future feature.
- Session deep-links in "Open Web UI" are intentionally not guessed — only the Harness home opens.
- Unknown harness event types are ignored (the protocol is merge-extensible); they do not crash the client but also do not render.
- **A revert writes the captured `before` text back — it does not use `git checkout`.** Before writing, it checks that the file on disk still matches the `after` it captured at review time, and that no editor has unsaved changes to it. If either has moved on, the revert is refused and the file is marked conflicted rather than overwritten. That guard is why the undo is safe to offer without asking, and why it can decline.
- **A turn's changed-files card lists what the turn changed, but only a file tool's own change can be undone from it.** The undo is scoped to the reviews that turn produced, because a Host summary carries paths and line counts, not the text needed to restore anything. A turn that changed files only through shell commands will say so.
- A changed-files summary lives for the Session's lifetime on the Host, so a card can resolve to "no changes to show" after a host restart. That renders as no card, matching the Web UI.

## Roadmap (v0.3.0+)

- **The five end-to-end chains above**, for real: a real Extension Host, a fake Host
  that can be killed and restarted mid-turn, and a matrix over Windows, macOS and
  Linux. Chain 5 in particular — agent edits, then *you* edit, then revert — needs the
  end-to-end shape, not just the unit-level guard.
- **Partial revert — hunk level.** The materializer already knows how to revert a single hunk (and refuses when the file has drifted), but no UI reaches it any more: a revert is all-or-nothing per file today. Restoring it means offering per-hunk undo in the changes card and in the native diff, driven by the hunk list the Host already serves rather than by whole-file text it does not keep.
- Per-item state patches: a streaming push still ships the whole transcript (~52 KB per push on a 40-turn session). The renderer no longer rebuilds it, but the structured clone across `postMessage` is the remaining per-chunk cost.
- Inspector: filter box / type highlight / export as JSONL
- Search: scope to workspace, pagination, highlight rendering
- Inline Completion
- VS Code filesystem provider
- Terminal integration
- LSP / ACP integration

## License

MIT
