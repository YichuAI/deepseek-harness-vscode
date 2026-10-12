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
npm run protocol-test      # → all 381 assertions ✓

# 1.5 end-to-end chains (real filesystem; reports its own coverage)
npm run e2e-test           # → every written chain passes, coverage reported

# 1.6 integration test (writes a session — needs a host running)
#     start one in another terminal:
#       cd ../deepseek-harness && npm run dsh -- web          (fixed port 3080)
#     the desktop app works too, but it starts its host with `--port 0`, so the
#     port is freshly assigned on every launch — read it off the listener table
#     and pass it in:
#       DSH_PORT=3081 npm run integration-test
npm run integration-test   # → 39/39 checks ✓, closed loop OK

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
      178 → 180 → 190 → 211 → 231 → 243 → 268 → 295 → 312 → 342 → 381 as the
      rc.2 rewrite replaced the rc.6 fake harness and the waterfall/pending-panel
      groups landed, and v0.2.2 added the session-mode vocabulary, the per-platform
      install routing and the launcher's pure functions;
      stale counts are the most common doc drift here — and since
      v0.2.1 `check-versions` fails the build on it rather than leaving it to
      this line).
- [ ] `README.md`'s newest "What's new" heading is this version, and the README
      keeps **exactly one** release's notes. History goes in the CHANGELOG.
- [ ] `LICENSE` present (MIT).
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

Expected (v0.2.2 = 14 files, 331,706 bytes, ~324 KB):

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

The size above is the **clean-checkout** figure, and it is the same number CI produced for the
Release asset. It is not the only number this tree can produce. With `core.autocrlf = true`
on Windows, any file git has round-tripped carries CRLF on disk while the blob it came from —
and therefore the CI checkout — does not. At v0.2.2 exactly one file was in that state,
`media/icon.svg`: its seven CR bytes compressed to 3 more bytes, so the local archive read
331,709 where CI read 331,706. Compare the two archives and the other **13 entries have
identical CRC32 and length**; only that one differs. So when a figure here disagrees with a
fresh clone by a few bytes, check `git status` and the line endings before assuming the tree
changed — and when recording a baseline, say which of the two you measured.

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
0.2.1 under the same `lucasliang` namespace.

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
`0.2.1` and the fix had to wait for a later version.

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
next version that edits a shipped file anyway.

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
- Release notes live **inside** the VSIX: `README.md`/`CHANGELOG.md` ship through vsce as
  `readme.md`/`changelog.md`, and the `*.zh-CN.md` twins ship verbatim. So every baseline
  below belongs to one particular tree, and editing a shipped doc afterwards invalidates it.
  Re-measure; do not carry the old figure forward. Shipped bytes, as `gh release view --json
  assets` reports them — i.e. what a user actually downloads: `v0.2.2` = 331,706;
  `v0.2.1` = 313,426; `v0.2.0` = 312,853 at `581ba27`; `v0.1.9` = 309,620;
  `v0.1.7` = 288,750.
  The v0.2.1 *local* figure moved three times while that release was being prepared — 312,063,
  then 312,745, then 313,441 — each time because a doc inside the VSIX was edited after the
  last measurement. Those intermediate reads were not wrong; they were readings of a different
  tree. Re-measure, never carry a number forward, and never adjust one by eye.
  Two local figures disagree with the released assets by a few bytes: v0.2.1 by 15 (313,441
  against 313,426), v0.2.2 by 3 (331,709 against 331,706). The v0.2.2 gap was run down to
  `media/icon.svg`'s line endings — step 2 says how to check it. The v0.2.1 gap of 15 bytes was
  never run down, and is left named rather than smoothed over. v0.2.0 agreed exactly.
  `RELEASE.md` is on the `.vscodeignore` list, so editing *this* file cannot move the number
  written one paragraph above it. That is the whole reason a baseline is safe to record here
  and then keep writing in the same document; it is not true of any of the other files.

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
