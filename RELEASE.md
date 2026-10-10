# Release Process

This document describes how to cut and publish a release of
**DeepSeek Harness Connector for VS Code**. v0.1.4 ships as a GitHub Release +
VSIX asset; Marketplace publishing is optional and documented in step 5.

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

# 1.2 build the bundle
npm run build              # → dist/extension.js

# 1.3 protocol test (fake harness — no dsh web needed)
npm run protocol-test      # → all 211 assertions ✓

# 1.4 integration test (writes a session — needs dsh web running)
#     start dsh web first in another terminal:
#       cd ../deepseek-harness && npm run dsh -- web
npm run integration-test   # → 25/25 checks ✓, closed loop OK

# 1.6 package the VSIX
npm run package            # → harness-connector-deepseek-<ver>.vsix
```

Manual checks:

- [ ] `package.json` `version` matches the intended tag.
- [ ] `CHANGELOG.md` has an entry for this version under `## [<version>] — <date>`.
- [ ] Docs are **bilingual**: every edit to `README.md` / `CHANGELOG.md` /
      `ARCHITECTURE.md` / `RELEASE.md` has been mirrored into its `*.zh-CN.md`
      twin. This is a standing rule, not a per-release judgement call.
- [ ] `CHANGELOG.md` and `ARCHITECTURE.md` still quote the **current** assertion
      count from `npm run protocol-test` (it has grown 50 → 64 → 98 → 83 → 156 →
      178 → 180 → 190 → 211 as the rc.2 rewrite replaced the rc.6 fake harness and
      the waterfall/pending-panel groups landed; stale counts are the most common
      doc drift here).
- [ ] `LICENSE` present (MIT).
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

Expected (v0.1.4 = 14 files, ~253 KB):

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

## 5. (Optional) Publish to the VS Code Marketplace

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

## Appendix — versioning policy

- `0.0.x` — features ship as patches while the protocol keeps moving; the wire
  is negotiated at connect, so a patch may widen what it calls without breaking
  older hosts (capability probes gate every control).
- Capability-related changes should be re-probed against a real host
  (`npm run protocol-probe`) rather than reasoned about from upstream source:
  the source snapshot on disk has repeatedly been a different release than the
  one actually running.

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
