# Release Process

This document describes how to cut and publish a release of
**DeepSeek Harness Connector for VS Code**.

**Prefer the tag.** Since v0.2.1 the whole flow runs in
`.github/workflows/release.yml` — push a tag and CI verifies, packages, creates the
GitHub Release, and (if a `VSCE_PAT` secret exists) publishes to the Marketplace:

```bash
git tag v<ver> && git push origin v<ver>
```

What follows is the same flow by hand, and the checklist the workflow encodes. Keep
both in step: the manual path is what you use when CI is unavailable, and it is the
only way to see what each check is actually doing.

The repo lives at `git@github.com:YichuAI/deepseek-harness-vscode.git`. Pushing
over HTTPS fails here (no credential helper), so the remote is SSH. A repo-local
`core.sshCommand` workaround for the non-ASCII home used to be required; it is
not any more — see "Appendix — SSH setup" at the end.

---

## 0. Prerequisites

- Node.js ≥ 20 (Node 22+ recommended — the integration test uses the global `WebSocket`).
- A running local `dsh web` for the pre-release integration test.
- `git` CLI authenticated to the release branch.
- (Optional) `gh` CLI for GitHub Releases.
- (Optional) A VS Code Marketplace publisher PAT for `vsce publish`.

```bash
# one-time tool install (already in devDependencies, but for reference)
npm install
```

---

## 1. Pre-release checklist

Run **all** of these from the project root
(`e:\deepseek\deepseek-harness-vscode`). Every box must be green.

```bash
# 1.1 clean typecheck
npm run typecheck          # → tsc --noEmit, exit 0

# 1.2 every version surface must agree with package.json
npm run check-versions     # → all checks pass; add --online to include the
                           #   published Release and the Marketplace listing
                           #   (needs network), --release at tag time

# 1.3 build the bundle
npm run build              # → dist/extension.js

# 1.4 protocol test (fake harness — no dsh web needed)
npm run protocol-test      # → all 523 assertions ✓

# 1.5 end-to-end chains (real filesystem; reports its own coverage)
npm run e2e-test           # → 3 of 5 chains covered, 2 not written; every
                           #   written chain passes (96 assertions today)

# 1.6 integration test (writes a session — needs a host running)
#     start one in another terminal:
#       cd ../deepseek-harness && npm run dsh -- web          (fixed port 3080)
#     the desktop app works too, but it starts its host with `--port 0`, so the
#     port is freshly assigned on every launch — read it off the listener table
#     and pass it in:
#       DSH_PORT=3081 npm run integration-test
npm run integration-test   # → 41/41 checks ✓, closed loop OK

# 1.7 package the VSIX
npm run package            # → harness-connector-deepseek-<ver>.vsix
```

Manual checks:

- [ ] `package.json` `version` matches the intended tag. `npm run check-versions`
      asserts this together with every other surface — do not eyeball it.
- [ ] `package-lock.json` carries this version too. `npm ci` does **not** validate
      the root version, so it drifts silently: v0.2.1 found it sitting on `0.1.4`,
      four releases stale. Fix with `npm install --package-lock-only` (a two-line
      diff, no churn). `check-versions` covers it since v0.2.1.
- [ ] `CHANGELOG.md` has an entry for this version under `## [<version>] — <date>`.
- [ ] Docs are **bilingual**: every edit to `README.md` / `CHANGELOG.md` /
      `ARCHITECTURE.md` / `RELEASE.md` has been mirrored into its `*.zh-CN.md`
      twin. This is a standing rule, not a per-release judgement call.
- [ ] `CHANGELOG.md` and `ARCHITECTURE.md` still quote the **current** assertion
      count from `npm run protocol-test` (it has grown 50 → 64 → 98 → 83 → 156 →
      178 → 180 → 190 → 211 → 231 → 243 → 268 → 295 → 312 → 342 → 381 → 461 → 493 → 504 → 512 → 523 as
      the rc.2 rewrite replaced the rc.6 fake harness, the waterfall/pending-panel
      groups landed, v0.2.2 added the session-mode vocabulary, the per-platform
      install routing and the launcher's pure functions, and v0.2.3 added the
      per-hunk surgery, the nine right-click asks and the loopback fence, and
      v0.2.4 added the waterfall attribution rule, the launch plan and the
      remote install route, and v0.2.5 touched shipped documentation only and
      added no new assertions, and v0.2.6 added the Open Web UI decision
      function and the copy it branches on, and v0.2.7 gave that function the mode
      itself — the boolean it was keyed on could not tell `paste` from `managed` —
      and added the eight assertions that pin the difference;
      stale counts are the most common doc drift here — and since
      v0.2.1 `check-versions` fails the build on it rather than leaving it to
      this line).
- [ ] `README.md`'s newest "What's new" heading is this version, and the README
      keeps **exactly one** release's notes. History goes in the CHANGELOG.
- [ ] The README's badges are still **derived, not typed**, and the ones that are
      checked still draw. `check-versions --online` fetches each of them and reads
      the label the SVG announces about itself, because a badge that string-matches
      the right URL and paints `404 badge not found` is exactly the bug that section
      exists for. One omission is deliberate: the two `open-vsx` badges are in the
      README but **not** in that list. shields' Open VSX provider flaps — it
      answered `200 open vsx: v0.2.5` and then `200 404: badge not found` for the
      same URL of a published, downloadable extension within minutes — and a release
      gate that red-lights at random is worse than no gate. Check those two by eye.
- [ ] The four **identity badges** in the hero (`dsh …`, `setup …`, `ui …`,
      `VS Code …`) are the only hand-typed numbers left in either README, and they
      are hand-typed on purpose: nothing serves "the Remote contract this build
      targets". Move them when `ARCHITECTURE.md`'s contract target moves, not
      before — and note that the gate's title check now accepts either a `#`
      heading or an `<h1>`, because the README stopped opening with one.
- [ ] Repository metadata still describes the project — it is how anyone finds the
      repo at all, so it ships with the release rather than decorating it:

      `gh repo view YichuAI/deepseek-harness-vscode --json description,homepageUrl,repositoryTopics`

      The homepage points at the Marketplace listing; the topics carry the words
      people actually search for (`dsh`, `deepseek-harness`, `vscode-extension`,
      `ai-coding-assistant`, …). Set them with `gh repo edit --add-topic <t>`
      `--homepage <url>`.
- [ ] `LICENSE` present (MIT).
- [ ] **Nothing new sits at the top level of the repo.** `.vscodeignore` is an
      exclusion list, so a directory nobody thought about ships by default — the
      v0.2.3 candidate had a local `宣传片/` storyboard folder inside it, worth
      565 KB on a 896 KB VSIX, and the only thing that noticed was a human opening
      the archive. Add the new path to `.vscodeignore` **and** confirm the count
      in step 2 is still 14.
- [ ] The expected VSIX size in step 2 was measured **after** the last edit to a
      shipped doc. `README.md` / `CHANGELOG.md` / `ARCHITECTURE.md` and their
      `*.zh-CN.md` twins live *inside* the VSIX, so editing one after packaging
      invalidates the number — re-package and re-measure, never adjust by eye.
      (This is how v0.2.0's baseline ended up 856 bytes short. `RELEASE.md`
      itself is *not* shipped, which is why the number can be written here
      afterwards.)

- [ ] No secrets / API keys / real prompt content in `test/fixtures/`
      (fixtures must use `<redacted:...>` placeholders).
- [ ] `.vscodeignore` excludes `src/`, `scripts/`, `test/`, configs **and
      `.workbuddy/`** (only `dist/`, `media/`, docs, `package.json`, `LICENSE`
      ship in the VSIX).
- [ ] `git status` clean (no uncommitted changes).

---

## 2. Verify the VSIX contents

```bash
# list what actually ships
unzip -l harness-connector-deepseek-<ver>.vsix
```

Expected (v0.2.8 = 14 files, 380,195 bytes in a clean checkout, ~371 KB):

```
[Content_Types].xml
extension.vsixmanifest
extension/ARCHITECTURE.md
extension/ARCHITECTURE.zh-CN.md
extension/CHANGELOG.zh-CN.md
extension/LICENSE.txt
extension/README.zh-CN.md
extension/changelog.md
extension/package.json
extension/readme.md
extension/dist/extension.js
extension/media/icon.png
extension/media/icon.svg
extension/media/markdown-it.umd.min.js
```

If `src/`, `scripts/`, `test/`, `node_modules/`, `.workbuddy/`, or `*.map`
appear, the `.vscodeignore` is wrong — fix it and re-package.

The size above is the **clean-checkout** figure, and it is the number CI produces for the
Release asset. It is not the only number this tree can produce. With `core.autocrlf = true`
on Windows, any file git has round-tripped carries CRLF on disk while the blob it came from —
and therefore the CI checkout — does not. Two shipped files are exposed to it here,
`media/icon.svg` and `CHANGELOG.md`. At v0.2.4 both were CRLF on disk in this working tree, so
it packaged to 363,966 where CI read 363,809 — a 157-byte gap (the same pair was
331,709 / 331,706 at v0.2.2 and 353,366 / 353,363 at v0.2.3). Comparing the two archives, the
other **12 entries have identical CRC32 and length**; the two that differ are exactly
`extension/changelog.md` and `extension/media/icon.svg`, which is how the second one was
found — nothing about the size alone would have said which file had moved.

At v0.2.5 that gap is **zero**, deliberately, and every release since keeps it there — but only
because the files were checked by hand each time. v0.2.8 is where that stopped being enough:
`package.json` is one of the fourteen entries, it had never been normalised, and on a Windows
checkout it carries 383 CRLF bytes that the Linux runner's checkout does not. This tree packaged to
**380,213** locally while CI produced **380,195** — eighteen bytes apart, which is 383 carriage
returns once zip has compressed them.

The fix is `.gitattributes` (`*.md text eol=lf`, `package.json text eol=lf`), so the question
stops being "what does this machine's working tree look like" and becomes "what is in the blob".
With `package.json` stripped, this tree packages to 380,195, which is what the Release asset
carries. Baseline figures are clean-checkout figures by definition; v0.2.6 and v0.2.7 matched by
hand, and every release from v0.2.8 matches by construction.
`git status` may still label them modified until git's stat cache is refreshed, but
`git diff --stat` is empty and `git cat-file blob :<path> | tr -cd '\r' | wc -c` reads 0 — the
worktree content genuinely is the blob. Note that `git checkout-index` cannot produce this:
it obeys `core.eol`, which defaults to native, so even
`-c core.autocrlf=false checkout-index -f` still writes CRLF. `git archive` does the same
thing for the same reason — measured on this machine, `git archive v0.2.3` emitted a
`CHANGELOG.md` with 1,581 CR bytes, so an archive is **not** a clean checkout either unless
the filter is switched off.

To measure a past tag without a second machine, export it with the filter off and package it
there. `vsce` still refuses to run with no `node_modules` present, so point one at it — a
directory junction on Windows is enough, and `--no-dependencies` never walks it:

```bash
mkdir -p /c/tmp/vclean
git -c core.autocrlf=false archive <tag> | tar -x -C /c/tmp/vclean   # LF, unlike plain archive
cd /c/tmp/vclean
# Windows: make node_modules a junction to the real one first
#   New-Item -ItemType Junction -Path .\node_modules -Target <repo>\node_modules
node <repo>/node_modules/@vscode/vsce/vsce package --no-dependencies  # → the CI figure
```

That is how `v0.2.3`'s 353,363 was confirmed after the fact, and how the claim that it was
ever *shipped* was found to be wrong.

So when a figure here disagrees with a fresh clone by a few bytes, check `git status` and the
line endings before assuming the tree changed — and when recording a baseline, say which of the
two you measured. From v0.2.8 there is only one: the text files in the package are pinned to LF
by `.gitattributes`, so a Windows checkout and a Linux checkout pack the same bytes. The older
figures above stay as recorded, because they were measured before the pin existed.

---

## 3. Smoke-test the VSIX in a clean Extension Host

```bash
# install into your VS Code
code --install-extension harness-connector-deepseek-<ver>.vsix

# then in VS Code:
#   - reload window
#   - open a folder that maps to a Harness workspace
#   - the DeepSeek Harness activity-bar icon appears
#   - pick a session, send a prompt, watch it stream
#   - open the same session in the browser at http://127.0.0.1:3080/
#   - both surfaces must show the same turn
```

Roll back:

```bash
code --uninstall-extension lucasliang.harness-connector-deepseek
```

---

## 4. Tag and GitHub Release

```bash
# 4.1 commit any release prep (CHANGELOG bump, etc.)
git add -A
git commit -m "release: v<ver>"

# 4.2 tag
git tag v<ver>
git push origin main --tags

# 4.3 create the GitHub Release and attach the VSIX
#     Option A — gh CLI (preferred). On this machine it is installed but NOT on
#     PATH: /c/Program Files/GitHub CLI/gh.exe. Logged in as YichuAI via
#     `gh auth login --web`; the token lives in the Windows credential store.
#     Device flow, if you ever need to redo it:
#       printf '\n\n\n' | "/c/Program Files/GitHub CLI/gh.exe" auth login \
#         --hostname github.com --git-protocol ssh --web --scopes "repo,read:org"
#     then it prints a one-time code for https://github.com/login/device.
"/c/Program Files/GitHub CLI/gh.exe" release create v<ver> \
  harness-connector-deepseek-<ver>.vsix \
  --title "v<ver>" \
  --notes-file <notes.md> \
  --verify-tag
#     `--notes-file CHANGELOG.md` would paste the *entire* changelog, so write the
#     matching `## [<ver>]` section to a temp file first.

#     Option B — REST API with a classic PAT scoped to `repo`/`public_repo`.
#     `scripts/release.sh <PAT>` does exactly this (credential check, changelog
#     extraction, create-or-reuse, asset upload) — prefer it over hand-rolling
#     the calls. Pass the token via env var or argument, never commit it, and
#     revoke it once the release is up.
./scripts/release.sh ghp_… YichuAI deepseek-harness-vscode v<ver> \
  harness-connector-deepseek-<ver>.vsix
```

The Release notes should be the matching `## [<version>]` section from
`CHANGELOG.md`. Attach **only** the `.vsix` as a binary asset.

---

## 5. (Optional) Publish to a registry

### VS Code Marketplace

Only do this once a publisher ID (`lucasliang`) and PAT are set
up at https://marketplace.visualstudio.com/manage.

```bash
# dry-run first — validates manifest without publishing
npx vsce package --no-dependencies          # already done in step 1.5

# publish
npx vsce publish --no-dependencies          # → live on the Marketplace

# or publish a pre-release flag
npx vsce publish --no-dependencies --pre-release
```

If you prefer to keep the Marketplace publish manual, users can still install
directly from the GitHub Release VSIX:

```bash
code --install-extension harness-connector-deepseek-<ver>.vsix
```

### Open VSX

Cursor, VSCodium and Windsurf read Open VSX rather than the Microsoft Marketplace, and an
extension present in only one of the two does not exist for those editors. Published since
0.2.1 under the same `lucasliang` namespace; the version serving as of 2026-10-15 is `0.2.7`
(published: 0.2.1, 0.2.2, 0.2.5, 0.2.6, 0.2.7). Read it off `/api/<ns>/<ext>` — the
`/allVersions` sibling answered `404` on 2026-10-15 while the main endpoint was serving 0.2.7
correctly, so a 404 there is the endpoint being flaky, not the publish having failed.

```bash
# On this machine npmjs is behind a proxy that answers 502, so every npx call
# needs the mirror; omit it elsewhere.
REG=https://registry.npmmirror.com

# a namespace has to exist before anything else touches it. A first *publish*
# creates it implicitly, but `verify-pat` and `get` fail with "Namespace not found"
# until it does.
npx --registry=$REG ovsx create-namespace lucasliang

# Prefer the env var: `--pat` works but is absent from --help, so it looks
# unsupported. The token is an `ovsxat_…` string from open-vsx.org → Settings →
# Access Tokens. Pass it inline, never write it to a file or a repo secret.
OVSX_PAT=<token> npx --registry=$REG ovsx publish harness-connector-deepseek-<ver>.vsix

# confirm it landed. Indexing is not instant — a fresh publish 404s for a while,
# and that 404 means lag, not failure.
npx --registry=$REG ovsx get lucasliang.harness-connector-deepseek
```

**Publish here last, once the artifact has stopped changing.** This is the one registry where
the number stops being yours the moment it is accepted. A version that is still *inactive* —
not visible, not fetchable, absent from the public API — occupies the number anyway:
re-publishing it is refused with `… is already published, but currently isn't active and
therefore not visible`, and `DELETE /api/-/publish/<ns>/<ext>/<ver>` with a publisher token
answers `403`. (The web UI can delete a version; a token cannot.) `0.2.2` was lost that way —
pushed ahead of the README badge fix, never activated, undeletable — so Open VSX kept serving
`0.2.1` and the fix had to wait for a later version. `0.2.5` was published here on 2026-10-14
without incident, because by then its artifact had a GitHub Release behind it and had stopped
moving. `0.2.6` followed the same way minutes after its Release was created, and all fourteen
entries matched on re-download. `0.2.7` did it again on 2026-10-15: published after its Release,
indexed about two minutes later, and 376,628 bytes with all fourteen entries matching.

Two things this route needs that the others do not:

- **The PAT is stored nowhere.** Repository secrets are empty and it has never been written to
  a file — it is passed inline and forgotten, which is the intent. It does survive in this
  machine's local session transcripts under `~/.workbuddy/projects/` (search `ovsxat_`), so a
  later run can recover it there; nothing else on the machine has it. Treat that as the reason
  to keep issuing short-lived tokens rather than as a place to put one deliberately.
- **Bypass the proxy.** This machine sets `http_proxy`/`https_proxy` to `127.0.0.1:13067`, and
  open-vsx.org is not reachable through it — the same reason `curl` here needs `--noproxy '*'`.
  Unset both (and the lowercase pair) before `verify-pat` or `publish`; the `npx` fetch of
  `ovsx` itself is unaffected and still needs the npmmirror registry.

To confirm a publish landed, compare **per-entry CRC and length** between the downloaded VSIX
and the local one — whole-file `sha256` will differ even for an identical package, because zip
entries carry timestamps. On 0.2.5 all 14 entries matched.

---

## 6. Post-release verification

- [ ] GitHub Release page shows the VSIX asset and the changelog notes.
- [ ] `gh release view v<ver>` lists the asset.
- [ ] (If Marketplace published) the Marketplace page shows version `<ver>` and
      the "Verified against" Harness version in the description.
- [ ] A fresh `code --install-extension` from the asset loads the extension and
      connects to a local `dsh web`.
- [ ] Record the verified Harness commit/version in `README.md`
      ("Verified against" section) if it changed.

---

## 7. Rollback

```bash
# GitHub: convert the release to a draft (keeps the asset, hides it)
gh release edit v<ver> --draft

# Marketplace: unpublish is destructive — instead yank the version
# (Marketplace has no soft-unpublish; prefer releasing a patched version.)
```

A drafted GitHub Release hides the VSIX from the public Releases page but the
tag remains. Communicate the rollback in the release notes.

---

## 8. CI

Three workflows live in `.github/workflows/`:

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | every branch push, every PR | typecheck · `check-versions` · `protocol-test` · build · package · assert the VSIX holds exactly the 14 expected files and no sources |
| `e2e.yml` | push to `main`, PR | the same gate on `ubuntu-latest`, `windows-latest`, `macos-latest` — the protocol test parses three OS listener-table dialects, so the matrix earns its cost on its own — plus `npm run e2e-test` |
| `release.yml` | a `v*` tag, or a manual dispatch naming an existing tag | `check-versions --release` (the tag must exist *and* point at HEAD) · tests · build · package · read the version back **out of** the VSIX · sha256 it · create the GitHub Release with the matching CHANGELOG section · publish to the Marketplace |

`ci.yml` needs `fetch-depth: 0`: `check-versions` compares against the newest reachable
tag, and a shallow clone has none.

### Publishing to the Marketplace without a stored secret

The publisher page is the only thing involved. No Azure subscription, no managed identity,
no Entra app registration, no personal access token.

1. Sign in at `https://marketplace.visualstudio.com/manage/publishers/lucasliang`.
2. Open the publisher's **Trusted publishers** / trusted-publishing settings.
3. Add a policy that allows this repository and this workflow:
   - repository: `YichuAI/deepseek-harness-vscode`
   - workflow: `release.yml`
   - environment: leave blank unless the page asks
4. Save.

> **Where that setting actually is — unresolved as of 2026-10-12.** The `lucasliang` publisher
> page renders exactly three tabs: **Extensions**, **Details**, **Members**. There is no
> *Trusted publishers* tab on it, which is why this step is written as "find it" rather than
> as coordinates. Other publishers do use this flow, so the feature exists; what is
> unverified is whether it is exposed for this publisher, and under which tab. Check
> **Details** first. If it is genuinely absent, the next move is a note to Marketplace
> support — **not** a descent into Azure. The exchange consumes a GitHub OIDC token and
> nothing else; it needs no Azure subscription, no managed identity and no Entra app
> registration, so none of that machinery is on the critical path.

After that, a tag push mints a short-lived GitHub OIDC token for the
`marketplace.visualstudio.com` audience; `vsce` exchanges it at
`POST /_apis/gallery/token?api-version=7.2-preview.1` (`Authorization: FederatedToken …`)
for a session credential valid for about 15 minutes, and that credential is used in place of
a PAT. Nothing long-lived is stored anywhere, so there is no secret to rotate or leak.

`vsce` does **not** fall back to a PAT when that exchange fails, and neither does this
workflow — a publishing mode that cannot publish fails the job. On 2026-10-11 the step
printed `VSCE_PAT is not set — skipping`, exited 0, and GitHub reported `success`, so a
skipped publish and a completed one looked identical from the outside.

`MARKETPLACE_PUBLISH` is a repository **variable** (Settings → Secrets and variables →
Actions → Variables), not a secret:

| Value | Effect |
| --- | --- |
| unset, or `oidc` | trusted publishing |
| `pat` | publish with the `VSCE_PAT` secret and emit a warning — Azure DevOps global PATs are retired on **2026-12-01** |
| `off` | skip, visibly and on purpose |

**Pin `4.0.1-3`, never `latest`.** `--oidc` landed in `@vscode/vsce@4.0.0` (#1291) and is
deliberately hidden from `--help` (#1297), so its absence there proves nothing. What does
matter is that the released **4.0.0 makes a request the service refuses**: the URL omits
`api-version` and the header says `Bearer` where the endpoint expects `FederatedToken`. Every
attempt therefore dies at the exchange with

```
400 … No api-version was supplied for the "POST" request.
```

before permissions are consulted at all — which is why this reads like an authorization
failure and is not one. Upstream fixed both lines in `c960f2e97` *Update OIDC exchange to the
final Marketplace contract* (2026-09-29), first shipped in `4.0.1-1`. On npm the dist-tags are
`latest` → **4.0.0** (still broken) and `next` → **4.0.1-3** (first published build with the
fix), so the obvious `npx @vscode/vsce` selects precisely the build that cannot work.

The local devDependency stays at `3.9.2` on purpose: bumping it would rewrite the shipped
`package.json` of a release that already has a GitHub Release behind it, and change the bytes
users download. All three versions produce entry-for-entry identical VSIXs — same file list,
same per-entry CRC and length — so the skew is inert. Fold the devDependency bump into the
next version that edits a shipped file anyway — **which turned out to be v0.2.7, and it still did
not take it**, on the grounds that a release changing behaviour and a release changing the packager
should not be the same release, and that the pin that actually matters for publishing already lives
in . Fold it into whichever release next has no other reason to exist.

### Backfilling a version that predates the policy

Actions → **Release** → *Run workflow* → `tag: v0.2.1`. It checks out that tag, rebuilds,
re-verifies every surface, and publishes to the Marketplace without moving the tag or
creating a second Release. `--packagePath` is used for the upload, so the bytes on the
Marketplace, the bytes in the Release asset and the sha256 printed in the log are one file.

---

## Appendix — versioning policy

- `0.0.x` — features ship as patches while the protocol keeps moving; the wire
  is negotiated at connect, so a patch may widen what it calls without breaking
  older hosts (capability probes gate every control).
- Capability-related changes should be re-probed against a real host
  (`npm run protocol-probe`) rather than reasoned about from upstream source:
  the source snapshot on disk has repeatedly been a different release than the
  one actually running.
- **A number may be re-cut before it ships, but never after.** `0.1.8` was cut under that
  number, re-cut as `0.2.0`, and shipped as `0.1.9` — one changeset, three names. The tag
  `v0.1.8` points at `806ce47`, where `package.json` genuinely read `0.1.8`, and it has no
  GitHub Release on purpose, because there is no artifact by that name. Retagging is only
  safe while the number has neither a release nor a Marketplace publish behind it; once a
  user can install it, the number is frozen and the fix becomes the next version.
- `0.2.3` is the other number with a tag and no Release, for a different reason — it was
  never withdrawn, it simply never went out. It was committed (`200e708`), annotated, and
  packaged, but the three fixes that landed the next day went into `0.2.4` instead of being
  merged back, and the tag was never pushed. It measures 353,366 in a working tree that has
  the CRLF-on-disk pair and **353,363** from a clean LF export; neither is a download count,
  because nobody could download it. The check is one command, and it is worth running before
  writing any version into a "shipped" list: `git ls-remote --tags origin`. If the tag is not
  there, no Release exists for it, whatever the CHANGELOG says — a CHANGELOG entry describes
  a tree, not a publication.
- Release notes live **inside** the VSIX: `README.md`/`CHANGELOG.md` ship through vsce as
  `readme.md`/`changelog.md`, and the `*.zh-CN.md` twins ship verbatim. So every baseline
  below belongs to one particular tree, and editing a shipped doc afterwards invalidates it.
  Re-measure; do not carry the old figure forward. Shipped bytes, as `gh release view --json
  assets` reports them — i.e. what a user actually downloads: `v0.2.8` = 380,195 (the figure
  `.gitattributes` now makes machine-independent);
  `v0.2.7` = 376,628;
  `v0.2.6` = 372,811;
  `v0.2.5` = 368,277; `v0.2.4` = 363,809; `v0.2.2` = 331,706;
  `v0.2.1` = 313,426; `v0.2.0` = 312,853 at `581ba27`; `v0.1.9` = 309,620;
  `v0.1.7` = 288,750.
  (`v0.2.3` is deliberately absent — it has a tag, a CHANGELOG entry and a package, and no
  Release, so no bytes of it were ever downloaded. See the policy bullet above.)
  The v0.2.1 *local* figure moved three times while that release was being prepared — 312,063,
  then 312,745, then 313,441 — each time because a doc inside the VSIX was edited after the
  last measurement. Those intermediate reads were not wrong; they were readings of a different
  tree. Re-measure, never carry a number forward, and never adjust one by eye.
  Local and shipped figures disagree by a few bytes, and it is always a file that was CRLF on
  disk in the working tree: v0.2.2 by 3 (331,709 against 331,706) and v0.2.4 by 157
  (363,966 against 363,809), both run down in step 2. v0.2.1 was off by 15 (313,441 against
  313,426), never run down and left named rather than smoothed over — the same shape of cause,
  but the file was not identified. v0.2.0 and v0.2.5 onward agreed exactly, and v0.2.5 agreed on
  purpose — the exposed files were normalised to LF before the measurement rather than after —
  while v0.2.6 onward simply had no exposed file: all fourteen entries were LF on disk at package time.
  v0.2.3 shows the same 3 as v0.2.2 (353,366 local against 353,363 clean) but belongs to
  neither column, because it was never published — see the policy bullet above.
  `RELEASE.md` is on the `.vscodeignore` list, so editing *this* file cannot move the number
  written one paragraph above it. That is the whole reason a baseline is safe to record here
  and then keep writing in the same document; it is not true of any of the other files.

## Appendix — dependency baseline

Audited 2026-10-14 against `npm outdated --registry=https://registry.npmmirror.com`. The
registry has to be named: the corporate proxy blocks `registry.npmjs.org` outright, and the
mirror does not implement `npm audit`'s endpoint (`NOT_IMPLEMENTED /-/npm/v1/security/*`), so
there is no vulnerability scan in this repo — say that rather than implying one ran.

**One runtime dependency, and it is current.** `yaml` is the only entry in `dependencies`, at
`2.9.1`, which is the published latest. It is not shipped as a package: `esbuild.mjs` sets
`bundle: true` with `external: ['vscode']`, so `yaml` is inlined into `dist/extension.js`.
Consequence worth knowing before touching it: **a `yaml` bump changes the bytes users
download**, so it rides a version number like any other shipped edit.

**Dev-only, and it does not appear in the VSIX at all** (`scripts/**` and `test/**` are on the
`.vscodeignore` list, and `--no-dependencies` never walks `node_modules`): `tsx`, `typescript`,
`@vscode/vsce`, `markdown-it`, `@types/markdown-it`, `sharp`, `potrace`, `@types/potrace`,
`@types/node`, `@types/vscode`. Two of these are not quite free:

- `esbuild` produces `dist/extension.js`, which ships. A bump can change the minified output
  and therefore the artifact, even though the dependency itself never enters it.
- `sharp` and `potrace` generate `media/icon.png` / `media/icon.svg`, which also ship — but
  they are checked in, so a bump only matters if the icons are regenerated.

**The rule that makes the rest cheap:** editing a version *string* in `package.json` is an edit
to a shipped file and needs a version number; a `package-lock.json`-only bump that leaves the
range strings identical does not move a single byte of the VSIX. So in-range updates that are
not build inputs can be taken at any time, and everything else waits for a release.

| Package | Declared | Resolved | Latest | Why it is where it is |
| --- | --- | --- | --- | --- |
| `yaml` | `^2.9.1` | 2.9.1 | 2.9.1 | Runtime, bundled. **Current.** |
| `potrace` | `^2.1.8` | 2.1.8 | 2.1.8 | Icon generation. **Current.** |
| `@types/potrace` | `^2.1.5` | 2.1.5 | 2.1.5 | **Current.** |
| `markdown-it` | `^15.0.0` | 15.0.0 | 15.0.2 | Test fixture only; the shipped `media/markdown-it.umd.min.js` is a checked-in asset, not built here. Bumpable lockfile-only. |
| `sharp` | `^0.35.3` | 0.35.3 | 0.35.5 | As above. |
| `tsx` | `^4.19.0` | 4.23.12 | 4.23.15 | Test runner. Bumpable lockfile-only. |
| `@types/markdown-it` | `^14.1.2` | 14.1.2 | 14.2.0 | Types. Bumpable lockfile-only. |
| `@vscode/vsce` | `^3.2.0` | 3.9.2 | 4.0.0 | Deliberate pin. `4.0.0` cannot do OIDC at all and `latest` still points at it; the working build is the `next` dist-tag. Keep `3.9.2` for *packaging*, use `4.0.1-3` by `npx` for *publishing*. See the Marketplace section. |
| `@types/node` | `^20.11.0` | 20.19.43 | 26.6.5 | Stays on the Node 20 line on purpose: the extension host is Node 18/20/22 and `esbuild` targets `node18`. A `@types/node` ahead of the runtime teaches you the wrong globals. |
| `esbuild` | `^0.24.0` | 0.24.2 | 0.28.2 | Build input — see above. Ride a version. |
| `typescript` | `^5.4.0` | 5.9.3 | 7.0.2 | TS 7 is the native rewrite; that is a migration, not a bump. |
| `@types/vscode` | `^1.85.0` | **1.125.0** | 1.140.0 | The one real gap. Read below. |

### `@types/vscode` can outrun `engines.vscode`

`engines.vscode` promises `^1.85.0`, and the README repeats it three times. But
`"@types/vscode": "^1.85.0"` is a caret range over every `1.x`, so `npm` installs whatever the
newest minor is — `1.125.0` here, `1.140.0` available. That mismatch is the ordinary shape of a
VS Code extension (the official generator writes exactly this range), and it means the
compiler is happy to accept an API added in 1.110 while the manifest still claims 1.85: it
type-checks, ships, and throws `undefined is not a function` on somebody's older VS Code.

**Today the promise holds, and it was measured rather than assumed.** `src/` is clean against
the 1.85 typings — all 40 files, `tsc` exit 0:

```bash
mkdir -p /c/tmp/vsc85 && cd /c/tmp/vsc85
npm pack @types/vscode@1.85.0 --registry=https://registry.npmmirror.com && tar xzf types-vscode-1.85.0.tgz
# a tsconfig that maps "vscode" onto C:/tmp/vsc85/vscode/index.d.ts, then:
node node_modules/typescript/bin/tsc -p /c/tmp/vsc85/tsconfig.json   # exits 0, and --listFiles shows the 1.85 file, not node_modules
```

The check has to override the module resolution to be worth anything; pointing `paths` at the
old `index.d.ts` is what makes it a real test, and `--listFiles` is how you prove the mapping
was used instead of believing it. There is no faster way to answer "does ≥ 1.85 still hold".

**The gap is forward-looking, and fixing it needs a version.** Pin the range — `"1.85.0"` or
`"~1.85.0"` — so the types can no longer resolve past the floor, or raise both together. Either
way it edits `package.json`, which ships, so it waits for the next release. Whatever you do,
do not add a gate assertion that merely compares the two range strings: it would fail on the
range that is *correct* (`~1.85.0` against `^1.85.0`) and pass on the one that is wrong.

## Appendix — SSH setup on this machine

Historically the Windows username was non-ASCII and the `ssh` binary resolved
`HOME` through the account DB in the local code page — so it looked for the key
under a mojibake path and silently found nothing
(`Could not create directory '/c/Users/<garbage>'`). The workaround was to keep
the key on an ASCII path and point git at it explicitly.

**That workaround is no longer in place and no longer needed.** As of 2026-10 the
account home is ASCII (`C:\Users\PP`), Git Bash reports `HOME=/c/Users/PP`, and
`~/.ssh/id_ed25519` authenticates as YichuAI. `/c/ssh/id_ed25519` does **not**
exist — do not paste the snippet below blindly, it will break the push.

```bash
# verify first — this must print "Hi YichuAI!"
ssh -T git@github.com

# only if the mojibake problem comes back:
mkdir -p /c/ssh
cp ~/.ssh/id_ed25519 /c/ssh/          # key generated normally, then relocated
git config core.sshCommand \
  "ssh -i /c/ssh/id_ed25519 -o UserKnownHostsFile=/c/ssh/known_hosts -o StrictHostKeyChecking=accept-new"
git remote set-url origin git@github.com:YichuAI/deepseek-harness-vscode.git
git push origin main --tags
```
