# 发布流程

本文档描述如何裁剪并发布 **DeepSeek Harness Connector for VS Code** 的一个版本。
v0.0.3 以 GitHub Release + VSIX 资产 + Marketplace 上传的形式发布；Marketplace 发布是可选的，见末尾说明。

---

## 0. 前置条件

- Node.js ≥ 20（推荐 Node 22+——集成测试使用全局 `WebSocket`）。
- 正在运行的本地 `dsh web`，用于发布前集成测试。
- `git` CLI 已认证到发布分支。
- （可选）`gh` CLI 用于创建 GitHub Release。
- （可选）VS Code Marketplace 发布者 PAT，用于 `vsce publish`。

```bash
# 一次性工具安装（已在 devDependencies 中，仅供参考）
npm install
```

---

## 1. 发布前检查清单

在项目根目录（`e:\deepseek\deepseek-harness-vscode`）执行以下**所有**步骤。
每一项都必须通过。

```bash
# 1.1 干净的类型检查
npm run typecheck          # → tsc --noEmit, 退出码 0

# 1.2 构建打包
npm run build              # → dist/extension.js

# 1.3 协议测试（假 harness——不需要 dsh web）
npm run protocol-test      # → 全部 34 项断言 ✓

# 1.4 集成测试（会写入会话——需要 dsh web 运行）
#     先在另一个终端启动 dsh web：
#       cd ../deepseek-harness && npm run dsh -- web
#     然后复制它打印的启动 URL
DSH_LAUNCH_URL='http://127.0.0.1:3080/?token=<token>' npm run integration-test

# 1.5 打包 VSIX
npm run package            # → harness-connector-deepseek-<版本>.vsix
```

手动检查：

- [ ] `package.json` 的 `version` 与目标标签一致。
- [ ] `CHANGELOG.md` 有对应版本的条目（`## [<版本>] — <日期>`）。
- [ ] `README.md` "已验证版本"部分仍指向正确的 Harness 版本。
- [ ] `LICENSE` 存在（MIT）。
- [ ] `test/fixtures/` 中无秘钥/API 密钥/真实提示内容
      （固件必须使用 `<redacted:...>` 占位符）。
- [ ] `.vscodeignore` 排除了 `src/`、`scripts/`、`test/`、配置文件
      （VSIX 中只包含 `dist/`、`media/`、文档、`package.json`、`LICENSE`）。
- [ ] `git status` 干净（无未提交变更）。

---

## 2. 验证 VSIX 内容

```bash
# 列出实际打包的内容
unzip -l harness-connector-deepseek-<版本>.vsix
```

预期（v0.0.1 ≈ 10 个文件，约 40 KB）：

```
[Content_Types].xml
extension.vsixmanifest
extension/ARCHITECTURE.md
extension/LICENSE.txt
extension/changelog.md
extension/package.json
extension/readme.md
extension/dist/extension.js
extension/media/icon.png
extension/media/icon.svg
```

如果出现 `src/`、`scripts/`、`test/`、`node_modules/` 或 `*.map`，
说明 `.vscodeignore` 配置有误——修复后重新打包。

---

## 3. 在干净的扩展宿主中冒烟测试 VSIX

```bash
# 安装到你的 VS Code
code --install-extension harness-connector-deepseek-<版本>.vsix

# 然后在 VS Code 中：
#   - 重新加载窗口
#   - 打开一个映射到 Harness 工作区的文件夹
#   - DeepSeek Harness 活动栏图标出现
#   - 选择一个会话，发送提示，观察流式输出
#   - 在浏览器中打开 http://127.0.0.1:3080/ 的同一会话
#   - 两端必须显示同一轮对话
```

回滚：

```bash
code --uninstall-extension lucasliang.harness-connector-deepseek
```

---

## 4. 打标签并创建 GitHub Release

```bash
# 4.1 提交发布准备（CHANGELOG 更新等）
git add -A
git commit -m "release: v<版本>"

# 4.2 打标签
git tag v<版本>
git push origin main --tags

# 4.3 创建 GitHub Release 并附加 VSIX
gh release create v<版本> \
  harness-connector-deepseek-<版本>.vsix \
  --title "v<版本>" \
  --notes-file CHANGELOG.md \
  --verify-tag
```

Release 说明应为 `CHANGELOG.md` 中对应的 `## [<版本>]` 章节。**仅**附加 `.vsix` 作为二进制资产。

---

## 5. （可选）发布到 VS Code Marketplace

仅在已设置发布者 ID（`lucasliang`）和 PAT 后执行，
详见 https://marketplace.visualstudio.com/manage。

```bash
# 先做 dry-run——验证清单但不发布
npx vsce package --no-dependencies          # 已在步骤 1.5 完成

# 发布
npx vsce publish --no-dependencies          # → 上线 Marketplace

# 或发布预发布版本
npx vsce publish --no-dependencies --pre-release
```

如果你更愿意手动发布到 Marketplace，用户仍可直接从 GitHub Release 的 VSIX 安装：

```bash
code --install-extension harness-connector-deepseek-<版本>.vsix
```

---

## 6. 发布后验证

- [ ] GitHub Release 页面显示 VSIX 资产和变更日志说明。
- [ ] `gh release view v<版本>` 列出了该资产。
- [ ] （若已发布到 Marketplace）Marketplace 页面显示版本 `<版本>`，
      描述中的"已验证"Harness 版本正确。
- [ ] 从资产执行全新的 `code --install-extension` 能加载扩展并
      连接到本地 `dsh web`。
- [ ] 如果 Harness 版本变化，更新 `README.md` 的"已验证版本"部分。

---

## 7. 回滚

```bash
# GitHub：将 Release 转为草稿（保留资产，但隐藏）
gh release edit v<版本> --draft

# Marketplace：取消发布是破坏性的——改为发布补丁版本
#（Marketplace 无软取消发布；优先发布补丁版本。）
```

草稿状态的 GitHub Release 会从公开 Releases 页面隐藏 VSIX，但标签保留。在 Release 说明中通报回滚事宜。

---

## 附录 — 版本策略

- `0.0.x`——v0.0.x 线是"最小闭环"线。v0.0.3 引入了 Diff 审查、审批工作流和文件内容内联。
- `0.1.0` 及以后——见 `README.md` 的路线图（内联补全、VS Code 文件系统提供器、终端集成、LSP/ACP 集成）。
