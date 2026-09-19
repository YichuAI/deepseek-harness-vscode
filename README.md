# DeepSeek Harness Connector for VS Code (v0.0.3)

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.svg)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![Version](https://img.shields.io/badge/version-0.0.3-blue.svg)](https://github.com/liangwythu/deepseek-harness-vscode/releases/tag/v0.0.3)

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

## What's new in v0.0.3

**Diff Review, Approval Workflow & File Context Inlining** — closes the biggest experience gap with Cursor/Cline: code changes can now be reviewed and approved entirely inside VS Code.

- **Diff Review & Inline Code Application** — When the agent writes or edits files, a review card appears in the sidebar showing each changed file with `+added`/`-removed` line counts. Click **Diff** to open VS Code's native diff editor. Accept (keep) or Reject (safe revert via `git checkout`) per-file or all at once.
- **Approval Workflow Integration** — `approval/requested` events now render inline as cards with **Allow once** / **Deny** buttons. No more switching to the browser to approve. A security allowlist restricts which tools can be approved from VS Code; high-risk operations still require the Web UI.
- **@file Content Inlining** — File references (`@file:path` or `@file:path:L10-L20`) now have their content read and inlined directly into the user message, guaranteeing the agent can see file content. Context metadata (active file, selection) is only sent on the first prompt of a session.
- **Context Menu Integration** — Right-click a file in the explorer → **Add to Harness Chat**. Select text in the editor → right-click → **Send Selection to Harness**. Both use workspace-relative paths.

See [CHANGELOG.md](./CHANGELOG.md) for the full diff.

### Previous releases

- **v0.0.2** — Conversation UX & Architecture Baseline: Assistant Markdown rendering, tool card merging, system message collapsing, lazy workspace/session creation, streaming render fix, architecture hardening.
- **v0.0.1** — First public release: prove VS Code and the browser share the same Harness session.

## What v0.0.3 does

- Connect to a **local** `dsh web` (loopback only — `127.0.0.1` / `localhost`).
- Match the active VS Code folder to a Harness workspace. If none exists, the workspace is created **lazily on first prompt** — no modal.
- List the workspace's existing sessions.
- Open a session and render its history.
- Send a plain-text prompt to that session. If no session exists, one is created automatically.
- Stream the assistant's reply with **Markdown rendering** (code blocks, lists, tables, links).
- Show tool calls as **collapsed cards** with name-aware titles (`Read src/foo.ts`, `Search "pattern"`, `Run npm test`).
- **Review agent code changes** — diff cards with per-file Accept/Reject, native VS Code diff editor, bulk Accept All / Reject All.
- **Approve or deny agent actions** — inline approval cards with Allow once / Deny buttons (security allowlist enforced).
- **Attach file context** — use `@file:path` or `@file:path:L10-L20` in your prompt; file content is read and inlined automatically. Right-click in explorer or editor for quick insertion.
- Hide plugin-injected system messages by default; toggle with the `SYS` button.
- Stop the active turn.
- Reopen the stream and refetch history on disconnect.
- "Open in Harness Web UI" command.
- Dock the view in the right side bar (like Chat) via the ⇲ button.

## What v0.0.3 deliberately does NOT do

For your safety, the following remain out of scope:

- No `commands/execute`, no `credentials` or `settings` API.
- No model switching.
- No inline completion, terminal/LSP integration.
- High-risk approvals (e.g. `bash` with untrusted input) cannot be allowed from VS Code — the card shows "Review in Web UI".
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

   Harness ≥ 0.1.6 prints a **launch URL with a one-shot token**. Copy it.

2. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) or via command line:

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   Or install the VSIX from [GitHub Releases](https://github.com/liangwythu/deepseek-harness-vscode/releases):

   ```bash
   code --install-extension harness-connector-deepseek-0.0.4.vsix
   ```

3. Nothing to configure. The extension auto-connects: it reads the browser-session
   signing secret that `dsh web` keeps in `$DSH_HOME/.credentials.yaml` and mints the
   same `dsh-auth-…` cookie itself. No token to paste.

4. Open a folder in VS Code that you want to bind to a Harness workspace.

5. The DeepSeek Harness activity-bar icon appears; the extension auto-connects. If your folder matches an existing Harness workspace, its sessions appear in the dropdown. Pick one and continue the conversation.

6. **No matching workspace?** Just type a prompt and hit Send — the workspace and session are created automatically.

7. **Attach file context** — type `@file:src/main.ts` or right-click a file in the explorer and choose **Add to Harness Chat**. Select text in the editor, right-click, and choose **Send Selection to Harness** for line-range references.

8. Open the same session in your browser at `http://127.0.0.1:3080/` — both surfaces see the same turn.

> The manual command **`DeepSeek Harness: Set Session Token from Launch URL`** still
> exists as a fallback — it is the only sanctioned path when the credential store
> cannot be read (see below).

### How the session is obtained

Harness ≥ 0.1.6 rejects every `/api/*` call without a browser-session cookie, and
the sanctioned way to get one is exchanging the per-process launch token. Nothing
writes that token to disk, so officially you must paste it.

But the cookie carries no trace of the token: it is an HMAC over
`{version, authority, issuedAt, expiresAt}` keyed by a secret persisted in
`$DSH_HOME/.credentials.yaml` (`client-connection/browser-session`), created once
and reused by every later `dsh web` process. Anything that can read that file can
therefore mint a byte-identical cookie — so the extension does, and you never
have to paste anything.

**Is this safe?** The file is written owner-only (`0600`) and holds your model API
keys, so being able to read it already implies full authority over this harness
home. Minting from it is *permission-equivalent*, not an escalation. It does skip
the per-process token gate, but that gate defends against remote callers
(rebinding, CSRF) — not against code already running as you. Set
`deepseekHarness.autoSession = false` to require the manual exchange instead.

The plugin log records which path was used on every connect.

### When manual entry is unavoidable

| Situation | Why |
| --- | --- |
| `$DSH_HOME` points elsewhere and you have not set the env var | nothing can be found to read |
| `dsh web` has never run in this harness home | no `client-connection/browser-session` record exists yet; run it once |
| You set `deepseekHarness.autoSession = false` | you asked for the sanctioned exchange |

A cookie granted either way then lives its own life: the extension stores it in VS
Code's secret storage (OS keychain — never `settings.json`), it survives `dsh web`
restarts, and it is only re-derived when it expires or you change `host`/`port`
(the cookie name is `dsh-auth-<sha256(host:port)>`, so it is bound to the
authority that minted it). If it ever lapses, the extension tells you which
command to run instead of just reporting `401`.

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | **v0.0.x only allows `127.0.0.1` or `localhost`.** Any other value is refused. |
| `deepseekHarness.port` | `3080` | The default `dsh web` port. Override if you started `dsh web --port <n>`. |
| `deepseekHarness.showSystemMessages` | `false` | Show plugin-injected system messages (runtime context, approval notices). Hidden by default; toggle live with the `SYS` button in the webview header. |

## Commands

- `DeepSeek Harness: Connect` / `Disconnect`
- `DeepSeek Harness: Set Session Token from Launch URL` — paste the `dsh web` launch URL to obtain the browser-session cookie
- `DeepSeek Harness: Clear Session Token` — drop the stored cookie (e.g. before switching `dsh web` instances)
- `DeepSeek Harness: New Session` (in the active workspace)
- `DeepSeek Harness: Refresh Sessions`
- `DeepSeek Harness: Move to Right Side Bar` — dock the view in the secondary side bar (like Chat) so it stops competing with the file explorer. Also available via the ⇲ button in the webview header.
- `DeepSeek Harness: Toggle Plan Mode` — flip `/plan` on the active session
- `DeepSeek Harness: Set Permission Preset` — pick (or type) a preset such as `read-only` / `workspace-write` / `danger-full-access`
- `DeepSeek Harness: Compact Session Context` — request `/compact`
- `DeepSeek Harness: Fork Session` — branch off the current session and switch to the fork
- `DeepSeek Harness: Rename Session` — pin a title (stops automatic regeneration)
- `DeepSeek Harness: Archive Session` — archive it out of the active workspace list
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

- **Add to Harness Chat** (explorer right-click) — inserts `@file:<relative-path>` into the chat input.
- **Send Selection to Harness** (editor right-click, requires selection) — inserts `@file:<relative-path>:L<start>-L<end>` into the chat input.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the one-page design and the protocol contract. (中文版: [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md))

## Protocol fixtures

`test/fixtures/` holds sanitized captures of the live wire format, useful for detecting upstream Harness protocol drift:

- `host-describe.json`, `workspace-list.json`, `session-list.json`, `session-history.json`, `session-prompt.json`, `session-event.json` — **note:** these are pre-0.1.6 captures, kept only as historical drift references. `host-describe` / `session-history` / `workspace-list` no longer exist upstream.

No credentials, API keys, or real prompt content are stored — only the JSON shapes (text fields are redacted).

## Protocol test

A standalone Node script drives the real client code against a **fake** 0.1.6
harness — no `dsh web` needed:

```bash
npm run protocol-test    # 98 assertions: wire negotiation (dot/slash, cookie
                         # gating, event socket), auth, cookie derivation,
                         # {args} payloads, approval waterfall, assistant
                         # stream, removed-endpoint 404 handling, control-surface
                         # capability probing and the whole-value control fold
```

To ask your **real** `dsh web` what it actually serves (endpoint style, event
socket, and which of 29 candidate methods exist):

```bash
npm run protocol-probe            # defaults to 127.0.0.1:3080
npm run protocol-probe 127.0.0.1 3080
```

For a closed loop against your **real** `dsh web`, use the integration test
(start `dsh web` first):

```bash
DSH_LAUNCH_URL='http://127.0.0.1:3080/?token=<token>' npm run integration-test
```

## Development

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # rebuild on change
npm run typecheck
npm run package      # → harness-connector-deepseek-0.0.4.vsix
npm run protocol-test      # 98 protocol assertions against a fake harness
npm run protocol-probe     # report what your real dsh web exposes
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Verified against

- Default `dsh web` port `3080`; the host must be on loopback.
- **The wire is negotiated, not assumed.** Endpoint style (`session/list` vs
  `session.list`), cookie gating, and the event socket (`/api/remote.mux` vs
  `/api/events.mux`) are all discovered at connect time, so one build works
  across host releases. Run `npm run protocol-probe` to see what your host
  actually serves.

## Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- Text prompts only (no image attachments).
- History loads the last ~50 messages; "load older" is a future feature.
- Session deep-links in "Open Web UI" are intentionally not guessed — only the Harness home opens.
- Unknown harness event types are ignored (the protocol is merge-extensible); they do not crash the client but also do not render.
- Diff review revert uses `git checkout` — uncommitted changes to the target file will be lost on Reject.

## Roadmap (v0.0.7+)

- Model / reasoning-effort pickers driven by `session/selectModel` and `llm/models`
- Sub-agent controls (`subagent/interrupt`, queued-message steering)
- "Load older" history pagination
- Inline Completion
- VS Code filesystem provider
- Terminal integration
- LSP / ACP integration
- Image attachments

## License

MIT
