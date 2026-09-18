# Release Process

This document describes how to cut and publish a release of
**DeepSeek Harness Connector for VS Code**. v0.0.2 ships as a GitHub Release + VSIX
asset + Marketplace upload; Marketplace publishing is optional and documented at the end.

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
npm run protocol-test      # → all 34 assertions ✓

# 1.4 integration test (writes a session — needs dsh web running)
#     start dsh web first in another terminal:
#       cd ../deepseek-harness && npm run dsh -- web
npm run integration-test   # → 11/11 checks ✓, closed loop OK

# 1.5 package the VSIX
npm run package            # → harness-connector-deepseek-<ver>.vsix
```

Manual checks:

- [ ] `package.json` `version` matches the intended tag.
- [ ] `CHANGELOG.md` has an entry for this version under `## [<version>] — <date>`.
- [ ] `README.md` "Verified against" section still names the correct Harness version.
- [ ] `LICENSE` present (MIT).
- [ ] No secrets / API keys / real prompt content in `test/fixtures/`
      (fixtures must use `<redacted:...>` placeholders).
- [ ] `.vscodeignore` excludes `src/`, `scripts/`, `test/`, configs
      (only `dist/`, `media/`, docs, `package.json`, `LICENSE` ship in the VSIX).
- [ ] `git status` clean (no uncommitted changes).

---

## 2. Verify the VSIX contents

```bash
# list what actually ships
unzip -l harness-connector-deepseek-<ver>.vsix
```

Expected (v0.0.1 ≈ 8 files, ~18 KB):

```
[Content_Types].xml
extension.vsixmanifest
extension/ARCHITECTURE.md
extension/LICENSE.txt
extension/package.json
extension/readme.md
extension/dist/extension.js
extension/media/icon.svg
```

If `src/`, `scripts/`, `test/`, `node_modules/`, or `*.map` appear, the
`.vscodeignore` is wrong — fix it and re-package.

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
gh release create v<ver> \
  harness-connector-deepseek-<ver>.vsix \
  --title "v<ver>" \
  --notes-file CHANGELOG.md \
  --verify-tag
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

- `0.0.x` — the v0.0.x line is the "minimum closed loop" line. Patch releases
  only fix protocol drift, build, or security issues. No new features.
- `0.1.0` and beyond — see `README.md` "v0.0.2 TODO" (Diff Review, Approval
  integration, Inline Completion, VS Code filesystem provider).
