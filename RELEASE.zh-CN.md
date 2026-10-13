# 发布流程

本文档描述如何裁剪并发布 **DeepSeek Harness Connector for VS Code** 的一个版本。

**优先用标签发。** 自 v0.2.1 起整套流程跑在 `.github/workflows/release.yml` 里——推一个
标签，CI 就会核验、打包、建 GitHub Release，并在存在 `VSCE_PAT` secret 时发布到
Marketplace：

```bash
git tag v<版本> && git push origin v<版本>
```

下面这份是同样的流程手动走一遍，也是那个工作流所编码的检查清单。两者要保持一致：CI 不可用的
时候走手动路径，而且只有手动走一遍，才看得见每项检查到底在做什么。

仓库地址 `git@github.com:YichuAI/deepseek-harness-vscode.git`。此处 HTTPS 推送会失败
（没有凭据助手），因此 remote 走 SSH。曾经需要 repo-local 的 `core.sshCommand` 来绕过
非 ASCII 主目录，现在已不需要——详见文末"附录 — 本机 SSH 配置"。

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

# 1.2 每一个版本展示面都必须和 package.json 一致
npm run check-versions     # → 全部检查通过；加 --online 会把已发布的 Release 与
                           #   Marketplace 列表也算进去（需要网络），
                           #   打标签时加 --release

# 1.3 构建打包
npm run build              # → dist/extension.js

# 1.4 协议测试（假 harness——不需要 dsh web）
npm run protocol-test      # → 全部 493 项断言 ✓

# 1.5 端到端链路（真实文件系统；会自己报告覆盖情况）
npm run e2e-test           # → 5 条链路里已写 3 条、未写 2 条；已编写的
                           #   链路全部通过（当前 96 项断言）

# 1.6 协议探测（可选但推荐——需要 dsh web 运行）
#     打印该 host 的端点风格、是否 cookie 门禁、事件套接字，以及它实际提供哪些
#     控制面方法。凡是升级过 host 版本，就该跑一次：它是 UI 能提供什么的最终依据。
npm run protocol-probe     # 接受 [host] [port] 参数，默认 127.0.0.1:3080

# 1.7 集成测试（会写入会话——需要有 host 在跑）
#     先在另一个终端启动一个：
#       cd ../deepseek-harness && npm run dsh -- web          （固定端口 3080）
#     桌面端也可以，但它用 `--port 0` 起 host，端口每次启动都重新分配——
#     从监听表里读出实际端口再传进去：
#       DSH_PORT=3081 npm run integration-test
#     默认走本地自签（也就是扩展实际用的那条路），无需再复制 token；
#     需要时可用 DSH_LAUNCH_URL='http://127.0.0.1:3080/?token=<token>' 覆盖
npm run integration-test   # → 41/41 项 ✓，闭环通过

# 1.8 打包 VSIX
npm run package            # → harness-connector-deepseek-<版本>.vsix
```

手动检查：

- [ ] `package.json` 的 `version` 与目标标签一致。`npm run check-versions` 会把这件事
      连同其他每一个展示面一起断言掉——不要用眼睛看。
- [ ] `package-lock.json` 也带着这个版本号。`npm ci` **不校验**根包版本，所以它会静默漂移：
      v0.2.1 发现它还停在 `0.1.4`，落后了四个版本。用 `npm install --package-lock-only`
      修（只有两行 diff，不会连带改动）。自 v0.2.1 起 `check-versions` 会覆盖它。
- [ ] `CHANGELOG.md` 有对应版本的条目（`## [<版本>] — <日期>`）。
- [ ] 文档**保持双语**：对 `README.md` / `CHANGELOG.md` / `ARCHITECTURE.md` /
      `RELEASE.md` 的每一处修改，都已镜像到对应的 `*.zh-CN.md`。这是长期约定，
      不是每次发版再临时判断的事。
- [ ] `CHANGELOG.md` 与 `ARCHITECTURE.md` 里的断言数与 `npm run protocol-test`
      的**当前**输出一致（它已历经 50 → 64 → 98 → 83 → 156 → 178 → 180 → 190 →
      211 → 231 → 243 → 268 → 295 → 312 → 342 → 381 → 461 → 493，其中 rc.2 重写用新假
      harness 替换了 rc.6 的那套，waterfall／待处理面板两组随之落地，v0.2.2 又加上了
      会话模式词表、分平台安装路线和启动器的两个纯函数，v0.2.3 再加上了逐 hunk 手术、
      那九条右键提问和回环围栏，v0.2.4 再加上了 waterfall 的归属规则、启动计划
      和远程安装路由，v0.2.5 只动了随包文档、没有新增断言；此处数字过期是最常见的文档漂移——
      **而自 v0.2.1 起，`check-versions` 会直接让构建失败，不再靠这一行靠人记**）。
- [ ] `README.md` 最新的「新特性」标题就是这个版本，而且 README 只保留**一个**版本的
      说明。历史写进 CHANGELOG。
- [ ] `LICENSE` 存在（MIT）。
- [ ] **仓库顶层没有多出任何东西。** `.vscodeignore` 是一张排除表，所以一个没人想到的目录
      默认就会随包——v0.2.3 的候选包里就躺着一个本地的 `宣传片/` 分镜目录，在一个 896 KB 的
      VSIX 里占了 565 KB，而唯一发现它的方式是有人打开归档看了一眼。把新路径加进
      `.vscodeignore`，**并且**确认第 2 步的文件数仍然是 14。
- [ ] 第 2 步里的 VSIX 期望体积，是在**最后一次改动随包文档之后**量出来的。
      `README.md` / `CHANGELOG.md` / `ARCHITECTURE.md` 及其 `*.zh-CN.md` 镜像
      **都被打进 VSIX**，打包之后再改其中一个，那个数字就作废了——重新打包、
      重新量，**不要凭感觉调**。（v0.2.0 的基线就是这么少了 856 字节的。`RELEASE.md`
      本身**不进包**，所以这个数字可以事后写在这里。）
- [ ] `test/fixtures/` 中无秘钥/API 密钥/真实提示内容
      （固件必须使用 `<redacted:...>` 占位符）。
- [ ] `.vscodeignore` 排除了 `src/`、`scripts/`、`test/`、配置文件**以及 `.workbuddy/`**
      （VSIX 中只包含 `dist/`、`media/`、文档、`package.json`、`LICENSE`）。
- [ ] `git status` 干净（无未提交变更）。

---

## 2. 验证 VSIX 内容

```bash
# 列出实际打包的内容
unzip -l harness-connector-deepseek-<版本>.vsix
```

预期（v0.2.5 = 14 个文件，干净检出 368,277 字节，约 360 KB）：

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

如果出现 `src/`、`scripts/`、`test/`、`node_modules/`、`.workbuddy/` 或 `*.map`，
说明 `.vscodeignore` 配置有误——修复后重新打包。

上面这个尺寸是**干净检出**的读数，也是 CI 为 Release 附件打出来的那个数字。它不是这棵树唯一
能产生的数字。在 Windows 上 `core.autocrlf = true` 时，凡是被 git 往返处理过的文件，磁盘上是
CRLF，而它对应的 blob——以及 CI 的检出——不是。这棵树里暴露在这个问题上的随包文件有两个：
`media/icon.svg` 和 `CHANGELOG.md`。v0.2.4 时两个在盘上都是 CRLF，所以打包出来是 363,966，
而 CI 读到 363,809，差了 157（同一对数字在 v0.2.2 是 331,709 / 331,706，在 v0.2.3 是
353,366 / 353,363）。把两个归档逐条目比一下会发现，**另外 12 个条目的 CRC32 和长度完全相同**，
不一样的正好是 `extension/changelog.md` 和 `extension/media/icon.svg`——第二个就是这么找出来的：
光看总字节数，没有任何线索告诉你动的是哪个文件。

v0.2.5 这个差值**是零**，而且是刻意的。这两个文件都用它们的索引 blob 重写过一遍
（`git cat-file blob :CHANGELOG.md` 取出来再 `writeFileSync`），所以工作树里放的就是 git 将来会
检出的同一批字节，这棵树本地打包 368,277，发出去也是 368,277。在 git 的 stat 缓存刷新之前，
`git status` 可能仍把它们标成已修改，但 `git diff --stat` 是空的，
`git cat-file blob :<路径> | tr -cd '\r' | wc -c` 读到 0——工作树内容确实就是那个 blob。要说明
的是 `git checkout-index` 做不到这件事：它服从 `core.eol`，而后者默认是 native，所以哪怕加上
`-c core.autocrlf=false checkout-index -f` 也照样写 CRLF。真正管用的是手工把 blob 字节导出——
不要再照抄旧的 `checkout-index` 配方。

所以当这里的数字和一个新克隆差了几个字节时，先看 `git status` 和行尾，再判断是不是树变了；而
记基线的时候，写清楚你量的是哪一种。v0.2.5 没有需要对账的地方：上面的 368,277 是在那两个暴露
文件已经归一成 LF 之后量的，本身就已经是干净读数。

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
#     方式 A —— gh CLI（首选）。本机已装但**不在 PATH 里**：
#     /c/Program Files/GitHub CLI/gh.exe，且已用 `gh auth login --web` 登录为
#     YichuAI（token 存 Windows 凭据管理器）。需要重新登录时走设备码：
#       printf '\n\n\n' | "/c/Program Files/GitHub CLI/gh.exe" auth login \
#         --hostname github.com --git-protocol ssh --web --scopes "repo,read:org"
#     它会打印一个一次性验证码，拿去 https://github.com/login/device 授权。
"/c/Program Files/GitHub CLI/gh.exe" release create v<版本> \
  harness-connector-deepseek-<版本>.vsix \
  --title "v<版本>" \
  --notes-file <notes.md> \
  --verify-tag
#     注意别用 `--notes-file CHANGELOG.md`：那会把**整份**变更日志贴上去。
#     先把对应的 `## [<版本>]` 段写进一个临时文件。

#     方式 B —— 用一个 scope 为 `repo`（公开仓库为 `public_repo`）的 classic PAT
#     打 REST API。`scripts/release.sh <PAT>` 就是干这个的（凭据自检、截取变更日志、
#     存在则复用否则新建、上传资产），优先用它而不是手写请求。
#     token 走环境变量或参数传入，绝不提交，Release 建好后立刻吊销。
./scripts/release.sh ghp_… YichuAI deepseek-harness-vscode v<版本> \
  harness-connector-deepseek-<版本>.vsix
```

Release 说明应为 `CHANGELOG.md` 中对应的 `## [<版本>]` 章节。**仅**附加 `.vsix` 作为二进制资产。

---

## 5. （可选）发布到注册表

### VS Code Marketplace

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

### Open VSX

Cursor、VSCodium 和 Windsurf 读的是 Open VSX 而不是微软 Marketplace，而只存在于其中一边的
扩展，对那几个编辑器来说等于不存在。自 0.2.1 起以同一个 `lucasliang` 命名空间发布。

```bash
# 本机 npmjs 走代理会拿到 502，所以每次 npx 都要带镜像源；换台机器就可以去掉。
REG=https://registry.npmmirror.com

# 命名空间必须先存在。首次 *发布* 会隐式创建它，但在那之前 `verify-pat` 和 `get`
# 都会以「Namespace not found」失败。
npx --registry=$REG ovsx create-namespace lucasliang

# 优先用环境变量：`--pat` 能用，但不在 --help 里，看着像不支持。token 是
# open-vsx.org → Settings → Access Tokens 里签的 `ovsxat_…` 串。
# 就地传入，绝不写进文件、也绝不进仓库 secret。
OVSX_PAT=<token> npx --registry=$REG ovsx publish harness-connector-deepseek-<版本>.vsix

# 确认它上去了。索引不是即时的——刚发布的版本会 404 一阵子，那个 404 是延迟，不是失败。
npx --registry=$REG ovsx get lucasliang.harness-connector-deepseek
```

**放到最后发，等产物不再变动之后。** 这是唯一一个「号一交出去就不再是你的」注册表。一个仍处于
*未激活* 状态的版本——对外不可见、取不到、公开 API 里也查不到——照样占着那个号：重发会被拒，
报 `… is already published, but currently isn't active and therefore not visible`；用发行者
token 打 `DELETE /api/-/publish/<ns>/<ext>/<ver>` 返回 `403`。（网页端可以删版本，token 不行。）
`0.2.2` 就是这么丢的——在 README 徽章修复之前先推了上去，从未激活，也删不掉——于是 Open VSX
继续服务 `0.2.1`，那个修复只能等下一个版本号。

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

## 8. CI

`.github/workflows/` 下有三个工作流：

| 工作流 | 触发条件 | 做什么 |
| --- | --- | --- |
| `ci.yml` | 每个分支的 push、每个 PR | 类型检查 · `check-versions` · `protocol-test` · 构建 · 打包 · 断言 VSIX 里恰好是那 14 个文件且不含源码 |
| `e2e.yml` | push 到 `main`、PR | 同样的门禁跑在 `ubuntu-latest`、`windows-latest`、`macos-latest` 上——协议测试要解析三种操作系统的监听表写法，光这一点就值回矩阵的成本——外加 `npm run e2e-test` |
| `release.yml` | 一个 `v*` 标签，或手动触发并指定一个已存在的标签 | `check-versions --release`（标签必须存在**且**指向 HEAD）· 测试 · 构建 · 打包 · 把版本号**从打出来的 VSIX 里读回来** · 算 sha256 · 以对应的 CHANGELOG 段落建 GitHub Release · 发布到 Marketplace |

`ci.yml` 需要 `fetch-depth: 0`：`check-versions` 要拿最新的可达标签做比对，而浅克隆里一个
标签都没有。

### 不用存任何密钥，把扩展发到 Marketplace

整个过程只碰发布者页面。不需要 Azure 订阅、不需要托管标识、不需要 Entra 应用注册、不需要 PAT。

1. 登录 `https://marketplace.visualstudio.com/manage/publishers/lucasliang`。
2. 打开该发布者的 **Trusted publishers**（受信任发布者 / 受信任发布）设置。
3. 添加一条策略，允许这个仓库和这个工作流：
   - 仓库：`YichuAI/deepseek-harness-vscode`
   - 工作流：`release.yml`
   - 环境（environment）：页面没强制要求就留空
4. 保存。

之后每次推标签，GitHub 会为 `marketplace.visualstudio.com` 这个受众签一个短期 OIDC 令牌；
`vsce` 拿它去 `POST /_apis/gallery/token?api-version=7.2-preview.1`
（`Authorization: FederatedToken …`）换一个约 15 分钟有效的会话凭证，用它代替 PAT。全程不落盘
任何长期凭据，也就没有可轮换、可泄漏的 secret。

交换失败时 `vsce` **不会**回退到 PAT，这个工作流也不会——选定的发布方式发不出去就让 job 失败。
2026-10-11 那次，这一步打印的是 `VSCE_PAT is not set — skipping`、退出码 0、GitHub 报 `success`，
所以「跳过了」和「发完了」从外面看长得一模一样。

`MARKETPLACE_PUBLISH` 是一个仓库**变量**（Settings → Secrets and variables → Actions →
Variables），不是 secret：

| 取值 | 行为 |
| --- | --- |
| 不设，或 `oidc` | 走受信任发布 |
| `pat` | 用 `VSCE_PAT` 发布，并打一条警告——Azure DevOps 全局 PAT 于 **2026-12-01** 退役 |
| `off` | 明确跳过，且看得见 |

为什么 CI 用 vsce 4 而不是仓库里钉住的开发依赖：`--oidc` 是 `@vscode/vsce@4.0.0` 才有的
（#1291），而且被刻意从 `--help` 里藏掉了（#1297）；本地那个 pin 留在 `3.9.2`，是为了让这次
改动不去改写一个**已经有 GitHub Release 在背后**的版本的随包 `package.json`。两个版本打出来的
VSIX 逐条目一致——文件清单、每个条目的 CRC 和长度都相同——所以这点版本偏差是惰性的。下次因为
别的原因要动随包文件时，顺手把它一起升掉。

### 给「策略配好之前就已发布」的版本补发

Actions → **Release** → *Run workflow* → 填 `tag: v0.2.1`。它会检出那个标签、重新构建、重新
校验每一个展示面，然后发布到 Marketplace，既不移动标签，也不会多建一个 Release。上传走的是
`--packagePath`，所以 Marketplace 上的字节、Release 附件里的字节和日志里印的 sha256 是同一个文件。

---

## 附录 — 版本策略

- `0.0.x`——协议仍在变动，因此功能以补丁形式发布；线缆在连接时协商，所以一个补丁可以
  放宽调用范围而不会弄坏旧 host（每个控件都由能力探测门控）。
- 涉及能力的改动应先对真实 host 跑 `npm run protocol-probe` 而不是对着上游源码推理：
  磁盘上的源码快照已多次与实际运行的版本不一致。
- **版本号在发布之前可以改切，发布之后不行。** `0.1.8` 以这个号被切出来，改切为 `0.2.0`，
  最终以 `0.1.9` 发布——一份改动，三个名字。标签 `v0.1.8` 指向 `806ce47`（那里
  `package.json` 写的就是 `0.1.8`），并且刻意不建 GitHub Release，因为那个名字下没有产物。
  重打标签只在这个号既没有 Release、也没有 Marketplace 发布记录时才是安全的；一旦用户能装到
  它，这个号就冻结了，后续修复只能发下一个版本。
- 发布说明本身就在 VSIX **里面**：`README.md`/`CHANGELOG.md` 经 vsce 以 `readme.md`/
  `changelog.md` 的形式随包，`*.zh-CN.md` 双胞胎原样随包。所以下面每一条基线都属于某一棵
  特定的树，事后再改一个随包文档，那个数字就作废了。重新量，不要把旧数字往下带。随包发出的
  字节数（也就是 `gh release view --json assets` 报出来的、用户真正下载的那个）：
  `v0.2.5` = 368,277（本地工作树同为 368,277）；
  `v0.2.4` = 363,809（本地工作树 363,966）；`v0.2.3` = 353,363（本地工作树 353,366）；
  `v0.2.2` = 331,706；
  `v0.2.1` = 313,426；`v0.2.0` = 312,853，树是 `581ba27`；
  `v0.1.9` = 309,620；`v0.1.7` = 288,750。
  v0.2.1 那个**本地**读数在准备那个版本的过程中动了三次——312,063、312,745、313,441——每一次都是
  因为包内某个文档在上次测量之后又被改了。中间那几次读数不是错的，它们量的是另一棵树。重新量，
  不要把数字往下带，更不要用眼睛估计。
  本地读数和发出去的附件总会差几个字节，原因永远是有个文件在本地测量时是 CRLF：v0.2.2 和
  v0.2.3 各差 3（331,709 / 353,366 对 331,706 / 353,363），v0.2.4 差 157（363,966 对
  363,809）——这几个都已经在第 2 步里查到根。v0.2.1 那 15 字节（313,441 对 313,426）从未
  查清，这里按原因的形状归到同一类，但不假装那个文件也被找到了。v0.2.0 和 v0.2.5 则完全一致，
  而 v0.2.5 的一致是刻意的：那两个暴露文件是在测量**之前**就归一成 LF 的，不是之后才解释的。
  `RELEASE.md` 在 `.vscodeignore` 的排除表里，所以改**这个**文件不会让上一段写下的那个数字
  发生变化。基线之所以能记在这里、然后继续在同一个文档里写字，唯一的原因就是这个；换成本文件
  之外的任何一个文件都不成立。

## 附录 — 本机 SSH 配置

历史上 Windows 用户名含非 ASCII 字符，而 `ssh` 会通过账户数据库按本地代码页解析 `HOME`，
于是去一个乱码路径下找密钥并静默失败（`Could not create directory '/c/Users/<乱码>'`）。
当时的绕开办法是把密钥放到纯 ASCII 路径，并让 git 显式指向它。

**这个绕法现在已经不在了，也不再需要。** 2026-10 起账户主目录是纯 ASCII（`C:\Users\PP`），
Git Bash 里 `HOME=/c/Users/PP`，`~/.ssh/id_ed25519` 直接就能以 YichuAI 身份通过认证。
**`/c/ssh/id_ed25519` 并不存在**——别照抄下面这段，照抄会把推送弄坏。

```bash
# 先自检——必须打印 "Hi YichuAI!"
ssh -T git@github.com

# 只有当乱码问题真的回来了才用：
mkdir -p /c/ssh
cp ~/.ssh/id_ed25519 /c/ssh/          # 密钥正常生成后再迁移
git config core.sshCommand \
  "ssh -i /c/ssh/id_ed25519 -o UserKnownHostsFile=/c/ssh/known_hosts -o StrictHostKeyChecking=accept-new"
git remote set-url origin git@github.com:YichuAI/deepseek-harness-vscode.git
git push origin main --tags
```
