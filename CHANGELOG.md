# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),  
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.5] — 2026-10-14

Tagline: **a documentation release that had to be a version, because the README ships inside the
package.**
Tagline (ZH): **一次必须算作版本的文档发布，因为 README 就在安装包里。**

### Added

- **`STORY.md`, with its `STORY.zh-CN.md` twin** — how the extension got built, told straight:
  58 days and 24 tagged versions, of which eleven days actually contain code; the change that
  mattered most was *deleting* the Accept button; the won't-do list that is longer than the
  feature list; and the three bugs a model could not have caught (a connection that said
  "connected" and then went silent, a green test that was green by accident, and 331,709
  against 331,706). Both READMEs link to it. It sits on the `.vscodeignore` list next to
  `RELEASE*.md`: the story is repository content, not extension content, and keeping it out is
  what holds the package at fourteen files.

- **A 30-second trailer, at the top of both READMEs.** `docs/media/promo-preview.webp` is an
  8-second silent loop cut from the film — 80 frames at 10 fps, under 900 KB — and it links to
  `docs/media/promo-1080p.mp4` (7.8 MB); `docs/media/promo-cover.jpg` is the poster the
  development story opens with. Why an animated image rather than a `<video>` tag is worth
  writing down: GitHub's renderer strips `<video>` out of a README entirely (checked by
  rendering the tag through the Markdown API — it comes back as an empty paragraph),
  `raw.githubusercontent.com` serves `.mp4` as `application/octet-stream` with
  `X-Content-Type-Options: nosniff`, and a bare `.mp4` link renders as nothing but a link. An
  animated WebP is the only form that moves in a README, and it survives the Marketplace's
  image pipeline too.

- **The screenshots are redacted.** `docs/screenshots/01-shared-session.png` and
  `03-editor-sidebar.png` were replaced with captures that do not carry the author's home
  directory or workspace path in the panel's status row.

### Changed

- **Both READMEs were reworked for someone skimming.** An "At a glance" table and a jump list at
  the top; the long paragraphs in *Design* and *Verified against* broken up or turned into
  tables; and *What's new* rebuilt around a table of what someone installing from the
  Marketplace is actually getting. No technical claim changed, and the mirror stays exact — the
  two READMEs are still one document in two languages.

- **The README now says what this release is.** Its current-release section opens by naming it:
  the first build to reach the Marketplace since 0.2.0.

### Notes

- **No runtime change.** 0.2.5 is 0.2.4's behaviour byte for byte, in a package whose shipped
  documentation is different. It carries a version number because `README.md` and
  `CHANGELOG.md` are two of the fourteen files inside the VSIX: editing them edits the
  artifact, and a version number names the artifact.
- Gates on this tree: `tsc --noEmit` clean, protocol-test **493**, e2e **96** (3 of 5 chains),
  live integration **41/41**, `check-versions` green.

## [0.2.4] — 2026-10-13

Tagline: **three things a day of testing turned up: a card from someone else's conversation, a remote
with no `dsh` on it, and a launch URL that had lost its token.**
Tagline (ZH): **测试一天翻出三件事：别人的对话的卡片、没装 `dsh` 的远程机，以及丢了 token 的启动 URL。**

### Added

- **`DeepSeek Harness: Install Host`** — and it installs in the extension host, which on a
  remote connection *is* the remote. The advice-only version of this feature fails in a way
  nobody notices: the user installs `dsh` on the laptop in front of them, reconnects to a
  remote that still has none, and the panel says the same thing again. `src/harness/install.ts`
  has no notion of "remote" in it at all, and that is the design — it spawns into `process`'s
  own context, which VS Code has already put on the correct side of the connection. It never
  elevates: a system-owned `npm` prefix fails with `EACCES` and the refusal plus npm's own
  output is what names the unwritable prefix.

- **`src/harness/waterfall.ts`** — the rule that a forwarded waterfall belongs to the session
  its frame names, and to nothing else. One exported function, pure, asserted exhaustively
  including the field's actual empty shapes (`''` from a template literal, a non-string, an
  absent key). See the attribution fix below for why it needs to exist at all.

- **`waterfallSession`, `launchPlan` and the remote install route are all asserted directly.**
  Each is one small decision where the wrong answer still looks plausible, which is exactly the
  kind of code a test should not reach through three layers of UI.

### Changed

- **A missing `dsh` has an automatic answer now, and it runs on the right machine.**
  `launchPlan(command)` returns the ordered commands managed launch will try: the configured
  one, plus — only for the **default** command, and only after a `not-found` failure —
  `npx -y @deepseek-ai/dsh@latest web --port 0`. Under Remote-SSH that fetches the CLI on the
  remote and starts the Host there, with nothing installed globally and nothing needed on the
  remote's `PATH`. Two deliberate limits: a non-`not-found` failure (timeout, early exit,
  refused URL) says something about the Host rather than about which command started it, so it
  gets no second attempt; and a `launchCommand` the user set is never substituted, because
  silently running a different build is how a real setup problem gets hidden. The `npx` step
  also gets a longer timeout (300s vs 120s), since fetching the package is the slowest part and
  a cold cache would otherwise read as a broken install.

- **The install advice follows the connection, not the platform.** `installGuidanceFor` took
  `(platform, arch)` and now takes a third input, `vscode.env.remoteName`. `platform` still
  describes the target correctly, which is precisely the bug: a **Windows remote** host was
  told to download a desktop `.exe` — something that machine cannot run, on a screen the user's
  mouse cannot reach. A remote window now always gets the npm route, with no download link.
  The not-found fix text and the "Harness is not running" advice are remote-aware for the same
  reason: "open the desktop app" is advice for a machine you are sitting at.

- **"Open Web UI" adds the token it has.** The harness gates its web UI per process — a bare
  `http://host:port/` answers `401` — so the command used to print a message telling the user
  to go and find the launch URL in a terminal. Two of the three session routes leave the
  extension holding one, so it opens it: the launcher's URL under `managed`, and
  `auth.browserUrl()` — the URL a pasted session was adopted from — under `paste`. It is a
  reusable per-process secret rather than a single-use grant, so it is still good when the
  command is used later. `browserUrl()` is gated on `cookieHeader()`, so it can never offer a
  URL for a Host the plugin is not authenticated against; a stale token opens a page saying
  "unauthorized", which reads like an extension bug rather than a restarted Host. Under
  `credentials` there was never a token (the cookie is minted from the signing secret without
  any exchange), and the message now says exactly that instead of pointing at a file the mode
  exists to avoid.

- **The panel's "open web UI" link is the same function as the command.** It was a second,
  shorter message with its own copy of the reasoning; it now calls `openWebUi`.

### Fixed

- **A question raised in another session was rendered as a card in the conversation on
  screen.** `$events` is host-wide — every session's approvals and questions arrive down the
  one socket — and `emitQuestionRequested` read `request.sessionId` to find out whose they
  were. An approval's `request` does carry one. A **question's does not**: the event is
  delivered on an Agent-scoped waterfall and the wire request contains no session of any kind.
  So the read found nothing, and the code fell back to *whatever session the panel happened to
  be showing*. A browser tab's question therefore appeared in VS Code as an answerable card
  about a different run.

  The field that says which session it is had been in `agentId` the whole time, unread. That
  is not an inference from naming: the shipped Host registers the wire codec as
  `lookups.register('agent', { wire: 'agentId', wireTypeSymbol:
  '@deepseek-ai/dsh-session/types#SessionId', resolve: (sessionId) => this.get(sessionId) })`
  — the declared wire type of `agentId` *is* `SessionId`, validated before the frame is
  forwarded. Both waterfalls now take their session from it, with `request.sessionId` as the
  fallback for an approval on a host that omits it, and **the fallback to the active session is
  gone**. A frame that names no session produces no card and is logged; `respondQuestion`
  already throws for a frame the client never adopted, so there is no second path in either.
  Guessing is how this bug happened, so guessing is not the fallback.

- **The end-to-end fake Host can now put a waterfall from another session on the wire.**
  `emitApproval` / `emitQuestion` take the frame's scope as an argument, with `null` meaning
  "omit `agentId`" — which is the only way to exercise the decline-rather-than-guess rule
  without hand-writing a frame. Chain 4 gained five assertions from it, and the live
  integration test gained one that reads the attributed session off a real
  `user-questions/request`, which is the only place that fact can be measured rather than
  reasoned about.

## [0.2.3] — 2026-10-13

Tagline: **undo part of a change, and get a written answer about remote workspaces instead of a refusal.**
Tagline (ZH): **可以只撤销一处改动的一部分了；远程工作区拿到的是一份写下来的回答，而不是一句拒绝。**

### Added

- **Per-hunk undo, in the changes card.** Each hunk inside a file gets its own row — a preview
  line, its own `+`/`−` counts, and an ↩ that reverts that hunk alone. The file-level button
  stays and now means "revert whatever is left", which is the same action it always was; what
  changed is that it is no longer the only one. `ReviewSummary.files[].hunks` grew from
  `{id, state}` to include `addedLines`, `removedLines` and a `preview`, because a card cannot
  offer a choice between hunks it cannot name.

  The text surgery lives in `src/review/patch.ts` — a pure module with no filesystem, no
  `vscode` and no store — so the interesting case is asserted directly rather than through a
  rendered card. That case is *where* a hunk is. A deletion hunk has no text on the result
  side to search for and an insertion hunk has none on the original side, so offsets have to
  be recovered from both sides at once; and a single `indexOf` per hunk silently mis-locates a
  repeated fragment, patching the first occurrence rather than the one the diff meant. Both
  are now handled by a forward-only cursor on each side, plus a consistency check that refuses
  when the unchanged text between two hunks does not read the same on both sides.

- **Nine context-menu commands, in three submenus.** *Explain / Fix / Review* against a
  selection (`editor/context`), a file or folder (`explorer/context`), or a change — reachable
  from a diff editor (`isInDiffEditor`) and from a source-control row (`scm/resourceState/context`).
  The one that needed thought is "this change": a diff tab can be open while the person
  right-clicks a different SCM row, so the resolver tries the menu argument first, then the
  diff tab's modified side, then its original side, then the active editor — and the ordering
  is load-bearing rather than incidental. `src/context/quick-task.ts` holds the prompt strings
  and the scheme policy (`file` and `vscode-remote` are openable; `git`, `gitlens` and our own
  `dsh-review` are not, since none of them is the working-tree file).

  The prompts are asserted through the webview's real `@` grammar rather than by
  pattern-matching the string, because the failure that matters is quiet: a prompt that reads
  perfectly and whose mention never becomes a chip, so the agent is asked about nothing.

- **`src/harness/endpoint.ts`** — the loopback fence and the three strings built from a
  `{host, port}` (the `Origin:` header, the authority the cookie is named after, the `ws://`
  URL). One module because they are one decision, and because the answer to "does this work
  over Remote-SSH?" should be a file you can point at rather than a setting you can look for.

- **A remote-development matrix in both READMEs.** Four scenarios, their state, and what each
  one means — including the three this machine could not exercise.

### Changed

- **`deepseekHarness.host` accepts three values, and now so does the documentation.**
  `127.0.0.1`, `localhost` and `::1` were always the accepted set; the README and the setting's
  description said "`127.0.0.1` or `localhost`", which was wrong in a way that cost nothing
  until it did — see the `::1` fix below.

- **The refusal is one message, and it is a diagnosis.** `connect()`, the unary `rpc()` path
  and the `changes.*` routes each had their own wording for the same rule, and the connect-time
  one still said "v0.0.x only supports local DeepSeek Harness instances". They now all raise
  `nonLoopbackRefusal(host)`, which names the three accepted values and the machine they mean,
  and `classifyConnectFailure` gained a `non-loopback-host` kind for it — first in the rule
  list, since it is a decision rather than a failure to diagnose. Previously a user who typed
  a LAN address got "Could not connect" with no fix.

- **`extensionKind: ["workspace"]` is now declared.** It was implicit before, and the default
  is a *preference* rather than a constraint. In a remote window the extension host has to run
  on the remote machine — that is the only place its `$DSH_HOME`, its listener table and its
  loopback all describe the same Harness — and a silent fallback to running locally would point
  the plugin at the wrong machine's loopback with the wrong machine's credential file.

- **`test/**/*.ts` is typechecked.** It never had been. Adding it to `tsconfig.json` immediately
  caught a real error: chain 4 was calling `respondQuestion` with `selected: 'Beta'` where the
  field is `string[]` — a question may allow several choices — so the most recently written
  end-to-end chain had been shipping a type error that `tsc` had never been asked about.

- **`ReviewMaterializer` takes an explicit `RevertWorkspace` interface** instead of
  `typeof vscode.workspace`, and `test/e2e/vscode-stub.ts` aliases that type rather than
  maintaining a second copy of it. Narrowing the constructor is what made the e2e suite
  typecheckable; aliasing the type is what keeps the stub from drifting into disagreement with
  the thing it stands in for.

- **End-to-end coverage went from 1 chain to 3.** Chains 1 and 4 are the two the
  v0.0.4→v0.1.1 changelog makes the case for: the panel did not start until v0.1.1, and "Allow"
  never actually allowed until later, and a unit test would have been green through both.

### Fixed

- **Undoing the second hunk of a file was refused as `stale`, every time.** The guard compared
  the *whole file* against `afterText`, and once the first hunk had been reverted the file no
  longer matched — so hunk 2 onward could never be undone, and the refusal blamed an edit that
  had not happened. The expected content is now derived from the diff (current text, plus back
  every hunk not yet undone) and compared that way. A genuine edit made in between still
  refuses; the difference is that "you edited this" is now true when it is said.

- **A click on a review that had captured no text deleted the file.** A review built from a
  tool call's arguments alone has `beforeText === null && afterText === null`; `rejectFile`
  fell through to the "this file was created" branch and removed the path. It now refuses with
  a new `no-diff` reason and says what is missing. Found by writing the per-hunk tests, not by
  a user — the only good way to find it.

- **The card could not repaint after a hunk undo.** `reviewSigFor` built its signature from
  file-level fields only, and undoing one hunk of three leaves the file `partial` with
  unchanged counts — so the click looked like it did nothing. The signature now folds in
  per-hunk state.

- **`reviewRejectHunk` had been dead code since v0.1.8.** The materializer had supported
  `rejectHunk` all along and `src/view/client.ts` had never once posted it; there was no hunk
  row in the webview to post it from. A file-level revert button also now shows for `partial`,
  not only `pending` — a half-undone file is exactly when you want the "revert the rest"
  affordance.

- **`::1` was accepted by the fence and unusable past it.** `LOOPBACK_HOSTS` has listed it
  since the fence was written, and every URL was composed as
  `` `http://${host}:${port}` `` — which for an IPv6 literal yields `http://::1:3080`, parsed
  as host `::1:3080` on port 80. `events.ts` already knew to bracket a literal for the socket
  URL; the HTTP origin, the upload URL and `authorityOf` did not. All of them now go through
  `endpoint.ts`, and `authorityOf` brackets too — which matters beyond the URL, because the
  cookie is named `sha256(authority)` and a client that formats its own cookie key differently
  from its own `Host` header is told its own cookie is invalid.

- **`muxUrl` had a private copy of the bracketing rule.** Same fix, same module.

### Notes

- **The two fences behind the remote answer, both measured on this machine.** *This plugin's*:
  `127.0.0.1`, `localhost` and `::1` are accepted; a LAN address, `0.0.0.0`,
  `host.docker.internal` and `172.17.0.1` are refused before a socket exists, asserted against
  an auth object that throws if touched — so "refused" means refused *before* the credential
  file was opened. *The Host's own*: with a Host on `127.0.0.1:3080`, the listener table reads
  `TCP 127.0.0.1:3080 … LISTENING` and nothing else on that port, and
  `192.168.68.221:3080` answers `ECONNREFUSED`.

- **Three of the four matrix rows could not be exercised here, and say so.** `wsl.exe` is on
  this sandbox's program blacklist and could not be launched at all; `docker` is not installed;
  there is no SSH server (`localhost:22` refuses). What is measured is the part that decides
  all four rows.

- **Test counts.** Protocol assertions 381 → **461** (the new N3 group covers the fence and the
  three derived strings; M2 covers the per-hunk surgery and the card that drives it; N2 covers
  the nine right-click asks). End-to-end 15 → **91** across three written chains (chain 1 = 23,
  chain 4 = 31, chain 5 = 37 — chain 5 grew from 6 sections to 13). Integration against a live
  `@deepseek-ai/dsh@0.2.0-rc.2` Host: **40/40** — one of them new, because the fence refusal
  is now asserted against the exported message rather than against a phrase from it, so the
  assertion cannot pass while the wording drifts somewhere the panel cannot render.
  Coverage is reported as `3 of 5 chains covered,
  2 not written`; the other two are still printed as unwritten rather than omitted.

- **Chains 1 and 4 need no Extension Host, and that is why they exist.** `HarnessClient` and
  `BrowserSessionAuth` import no `vscode`, so `test/e2e/fake-host.ts` is a real `http.Server`
  with a hand-written WebSocket and both chains run in plain Node. The fake Host keeps the
  real one's fences on purpose: a POST route that forgot to require the cookie answers the
  wire-negotiation probe with `200` instead of `401`, and the test would then be measuring the
  wrong classifier.

## [0.2.2] — 2026-10-12

Tagline: **it no longer has to read a file full of your API keys, and `autoSession: false` finally means something.**
Tagline (ZH): **它不必再读那个装满你 API key 的文件了，而 `autoSession: false` 也终于有了实际含义。**

### Added

- **Managed launch — opt-in, and the extension starts `dsh web` itself.** Until now the only
  way to authenticate was to read `$DSH_HOME/.credentials.yaml`, which also holds the user's
  model API keys. That was the single largest reason not to install this plugin, and it was a
  trade made for a real reason: minting the cookie locally costs no paste, and the alternative
  — the sanctioned per-process launch-token exchange — needs a line that only exists on the
  console of a process nobody controls.

  `deepseekHarness.sessionMode: "managed"` removes the trade entirely. The extension runs
  `deepseekHarness.launchCommand` (`dsh web --port 0` by default), captures the launch URL it
  prints, and redeems that token. Owning the process is what makes this possible: its stdout
  is ours, so there is nothing to paste and no credential file to read. The Host it started is
  stopped on `deactivate()`, which is why `deactivate` is now async.

  Discovery always runs first, so an already-running Host — the desktop app's, most likely —
  is adopted rather than duplicated.

- **`DeepSeek Harness: Use Launch URL`.** The `paste` route, as a command: paste the
  `dsh web: http://…` line and the extension trades the token for a session. This is what
  `autoSession: false` should always have been.

- **Install guidance, and it appears only on a failed connection.** `classifyConnectFailure`
  gained five inputs (`platform`, `arch`, `credentialsUnavailable`, `desktopInstalled`,
  `managedAttempted`) and now returns at most one `install` route. Windows and macOS get a
  link to the download page; Linux gets the build commands to copy, because upstream ships no
  desktop build for it. The panel renders one button, only while the connection is in the
  `error` state, and the button carries no payload — which route to take is decided
  extension-side from the same hint that produced it, so the webview cannot hand it a URL.

  The button is withheld when the desktop app is already on disk (the fix then says to open
  it), when a managed launch ran and exited (the fix says the port is taken), and when no
  platform is known. Telling somebody to install something they already have is worse than
  saying nothing.

- **Screenshots in the README.** It had four badges and zero images, which is a strange way to
  describe a visual product.

- **`scripts/launch-probe.ts`.** Runs the real launcher against a real `dsh web` and reports
  what a unit test cannot: whether a launch token can be redeemed twice, whether the Host
  outlives the child we spawned, and whether the port is quiet after `stop()`. Exit code is 0
  only when all three hold.

### Changed

- **`deepseekHarness.autoSession` (boolean) becomes `deepseekHarness.sessionMode` (enum).**
  The old switch could only turn authentication *off* — `false` meant "do not authenticate",
  because the command that would have offered the other route had been unregistered. A switch
  that can only disable things is not a setting, it is a trap, and it made the extension look
  like it could not work without reading the credential file.

  The three modes are `credentials` (mint locally — the previous behaviour, and still the
  default), `managed` (start the Host), and `paste` (you supply the URL). Upgrading changes
  nothing for anyone who does not change it; `credentials` is deliberately the default so that
  a silent change of behaviour is not what this release delivers.

  `traitsOf()` in `app/session-mode.ts` is the one place that answers "what does this mode
  permit", so `managed` cannot accidentally fall back to reading the credential file — which
  would make choosing it buy nothing.

- **`deepseekHarness.launchCommand`** — new setting, default `dsh web --port 0`. `--port 0`
  because managed launch reads the real port off the launch URL, so pinning one only adds a
  way to fail. Run through a shell, so wrappers and `npx` resolve the way they would in a
  terminal.

- **`DeepSeek Harness: Open Web UI` can now do what it says.** It used to be a message
  explaining why it could not: the harness authenticates its web UI per process, and a Host
  somebody else started never shows us its URL. A Host *we* started is the case where the
  extension has the URL, so under `managed` the command opens it.

- **A failed connect now names the route you are *not* on.** `alternatives()` switches on the
  active mode, because advice that tells you to do the thing you are already doing is worse
  than no advice. The refusing message in `authRequired()` also branches on whether local
  minting is even enabled — in `managed`/`paste`, the absence of a cookie is the design, not a
  misconfiguration, and pointing at a file the user asked us not to open would be wrong.

- **The README leads with the product and trails with the essay.** The design philosophy was
  the fourth section, above the fold, before a reader had been told what the thing does. The
  first screen is now a value proposition, a screenshot of the same session in two windows,
  and seven bullets; the "DSH owns the write" essay sits after Development. The credential
  discussion moved into "How the session is obtained" and is now about three modes rather than
  one unavoidable privilege.

- **Marketplace category `Other` → `AI`, and the keyword list expanded** to the terms people
  actually search (`deepseek-harness`, `dsh`, `ai-agent`, `coding-agent`, …).

### Fixed

- **The Marketplace badges in the README pointed at a namespace shields.io never served.**
  `img.shields.io/vs-marketplace/v/…` had been sitting there since the version gate landed, and
  it draws `404 badge not found` — on GitHub, and on the Marketplace listing too, which renders
  this README verbatim. Both badges now read `badgen.net`, which still serves real Marketplace
  data. (The version half is worth watching for exactly that reason: it reads `v0.2.0`, which is
  the truth the Marketplace has been sitting on.)

  There was no "correct shields URL" to switch to. shields' namespace is
  `visual-studio-marketplace`, and that one now answers with an SVG labelled *"retired badge"*
  — the integration was withdrawn rather than renamed. The gate that was meant to catch this
  compared substrings, and a dead badge string-matches perfectly. It now asserts the host,
  rejects any surviving `img.shields.io/vs-marketplace` URL, and under `--online` fetches each
  badge and fails when the SVG announces `not found` or `retired`.

- **A successful stop could be reported as `signalled`.** `taskkill` loses a race with a child
  that exits on its own, and then reports "no process found" — which reads like a failure while
  the Host is already gone, i.e. exactly the desired outcome. `stop()` now checks whether the
  child is still alive after a failed attempt, and only reports an unconfirmed stop when it
  truly is.

- **`envWithAugmentedPath` used the *host* `PATH` delimiter.** It takes a `platform` argument
  and then ignored it for the separator, so a Windows host building a macOS `PATH` produced a
  single unusable entry. Found by an assertion that passed on Linux and could not pass here —
  which is the argument for the assertion. `pathAugmentations` and `desktopInstallCandidates`
  now join with the matching `win32`/`posix` implementation for the same reason.

- **`adoptLaunchUrl` no longer re-redeems a launch URL it has already redeemed.** The
  comparison is against the URL, not the authority: a *new* Host can bind a port a dead one
  just released, and a persisted cookie for that authority belongs to the old Host's secret —
  so matching on authority alone would turn a port reuse into an unrecoverable
  "authentication failed".

- **The README called the launch token a "one-shot token".** It is not. Upstream's
  `authorizeIndex` compares the query token against the process secret with `timingSafeEqual`
  on every request to `/`, so the same URL can be redeemed repeatedly — confirmed both in
  `dsh-client-connection/lib/index.js` and by redeeming it twice in `launch-probe.ts`.

- **A factual claim the new feature made false is gone:** "Never starts a process for you. The
  extension does not spawn `dsh web`" was true and is now only true by default.

### Notes

- The measured behaviour behind managed launch, all from `launch-probe.ts` on Windows
  x64 against `@deepseek-ai/dsh@0.2.0-rc.2`: Host up in ~13 s from a cold `npx` (including
  the download), launch URL on stdout with a 43-character token, exchange `303`, bare `GET /`
  `401`, second exchange `303`, child alive and holding the port across 3 s of sampling, and
  the port refusing connections for 4 s after `stop()`.

- `dsh` has a background-boot concept — `--dsh-boot-bg` appears in the HTML it serves — so
  "does the child we spawned actually own the port?" was worth answering rather than assuming.
  It does. If it did not, killing the child would leave a Host running that the user could not
  account for, which is the specific mess this extension exists to avoid creating.

- Prototype note for anyone reading the diff: this machine's globally-installed `dsh` was
  `0.1.0-rc.6`, which predates the `{version, refs, records}` credential-file schema the
  desktop app writes — it fails with `the value for "version" in … must be a string`, because
  it parses that YAML as a flat map of credential-ref → string. That is an upstream version
  skew, not a defect here, and it is exactly the failure the new `exited` branch is designed to
  make legible: the panel sends you to the log, and the log carries the child's own stack
  trace.

- **Also published to Open VSX, starting with 0.2.1.** Cursor, VSCodium and Windsurf read
  Open VSX rather than the Microsoft Marketplace, and an extension present in only one of the
  two does not exist for those editors. One hard lesson for whoever publishes the next one:
  **a version number is occupied on Open VSX the moment it is accepted, even while the version
  is still inactive and unfetchable.** 0.2.2 was pushed there before the badge fix above and
  never became visible; re-publishing the same number is refused, and a `DELETE` carrying a
  publisher token answers `403`. So Open VSX keeps serving 0.2.1, and the badge fix will reach
  it with whatever version follows. Publish to Open VSX *last*, once the artifact has stopped
  changing — it is the one registry where that number stops being yours.

## [0.2.1] — 2026-10-11

Tagline: **version numbers that cannot drift apart, and an undo that cannot eat your work.**
Tagline (ZH): **版本号再也没法各自跑偏，撤销也再没机会吃掉你的改动。**

### Added

- **`npm run check-versions` — one gate for every hand-typed version.** The same extension
  was showing four different versions depending on where you looked: the Marketplace listing,
  `package.json` on `main`, the newest GitHub Release, and a stale `v0.0.3` heading that had
  been sitting in the README since August. None of it was a code defect. They were four
  independently-typed strings that nothing had ever compared, and a human had to notice.

  `package.json` is now the only place a version is authored. The gate compares it against
  the README's "what's new" heading, the VSIX filename in the install command, both
  CHANGELOGs' newest entry, `RELEASE.md`'s packaging baseline, the assertion counts the docs
  advertise, and — with `--online` — the published GitHub Release and the Marketplace
  listing. `--release` additionally requires the tag to exist and to point at HEAD.
- **The README's badges are derived, not typed.** A `badge/version-0.2.0-blue.svg` URL is a
  number someone has to remember and forgot twice; they are live shields endpoints now
  (`github/v/release`, `vs-marketplace/v`). The install commands keep the real filename and
  are *checked*, because a reader is supposed to paste them.
- **`DeepSeek Harness: Diagnostics`.** Runtime version, extension version, connection state,
  which capabilities the Host actually serves, and the last error — in one document, opened
  as untitled Markdown with a *Copy redacted report* action. Built by a pure function, so the
  redaction rules are unit-tested rather than trusted.
- **A connect failure is now classified instead of echoed.** `Disconnected`, `ECONNREFUSED`
  and "the Host refused our cookie" used to render as the same shrug. There are now five
  kinds — runtime not running, auth failed, wrong port, protocol incompatible, unknown — each
  with its own explanation and a repair action. The rules are ordered most-specific-first on
  purpose: a Host refusal also mentions failing to reach `/api/*`, so a reachability rule
  tested first would answer a credential problem with "start `dsh web`".
- **GitHub Actions: `ci.yml`, `e2e.yml`, `release.yml`.** CI gates on typecheck, version
  agreement, the protocol test, and the packaged VSIX's contents (14 files, sources
  excluded). The e2e workflow runs the suite on Windows, macOS and Linux — worth the matrix
  on its own, because the protocol test parses three OS listener-table dialects. The release
  workflow fires on a `v*` tag, verifies in `--release` mode, reads the version back *out of*
  the packaged VSIX, and attaches it with the matching CHANGELOG section as the notes;
  Marketplace publishing happens only if a `VSCE_PAT` secret exists.
- **`test/e2e/` — the first real user-action chain.** Chain 5 is the one on the checklist
  with a hazard rather than a bug: the agent changes a file, you change it again, then click
  Revert. Fifteen assertions drive `ReviewMaterializer` against an actual temp directory
  through a stub whose `fs` is the real filesystem — a simulated one would let the test agree
  with the implementation instead of catching it.

### Changed

- **The README describes the current state and no longer doubles as a changelog.** Every
  `What's new in v0.1.x` section and two long-obsolete `What v0.0.3 does` sections moved out;
  history lives in this file. What remains at the top is the design position, the credential
  disclosure, one release's notes, and the limitations.
- **The credential situation is stated up front.** The extension reads
  `$DSH_HOME/.credentials.yaml` to mint the session cookie, and that file also holds your
  model API keys. That was true before this release and documented further down; it now has
  its own section, including what follows from it and the note that a first-class
  local-client authorization flow would remove the need for it entirely.

### Fixed

- **A refused revert threw its reason away.** `markConflicted` set the state and dropped the
  message, so the card could say `conflicted` — a word that reports that nothing happened and
  nothing about what to do next. The reason is now stored on the file, carried to the webview
  in the summary, cleared when the file leaves the state, and folded into the review's
  render signature (a file refused twice with two different reasons keeps the same `state`).
  The row reads "⚠ not reverted" with the reason attached.
- **Reverting a whole turn reported once per file.** A turn touching twelve files where three
  had since been edited produced twelve notifications and buried the three that carried
  information. It is now one report with a count, and it says plainly that the untouched
  files were reverted and the edited ones were left alone.
- **The lockfile had been carrying a stale version since 0.1.5.** `package-lock.json` still said
  `0.1.4` while every other surface had moved on. `npm ci` does not validate the root version, so
  nothing noticed. It is invisible to a user, which is exactly why it is worth naming: it was the
  fifth place this release's number was written down, and the only one that was neither checked
  nor shipped. It is checked now.

### Notes

- The regression gate is now **342 assertions** (was 312): the new ones pin the failure
  classifier (including the ordering rule that keeps an auth refusal from being read as a
  dead process), the redaction rules, and the fact that a refusal keeps its reason.
- **End-to-end coverage is 1 of 5 chains, and the suite reports it rather than implying it.**
  Chains 1–4 print as *not written* with what each one needs, and the runner exits non-zero
  only for a chain that ran and failed. The README carries the same table.
- The version gate immediately caught one real thing: `ARCHITECTURE.md` and its Chinese twin
  quoted an assertion count the docs no longer agreed on. That is the drift it exists for.
- Packaging baseline: **14 files** (the byte count is recorded in `RELEASE.md`, measured
  after the last edit to a shipped doc — this file is one of the docs that ships, so a
  number written here would invalidate itself).

## [0.2.0] — 2026-10-11

Tagline: **two bugs that only showed up in use — a chip that ate the prompt, and a card that never stopped answering.**  
Tagline (ZH): **两个只有用起来才会冒出来的 bug——一个把提示词吃掉的芯片，一张永远答不完的卡片。**

### Fixed

- **The mention chip under the composer swallowed the prompt.** The webview's copy of the  
  `@` grammar lived in a plain string handed to `new RegExp`, and a string literal consumes  
  the backslash before `RegExp` ever sees it: `'[^\s"]'` arrived as `'[^s"]'`, a class that  
  matches spaces, newlines and further `@`s. Typing `@readmefor_human.md some prose` and  
  then `@RELEASE.md` on the next line produced one chip reading  
  `readmefor_human.md some prose @RELEASE.md` instead of two — and `:L10-L20` ranges  
  stopped parsing at all, because `\d` had degenerated to a literal `d`.

  It is a regex literal now, where the template's own escaping is the correct amount —  
  which is why the `/\\s/` test two lines below it had always worked. The file already  
  carried a note about the template eating backslashes; what the note missed is that a  
  *string* needs four where a regex literal needs two.
- **An answered question, and a granted approval, stayed on screen for the rest of the  
  session.** A mux client is never sent `question/resolved` or `approval/resolved` — only  
  a withdrawal `cancel` — so the card sat under the composer reading "Answering…" with its  
  buttons dead, and nothing ever released it. The POST **is** the settlement: a 2xx means  
  the Host took our value, so that is what settles the card now. A POST that fails walks  
  it back to pending instead of leaving the same dead end.

### Notes

- The regression gate is now **312 assertions** (was 295). The new ones drive the  
  *emitted* webview script for the chip grammar — the only layer that can see a backslash  
  eaten by the template — and the real controller for the waterfall lifecycle, including  
  the failed-POST path a happy-path controller test cannot reach.
- Live integration stays **39/39**.

## [0.1.9] — 2026-10-11

Tagline: **a ledger of what the turn changed — and an undo, not a permission slip.**  
Tagline (ZH): **一张本回合改了什么的账本——以及一个撤销键，而不是一张许可单。**

### Added

- **A changed-files card, one per turn.** The Host records what every top-level turn  
  touched and announces it as a `workspace/changes` Session event; the plugin now turns  
  that announcement into a card in the conversation stream's tool row. The card is fed by  
  a plain authenticated `GET /api/changes.summary?sessionId=&seq=`, addressed by the  
  announcing event's own `seq` — that event *is* the coordinate.

  This is deliberately not the same thing as the per-call review card. A review is built  
  from a file tool's own `before`/`after`, so it can only ever report what a file tool  
  reported. The turn record is built Host-side from a git snapshot of the working tree at  
  turn start and turn end (through a private index, into a temporary object directory),  
  plus whole-file copies taken around `write`/`edit`/mutating `str_replace_editor` calls —  
  so it also covers a file changed by `sed -i` inside a shell command, and it is the only  
  source that describes the whole turn rather than one call in it.
- **Revert one file, or revert the whole turn.** Each row gets a `Revert this file`, and  
  the card a `Revert all`. Both are scoped to the reviews that turn produced, because a  
  summary carries paths and line counts but not the text needed to restore them — only a  
  review keeps a `before`. A turn whose changes all came from shell commands says so  
  plainly instead of pretending to act.
- **A native diff for any file in the turn**, opened as an ordinary VS Code diff editor.  
  The Host serves hunks, not whole-file text, so both sides are rebuilt from the hunk list  
  and kept line-aligned (`+`/`-`/context), with the other side emitting a blank so column N  
  means the same source line on both sides. Clicking a path in the card opens the file in  
  the editor, optionally at the line it was changed.

### Changed

- **The review card stopped asking for permission.** A review describes a mutation the  
  turn has *already made to disk* — DSH writes, then reads back next step, and that  
  ordering is what its whole loop is built on. "Accept" was therefore a button that did  
  nothing except imply the change had been waiting for it. Both accepts are gone; the two  
  rejection buttons are now one `Revert all`, and the per-file `✕`/`✓` pair is one  
  `Revert this file`. The card reads "Changed by this call" rather than presenting itself  
  as something awaiting approval.

### Fixed

- **Every diff opened through the native review provider rendered blank.**  
  `Uri.parse('dsh-review://review-1/foo/before').path` is `/foo/before` — a hierarchical  
  URI keeps the leading slash — so the id was read from `path.split('/')[0]`, which is the  
  empty string, and the store lookup never matched. The id is read from `uri.authority`,  
  where it was always meant to be. The new changes provider had the same requirement, which  
  is how the bug surfaced.

### Notes

- The regression gate is now **295 assertions** (was 268). The new group pins the two  
  routes, the hunk-to-sides alignment, the URI authority contract, and the model-side card  
  semantics: one card per turn, a repeat announcement replacing the coordinate instead of  
  stacking a second card, and a summary the Host no longer serves resolving to no card  
  rather than to an error.
- Live integration is **39/39** (was 29). The ten new assertions put a real turn through  
  the real model, because the part that can silently break is the handoff — the  
  announcement names a *turn*, the summary route is addressed by an *event seq*, and only  
  the model converts one into the other. Two of them could not have been proven by a  
  fixture: the hunk prefix format is what `hunksToSides()` splits on, and 404-means-no-card  
  is the difference between a dropped summary and a broken panel.
- Deliberately not done, and why: `POST /api/changes.open` (the Host's own native-open  
  route) is skipped because VS Code's own editor is a strictly better target than the  
  desktop window; partial (hunk-level) revert is not implemented — it is recorded on the  
  roadmap; and there is **no** `onDidSaveTextDocument` reflow, because DSH re-reads disk  
  every step and therefore has nothing to be told about a file that changed underneath it.

## [0.1.7] — 2026-10-11

Tagline: **the longer the conversation, the cheaper each streamed chunk.**  
Tagline (ZH): **对话越长，每个流式分块越便宜。**

### Changed

- **The webview rebuilt the whole transcript on every streamed chunk.** `renderVersion`  
  changes on every chunk, and the webview used that as a signal to tear `#messages` down  
  and rebuild every row — re-parsing every assistant message through markdown-it on the  
  way. The cost of one chunk therefore grew with the length of the conversation, which is  
  the actual mechanism behind "it gets laggier the longer I chat". Measured on a 40-turn  
  transcript, for every 40 characters of new text:
  |                          | before | after      |
  | ------------------------ | ------ | ---------- |
  | DOM nodes built          | 291    | **4**      |
  | markdown passes          | ~42    | **1**      |
  | markdown bytes re-parsed | 43 KB  | **1.4 KB** |
  Each item now carries a `uid` (its DOM key — stable across streaming updates and a tool  
  row gaining its result) and a `rev` (its own change signature, stamped on every  
  mutation). The webview reconciles against those, so a chunk redraws exactly one row and  
  every other row keeps the node — and the parsed markdown — it already has. `uid` comes  
  from a process-wide counter, so a model rebuilt for the same session (reconnect, fork,  
  switch) cannot hand out an id the webview already has a node for.
- **One streaming flush built the full snapshot once per frame.** `applyMuxFrame()`  
  projected the model into `UiState` inside the per-frame loop, and a flush carries a  
  whole turn's worth of deltas. The projection now happens once per batch, matching the  
  single publish the batch already produced.
- **The session `<select>` was rebuilt on every state push** — i.e. on every streamed  
  chunk — discarding the user's selection mid-interaction to redraw an identical list. It  
  is now guarded by a signature.

### Fixed

- **A delta that arrived after its turn closed opened a duplicate assistant bubble.** The  
  live assistant stream and the durable journal are not ordered against each other, so a  
  chunk can land after `turn/end` — or after the authoritative `assistant/message` it  
  duplicates. It found no streaming placeholder, recreated the buffer from empty and  
  appended a second bubble under the finished answer. Deltas for an ended turn or an  
  already-finalised step are now dropped.

### Notes

- The inspector ring buffer's `JSON.stringify` per frame was measured rather than assumed:  
  **~1.2 µs** for a typical `assistant/stream` delta and ~47 µs for a 20 KB  
  `assistant/message`. At a streaming cadence of ~33 frames/s that is tens of  
  microseconds per second. It is left alone: computing the raw lazily would mean  
  retaining up to 300 live frame objects instead of 300 truncated 2 KB strings, which is a  
  memory regression bought for nothing.

## [0.1.6] — 2026-10-11

Tagline: **一次问答不再把整条对话流重画两遍。**  
Tagline (EN): **fix: stop rebuilding the transcript for a diff of nothing.**

### Fixed

- **一次问答会让整条对话流重建两遍。** 在一条 72 条记录的会话上实测：一个审批/提问事件  
  产生 **2 次**全量状态推送、约 70 KB、**2 次**完整 DOM 重建；一次作答往返合计  
  **6 次推送、约 212 KB、6 次重建**。三个原因，都修了：
  1. 事件到达会推送两次——`ApprovalStore` 自己的变更监听器一次，刚改完 store 的调用方  
     再一次。两次落在同一个 tick 里，中间没有绘制的机会，所以第二次只是把主线程时间  
     翻了一倍。
  2. `pushReviewApprovalState()` 无条件 `model.touch()`。但审批和提问**根本不在对话流里  
     画**——`renderTool` 里写明了这件事——只有 review 卡片画在里面，所以只有 review 变化  
     才该触发重建。
  3. `session/follow` 批处理的回调无条件 `pushState()`，批里什么都没变也照推。  
     修复后：一个事件 **1 次推送、0 次对话流重建**；一次作答往返 **3 次推送、0 次重建**。  
     *EN:* A waterfall event published the whole state twice over ("store notified, then the  
     caller pushed as well"), and each accepted push made the webview tear the transcript  
     down and rebuild it. Now: one push per event, and none of them a rebuild.
- **检查器的事件环形缓冲区搭上了每一次状态推送**，哪怕面板是关着的。它是 300 帧 ×  
  最长 2 KB ≈ 600 KB 的结构化克隆，而 `pushState` 在流式输出里是逐块触发的。  
  实测：缓冲填满后单次推送 **1,318,580 字节**，其中绝大部分没有任何人读。现在只有面板  
  开着才发布（开面板时一次性补全历史），关掉立刻回落——实测 **1.29 MB → 35 KB**。  
  *EN:* The inspector's frame ring buffer rode every push even with the panel closed —  
  up to ~600 KB of structured clone per push, on a push that fires per streamed chunk.
- **检查器列表会越堆越多。** 它每次都把整个数组 append 一遍，而缓冲区是环形的、头部会  
  移动，于是每来一帧就多堆一份完整的行（300、600、900…）。改为整体重建，代价有界  
  （最多 300 行）。
- **把提问或审批交给 Web UI 成功时，弹的是红色错误提示。** 那是正常操作，却走  
  `notifyError`，看起来像失败。


### Removed

- `ToolItem.approvalRpcId` 和写它的 `ConversationModel.setApprovalRpcId()`。写进去之后  
  没有任何地方读，而它带的 `renderVersion` 自增会在 store 监听器那次推送之上再逼出一次  
  完整的对话流重建。

### Verification

- 回归门 **231 → 243 项**全绿，新增第 I 组：一个提问到达只推送一次状态、且**不动**  
  `snapshot.renderVersion`；作答同理；环形缓冲区在面板关闭时不发布、打开时补全、关闭后  
  清零。
- 真机闭环 **29/29** 不变（跑在桌面端 Host 上）。
- 一条 72 条记录会话上的实测对比（单次事件）：
  |              | 推送次数 | 载荷          | 对话流重建 |
  | ------------ | ---- | ----------- | ----- |
  | 修复前 · 提问到达   | 2    | 70,794 B    | 2     |
  | 修复后 · 提问到达   | 1    | 35,397 B    | **0** |
  | 修复前 · 作答     | 2    | 70,800 B    | 2     |
  | 修复后 · 作答     | 1    | 35,400 B    | **0** |
  | 修复前 · 检查器缓冲满 | 2    | 1,318,580 B | 2     |
  | 修复后 · 检查器缓冲满 | 1    | 35,399 B    | **0** |

## [0.1.5] — 2026-10-11

Tagline: **Host 换了端口、或者被重启之后，不用再重载 VS Code。**  
Tagline (EN): **feat: reconnect on demand, and find the Host again when it moves ports.**

### Added

- **常驻的 Reconnect 按钮**（状态行里一个，视图标题里一个）。点它总是把旧连接拆干净、  
  重新协商一次。为什么必须"强制"：Host 重启之后客户端这边的状态**仍然是 `connected`**  
  ——流只是不响了——而普通的 `connect()` 会在这个状态上直接早退。这个空档正是过去  
  "只能重载窗口"的原因。  
  *EN:* One button, always visible, that always tears the old session down first.
- **Host 自动发现**（`deepseekHarness.autoDiscover`，默认开）。配置的端口没人应答时，  
  先读 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里钉过的 `webserver.port`，再枚举本机  
  loopback 监听端口，用 Host **自己的匿名拒绝文本**当指纹逐个确认——`401` +  
  `dsh web authentication required; reopen the URL printed by dsh web.`。这句话来自  
  connection carrier 的栅栏而不是 web 前端，所以哪个入口启动的 Host 都会这么说。  
  为什么需要它：**桌面端用 `--port 0` 启动 Host**（`apps/desktop-host/src/index.ts`  
  里写死），端口由系统每次重新分配，只通过 Node IPC 报给 Electron，不落盘。  
  发现的端口只在本次会话内使用，**不写回设置**——那是一个每次启动都会变的端口，  
  写进去只会留下一个下次必然过期的钉子。真机实测：46 个 loopback 监听里命中 1 个，  
  并正确归因到 `desktop` profile 里钉的端口。  
  *EN:* Pinned ports from profile patch layers, then the OS listener table, confirmed  
  by the Host's own anonymous refusal. Discovered ports are session-local and never  
  written to settings.
- `HarnessClient.target()`：取当前指向的 host/port。
- 连接请求**串行化**：一次点击对应一次尝试，重叠的点击排队等待，而不是两个协商互相  
  拆掉对方的 socket。

### Fixed

- **强制重连之后，原来打开的那个会话会丢。** `disconnect()` 拆掉了 `session/follow`  
  订阅，而 `refreshSessions()` 在 `activeSessionId` 已设置时是**故意不动**它的——结果是  
  对话还留在屏幕上、订阅已经没了。现在重连后会重新选中同一个会话（重建 model、重新订阅、  
  重拉历史，也就是文档里写的"重建而不是游标续传"）。会话在这个 Host 上确实不存在时才  
  退回到最新的那个。
- **每次切换会话都会泄漏一个 `session/follow` 订阅。** 它们被丢进 `disposables` 之后再  
  也没被释放；而重连现在每次都会重新选中会话，泄漏会加速。改为显式持有，切换前先释放。
- **没有 cookie 的时候却报"签名密钥被轮换了"。** `authRequired()` 无条件调用  
  `noteRejected()`，于是"压根没拿到会话"（`autoSession` 被关掉，或者  
  `$DSH_HOME/.credentials.yaml` 还不存在）被描述成"运行中的 Host 拒绝了我们以为有效的  
  cookie —— 它的签名密钥几乎肯定被重新生成了"。用户会去查错误的东西。现在只有真的  
  发出过 cookie 才记录这次拒绝。
- **`connect()` 在 `connecting` 状态上早退**：一次卡住的连接会让重试按钮变成空操作。  
  串行化 + 强制拆连之后，这条路径不再存在。

### Changed

- 面板打开时的自动连接改用新的**非破坏性** `ensureConnected`：光是把面板打开，不应该把  
  扩展宿主已经建立的会话拆掉再重建。按钮依然是强制的那条路。
- 视图标题里的重连图标不再挂在 `deepseekHarness.offline` 条件上——那恰好让它在最需要  
  重连的时候消失。`deepseekHarness.offline` 这个上下文键从此没有使用者，连同  
  `syncOfflineContext()` 一起删掉了。

### Verification

- 回归门 **211 → 231 项**全绿。新增 G3 组：面板 boot 发的是 `ensureConnected` 而不是  
  破坏性的 `connect`、点按钮发的是 `{type:'connect'}`、已连接时按钮仍在且读作  
  `⟳ Reconnect`。新增 H 组：`webserver` 钉端口解析（只认 `webserver` 条目下的 `port`）、  
  三平台监听表解析（含 `/proc/net/tcp6` 里 `::1` 的**字序**——`01000000` 不是  
  `00000001`）、指纹的"是 Host / 是别的 HTTP / 静默"三条判定、发现的排序与负例。
- 真机集成 **25 → 29 项**全绿，其中四条为新链路实测：真实 Host 能被匿名指纹认出来、  
  一个普通 HTTP 监听器**不会**被误认成 Host（指纹匹配一切就等于没有指纹）、强制重连后  
  连接仍在、那个会话仍然在 Host 上。

## [0.1.4] — 2026-10-10

Tagline: **问题与审批现在真的能在 VS Code 里回答了 —— 而且点"允许"真的等于允许。**  
Tagline (EN): **fix: answer approvals and agent questions from the sidebar — and make Allow actually allow.**

### Fixed

- **Agent 的提问（`user-questions/request`）在 VS Code 里完全没有出口。** 客户端一直把它  
  正确翻译成 `question/requested`，然后控制器把这一帧丢在地上：既不渲染，也无法回答。  
  后果比"少一张卡片"严重——Host 侧 `ask_user_question` **阻塞**着那次工具调用，没人回答，  
  这一轮就停在那里。现在它和审批共用同一个待答面板。
  - 单问题单选：点选项即作答（与 Web UI 的选项卡片一致）；多问题或复选：显式点 Answer，  
    一次提交整批，未作答的会就地报错而不是发一批空答案上去。
  - 自由文本始终可用，走 `custom` 字段（不是 `selected`）。
- **点"允许"从来没有允许过任何东西。** 审批的应答体发的是 `{ kind: 'result' }`，**没有  
  `value`**。但 `value` 就是 Host 瀑布的返回值，省略它等于用 `undefined` 结算；而  
  `ApprovalService.decide` 会把一切不在词表内的返回值（包括 `undefined`）归一化成  
  `'unavailable'` —— 一次**静默的 fail-closed 拒绝**，而且照常写一条看起来正常的  
  `approval/decided` 审计。真机实测：裸形状 → `outcome: "unavailable"`，工具报  
  "requires approval, but no approval channel is available"；带值形状 →  
  `outcome: "allowed-once"`，命令真的执行了。
- **点"拒绝"也被记成了"没有可用的审批通道"。** 原来把拒绝编码成  
  `{ kind: 'rejected', error: … }`，那会 *取消* Host 瀑布，`decide` 里的 containment  
  再把它归一化成 `'unavailable'`。拒绝是一个携带词表字符串的 **result**，不是传输层错误。
- **在 Web UI 里回答过之后，VS Code 的卡片永远点得动。** Host 对 mux 客户端**只**发一个  
  `cancel` 帧表示撤销（0.2.1 不转发 `approval/resolved` / `question/resolved`），而旧代码  
  只把它记进日志。现在 `cancel` 会被翻译成 `waterfall/resolved` 并撤掉对应卡片。
- **审批卡只在"能匹配到工具行"时才画得出来。** 它原来嵌在 ToolItem 里，靠 `callId` 匹配；  
  没有匹配行（会话没在前台、工具行还没折进来）就等于不存在。现在待答项有自己的面板，  
  位于输入框上方——用户准备打字时正在看的地方。

### Changed

- **审批的放行门槛改成看"理由"，不再看工具名。** 原来的白名单是  
  `write/edit/read/grep/…` ——它列的这些名字本机 Host 根本没有（shell 工具叫 `pwsh`/`bash`），  
  于是**每一次真实的 shell 升级都会被拒**，而这条路径恰好是最常见的。名字本来也说明不了  
  申请有多大权限，理由才说明（"escalate sandbox to danger-full-access: …" 是 Host 自己  
  写的风险陈述），而且理由会**原样显示**在按钮旁边。现在只在理由声明了  
  full/unrestricted access 时不给内联允许；那张卡仍会显示、仍可拒绝、并多一个  
  "Answer in Web UI" 把它交回浏览器。被拒绝的按钮不再没有解释——  
  `blockedBy` 会说明原因。
- 面板不再把"已解决"的请求画出来。

### Added

- `delegateWaterfall`：把仍开着的瀑布交回 Host 链（`outcome: {kind:'next'}`）。这是真正的  
  委托而非忽略——我们放弃自己的 delivery，请求继续留给 Web UI；只有当没有别的 delivery 时  
  Host 才会用 `next()` 结算。

### Verification

- 回归门 **190 → 211 项**全绿，新增第 G2 组：面板渲染、Allow/Deny 各自发出的**确切**载荷、  
  高危卡不给 Allow 但给交回、单选点击即答（按**标签**而不是下标）、多问题必须显式提交、  
  空答案被就地拦下、自由文本走 `custom`、已解决项离开面板。第 08 组补上四种信封的断言。  
  webview 桩升级到可"驱动"（记录监听器、`innerHTML=''` 清空子树），因为这次要验的是  
  按钮**做了什么**，不只是它**画出来了**。
- 真机集成 **21 → 25 项**全绿，其中两条为新链路实测：Host 把 `user-questions/request`  
  交付给 mux 客户端且答案回到了被阻塞的工具调用；Host 交付 `approval/request` 且  
  "允许"**真的授予了**越界升级（命令执行成功）。

## [0.1.3] — 2026-10-10

Tagline: **修好了"能连上但收不到回话"，补上了图片与真正的文件上传，顺手拔掉两个静默 bug。**  
Tagline (EN): **fix: the sidebar connected and then went silent; plus inline images, real file uploads, and two silent bugs.**

### Fixed

- **"Connected" 之后一片安静：会话流走的是另一条逻辑流。** 插件一直把传输层建模成  
  "一条 `$events` 承载所有帧"。真机（`0.2.1-alpha.2`）上这个假设错得很隐蔽：`$events`  
  确实会发一个 `ready` 帧（所以面板老老实实显示 "Connected"），然后**一条对话流量都没有**  
  ——因为 `$events` 是一份固定的转发白名单（`api-session/status`、`approval/request`、  
  `user-questions/request`、插件清单……）。对话在**另一条**逻辑流 `session/follow` 上，  
  词汇表完全不同：`snapshot`（积压记录）→ `event`（持久记录）→ 实时 `assistant-stream`  
  （`start`/`chunk`/`end`）。两条流现在各开一条 socket，`DownlinkSocket` 从"events 专用"  
  改成通用的单逻辑流载体（`endpoint` / `openArgs` / `expectReady`）。真机验证：30 帧，  
  `p` + `ong` → `pong`，模型快照 `Turn 1 — started / user / assistant pong / Turn 1 — completed`。  
  *EN:* Conversation rides `session/follow`, not `$events`; the two streams are now opened  
  separately and translated on their own vocabularies.
- **一条没有 `start` 的 `chunk` 会被丢弃，而不是猜个归属。** 只有 `start` 带  
  `turn`/`step`，而 chunk 是进程内的（从不进持久日志），所以孤儿 chunk 没有正确落点——  
  猜错就是把文本拼到别的回合上。
- **`api-session/status` 不再被丢掉。** 它从 `$events` 的转发帧翻译成 `session/status`，  
  Stop 按钮的状态才对得上。
- **"没有这个方法"和"这个 workspace 不存在"被混为一谈。** 在真机上量出来的事实是：  
  方法不存在 → **HTTP 404**（body 甚至不是 JSON 信封）；而 `session/rename` 指向一个已删除的  
  会话 → 200 + `code: session/not-found`，`session/create` 拿到一个过期的 workspaceId →  
  200 + `code: workspace/not-found`。`MISSING_METHOD_CODE` 里那个裸的 `/not-found/` 把后两者  
  塌进了第一类，于是普通的业务错误被抛成  
  *"this harness does not serve `session/create` — upgrade the host"*。现在只认  
  dispatch 层的码（`gateway/method-unavailable`、`gateway/unsupported`、`unknown_method`、  
  `method-not-found`、`unimplemented`）；带域命名空间的一律按业务错误处理，  
  原样把宿主的措辞交给调用方。附带两个效果：参数形状的重试逻辑不再提前放弃；  
  一个过期 id 不会再劝用户去升级宿主。  
  *EN:* A bare `/not-found/` made the client report business errors  
  (`workspace/not-found`, `session/not-found`) as missing capabilities. Narrowed to  
  dispatch-layer codes.
- **`@` 浮层曾根本打不开。** `queryFileReferences` 拿 `UiState.refQuery`（**上一次回复**  
  所回答的查询，初始是 `undefined`）当陈旧守卫，于是第一次敲 `@`（查询为空串）就被自己的  
  守卫挡掉，什么都没发布；即便绕过了守卫，成功分支也只写 `refCandidates` 而不写  
  `refQuery`，而 composer 只接受能匹配上查询的那批结果——菜单永远是关着的，还一声不响。  
  现在守卫比的是"最近一次请求的查询"（单独跟踪的 `refQueryLatest`），且两个字段**一起**  
  发布。这个 bug 的教训是：协议层断言再多也抓不到"某个字段压根没写"，  
  所以新增的断言直接检查**发布出去的 state**，并用真控制器 + 真 client 打假宿主。  
  *EN:* The `@` completion menu could never open: the staleness guard compared against  
  the query the last *reply* answered (initially `undefined`), so a bare `@` swallowed  
  its own request, and the success path published candidates without the matching query.
- **历史永远是空的——而且每次重连都会把对话擦掉。** `session/page` 一直写死  
  `throughSeq: 0`。但 `throughSeq` 是**日志游标**，不是条数：上游 `history.ts` 把 `-1`  
  解析成空页、`0` 解析成"只要第 0 条"、越界则报 `gateway/bad-request … past cursor N`。  
  唯一被认可的来源是 `session/follow` **开场帧**里的 `snapshot.cursor`  
  （`SessionPageRequest.throughSeq` 的文档注释原话就是"来自对应的 follow 开场帧"）。  
  现在客户端记录 follow 流交给它的每个游标（单调不回退），而 `getHistory()` 在还没学到  
  游标时**直接返回空页、一个请求都不发**。更要命的是第二层：调用方会把空页当事实折进模型，  
  于是**每次 socket 重连都会把眼前正在看的对话清空**——现在空页只记一条日志，绝不清屏。  
  *EN:* `throughSeq` is a journal cursor, not a count; the hard-coded `0` made history  
  permanently empty and the resulting empty page erased the live transcript on every  
  reconnect. The cursor now comes from the `session/follow` opening frame, and an empty  
  page no longer clears the screen.
- **参数形状重试把记住的正确形状排在最后试。** `rpc()` 的候选顺序是  
  `[...all.filter(没记住的), 记住的那个]`，于是**每次调用都先白烧两次失败往返**才轮到对的那个；  
  更糟的是最终停在哪个 `inner` 形状取决于宿主的宽容度，同一个会话里可能漂移。  
  改为**记住的形状优先**（`[all[remembered], ...其余]`）。这条是修上面那条历史问题时  
  被顺带照出来的：断言在"历史为空"的假象下暴露了 `inner` 停在 `_request` 形状。  
  *EN:* The remembered endpoint shape was tried *last*, so every call burned two failing  
  round-trips first and the wire shape could drift with host leniency. Now tried first.

### Added

- **图片支持：粘贴 / 拖拽 / 选文件 → 待发 chip → 内联进 `session/prompt`。**  
  剪贴板图片、往输入区拖拽、或 `Attach File to Session` 命令，都会在输入框上方排成一条  
  待发附件（带本地缩略图）；点发送时图片作为内联部件  
  `{ type: 'image', mediaType, data, name? }`（`png/jpeg/webp/gif`）随 prompt 发出。  
  只发图片不发文字是合法的。契约不是猜的——是从  
  `deepseek-harness@0.2.1-alpha.2` 源码读出来、再在真机上跑通的：宿主上限为单张 20 MiB、  
  单条 20 张、合计 200 MiB；`admitPromptContent` 会把内联图片**提升**为  
  `ImageAttachmentRef`（做归一化、可能缩放），所以落库的是 `sha256:…` 而不是客户端发去的字节。  
  **模型能力不发布、无法预判**：不吃图的模型会让 prompt 失败并返回  
  `session/attachment-invalid` + `details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES`，  
  `describePromptFailure()` 把这一条码翻译成"去 Controls 换个支持图片的模型"，  
  并且**保留**已暂存附件让重试不必重选。  
  *EN:* Images ride `session/prompt` as inline parts (paste / drop / picker → staging chips);  
  model image support is unpublished, so the host's refusal code is translated and the  
  staged attachments are kept for the retry.
- **非图片文件走真实上传路径。** 旧代码把字节往 `session/attachment` 上怼，但那根本不是上传  
  接口——它是"按 id 读附件"`{ request: { sessionId, attachmentId } }` →  
  `{ attachment, data }`，这也正是当初无论发什么都是 `boundary validation failed` 的原因。  
  真正的上传是裸 HTTP：`POST /api/session/uploadFileBinary?sessionId=<id>&name=<leaf>`，  
  `content-type: application/octet-stream`，body 是原始字节，返回  
  `{ ok: true, value: { receiptId, file } }`；prompt 里用 `{ type: 'file', receiptId }` 引用。  
  注意回执同时绑定**会话**与 `dsh web` **进程**，宿主重启即失效。  
  *EN:* File upload goes over `POST /api/session/uploadFileBinary` (raw bytes → receipt);  
  `session/attachment` is the read-back path, which is what the old code got wrong.
- **自动连接失败时有得点了：状态行 `Connect` 按钮 + 标题栏插头图标。**  
  自动连接是尽力而为，本机实测在宿主一切正常时 `auth` 也可能返回未就绪——把可用性押在  
  一次成功的自动连接上，失败时用户面对的就是"没得点、也没得读"。现在状态行按钮三态如实  
  （`Connect` / `Retry` / `Connecting…`，进行中禁用），并在 `package.json` 里贡献一条  
  `view/title` 菜单，`when` 为 `view == deepseekHarness.sessionView && deepseekHarness.offline`，  
  于是插头图标**只在未连接时**出现。上下文键边沿触发，`start()` 里先置 `true`，  
  按钮从第一帧起就可见。（"auth 为什么返回未就绪"仍是未解问题——按钮是地板，不是修复。）  
  *EN:* A manual `Connect` button (status row, three honest labels) plus a context-key-gated  
  `view/title` plug icon, so a failed auto-connect is no longer a dead end.
- **附件字节永不进 `UiState`。** `pushState` 每个流式分片都会触发，所以 `pending` 只携带  
  chip 元数据（id / kind / name / 字节数 / mediaType），base64 留在 controller；  
  webview 用本地 `URL.createObjectURL` 自建缩略图，controller 复用 webview 传来的 `key`  
  当 chip id——预览图片因此永远不穿过状态桥回传（那也会撞上 CSP）。
- **`@` 引用改用宿主自己的语法，且不再粘贴正文。** 原来的 `@file:path` + `readFileSync`  
  内联是插件自己发明的：宿主早就有一套，语法不同，还自带补全源。现在支持  
  `@path`、`@"含空格的 path"`、`@dir/`，可带 `:L<n>` / `:L<n>-L<m>`；  
  `someone@example.com` 不会被误判成引用（必须行首或空白之后才触发）。补全走  
  `fileReferences/list`，它的描述符是位置的 `(agentId, query)`——**内层 args 是裸对象，  
  没有 `request` 包装**。除了对齐，还有个实际收益：内联会让提示随文件大小变长、并且每轮  
  都改动前缀，等于每次发送都作废 KV cache。
- **`@` 补全浮层。** 90ms 防抖、陈旧响应丢弃、`mousedown` 而非 `click` 选中，引用文本的  
  转义与宿主的 `formatFileMention` 逐字节一致。回复里的查询只有是当前 token 的**前缀**时  
  才继续沿用（正常快速输入的情形），否则等自己的回复——避免每敲一个字就闪一次空，  
  又不会拿无关的结果顶上去。


### Removed

- **`DeepSeek Harness: Set Session Token from Launch URL` 命令及其标题栏菜单项。**  
  从 `$DSH_HOME/.credentials.yaml` 本地自签已经是实际唯一可用的路径；一个每次 `dsh web`  
  重启都换的 token 只剩维护成本。连接失败时的报错改为点名那个凭据文件和 `autoSession`  
  设置（后者的含义现在是"拒绝自签"，不再是"弹个框问我要 token"）。

### Verified

- 回归门 **108 → 180 项**。假宿主按 `0.2.1-alpha.2` 重建（`$events` 白名单 + `session/follow`  
  流），新增断言把两条流的 open payload、快照回放、`api-session/status` 翻译、`waterfall`  
  审批信封、"孤儿 / 迟到 chunk 必须被丢弃"，以及"业务级 `x/not-found` 不是能力缺失"全部钉死。  
  本轮又补了五组：`session/attachment` **读图**形状 vs. 暂存两条路、三种 prompt content 组合  
  （纯文本 / 图+文 / 纯图）、`session/page` "无游标不发请求、有游标才透传"、  
  `session/follow` 快照教会客户端游标，以及**读回图片时的记录形状**；假宿主也补上了  
  `uploadFileBinary` 的**原始字节**路由（连 415/400 边界一起）。第 G 组新增六条 Connect 按钮  
  断言（已连接时隐藏、断开时显示可点的 `Connect`、失败后显示 `Retry`、连接中显示  
  `Connecting…` 且禁用）。
  - **最后那一组是被一次真实事故逼出来的**：两种持久消息记录的嵌套方式**不一样**，而且是  
    静默失败——`user/message` 把内容放在 `data.content`（图片的持久引用就在这里），  
    `assistant/message` 与 `system/message` 才放在 `data.message.content`。集成测试里那条  
    "落库消息带持久图片引用"的断言只查了嵌套形式，于是**永远找不到图片**；它此前"通过"过，  
    属于偶然命中而非测量。现在这个不对称由协议层断言直接钉住（真机实测三种记录形状）。
- **真机集成测试 16 → 21 项全绿**，新增的 08b 段落跑的是**真图闭环**：遍历 `modelCatalog`  
  找到肯收图的模型路由（默认 `deepseek-v4-flash` 被拒、`deepseek-flash` 收下）→ 内联发图  
  → 落库后经 `session/page` 找到持久的图片引用（`sha256:97a3a410…`）→  
  `session/attachment` 读回 73 字节并校验 PNG 签名 → `uploadFileBinary` 拿到回执 →  
  再发一条引用该回执的 prompt 并被准入。顺带修掉了测试自身的两个问题：① 原先硬要求  
  `DSH_LAUNCH_URL`（一个得从终端里手动复制、且随进程失效的 token），现在默认走本地自签，也就是扩展实际用的  
  那条路，启动 URL 换 token 保留为可选路径；② 第 03 步把 `listWorkspaces()` 派生的  
  **路径形** `workspaceId` 直接喂给了 `session/create`。workspace 是两步的：先从  
  `session/list` 派生，再用 `workspace/create` 归一化——这正是  
  `ensureHarnessWorkspace()` 做的事，现在测试也照做。
- 仓库链接 `liangwythu` → `YichuAI`（仓库已迁移）。

## [0.1.2] — 2026-10-09

Tagline: **修复：webview 脚本自 v0.0.4 起就是语法错误的——面板其实从未启动过。**  
Tagline (EN): **fix: the webview script had been invalid JavaScript since v0.0.4 — the panel never actually booted.**

### Fixed

- **面板"永远 Disconnected"的真正根因：webview 脚本是一个语法错误的 JS。**  
  `src/view/client.ts` 的脚本是**模板字符串**，`tsc` 看不到里面的内容。里面混进了一句  
  TypeScript：`const bits: string[] = [];`。浏览器解析这段脚本时直接抛  
  `SyntaxError: Missing initializer in const declaration`，于是**整个脚本从头到尾没有执行**——  
  第 1030 行那条 `window.addEventListener('message', …)` 从未注册，面板永远停在  
  `html.ts` 里写死的静态占位 `<span id="status-text">Disconnected</span>`，所有按钮全部失效。  
  这条错误由 **v0.0.4（commit `ac1cb2c`）** 引入，**v0.0.8 / v0.0.9 / v0.1.0 / v0.1.1  
  每一个发布版本都带着它**。这也解释了为什么 v0.1.1 修好工作区发现之后面板仍然  
  "Disconnected"——工作区那条修复是必要的，但不是充分的：面板压根没在运行。  
  *EN:* A TypeScript annotation inside the webview template string made the whole  
  client script a syntax error, so it never executed and the panel stayed on the  
  static "Disconnected" placeholder with dead controls. Present since v0.0.4.
- **同一模板转义坑的第二处：`/^\/\S*$/` 被吃掉反斜杠。** 模板字符串会把 `\/` 变成 `/`、  
  `\S` 变成 `S`，于是 Slash 补全的判定正则变成 `/^/S*$/`（`Invalid regular expression flags`）。  
  已改为等价的、不依赖斜杠转义的写法，并在注释里标明这个坑（与既有的 `AT_FILE_RE` 注释一致）。  
  *EN:* The template literal also ate the backslashes in the slash-command regex;  
  rewritten without needing slash escapes.

### Hardened

- **启动失败不再静默。** 脚本开头装了 `window.addEventListener('error', …)` 兜底：  
  今后任何启动期异常都会把原因直接打印在消息区，而不是把一个"看起来是 Disconnected、  
  其实是死的"面板留在那里。
- **markdown-it 降级路径修好。** 覆盖链接渲染器的那段代码此前无条件访问  
  `md.renderer.rules`；而扩展在没有 markdown-it UMD 时用的兜底 stub 恰好没有  
  `renderer`，于是**兜底本身就会让脚本崩溃**（"优雅降级"其实不优雅）。现在加了特性判断，  
  并让 provider 的兜底 stub 也带 `renderer.rules`，两条路都能启动。
- **webview 脚本纳入回归门（新增第 G 组断言）。** 三条检查：  
  ① 脚本必须能被 `new Function()` 解析（任何 TS 语法泄漏、被吃掉的反斜杠都会在这里现形）；  
  ② 脚本里每一个 `$('id')` 都必须在 HTML 骨架里有对应元素；  
  ③ 用 DOM 桩**真实启动**脚本并投喂一份 state，断言能注册监听并把状态渲染成 `Connected`  
  ——正常 markdown-it 与"无 markdown-it 兜底"两种模式各测一遍。  
  回归门 **102 → 108 项断言**全绿。

### Verified

- 用真实传输代码对本机 `dsh web`（`127.0.0.1:3080`）连接：`connecting → connected`，  
  `session/list` 返回 1 条、`listWorkspaces` 派生 1 个工作区（`default-workspace`）。
- 把 webview 脚本单独导出后 `node --check` 通过；DOM 桩启动测试两种模式均  
  `render(state) → status-text = "Connected"`。

## [0.1.1] — 2026-10-09

Tagline: **修复：工作区发现恒为空导致面板永远显示 Disconnected。**  
Tagline (EN): **fix: workspace discovery always returned empty, so the panel stayed "Disconnected".**

### Fixed

- **工作区绑定不再恒为空（`listWorkspaces`）。** 该方法此前是一个硬编码的空数组桩，  
  注释写"等 projection 接上再说"。后果是连锁的：`findHarnessWorkspace()` 对空数组  
  做 `find()` 必然返回 `undefined` → `binding.harness` 永远不赋值 → 面板一直停在  
  **Disconnected**，尽管握手、鉴权（cookie + ready 帧）全部正常。唯一能走通的路径  
  是发送时的 `createWorkspace()` 兜底，而它只活在内存里，窗口一重载就还原。  
  现在改为**从 `session/list` 的 `cwd` 派生工作区注册表**——这正是原注释指明的路径。  
  rc.2 没有 `workspace/list`（真机 HTTP 404，宿主源码零匹配），但每条 `session/list`  
  记录都带宿主规范化的 `cwd`，且这些目录与工作区注册表 1:1（工作区以路径为键，  
  对已存在路径调用 `workspace/create` 会返回既有工作区且 `created:false`）。  
  *EN:* `listWorkspaces()` derives the registry by grouping `session/list` rows on  
  their host-canonical `cwd`, instead of returning a hard-coded empty array that  
  made workspace binding impossible and left the UI permanently "Disconnected".
- **派生的 workspaceId 不再被当作宿主 id 写入。** 派生出的 `workspaceId` 就是路径，  
  直接传给 `session/create` 是错的。现在写入前统一走一次幂等的 `workspace/create`  
  取回宿主签发的权威 id（`WorkspaceBinding.confirmed` 标记，避免重复确认），  
  `newSession()` 与 `sendPrompt()` 均已改道。

### Verified

- 真机（`127.0.0.1:3080`）验证：1 个 session、1 个 distinct cwd → 派生 1 个工作区，  
  `title` 取自目录名，中文路径正常。
- 回归门 **95 → 102 项断言**全绿；新增断言覆盖派生条目数、cwd 聚合、排序、  
  "从不调用 workspace/list" 以及 `findHarnessWorkspace` 端到端解析。  
  同时修正两条被新数据推翻的旧断言（session/list 条数、以及那条断言  
  "listWorkspaces 应为空"的用例——它正是本次要推翻的行为）。

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
  - **更正（见 [0.1.3]）**：上面这条描述的上传线**从未存在过**。  
    `session/attachment` 是"按 id **读**附件"，不是上传接口；图片内联在 `session/prompt`，  
    真正的文件上传走 `POST /api/session/uploadFileBinary`。  
    *EN:* The upload wire described here never existed — see [0.1.3].

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

[0.0.1]: https://github.com/YichuAI/deepseek-harness-vscode/releases/tag/v0.0.1
