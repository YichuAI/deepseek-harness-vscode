# DeepSeek Harness Connector for VS Code

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://img.shields.io/vs-marketplace/v/lucasliang.harness-connector-deepseek)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![安装量](https://img.shields.io/vs-marketplace/i/lucasliang.harness-connector-deepseek)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![最新版本](https://img.shields.io/github/v/release/YichuAI/deepseek-harness-vscode)](https://github.com/YichuAI/deepseek-harness-vscode/releases)
[![许可证](https://img.shields.io/github/license/YichuAI/deepseek-harness-vscode)](./LICENSE)

> DeepSeek Harness 的原生 VS Code 客户端。
>
> 连接你已在本地运行的 Harness 实例，直接在 VS Code 中继续相同的工作区和会话。

**同一个 Harness。同一个工作区。同一个会话。VS Code 客户端。**

这**不是** Cursor 的替代品，不是 Claude Code 的替代品，也不是完整的编码 Agent。它将 VS Code 连接到你已在运行的本地 `dsh web` 实例：

```
浏览器 ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘
```

VS Code 读取浏览器中已有的工作区和会话，并继续**同一个**会话——所以浏览器刷新该会话时能看到 VS Code 发送的内容。

## 它能做什么

- **接着你已经有的会话用。** 工作区与会话都是从运行中的 Host 读来的，不导入、不镜像、不分叉。
- **对话就在侧边栏里**，工具行、审批、提问、附件、改动卡片都画在产生它的那一段对话流里。
- **在 VS Code 里就能答审批与提问。** 两条瀑布都由插件结算，你不必为了解开一次运行而一直开着浏览器标签。
- **报告每个回合改了什么，并且能撤销。** 数据来自 Host 自己的回合记录——所以 shell 命令改掉的文件也包含在内，不只是文件工具报告过的那些。
- **凡是代码相关的，都交给 VS Code 自己的编辑器。** diff 就是真正的 diff 编辑器，路径点击就打开文件。不在 webview 里重新实现一套查看器。
- **自己找到 Host**，包括桌面端那种每次启动都换一个系统分配端口的 Host。
- **不替你启动任何进程。** 扩展不 spawn `dsh web`，只附着到你已经在跑的那个。

## 设计：写盘归 DSH，插件只观察与告知

DSH 的两个事实，几乎决定了这里其余一切的取舍。

**DSH 先把改动写进磁盘，下一步再把它读回来。** 这个先后顺序不是可以绕开的实现细节——每一步
都建立在它上面。文件工具报告自己的改动，紧接着的那一步打开的就是此刻磁盘上的那个文件。所以
那个看起来很诱人的做法——拦截写入、缓冲它、代理它、把它变成交给 VS Code 执行的
`WorkspaceEdit`——代价是打破步与步之间的一致性，换来一个表面更好看的审阅流程。而且它坏得很
晚、很偏：错误结果出现在好几步之后，中间看不出跟那次拦截有什么联系。本插件不拦截写入。
**DSH 是唯一的写盘者。**

**插件是观察者，不是守门人。** 等你看见一个改动时，它已经落盘了。这让「接受」变成了一个除了
暗示「此前一直在等它批准」之外什么也没做的按钮，所以它被删掉了。剩下的是报告：改了什么、
diff 在这儿、撤销在这儿。这跟两个人在同一个仓库里的关系是一样的——你保存文件不需要谁批准，
你看的是另一个人做了什么。

三个后果，全是有意为之：

- **在文件这一层，人和 AI 是对等的。** DSH 会写，你也会写，谁也不向谁请求确认。让你们不撞车
  的不是锁，而是两边都能看见 diff、两边都能撤销。插件要做的是把这份记录摆在对话流里、摆在
  产生它的那次调用旁边，而不是站在你们两个人中间。
- **没有回流机制，也不需要。** DSH 每一步都重新读盘，所以它手上永远不会是一份过期的副本——
  即使那个文件在你这边刚被改过。你想让 AI 知道你的改动，就在对话里说，或者让它读 git 记录。
  没有什么需要「推」给它的。
- **浏览器能展示的，VS Code 用原生方式展示。** 插件有东西要呈现时——一个 diff、一个 AI 指出
  的文件——它打开 VS Code 自己的编辑器，而不是在 webview 里重新实现一个查看器。webview 负责
  对话，编辑器负责代码。

被排除掉的东西，跟被包含的东西一样是设计的一部分。把 DSH 注册成 **Copilot 语言模型**，等于在
选择器里多一个条目，背后却换成别人的 agent 循环——没有工具调用、没有审批、没有上下文管理，
一个真正的产品该有的编排全没了。拿 harness 去换一个模型条目，是一笔亏本买卖。改走 **ACP**
而不用 web 传输，是同一种错的缩小版：`acp` profile 是一个自称 automation-only 的 stdio
JSON-RPC 服务，既不带 elicitation，也不带 DSH 的展示卡片——那会丢掉审批/提问瀑布和改动记录，
而这两样 HTTP+WS 传输本来就已经给到了。

## 凭据：这个扩展能读到什么

**装之前请先读这一节。** 「零配置连接」是有代价的，代价是一项真实的权限；它应该是被写明的
限制，而不是一个藏在连接说明底下的副作用。

`dsh web` 会把一个持久化签名密钥放在 `$DSH_HOME/.credentials.yaml`
（`client-connection/browser-session`）。浏览器会话 cookie 是对
`{version, authority, issuedAt, expiresAt}` 的 HMAC，密钥就是这个。cookie 本身不包含
launch token 的任何痕迹，而这个密钥只生成一次、之后每个 `dsh web` 进程复用。所以任何能读到
该文件的东西都能签出**字节级相同**的 cookie。扩展就是自己读它、自己签，这就是为什么没有需要
粘贴的东西。

**而那个文件里同时存着你的模型 API key。** 由此可以推出：

- 能读它，就**等价于**能完全控制这个 harness home。这不是提权，也没有绕过一道「防你自己」的
  边界——但它确实意味着扩展进程能看到与这个 VS Code 客户端毫无关系的密钥。
- 它确实绕过了那个每进程 launch token 闸门。那个闸门防的是**远程调用者**（DNS rebinding、
  CSRF），不是防已经以你的身份运行在本机上的代码。
- **任何凭据内容都不会进日志、不会发给 webview、不会出现在诊断报告里。** 日志只记录「发生过
  一次签发」，从不记录材料本身。cookie 存在 VS Code 的 secret storage（系统钥匙串）里，
  **不会**写进 `settings.json`。`DeepSeek Harness: Diagnostics` 导出的是一份脱敏报告，你可以
  先完整读一遍再决定发不发出去。
- 把 `deepseekHarness.autoSession` 设为 `false` 就完全拒绝自签。那是安全开关，不是便利开关：
  关掉之后扩展就是没有鉴权状态。

**这是一个权宜之计，我们更希望它没必要存在。** 官方路径是拿每个进程一次性生成的 launch token
去换——但那个 token **不落盘**，所以官方文档要求你手动从终端复制，而且每次 `dsh web` 重启都会
换一个。一个正式的本地客户端授权流程才是正解：一个 socket，或者一个 `0600` 权限、只对单个
客户端有效的一次性 token 文件，就能让编辑器连上来而完全不必把原始签名密钥交给它。在 Harness
提供这些之前，读那个文件是唯一能保住「零配置」的路径；而**被写明的限制，好过沉默的特权**。

## v0.2.1 新特性

**版本号再也没法各自跑偏，撤销也再没机会吃掉你的改动。**

- **每一个版本展示面现在是被检查的，而不是靠记性。** 同一个扩展曾经在四个地方显示四个不同的版本——Marketplace 列表、`package.json`、最新的 Release，以及 README 里一条还活着的旧 `v0.0.3` 标题。这些都不是代码缺陷，它们是各自手写的字符串，彼此从没被比对过。现在 `npm run check-versions` 会把所有这些面——包括文档里自称的断言条数——统一对着 `package.json` 比对，任何不一致直接让构建失败。README 的徽章换成了 shields 的实时端点而不是写死的数字，发布历史也从 README 搬进了 CHANGELOG——它本来就该在那儿。
- **凭据这件事搬到了 README 最前面。** 见上一节：扩展会读一个同时存着你 API key 的文件，这一点现在是明说的，而不是埋在连接步骤里的第 3 条。
- **回退会拒绝，而不是覆盖。** 撤销此前已经会检查盘上文件是否还等于 review 那一刻抓到的内容；它没做好的是**拒绝时有没有把话说清楚**。现在部分回退会报告它实际还原了几个文件，而那之后又被动过的文件会在卡片上被标为冲突并给出查看 diff 的入口，而不是弹一个转身就消失的提示。
- **新增 Diagnostics 命令。** 运行时版本、扩展版本、连接状态、协商出来的能力、最近一次错误，全在一份可以脱敏导出的文档里。

门禁：**342 项断言**（原 312）——新增的那些钉住了失败分类器、脱敏规则，以及「被拒绝的回退会留下原因」这件事。此外还有第一条真正跑起来的端到端链路：**15 项断言**驱动 `ReviewMaterializer` 对着一个真实的临时目录跑，其中就包含这个版本要处理的那种情况——文件在回合之后被改过，所以回退必须拒绝，而改动必须活下来。

完整差异见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)，更早的每一个版本也都在那里。

## 环境要求

- VS Code ≥ 1.85
- 正在运行的本地 `dsh web`（默认端口 `3080`）。本扩展**不会**为你启动它。

## 快速开始

1. 在本地启动 Harness：

   ```bash
   dsh web
   # → http://127.0.0.1:3080/?token=<43 位 token>
   ```

   较新的 Harness 会打印一个**带一次性 token 的启动 URL**。VS Code 不需要它——
   想同时开着网页端对照时，用它打开浏览器即可。

   更老的版本则完全不对 `/api/*` 做鉴权、不需要任何 token —— 插件会自行探测所连的是哪一种，
   所以如果没有出现启动 URL，这一步可以直接跳过。

2. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) 安装，或通过命令行：

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   或从 [GitHub Releases](https://github.com/YichuAI/deepseek-harness-vscode/releases) 安装 VSIX：

   ```bash
   code --install-extension harness-connector-deepseek-0.2.1.vsix
   ```

3. **不用配置任何东西。** 扩展会自动连接：它读取 `dsh web` 写在 `$DSH_HOME/.credentials.yaml` 里的浏览器会话签名密钥，自己签出同一个 `dsh-auth-…` cookie。**没有需要粘贴的 token。**

   读一下上面的[《凭据》](#凭据这个扩展能读到什么)一节，就知道这意味着什么。

4. 在 VS Code 中打开一个你想绑定到 Harness 工作区的文件夹。

5. DeepSeek Harness 活动栏图标出现；扩展自动连接。如果你的文件夹匹配到一个已有的 Harness 工作区，其会话会出现在下拉列表中。选择一个，继续对话。

6. **没有匹配的工作区？** 直接输入提示按 Send——工作区和会话会自动创建。

7. **用 `@` 引用文件** —— 在输入框里打一个 `@`，会弹出补全列表；选中即插入为引用（`@src/main.ts`）。也可以在资源管理器右键文件选 **Add to Harness Chat**，或在编辑器里选中文本后右键选 **Send Selection to Harness**（插入 `@src/main.ts:L10-L20`）。**不会把文件内容贴进消息里**：引用只是一个*指针*，宿主会提示 agent 自己去读该文件。这样无论文件多大，你的提示文本（以及它的 KV cache）都保持稳定。

8. 在浏览器中打开 `http://127.0.0.1:3080/` 的同一会话——两端看到的是同一轮对话。

> 没有"设置会话 token"这条命令。cookie 每次连接都从
> `$DSH_HOME/.credentials.yaml` 本地签发，没有任何需要粘贴的东西。粘贴启动 URL
> 的命令已经删掉，因为一个每次重启都变的 token，在本地自签可用之后只剩下维护成本。

### 本地签发跑不起来的时候

连接失败时扩展会直接在报错里点名它找过的文件，没有手动兜底——请把根因解决掉。

| 情况 | 怎么办 |
| --- | --- |
| `$DSH_HOME` 指向别处，且没设环境变量 | 给 VS Code 进程设置 `DSH_HOME`，或用默认 home 启动 `dsh web` |
| 这个 harness home 里从没跑过 `dsh web` | 跑一次——`client-connection/browser-session` 记录是那时才建立的 |
| 你把 `deepseekHarness.autoSession` 设成了 `false` | 改回 `true`：这个开关现在的含义是"拒绝自签"，而不是"弹个框让我手输 token" |

签出来的 cookie 之后有自己的生命周期：扩展把它存进 VS Code 的 secret storage
（系统钥匙串，**不会**写入 `settings.json`），`dsh web` 重启不会失效，只有在过期或你改了
`host`/`port` 时才重新签发（cookie 名是 `dsh-auth-<sha256(host:port)>`，绑定签发它的
authority）。

## 配置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | 仅允许 `127.0.0.1` 或 `localhost`。其他值会被拒绝。 |
| `deepseekHarness.port` | `3080` | 默认 `dsh web` 端口。如果你用 `dsh web --port <n>` 启动则需修改。 |
| `deepseekHarness.showSystemMessages` | `false` | 显示插件注入的系统消息（运行时上下文、审批通知）。默认隐藏；可通过 webview 头部的 `SYS` 按钮实时切换。 |
| `deepseekHarness.autoSession` | `true` | 从 `$DSH_HOME/.credentials.yaml` 本地签发浏览器会话 cookie。关掉它扩展就没有鉴权了——这是安全开关，不是便利开关。 |
| `deepseekHarness.autoApproveApprovals` | `false` | 自动用 `allowed-once` 回应所有审批请求。默认关闭——开启意味着工具调用不再逐次确认。 |
| `deepseekHarness.autoDiscover` | `true` | 配置的端口没人应答时，在回环地址上另找 dsh Host（先看各 profile patch 里钉的 `webserver.port`，再枚举系统监听表，用 Host 自己的拒绝文本确认）。桌面端需要它——桌面端用系统分配的端口启动 Host。发现的端口只在本次会话内使用，绝不写回设置。 |

## 命令

- `DeepSeek Harness: Connect` / `Reconnect` / `Disconnect`（连接 / 重连 / 断开）——**Reconnect**（同时也是面板标题的 ⟳ 按钮、以及状态行里常驻的那个按钮）会先拆掉当前连接再重新协商一次
- `DeepSeek Harness: Diagnostics`（诊断）——一份文档：运行时版本、本扩展的版本、连接状态、这台 Host 实际提供哪些能力、以及最近一次错误。带一个**复制脱敏报告**动作；其中不含任何凭据内容
- `DeepSeek Harness: Clear Session Token`（清除会话 token）——删除已存储的 cookie 并重连（会重新签一个；切换 `dsh web` 实例前用它）
- `DeepSeek Harness: New Session`（在当前工作区新建会话）
- `DeepSeek Harness: Refresh Sessions`（刷新会话列表）
- `DeepSeek Harness: Move to Right Side Bar`（移至右侧边栏）——将视图停靠在辅助侧边栏（像聊天面板一样），不再与文件浏览器争抢左侧空间。也可通过 webview 头部的 ⇲ 按钮触发。
- `DeepSeek Harness: Toggle Plan Mode`（切换计划模式）——翻转当前会话的 `/plan`
- `DeepSeek Harness: Set Permission Preset`（设置权限预设）——选择或输入预设名，如 `read-only` / `workspace-write` / `danger-full-access`
- `DeepSeek Harness: Compact Session Context`（压缩会话上下文）——请求 `/compact`
- `DeepSeek Harness: Fork Session`（分叉会话）——从当前会话分叉并切到新会话
- `DeepSeek Harness: Rename Session`（重命名会话）——固定标题（之后不再自动生成）
- `DeepSeek Harness: Archive Session`（归档会话）——从当前工作区列表归档
- `DeepSeek Harness: Attach File to Session`（附加文件到会话）——为下一条提示暂存本地图片/文件（图片走 `session/prompt` 内联部件；其它文件上传到 `POST /api/session/uploadFileBinary` 并按回执引用）。也可通过 📎 按钮、或直接往输入框粘贴/拖拽触发
- `DeepSeek Harness: Open Web UI`（打开 Web UI）
- `DeepSeek Harness: Show Logs`（显示日志，即 `DeepSeek Harness` 输出通道）

这六个控制项同时也在侧边栏的 **Controls（控制）** 面板里，面板还会显示 host
下发的状态：计划模式、沙箱模式、审批策略、agent 预设、当前生效模型、待办列表、
当前目标、子代理活动和最近一次压缩摘要。

**每个控制项都只在这台 host 真的提供它时才出现** —— 能力探测在连接时完成，
所以面对较旧的 `dsh web`，面板只会少显示几个旋钮，而不是给你点不动的按钮。

### 右键菜单操作

- **Add to Harness Chat**（资源管理器右键）—— 将 `@<相对路径>` 引用插入聊天输入框。
- **Send Selection to Harness**（编辑器右键，需选中文本）—— 插入 `@<相对路径>:L<起始行>-L<结束行>`。

两者插入的都是**引用**，不是文件内容。宿主的引用语法为 `@path`、`@"含空格的
path"`、`@dir/`，可带 `:L<n>` / `:L<n>-L<m>` 后缀；从 `@` 补全列表里选中一项同样
不附带任何内容——文件是 agent 自己去读的。

## 架构

见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) 了解一页式设计和协议契约。

## 协议固件

`test/fixtures/` 存放了线缆格式的脱敏快照，用于检测上游 Harness 协议漂移：

- `host-describe.json`、`workspace-list.json`、`session-list.json`、`session-history.json`、`session-prompt.json`、`session-event.json` —— **注意：** 这些是 0.1.6 之前的快照，仅作为历史漂移参考保留。`host-describe` / `session-history` / `workspace-list` 在上游已不存在。

不存储任何凭据、API 密钥或真实提示内容——仅保留 JSON 结构（文本字段已脱敏）。

## 协议测试

一个独立的 Node 脚本用真实客户端代码驱动一个**假**的 harness（假实现照 `0.2.1-alpha.2` 的服务端那一半写死）—— 不需要 `dsh web`：

```bash
npm run protocol-test    # 342 项断言：双流传输拆分（$events 白名单 vs
                         # session/follow）、线缆协商（点分/斜杠、cookie 门禁、
                         # 事件套接字）、认证、cookie 派生、{args} payload、
                         # 审批与提问两条瀑布（Allow/Deny 的确切信封、cancel 撤卡、
                         # next 委托）、assistant 流、已移除端点的 404 处理、
                         # 控制面能力探测与全量值状态折叠、经真实控制器的
                         # @ 补全状态契约、用可驱动 DOM 桩跑通的待答面板、
                         # 改动卡片的两条路由（普通带鉴权 GET、摘要已消失即
                         # 「没有卡片」）、hunk 到两侧的逐行对齐、虚拟 URI 的
                         # authority 契约、每回合一张卡的模型语义
```

协议测试**刻意不覆盖**整个产品。它钉的是线缆契约和模型，不是用户的一串动作。
上面那一层见[《端到端测试》](#端到端测试)。

想让**真实**的 `dsh web` 自己报出它提供了什么（端点风格、事件套接字，以及
30 个候选方法里哪些存在）：

```bash
npm run protocol-probe            # 默认 127.0.0.1:3080
npm run protocol-probe 127.0.0.1 3080
```

要对**真实** `dsh web` 做闭环验证，用集成测试（需先启动 `dsh web`——它会本地签 cookie，不用粘
token）：

```bash
npm run integration-test
# 桌面端也可以，但它用系统分配的端口启动 Host：
DSH_PORT=3081 npm run integration-test
```

## 端到端测试

协议断言很便宜，也很可靠——那个弄坏引用芯片的版本，协议断言是一条不落地全绿的。它看不见的是
**一串动作**：连接、重启 Host、重连；浏览器发消息、这边看见；允许、拒绝、超时。这一层是这个
项目现在要补的。

`test/e2e/` 就是这些链路的去处。**这张表是它的真实状态，而不是意图的路线图**——没写的链路会
明说，在这套测试自己的输出里说，也在下面说；因为一个悄悄少跑五分之四的测试套件，跟一个全绿的
套件看起来一模一样。

| # | 链路 | 状态 |
| --- | --- | --- |
| 1 | 连接与认证——Host 起来 → VS Code 连上 → Host 重启 → 自动恢复 | ⬜ 未编写——需要一个能在两次连接之间被杀掉再重启的 Host |
| 2 | 会话一致性——浏览器发消息 → VS Code 同步 → 切换 → 重载 → 历史一致 | ⬜ 未编写——需要真实的扩展宿主 |
| 3 | 流式输出——长回复 → 工具调用 → 断连 → 不重复、不丢失、不乱序 | ⬜ 未编写——需要一个能掐掉单条连接而不自尽的 Host |
| 4 | 审批交互——允许、拒绝、超时、Host 报错 → 卡片都进入正确终态 | ⬜ 未编写——需要真实的扩展宿主才能点得到 |
| 5 | 文件变更——agent 改文件 → 用户又改 → 撤销不得覆盖用户 | ✅ **15 项断言通过**，跑在真实文件系统上 |

第 5 条是「有风险」而不是「有 bug」的那一条，也是唯一一条不需要扩展宿主就能被如实测到的：
`ReviewMaterializer` 把工作区 API 当构造参数收，所以它能对着一个 `fs` 就是**真实**文件系统的
桩、在一个真实的临时目录上跑。模拟一套文件系统，只会让测试去附和实现，而不是抓住它。它覆盖了
普通回退、清单上的那种情况（文件在回合之后被改过 → 回退拒绝 → 你的字节活下来）、编辑器有未保存
改动、新建文件被删除、新建文件被编辑过、以及被工具删掉的文件被还原。

`npm run e2e-test` 会报出 `1 of 5 chains covered, 4 not written`，并且只在「跑到且失败」时才
返回非零。三平台矩阵（`ubuntu-latest`、`windows-latest`、`macos-latest`）已接进
`.github/workflows/e2e.yml`，而且它现在就已经值回票价：协议测试要解析三种不同的系统监听表
写法，只有在三个平台上跑，那些解析器才会遇到它们真正的目标。

## 开发

```bash
npm install
npm run build            # esbuild → dist/extension.js
npm run watch            # 变更时自动重建
npm run typecheck
npm run check-versions   # 每一个版本展示面都必须和 package.json 一致
npm run protocol-test    # 针对假 harness 的 342 项协议断言
npm run protocol-probe   # 报告真实 dsh web 暴露了什么
npm run package          # → harness-connector-deepseek-0.2.1.vsix
```

在 VS Code 中按 `F5` 启动带有该扩展的扩展开发宿主。

有两条习惯现在是仓库强制的，而不是靠自觉：

- **`package.json` 是唯一手写版本号的地方。** 其余每一处——README 的「新特性」标题、安装命令里的
  VSIX 文件名、CHANGELOG 的第一条、发布基线、文档里自称的断言条数——都由 `npm run check-versions`
  对着它比对。新增一个会提到版本的展示面，就顺手加一条检查；不要新增一个数字然后指望它别忘。
- **发布历史写进 CHANGELOG。** README 描述的是产品的当前状态，只保留一个版本的说明。

## 已验证版本

- 默认 `dsh web` 端口 `3080`，且 host 必须位于回环地址。
- **线缆是协商出来的，不是猜出来的。** 端点风格（`session/list` 还是 `session.list`）、
  是否需要 cookie、事件套接字在 0.2.0-rc.2 上是 `/api/remote.mux`、旧版上是 `/api/events.mux`——都在连接时
  自动探测，同一个构建因此能跨 host 版本工作。跑 `npm run protocol-probe` 可以看到
  你的 host 到底提供了什么。
- **对话流量不在事件套接字上。** 在 `0.2.1-alpha.2` 上，那条复用套接字承载着**两条**词表不同的
  逻辑流：`$events`（一份固定的转发白名单——会话状态、审批、插件清单）与 `session/follow`
  （一条会话的记录与实时 assistant 增量）。按「所有东西都从 `$events` 来」写，正是早期某版连上之后
  就彻底沉默的原因。两条流分开打开，形状钉在 `scripts/protocol-test.ts` 里。
- **不知道 Host 在哪也能把它找出来。** 对 dsh Host 发起匿名请求，会被 connection carrier
  用一句固定的话拒绝（`dsh web authentication required; reopen the URL printed by dsh web.`），
  本机没有第二个服务会这么说——所以它同时也是一个身份判据。`deepseekHarness.autoDiscover`
  用的就是它，在这之前先读各 profile 用户 patch 层里钉过的 `webserver.port`。本机实测：
  探测 46 个 loopback 监听，命中 1 个 Host，并归因到 `desktop` profile 里钉的端口。
- **一次状态推送很贵，所以推送次数和"真的有变化"的次数一样多。** webview 收到一次被接受
  的推送，就会把 `#messages` 拆掉、逐条重建，所以凡是要发布的东西都必须真的有东西可发布。
  在一条 72 条记录的会话上实测：一个审批/提问事件过去要花 2 次推送、约 70 KB、2 次完整重建，
  现在 1 次推送、0 次重建。检查器的事件环形缓冲区（最多约 600 KB 的截断帧）只在那个面板
  在屏幕上时才发布，同一会话下单次推送因此从 1,318,580 字节降到 35,399 字节。这些数字是被
  断言住的，不是自称的——见 `scripts/protocol-test.ts` 第 I 组。

## 限制

- 仅限回环——不支持远程 / 局域网 / WSL 桥接的主机。
- **扩展能读到一个存着你 API key 的文件。** 要签会话 cookie 就必须读它。见[《凭据》](#凭据这个扩展能读到什么)。
- **图片能不能用取决于模型。** 模型是否吃图并不在 `session/modelCatalog` 里发布，插件只能把宿主的裁决透传：不吃图的模型会让 prompt 失败并返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`，面板会提示你去 Controls 换模型。已暂存的附件会**保留**，方便重试。
- **暂存文件绑定进程。** 上传回执同时绑定会话**和**正在运行的 `dsh web` 进程，宿主重启后必须重新选文件。
- 历史记录加载最近约 50 条消息；"加载更早"是未来版本的计划。
- "Open Web UI" 中的会话深链接不做猜测——只打开 Harness 首页。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；它们不会导致客户端崩溃，但也不会渲染。
- **一次回退是把抓到的 `before` 文本写回去——不走 `git checkout`。** 写之前它会检查盘上的文件是否仍等于 review 建立时抓到的 `after`，以及是否有编辑器带着未保存的改动。两者只要有一个变过，回退就会被拒绝并把该文件标为冲突，而不是覆盖。正是这道闸让「不用问就能撤销」这件事是安全的，也是它能说「不」的原因。
- **回合的改动卡片列出的是这个回合改了哪些文件，但其中只有文件工具自己的改动能从中撤销。** 撤销范围限定在该回合产出的 review 内，因为 Host 的摘要只带路径与行数，不带还原所需的文本。某个回合若只通过 shell 命令改了文件，它会直说。
- 改动摘要在宿主上只活到 Session 结束，所以宿主重启后卡片可能解析为「没有改动可显示」。这会渲染成没有卡片，与 Web UI 一致。

## 路线图（v0.2.2+）

- **上面那五条端到端链路，做实。** 真实的扩展宿主、一个能在回合进行中被杀掉再重启的假 Host，以及
  Windows / macOS / Linux 三平台矩阵。第 5 条尤其如此——agent 改完、**你**又改、然后撤销——需要
  的是端到端的形状，而不只是单元层的守卫。
- **部分回退——hunk 级。** materializer 其实已经会回退单个 hunk（并且会在文件漂移时拒绝），但现在没有任何 UI 能触达它：今天的回退是每文件全有或全无。要恢复它，意味着在改动卡片和原生 diff 里提供逐 hunk 撤销，数据来自 Host 本来就提供的 hunk 列表，而不是它并不保留的整份文件文本。
- 按条目下发状态增量：流式推送目前仍整份发送对话流（40 轮会话约 52 KB/次）。渲染端已不再重建它，但跨 `postMessage` 的结构化克隆仍是每个分块剩下的代价。
- 检查器：过滤框 / 类型高亮 / 导出 JSONL
- 搜索：限定工作区、分页、命中高亮
- 内联补全（Inline Completion）
- VS Code 文件系统提供器
- 终端集成
- LSP / ACP 集成

## 许可证

MIT
