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
npm run protocol-test      # → 全部 523 项断言 ✓

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
      211 → 231 → 243 → 268 → 295 → 312 → 342 → 381 → 461 → 493 → 504 → 512 → 523，其中 rc.2 重写用新假
      harness 替换了 rc.6 的那套，waterfall／待处理面板两组随之落地，v0.2.2 又加上了
      会话模式词表、分平台安装路线和启动器的两个纯函数，v0.2.3 再加上了逐 hunk 手术、
      那九条右键提问和回环围栏，v0.2.4 再加上了 waterfall 的归属规则、启动计划
      和远程安装路由，v0.2.5 只动了随包文档、没有新增断言，v0.2.6 加上了 Open Web UI 的
      决策函数以及它据以分支的那几段文案，v0.2.7 又把这个函数的输入换成了模式本身
      ——它原来据以分支的那个布尔值分不开 `paste` 和 `managed`——并补上了钉住这个区别的
      八条断言；此处数字过期是最常见的文档漂移——
      **而自 v0.2.1 起，`check-versions` 会直接让构建失败，不再靠这一行靠人记**）。
- [ ] `README.md` 最新的「新特性」标题就是这个版本，而且 README 只保留**一个**版本的
      说明。历史写进 CHANGELOG。
- [ ] README 上的徽章仍然是**推导出来的、不是手写的**，而且被检查的那些真的能画出来。
      `check-versions --online` 会把它们逐个抓下来，读 SVG 自己声明的 label——因为一个 URL
      字符串对得上、画出来却是 `404 badge not found` 的徽章，正是那一节存在的理由。
      有一处是**有意不查**的：两个 `open-vsx` 徽章留在 README 里，但**不在**那份名单里。
      shields 的 Open VSX 上游会抖——同一个 URL、一个已发布且可下载的扩展，几分钟内先答
      `200 open vsx: v0.2.5`、再答 `200 404: badge not found`——而一个会随机变红的发版门禁
      比没有门禁更糟。这两个用眼睛确认。
- [ ] 首屏那四个**身份徽章**（`dsh …`、`setup …`、`ui …`、`VS Code …`）是两份 README 里
      仅存的手写数字，而且是**刻意手写**的：没有任何端点能提供「这个构建针对的 Remote 契约」。
      等 `ARCHITECTURE.md` 里的契约目标变了再动它们，别提前动。顺带记一句：门禁的标题检查
      现在同时接受 `#` 标题和 `<h1>`，因为 README 已经不再以标题开头了。
- [ ] 仓库元数据仍然描述这个项目——别人正是靠它找到仓库的，所以它属于发版的一部分，
      不是装饰：

      `gh repo view YichuAI/deepseek-harness-vscode --json description,homepageUrl,repositoryTopics`

      homepage 指向 Marketplace 页面；topics 装的是人们真正会搜的词（`dsh`、
      `deepseek-harness`、`vscode-extension`、`ai-coding-assistant` 等）。用
      `gh repo edit --add-topic <t> --homepage <url>` 设置。
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

预期（v0.2.8 = 14 个文件，干净检出 380,195 字节，约 371 KB）：

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
而 CI 读到 363,809，差了 157（同一对数字在 v0.2.2 是 331,709 / 331,706）。把两个归档逐条目
比一下会发现，**另外 12 个条目的 CRC32 和长度完全相同**，不一样的正好是
`extension/changelog.md` 和 `extension/media/icon.svg`——第二个就是这么找出来的：光看总字节数，
没有任何线索告诉你动的是哪个文件。

v0.2.5 这个差值**是零**，而且是刻意的，之后每个版本也让它继续为零——但只是靠每次手工检查。
v0.2.8 是这件事不再够用的那一次：`package.json` 是十四个条目之一，它从来没被归一过，而在 Windows
检出上它带着 383 个 CRLF 字节，Linux runner 的检出没有。这棵树本地打包 **380,213**，CI 产出
**380,195**——差 18 字节，也就是 383 个回车被 zip 压缩之后的体积。

修法是 `.gitattributes`（`*.md text eol=lf`、`package.json text eol=lf`）：问题从「这台机器的工作树
长什么样」变成「blob 里是什么」。把 `package.json` 的 CR 去掉之后，这棵树打包正好 **380,195**，
与 Release 附件一致。基线数字按定义都是干净检出数字；v0.2.6 与 v0.2.7 是手工对齐的，从 v0.2.8 起是
结构上对齐的。在 git 的 stat 缓存刷新之前，
`git status` 可能仍把它们标成已修改，但 `git diff --stat` 是空的，
`git cat-file blob :<路径> | tr -cd '\r' | wc -c` 读到 0——工作树内容确实就是那个 blob。要说明
的是 `git checkout-index` 做不到这件事：它服从 `core.eol`，而后者默认是 native，所以哪怕加上
`-c core.autocrlf=false checkout-index -f` 也照样写 CRLF。**`git archive` 出于同一个原因也一样**
——本机实测 `git archive v0.2.3` 导出的 `CHANGELOG.md` 带着 1,581 个 CR 字节，所以除非把过滤
关掉，归档也不算干净检出。

想在一台机器上量一个历史 tag，就用关掉过滤的方式导出，在那里面打包。`vsce` 在没有
`node_modules` 的目录里仍然跑不起来，所以给它指一个——Windows 上建个目录联接就够，
`--no-dependencies` 也不会去遍历它：

```bash
mkdir -p /c/tmp/vclean
git -c core.autocrlf=false archive <tag> | tar -x -C /c/tmp/vclean   # LF，与裸 archive 不同
cd /c/tmp/vclean
# Windows：先把 node_modules 做成指向真实目录的联接
#   New-Item -ItemType Junction -Path .\node_modules -Target <仓库>\node_modules
node <仓库>/node_modules/@vscode/vsce/vsce package --no-dependencies  # → CI 会读到的数字
```

`v0.2.3` 的 353,363 就是这么事后确认的，也正是这条路查出了「它曾被发布过」这个说法是错的。

所以当这里的数字和一个新克隆差了几个字节时，先看 `git status` 和行尾，再判断是不是树变了；而
记基线的时候，写清楚你量的是哪一种。从 v0.2.8 起只有一种：随包的文本文件由 `.gitattributes` 钉在
LF，Windows 检出和 Linux 检出打出来的字节相同。上面那些更早的数字按原样留着，因为它们是钉住之前
量的。

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
扩展，对那几个编辑器来说等于不存在。自 0.2.1 起以同一个 `lucasliang` 命名空间发布；
截至 2026-10-15 对外服务的是 `0.2.7`（已发布：0.2.1、0.2.2、0.2.5、0.2.6、0.2.7）。版本号请从
`/api/<ns>/<ext>` 读——2026-10-15 那天主端点正常服务 0.2.7，而它旁边的 `/allVersions` 却答
`404`，所以那个 404 是端点自己在抖，不是发布失败。

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
继续服务 `0.2.1`，那个修复只能等下一个版本号。`0.2.5` 于 2026-10-14 在这里发布，一路顺畅，
因为它那时已经有一个 GitHub Release 撑在背后、产物不再变动了。`0.2.6` 走的是同一条路，在它的
Release 建出来几分钟后发出，重新下载回来核对，十四个条目全部一致。`0.2.7` 于 2026-10-15 又走
了一遍：Release 之后发布，约两分钟后被索引，376,628 字节，十四个条目全部一致。

这条路有两件事是别的路不需要的：

- **PAT 哪里都不存。** 仓库 secrets 是空的，它也从来没被写进任何文件——就地传入、用完即忘，
  这正是设计意图。它确实会留在这台机的本地会话记录里（`~/.workbuddy/projects/`，搜 `ovsxat_`），
  所以之后再发时可以从那儿找回来；机器上再没有别的地方有它。请把这当成「所以要一直签短期
  token」的理由，而不是一个可以主动往里写 token 的地方。
- **绕开代理。** 这台机把 `http_proxy`/`https_proxy` 设成了 `127.0.0.1:13067`，open-vsx.org
  走不通——和这里 `curl` 必须加 `--noproxy '*'` 是同一个原因。`verify-pat` 和 `publish` 之前
  把大小写两组都 unset；`npx` 取 `ovsx` 本身不受影响，仍然要带 npmmirror 镜像源。

要确认发布真的落地，拿下载回来的 VSIX 和本地的**逐条目比 CRC 和长度**——整包 `sha256`
即使包完全相同也会不一样，因为 zip 条目带时间戳。0.2.5 的 14 个条目全部一致。

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
VSIX 逐条目一致——文件清单、每个条目的 CRC 和长度都相同——所以这点版本偏差是惰性的。原本的打算是
「下次因为别的原因要动随包文件时顺手升掉」——**那个版本正是 v0.2.7，而它仍然没升**：改行为的
版本和换打包器的版本不该是同一个，况且发布真正依赖的那个钉法本来就在 `release.yml` 里。留给
下一个除了升级本身没有别的理由存在的版本。

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
- `0.2.3` 是另一个「有 tag、没 Release」的号，但原因不同——它不是被撤下的，是压根没发出去过。
  它已 commit（`200e708`）、已打注解标签、也打了包，但第二天落地的那三处修复走的是 `0.2.4`
  而不是并回来，标签也从未推远端。它在带 CRLF 的工作树里量到 353,366，从干净 LF 导出量到
  **353,363**；两个都不是下载数，因为没人能下载它。检查只需要一条命令，而且在把任何版本号写进
  「已发布」清单之前都值得先跑：`git ls-remote --tags origin`。远端没有这个 tag，就没有对应的
  Release，CHANGELOG 怎么写都不算数——CHANGELOG 条目描述的是一棵树，不是一次发布。
- 发布说明本身就在 VSIX **里面**：`README.md`/`CHANGELOG.md` 经 vsce 以 `readme.md`/
  `changelog.md` 的形式随包，`*.zh-CN.md` 双胞胎原样随包。所以下面每一条基线都属于某一棵
  特定的树，事后再改一个随包文档，那个数字就作废了。重新量，不要把旧数字往下带。随包发出的
  字节数（也就是 `gh release view --json assets` 报出来的、用户真正下载的那个）：
  `v0.2.8` = 380,195（`.gitattributes` 让它与机器无关）；
  `v0.2.7` = 376,628；
  `v0.2.6` = 372,811；
  `v0.2.5` = 368,277（本地工作树同为 368,277）；
  `v0.2.4` = 363,809（本地工作树 363,966）；
  `v0.2.2` = 331,706；
  `v0.2.1` = 313,426；`v0.2.0` = 312,853，树是 `581ba27`；
  `v0.1.9` = 309,620；`v0.1.7` = 288,750。
  （`v0.2.3` 是刻意不在里面的——它有 tag、有 CHANGELOG 段、有包，但没有 Release，
  所以它一个字节都没被人下载过。见上面的版本策略条目。）
  v0.2.1 那个**本地**读数在准备那个版本的过程中动了三次——312,063、312,745、313,441——每一次都是
  因为包内某个文档在上次测量之后又被改了。中间那几次读数不是错的，它们量的是另一棵树。重新量，
  不要把数字往下带，更不要用眼睛估计。
  本地读数和发出去的附件总会差几个字节，原因永远是有个文件在本地测量时是 CRLF：v0.2.2 差 3
  （331,709 对 331,706），v0.2.4 差 157（363,966 对 363,809）——这两个都已经在第 2 步里查到根。
  v0.2.1 那 15 字节（313,441 对 313,426）从未查清，这里按原因的形状归到同一类，但不假装那个文件
  也被找到了。v0.2.0、v0.2.5、v0.2.6 和 v0.2.7 则完全一致：v0.2.5 的一致是刻意的，那两个暴露文件是在测量
  **之前**就归一成 LF 的，不是之后才解释的；v0.2.6 与 v0.2.7 则干脆没有暴露文件，打包时十四个条目在盘上
  全是 LF。v0.2.3 和 v0.2.2 一样差 3（本地 353,366 对干净
  353,363），但它两栏都不属于——它从未发布，见上面的版本策略条目。
  `RELEASE.md` 在 `.vscodeignore` 的排除表里，所以改**这个**文件不会让上一段写下的那个数字
  发生变化。基线之所以能记在这里、然后继续在同一个文档里写字，唯一的原因就是这个；换成本文件
  之外的任何一个文件都不成立。

## 附录 — 依赖基线

2026-10-14 用 `npm outdated --registry=https://registry.npmmirror.com` 盘点。registry 必须写明：
公司代理把 `registry.npmjs.org` 整个挡掉了，而镜像也没有实现 `npm audit` 的端点
（`NOT_IMPLEMENTED /-/npm/v1/security/*`），所以这个仓库**没有漏洞扫描**——没有就是没有，别写得
像跑过一样。

**运行时依赖只有一个，而且是最新的。** `dependencies` 里只有 `yaml`，版本 `2.9.1`，就是官方最新。
它不是以包的形式随包发出的：`esbuild.mjs` 里 `bundle: true`、`external: ['vscode']`，所以 `yaml`
被内联进了 `dist/extension.js`。动手之前先知道这件事：**升 `yaml` 会改变用户下载到的字节**，
因此它和任何随包改动一样，要搭一个版本号。

**纯开发依赖，完全不进 VSIX**（`scripts/**` 与 `test/**` 都在 `.vscodeignore` 的排除表里，
`--no-dependencies` 也不会去走 `node_modules`）：`tsx`、`typescript`、`@vscode/vsce`、
`markdown-it`、`@types/markdown-it`、`sharp`、`potrace`、`@types/potrace`、`@types/node`、
`@types/vscode`。其中有两个不算完全免费：

- `esbuild` 产出的是 `dist/extension.js`，那个是随包的。升它可能改变压缩结果，进而改变产物字节，
  尽管这个依赖本身从不进包。
- `sharp` 和 `potrace` 生成 `media/icon.png` / `media/icon.svg`，那两个也随包——但它们已经提交在
  仓库里了，所以只有重新生成图标时升它们才有影响。

**真正让其余更新变便宜的那条规则：**改 `package.json` 里的版本**字符串**就是对随包文件的改动，
必须搭版本号；只动 `package-lock.json`、范围字符串原样不动的升级，一个字节都不会改变 VSIX。所以
范围内的更新、只要不是构建输入，随时可以拿；其余的等一个版本。

| 包 | 声明 | 实装 | 最新 | 为什么停在这里 |
| --- | --- | --- | --- | --- |
| `yaml` | `^2.9.1` | 2.9.1 | 2.9.1 | 运行时，被内联。**已最新。** |
| `potrace` | `^2.1.8` | 2.1.8 | 2.1.8 | 生成图标用。**已最新。** |
| `@types/potrace` | `^2.1.5` | 2.1.5 | 2.1.5 | **已最新。** |
| `markdown-it` | `^15.0.0` | 15.0.0 | 15.0.2 | 只作测试夹具；随包的 `media/markdown-it.umd.min.js` 是提交进仓库的成品，不是这里构建的。可只动 lockfile。 |
| `sharp` | `^0.35.3` | 0.35.3 | 0.35.5 | 同上。 |
| `tsx` | `^4.19.0` | 4.23.12 | 4.23.15 | 测试运行器。可只动 lockfile。 |
| `@types/markdown-it` | `^14.1.2` | 14.1.2 | 14.2.0 | 类型。可只动 lockfile。 |
| `@vscode/vsce` | `^3.2.0` | 3.9.2 | 4.0.0 | 刻意钉住。`4.0.0` 根本做不了 OIDC，而 `latest` 正指着它；能用的那个在 `next` 这个 dist-tag 上。**打包**留 `3.9.2`，**发布**用 `npx` 拿 `4.0.1-3`。见 Marketplace 一节。 |
| `@types/node` | `^20.11.0` | 20.19.43 | 26.6.5 | 刻意留在 Node 20 线上：扩展宿主是 Node 18/20/22，`esbuild` 的 target 是 `node18`。类型比运行时新，教给你的是一堆运行时不存在的全局对象。 |
| `esbuild` | `^0.24.0` | 0.24.2 | 0.28.2 | 构建输入——见上。搭版本号。 |
| `typescript` | `^5.4.0` | 5.9.3 | 7.0.2 | TS 7 是原生重写，那是一次迁移，不是一次升级。 |
| `@types/vscode` | `^1.85.0` | **1.125.0** | 1.140.0 | 唯一真正的缺口，见下。 |

### `@types/vscode` 能跑到 `engines.vscode` 前面

`engines.vscode` 承诺的是 `^1.85.0`，README 里重复了三次。但 `"@types/vscode": "^1.85.0"` 是一个
覆盖所有 `1.x` 的 caret 范围，于是 `npm` 装的是最新那个次版本——这里是 `1.125.0`，还能到 `1.140.0`。
这个错配是 VS Code 扩展的常态（官方生成器写的就是这个范围），代价是：编译器会欣然接受一个
1.110 才加的 API，而清单上仍写着 1.85——类型检查过、发得出去、然后在别人老一点的 VS Code 上抛
`undefined is not a function`。

**今天这个承诺是成立的，而且是量出来的、不是推出来的。** `src/` 对着 1.85 的类型是干净的——
40 个文件全过，`tsc` 退出码 0：

```bash
mkdir -p /c/tmp/vsc85 && cd /c/tmp/vsc85
npm pack @types/vscode@1.85.0 --registry=https://registry.npmmirror.com && tar xzf types-vscode-1.85.0.tgz
# 写一份把 "vscode" 映射到 C:/tmp/vsc85/vscode/index.d.ts 的 tsconfig，然后：
node node_modules/typescript/bin/tsc -p /c/tmp/vsc85/tsconfig.json   # 退出码 0；--listFiles 里出现的是 1.85 那份、不是 node_modules
```

这个检查**必须**覆盖模块解析才值钱；把 `paths` 指向旧的 `index.d.ts` 才是真正的测试，而
`--listFiles` 是证明映射真的生效、而不是你以为它生效的唯一办法。要回答「≥ 1.85 还算不算数」，
没有更快的路。

**这个缺口是面向未来的，而且修它需要一个版本号。** 把范围钉死——`"1.85.0"` 或 `"~1.85.0"`——
让类型再也跑不到下限之上，或者把两者一起抬上去。无论哪种都改 `package.json`，那是随包文件，
所以要等下一个版本。另外，**别**加一条只比较两个范围字符串的门禁断言：它会在**正确**的那种写法
（`~1.85.0` 对 `^1.85.0`）上变红，在错的那一种上放行。

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
