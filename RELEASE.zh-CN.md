# 发布流程

本文档描述如何裁剪并发布 **DeepSeek Harness Connector for VS Code** 的一个版本。
v0.0.6 以 GitHub Release + VSIX 资产的形式发布；Marketplace 发布是可选的，见第 5 节。

仓库地址 `git@github.com:YichuAI/deepseek-harness-vscode.git`。此处 HTTPS 推送会失败
（没有凭据助手），因此 remote 走 SSH，并用 repo-local 的 `core.sshCommand` 指向一个
纯 ASCII 的密钥路径——详见文末"附录 — 本机 SSH 配置"。

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
npm run protocol-test      # → 全部 98 项断言 ✓

# 1.4 协议探测（可选但推荐——需要 dsh web 运行）
#     打印该 host 的端点风格、是否 cookie 门禁、事件套接字，以及它实际提供哪些
#     控制面方法。凡是升级过 host 版本，就该跑一次：它是 UI 能提供什么的最终依据。
npm run protocol-probe     # 接受 [host] [port] 参数，默认 127.0.0.1:3080

# 1.5 集成测试（会写入会话——需要 dsh web 运行）
#     先在另一个终端启动 dsh web：
#       cd ../deepseek-harness && npm run dsh -- web
#     然后复制它打印的启动 URL
DSH_LAUNCH_URL='http://127.0.0.1:3080/?token=<token>' npm run integration-test

# 1.6 打包 VSIX
npm run package            # → harness-connector-deepseek-<版本>.vsix
```

手动检查：

- [ ] `package.json` 的 `version` 与目标标签一致。
- [ ] `CHANGELOG.md` 有对应版本的条目（`## [<版本>] — <日期>`）。
- [ ] 文档**保持双语**：对 `README.md` / `CHANGELOG.md` / `ARCHITECTURE.md` /
      `RELEASE.md` 的每一处修改，都已镜像到对应的 `*.zh-CN.md`。这是长期约定，
      不是每次发版再临时判断的事。
- [ ] `CHANGELOG.md` 与 `ARCHITECTURE.md` 里的断言数与 `npm run protocol-test`
      的**当前**输出一致（它已历经 50 → 64 → 98；此处数字过期是最常见的文档漂移）。
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
#     方式 A —— gh CLI（并非每台机器都装了）：
gh release create v<版本> \
  harness-connector-deepseek-<版本>.vsix \
  --title "v<版本>" \
  --notes-file CHANGELOG.md \
  --verify-tag

#     方式 B —— 用一个 scope 为 `repo`（公开仓库为 `public_repo`）的 classic PAT
#     打 REST API。token 走环境变量传入，绝不要作为命令行参数（会泄进 shell
#     历史和 `ps` 输出）。Release 建好后就把 token 吊销。
GITHUB_TOKEN=ghp_… python - <<'PY'
import os, json, urllib.request
tok = os.environ["GITHUB_TOKEN"]
repo = "YichuAI/deepseek-harness-vscode"
def api(method, path, body=None, ctype="application/json"):
    req = urllib.request.Request(f"https://api.github.com{path}", method=method)
    req.add_header("Authorization", f"Bearer {tok}")
    req.add_header("Accept", "application/vnd.github+json")
    data = None
    if body is not None:
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        req.add_header("Content-Type", ctype)
    with urllib.request.urlopen(req, data) as r:
        return json.loads(r.read() or b"{}")
rel = api("POST", f"/repos/{repo}/releases",
          {"tag_name": "<版本>", "name": "v<版本>", "body": open("notes.md").read()})
with open("harness-connector-deepseek-<版本>.vsix", "rb") as f:
    api("POST", f"https://uploads.github.com/repos/{repo}/releases/{rel['id']}"
                "/assets?name=harness-connector-deepseek.vsix",
        f.read(), "application/octet-stream")
PY
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

在 Windows 上**不要**直接调用 `node_modules/.bin/vsce`——那是个 bash 脚本，用 node 跑会崩。
改为调用 JS 入口：

```bash
node ./node_modules/@vscode/vsce/vsce package --no-dependencies \
     --out dist/harness-connector-deepseek.vsix
node ./node_modules/@vscode/vsce/vsce publish --no-dependencies
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

- `0.0.x`——协议仍在变动，因此功能以补丁形式发布；线缆在连接时协商，所以一个补丁可以
  放宽调用范围而不会弄坏旧 host（每个控件都由能力探测门控）。
- 涉及能力的改动应先对真实 host 跑 `npm run protocol-probe` 而不是对着上游源码推理：
  磁盘上的源码快照已多次与实际运行的版本不一致。

## 附录 — 本机 SSH 配置

Windows 用户名含非 ASCII 字符，而 `ssh` 会通过账户数据库按本地代码页解析 `HOME`，
于是去一个乱码路径下找密钥并静默失败（`Could not create directory '/c/Users/<乱码>'`）。
绕开办法：把密钥放在纯 ASCII 路径上，并让 git 显式指向它。

```bash
mkdir -p /c/ssh
cp ~/.ssh/id_ed25519 /c/ssh/          # 密钥正常生成后再迁移
git config core.sshCommand \
  "ssh -i /c/ssh/id_ed25519 -o UserKnownHostsFile=/c/ssh/known_hosts -o StrictHostKeyChecking=accept-new"
git remote set-url origin git@github.com:YichuAI/deepseek-harness-vscode.git
git push origin main --tags
```
