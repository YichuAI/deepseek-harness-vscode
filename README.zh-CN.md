# DeepSeek Harness Connector for VS Code

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/lucasliang.harness-connector-deepseek)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![安装量](https://badgen.net/vs-marketplace/i/lucasliang.harness-connector-deepseek)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![最新版本](https://img.shields.io/github/v/release/YichuAI/deepseek-harness-vscode)](https://github.com/YichuAI/deepseek-harness-vscode/releases)
[![许可证](https://img.shields.io/github/license/YichuAI/deepseek-harness-vscode)](./LICENSE)

> DeepSeek Harness 的原生 VS Code 客户端。
>
> 连接你已在本地运行的 Harness 实例，直接在 VS Code 中继续相同的工作区和会话。

**同一个 Harness。同一个工作区。同一个会话。VS Code 客户端。**

![浏览器 Web UI 与 VS Code 面板显示同一个会话的同一个回合](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/01-shared-session.png)

*同一个会话，两个窗口。左边浏览器，右边 VS Code——没有导入，没有镜像，没有分叉。*

## 它能做什么

- **接着你已经有的会话用。** 工作区与会话都从运行中的 Host 读来。在浏览器里刷新同一个会话，看到的就是 VS Code 刚发出去的内容。
- **在 VS Code 里就能答审批与提问。** 两条瀑布都由插件结算，你不必为了解开一次运行而一直开着浏览器标签。
- **报告每个回合改了什么，并且能撤销——还能一个 hunk 一个 hunk 地撤。** 数据来自 Host 自己的回合记录——所以 shell 命令改掉的文件也包含在内，不只是文件工具报告过的那些。卡片里每个 hunk 各带一个撤销按钮，文件级按钮撤掉剩下的全部。两者都会先比对文件当前内容，对不上就拒绝，而不是覆盖你的改动。
- **右键就能问。** 选中一段代码、在资源管理器里右键一个文件、或者在 diff 编辑器里右键一处改动，右键菜单就会给出 *解释 / 修复 / 审查*——连提示词和正确的 `@` 引用一起填好，选区还会带上行号范围。
- **凡是代码相关的，都交给 VS Code 自己的编辑器。** diff 就是真正的 diff 编辑器，路径点击就打开文件。不在 webview 里重新实现一套查看器。
- **自己找到 Host**，包括桌面端那种每次启动都换一个系统分配端口的 Host。
- **三条取会话的路，由你挑。** 从 harness 自己的凭据库里签发（零配置，但意味着要读一个同时装着你的 API key 的文件）、由扩展自己启动 `dsh web` 并读走它打印的启动 URL、或者你自己粘一个启动 URL。见[会话是怎么拿到的](#会话是怎么拿到的)。
- **你不要求，它就不启动任何进程。** 默认行为仍然是附着到你已经在跑的那个 Host。

## 它怎么连

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

## 截图

| | |
| --- | --- |
| ![VS Code 侧边栏里的对话](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/03-editor-sidebar.png) | ![agent 改动过的文件在 VS Code 原生 diff 里](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/04-native-diff.png) |

*左：对话就在侧边栏里，工具行和改动卡片都在。右：「Diff」打开的是 VS Code 自己的 diff 编辑器，不是 webview 仿的。*

![Harness 浏览器界面本身](https://raw.githubusercontent.com/YichuAI/deepseek-harness-vscode/main/docs/screenshots/02-browser-web-ui.png)

## v0.2.3 新特性

**上一版留在桌上的两件事：撤销一处改动的*一部分*，以及对远程工作区给一个诚实的回答。**

- **逐 hunk 撤销。** 改动卡片现在会把一个文件里的每个 hunk 列出来，各自带一个 ↩，旁边是这个 hunk 的预览行和它自己的 `+`/`−` 计数。文件级按钮保留，作用是撤掉剩下的全部——所以「三个 hunk 撤掉两个、第三个算了」是两次点击，而不是一个你必须事先做好的决定。Host 一直都提供 hunk 列表；缺的是从卡片到 materializer 的一条线，以及 materializer 自己的整文件守卫——它会把第一个之后的每个 hunk 都判为失效。两处都修了，而且守卫现在是**从 diff 推出来的**：期望内容是「当前文件减去你已经撤掉的那些 hunk」，所以第二次撤销能成，而在中间真做过一次编辑仍然不成。
- **右键选中的代码、文件或改动，就能问它。** 三个子菜单——编辑器、资源管理器、源代码管理行上各一个——对右击的那个东西给出**解释 / 修复 / 审查**。它插入一段提示词加上对应的 `@` 引用，有选区时带上行号范围；你的文件内容一个字都不会外流。diff 编辑器是最有意思的一格：「这处改动」解析到文件的工作区一侧，而不是碰巧聚焦的那个窗格。
- **对一个没抓到任何文本的 review 点撤销，过去会删掉那个文件。** 只从工具调用参数建立起来的 review，既没有 `before` 也没有 `after`；撤销逻辑于是走进了「这是新建文件」的分支，把路径删了。现在它会以 `no-diff` 拒绝，并说明缺了什么。这是写逐 hunk 测试时发现的，不是用户报的——这也正是发现它的唯一好方式。
- **远程开发从一个一句话的拒绝，变成了一份写下来的回答。** README 里有了本地 / Remote-SSH / WSL / 容器四格的矩阵，扩展显式声明 `extensionKind: "workspace"`，回环围栏搬进了一个独立模块——它同时负责 URL 和 cookie authority 的拼装，也因此暴露出 `::1` 一直被围栏接受、却在围栏之外无法使用。非回环 host 现在也是一种一等诊断：面板会告诉你它接受哪三个值，并且对远程用户说清该动哪一头。

门禁：**461 项断言**（原 381），端到端链路从 **15 条到 91 条**。第 1 条和第 4 条——v0.0.4→v0.1.1 的更新日志里论证过必须补的那两类链路，因为面板当时根本没启动、而「Allow」曾经从未真正放行——现在对着一个能被杀掉再重启的假 Host 真跑，且完全不需要 VS Code 扩展宿主。随着 hunk 级撤销落地，第 5 条从 6 节长到 13 节。覆盖率现在是**五条链路里写好了三条**，另外两条仍由测试套件自己如实打印为「未编写」，而不是悄悄略过。

完整 diff 和更早版本的说明见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## 环境要求

- VS Code ≥ 1.85
- 本地有一个 `dsh web`（默认端口 `3080`），要么已经在跑，要么由 `sessionMode: "managed"` 替你启动。
- Harness 必须与 VS Code 窗口在**同一台机器上**。这是唯一的硬约束；Remote-SSH、WSL 和容器分别意味着什么，见[《远程开发》](#远程开发)。

## 快速开始

1. 在本地启动 Harness——除非你更愿意让扩展来做这件事：

   ```bash
   dsh web
   # → http://127.0.0.1:3080/?token=<43 位 token>
   ```

   较新的 Harness 会打印一个**带进程级 token 的启动 URL**。默认配置下你不需要它——
   想同时开着网页端对照时，用它打开浏览器即可。（那个 token 是每次请求都比对的进程级密钥，
   不是一次性凭证，所以反复打开这个 URL 依然有效。）

   跳过这一步也是受支持的：把 `deepseekHarness.sessionMode` 设成 `"managed"`，扩展会自己
   启动 Host 并从它的控制台读走那个 URL。见[会话是怎么拿到的](#会话是怎么拿到的)。

   更老的版本则完全不对 `/api/*` 做鉴权、不需要任何 token —— 插件会自行探测所连的是哪一种，
   所以如果没有出现启动 URL，这一步可以直接跳过。

2. 从 [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek) 安装，或通过命令行：

   ```bash
   code --install-extension lucasliang.harness-connector-deepseek
   ```

   或从 [GitHub Releases](https://github.com/YichuAI/deepseek-harness-vscode/releases) 安装 VSIX：

   ```bash
   code --install-extension harness-connector-deepseek-0.2.3.vsix
   ```

3. **不用配置任何东西。** 在默认的 `sessionMode: "credentials"` 下，扩展会自动连接：它读取 `dsh web` 写在 `$DSH_HOME/.credentials.yaml` 里的浏览器会话签名密钥，自己签出同一个 `dsh-auth-…` cookie。**没有需要粘贴的 token。**

   读一下[《会话是怎么拿到的》](#会话是怎么拿到的)一节，就知道这意味着什么，以及另外两种压根不打开那个文件的模式。

4. 在 VS Code 中打开一个你想绑定到 Harness 工作区的文件夹。

5. DeepSeek Harness 活动栏图标出现；扩展自动连接。如果你的文件夹匹配到一个已有的 Harness 工作区，其会话会出现在下拉列表中。选择一个，继续对话。

6. **没有匹配的工作区？** 直接输入提示按 Send——工作区和会话会自动创建。

7. **用 `@` 引用文件** —— 在输入框里打一个 `@`，会弹出补全列表；选中即插入为引用（`@src/main.ts`）。也可以在资源管理器右键文件选 **Add to Harness Chat**，或在编辑器里选中文本后右键选 **Send Selection to Harness**（插入 `@src/main.ts:L10-L20`）。**不会把文件内容贴进消息里**：引用只是一个*指针*，宿主会提示 agent 自己去读该文件。这样无论文件多大，你的提示文本（以及它的 KV cache）都保持稳定。

8. 在浏览器中打开 `http://127.0.0.1:3080/` 的同一会话——两端看到的是同一轮对话。

### 会话是怎么拿到的

Harness 用浏览器会话 cookie 给 `/api/*` 做鉴权，而这里有且只有三条拿到它的路，由
`deepseekHarness.sessionMode` 决定走哪条。

**`credentials`（默认）——本地签发。** `dsh web` 会在 `$DSH_HOME/.credentials.yaml`
的 `client-connection/browser-session` 下留一个持久签名密钥。cookie 是用它给
`{version, authority, issuedAt, expiresAt}` 算的 HMAC；cookie 里不含启动 token 的任何痕迹；
而这个密钥只生成一次、之后每个 `dsh web` 进程复用——所以任何能读到该文件的东西，都能签出
一个逐字节相同的 cookie。扩展读它并自己签发。这就是「没有需要粘贴的东西」的来源。

**`managed`——让扩展启动 Host。** 它运行 `deepseekHarness.launchCommand`（默认
`dsh web --port 0`），从它自己拥有的进程的控制台里读走启动 URL，再用那个 token 去兑换。
不碰凭据文件，不需要粘贴。它启动的 Host 会在这扇窗口关闭时被停掉。

**`paste`——你自己启，然后把 URL 交过来。** 跑 `dsh web`，复制那行
`dsh web: http://…`，执行 **DeepSeek Harness: Use Launch URL**。不读磁盘，也不启动任何进程。

关于 `credentials`，因为它是默认值，而且是一份真实的权限：

- **那个文件里同时装着你的模型 API key。** 读它，在权限上**等价于**对这个 harness home
  拥有完整权力。它不是提权，也没有绕过一个「防你自己」的边界——但扩展进程因此能看到一批
  跟 VS Code 客户端毫无关系的密钥。
- 它会跳过进程级的 launch-token 闸门。那道闸门防的是*远端*调用方（DNS rebinding、CSRF），
  不是防已经以你的身份在本机运行的代码。
- **`managed` 就是对上面两条的回答。** 如果这笔交换你不愿做，换个模式即可——除了多一个由
  扩展启动的进程之外，你什么也没损失。
- **没有任何凭据材料会进日志、进 webview 或进诊断报告。** 日志只记录「发生了一次签发」，
  从不记录材料本身。启动 URL 只在内存里为它唯一用途而存在，且所有提到它的日志行都会被脱敏。
  cookie 存在 VS Code 的 secret storage（系统钥匙串）里，**不会**写进 `settings.json`。
  `DeepSeek Harness: Diagnostics` 导出的是你可以先完整读一遍再决定要不要发出去的脱敏报告。

**这是一个权宜之计，我们更希望它没必要存在。** 官方路径是兑换进程级的 launch token，而
`managed`/`paste` 做的正是这件事——但没有任何东西会把 token 写到盘上，所以一个不是自己启动
Host 的客户端根本无从取得它；这正是当年「读签名密钥」成为唯一零配置路径的原因。一个一等的
本地客户端授权流程才能把这件事做对：一个 socket，或者一个 `0600`、只对单个客户端生效的一次性
token 文件。在 Harness 提供它之前，上面三种模式就是诚实的全部菜单。

### 某条路跑不起来的时候

连接失败时扩展会在报错里点出原因、以及它找过的文件或命令。没有静默兜底。

| 情况 | 怎么办 |
| --- | --- |
| `$DSH_HOME` 指向别处，且没设环境变量 | 给 VS Code 进程设置 `DSH_HOME`，或用默认 home 启动 `dsh web` |
| 这个 harness home 里从没跑过 `dsh web` | 跑一次——`client-connection/browser-session` 记录是那时才建立的；或者改用 `sessionMode: "managed"` |
| `managed` 模式下 `PATH` 里没有 `dsh` | 面板会给出对应平台的安装路线；Windows 和 macOS 上装桌面端也会顺带把 `dsh` 注册好 |
| `managed` 跑了但 `dsh` 立刻退出 | 通常是对端端口已被占用——日志里有子进程自己打出的最后几行 |
| 你在 `paste` 模式下还没粘贴过 | 执行 **DeepSeek Harness: Use Launch URL** |

以任何方式拿到的 cookie，之后都有自己的生命周期：扩展把它存进 VS Code 的 secret storage
（系统钥匙串，**不会**写入 `settings.json`），`dsh web` 重启不会失效，只有在过期或你改了
`host`/`port` 时才重新签发（cookie 名是 `dsh-auth-<sha256(host:port)>`，绑定签发它的
authority）。

## 配置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `deepseekHarness.host` | `127.0.0.1` | 只接受三个值：`127.0.0.1`、`localhost`、`::1`。其它值会在打开套接字之前就被拒绝。见[《远程开发》](#远程开发)。 |
| `deepseekHarness.port` | `3080` | 默认 `dsh web` 端口。如果你用 `dsh web --port <n>` 启动则需修改。 |
| `deepseekHarness.showSystemMessages` | `false` | 显示插件注入的系统消息（运行时上下文、审批通知）。默认隐藏；可通过 webview 头部的 `SYS` 按钮实时切换。 |
| `deepseekHarness.sessionMode` | `credentials` | 会话从哪来。`credentials` 从 `$DSH_HOME/.credentials.yaml` 本地签发 cookie；`managed` 启动 `dsh web` 并读走它的启动 URL；`paste` 等你把 URL 交过来。见[会话是怎么拿到的](#会话是怎么拿到的)。 |
| `deepseekHarness.launchCommand` | `dsh web --port 0` | `sessionMode: "managed"` 运行的命令。默认让系统分配端口，因为托管启动本来就是从启动 URL 里读真实端口，钉死端口只是多一种失败方式。命令走 shell，所以包装脚本和 `npx` 都能用。只在启动 Host 时读一次；改它不会打扰正在跑的那个 Host。 |
| `deepseekHarness.autoApproveApprovals` | `false` | 自动用 `allowed-once` 回应所有审批请求。默认关闭——开启意味着工具调用不再逐次确认。 |
| `deepseekHarness.autoDiscover` | `true` | 配置的端口没人应答时，在回环地址上另找 dsh Host（先看各 profile patch 里钉的 `webserver.port`，再枚举系统监听表，用 Host 自己的拒绝文本确认）。桌面端需要它——桌面端用系统分配的端口启动 Host。发现的端口只在本次会话内使用，绝不写回设置。 |

## 命令

- `DeepSeek Harness: Connect` / `Reconnect` / `Disconnect`（连接 / 重连 / 断开）——**Reconnect**（同时也是面板标题的 ⟳ 按钮、以及状态行里常驻的那个按钮）会先拆掉当前连接再重新协商一次
- `DeepSeek Harness: Diagnostics`（诊断）——一份文档：运行时版本、本扩展的版本、连接状态、这台 Host 实际提供哪些能力、以及最近一次错误。带一个**复制脱敏报告**动作；其中不含任何凭据内容
- `DeepSeek Harness: Clear Session Token`（清除会话 token）——删除已存储的 cookie 并重连（`credentials` 下会重新签一个，`managed` 下会重新起一个 Host；切换 `dsh web` 实例前用它）
- `DeepSeek Harness: Use Launch URL`（使用启动 URL）——粘贴 Host 打印的那行 `dsh web: http://…` 并采用它的会话。这就是 `paste` 那条路，任何模式下都能用
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
- `DeepSeek Harness: Open Web UI`（打开 Web UI）——在浏览器里打开那个带 token 的启动 URL。`sessionMode: "managed"` 下 Host 是扩展自己起的，它手里就有这个 URL，所以这条命令真的能打开；其他模式下它会告诉你那行 URL 在哪
- `DeepSeek Harness: Show Logs`（显示日志，即 `DeepSeek Harness` 输出通道）

这六个控制项同时也在侧边栏的 **Controls（控制）** 面板里，面板还会显示 host
下发的状态：计划模式、沙箱模式、审批策略、agent 预设、当前生效模型、待办列表、
当前目标、子代理活动和最近一次压缩摘要。

**每个控制项都只在这台 host 真的提供它时才出现** —— 能力探测在连接时完成，
所以面对较旧的 `dsh web`，面板只会少显示几个旋钮，而不是给你点不动的按钮。

### 右键菜单操作

九条命令，装在三个子菜单里。其中两条插入一个光秃秃的引用，另外七条是对着你右击的那个东西问同样三件事。

| 位置 | 命令 | 插入什么 |
| --- | --- | --- |
| 资源管理器，右键文件或文件夹 | **Add to Harness Chat** | `@<相对路径>` |
| 编辑器，已选中文本 | **Send Selection to Harness** | `@<相对路径>:L<起始>-L<结束>` |
| 资源管理器 → **DeepSeek Harness** | 解释 / 修复 / 审查**这个文件** | 一行提示词，然后 `@<相对路径>` |
| 编辑器 → **DeepSeek Harness**（有选区） | 解释 / 修复 / 审查**这段代码** | 一行提示词，然后 `@<路径>:L<n>-L<m>` |
| 编辑器 → **DeepSeek Harness**（diff 编辑器） | 解释 / 修复 / 审查**这处改动** | 一行提示词，然后 `@<路径>`——diff 的工作区那一侧 |
| 源代码管理，右键某个文件行 → **DeepSeek Harness** | 解释 / 修复 / 审查**这处改动** | 同上，从 SCM 行解析出来 |

它们插入的都是**引用**，不是文件内容。宿主的引用语法为 `@path`、`@"含空格的
path"`、`@dir/`，可带 `:L<n>` / `:L<n>-L<m>` 后缀；从 `@` 补全列表里选中一项同样
不附带任何内容——文件是 agent 自己去读的。提示词文本落在引用**上面**、自占一行，
所以那始终是你的文本，而不会被卷进一个路径里。

这九条都从命令面板里隐藏了，因为「修复这个文件里的问题」在你手里没有文件时是一条
无事可做的命令。**Add to Harness Chat** 和 **Send Selection to Harness** 是其中
两条不需要连着 host 也能用的——它们插入文本，然后就结束了。

## 架构

见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) 了解一页式设计和协议契约。

## 协议固件

`test/fixtures/` 存放了线缆格式的脱敏快照，用于检测上游 Harness 协议漂移：

- `host-describe.json`、`workspace-list.json`、`session-list.json`、`session-history.json`、`session-prompt.json`、`session-event.json` —— **注意：** 这些是 0.1.6 之前的快照，仅作为历史漂移参考保留。`host-describe` / `session-history` / `workspace-list` 在上游已不存在。

不存储任何凭据、API 密钥或真实提示内容——仅保留 JSON 结构（文本字段已脱敏）。

## 协议测试

一个独立的 Node 脚本用真实客户端代码驱动一个**假**的 harness（假实现照 `0.2.1-alpha.2` 的服务端那一半写死）—— 不需要 `dsh web`：

```bash
npm run protocol-test    # 461 项断言：双流传输拆分（$events 白名单 vs
                         # session/follow）、线缆协商（点分/斜杠、cookie 门禁、
                         # 事件套接字）、认证、cookie 派生、{args} payload、
                         # 审批与提问两条瀑布（Allow/Deny 的确切信封、cancel 撤卡、
                         # next 委托）、assistant 流、已移除端点的 404 处理、
                         # 控制面能力探测与全量值状态折叠、经真实控制器的
                         # @ 补全状态契约、用可驱动 DOM 桩跑通的待答面板、
                         # 改动卡片的两条路由（普通带鉴权 GET、摘要已消失即
                         # 「没有卡片」）、hunk 到两侧的逐行对齐、虚拟 URI 的
                         # authority 契约、每回合一张卡的模型语义、
                         # 逐 hunk 撤销的文本手术（从任一侧撤销、重复片段定位到
                         # diff 真正指的那一处、两侧不一致时拒绝）、经真实 `@` 语法
                         # 驱动的那九条右键提问（这就能让「读起来没问题但成不了
                         # 芯片」的提示词在这里失败，而不是在 agent 手上）、
                         # 回环围栏以及由一个被接受的 host 拼出的三种字符串
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
明说，在这套测试自己的输出里说，也在下面说；因为一个悄悄少跑五分之二的测试套件，跟一个全绿的
套件看起来一模一样。

| # | 链路 | 状态 |
| --- | --- | --- |
| 1 | 连接与认证——Host 起来 → VS Code 连上 → Host 重启 → 自动恢复 | ✅ **23 项断言通过**，对着一个在两次连接之间被杀掉又重启的假 Host |
| 2 | 会话一致性——浏览器发消息 → VS Code 同步 → 切换 → 重载 → 历史一致 | ⬜ 未编写——需要真实的扩展宿主 |
| 3 | 流式输出——长回复 → 工具调用 → 断连 → 不重复、不丢失、不乱序 | ⬜ 未编写——需要一个能掐掉单条连接而不自尽的 Host |
| 4 | 审批交互——允许、拒绝、超时、Host 报错 → 卡片都进入正确终态 | ✅ **31 项断言通过**，假 Host 会把四种结局都演一遍 |
| 5 | 文件变更——agent 改文件 → 用户又改 → 撤销不得覆盖用户 | ✅ **37 项断言通过**，跑在真实文件系统上 |

第 1 条和第 4 条，正是 v0.0.4→v0.1.1 更新日志里有理由要补的那两类：面板直到 v0.1.1 才
真正能启动，「Allow」也曾经从未真正放行，而这两件事在单元测试下都会是绿的。它们之所以
做得到，是因为 `HarnessClient` 和 `BrowserSessionAuth` **不 import `vscode`**——所以
`test/e2e/fake-host.ts` 是一个真的 `http.Server` 加一份手写的 WebSocket，这两条链路在
纯 Node 里跑，完全不需要扩展宿主。假 Host 刻意照 `0.2.0-rc.2` 连围栏一起做：一个忘了
要求 cookie 的 POST 路由会给线缆协商探测回 `200` 而不是 `401`，那样测到的就是错误的分类器。

第 5 条是「有风险」而不是「有 bug」的那一条，也是唯一一条以文件系统为主题的：
`ReviewMaterializer` 把工作区 API 当构造参数收，所以它能对着一个 `fs` 就是**真实**文件系统的
桩、在一个真实的临时目录上跑。模拟一套文件系统，只会让测试去附和实现，而不是抓住它。它的
十三节覆盖了普通回退、清单上的那种情况（文件在回合之后被改过 → 回退拒绝 → 你的字节活下来）、
编辑器有未保存改动、新建文件被删除、新建文件被编辑过、被工具删掉的文件被还原，以及——在
hunk 撤销落地之后——先撤第二个 hunk 再撤第一个、反过来再撤一遍、一个撤了一半的文件整体回退、
hunk 撤销之后又发生编辑仍然拒绝、双击第二次不写任何东西、以及一个没抓到文本的 review 拒绝
而不是删掉文件。

`npm run e2e-test` 会报出 `3 of 5 chains covered, 2 not written`，并且只在「跑到且失败」时才
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
npm run protocol-test    # 针对假 harness 的 461 项协议断言
npm run protocol-probe   # 报告真实 dsh web 暴露了什么
npm run package          # → harness-connector-deepseek-0.2.3.vsix
```

在 VS Code 中按 `F5` 启动带有该扩展的扩展开发宿主。

有两条习惯现在是仓库强制的，而不是靠自觉：

- **`package.json` 是唯一手写版本号的地方。** 其余每一处——README 的「新特性」标题、安装命令里的
  VSIX 文件名、CHANGELOG 的第一条、发布基线、文档里自称的断言条数——都由 `npm run check-versions`
  对着它比对。新增一个会提到版本的展示面，就顺手加一条检查；不要新增一个数字然后指望它别忘。
- **发布历史写进 CHANGELOG。** README 描述的是产品的当前状态，只保留一个版本的说明。

## 设计：写盘归 DSH，插件只观察与告知

关于 DSH 如何工作的两个事实，决定了这里几乎所有其他决定。

**DSH 写盘，并在下一步读回来。** 这个顺序不是可以绕开的实现细节——每一步都建立在它之上。文件工具报告它的改动，接着下一步就把文件按现在的样子打开。所以那个诱人的做法——拦截写入：缓冲它、代理它、把它变成 `WorkspaceEdit` 交给 VS Code 去应用——换来的是一个看起来更整洁的 review 流程，代价是破坏步骤之间的一致性。而且它会很晚、很斜地爆：好几十步之后一个错误的结果，没有任何可见的线索指回那次拦截。所以本插件不拦截写入。**DSH 是唯一的写盘者。**

**插件是观察者，不是守门人。** 等你看到一处改动时，它已经在盘上了。这让「Accept」变成一个除了暗示「这处改动还在等许可」之外什么也没做的按钮，所以它被删了。剩下的是一份记录：改了什么、diff 在哪、怎么撤销。这跟两个人在同一个仓库上协作是同一种关系——你保存文件不需要问谁许可，你去看另一个人做了什么。

三个后果，都是刻意为之：

- **在文件层面，人和 AI 是对等的。** DSH 写，你也写，谁也不被要求为对方确认。让你们不撞车的不是一把锁——而是两个人都能看到 diff、两个人都能撤销。插件的职责是把这份记录显示在对话流里、紧挨着产生它的那次调用，而不是站在你们俩中间。
- **没有回流机制，也不需要。** DSH 每一步都重新读盘，所以它永远不会拿着一份你已经在下面改过的旧副本干活。想让 AI 知道你的改动，就在对话里说，或者让它去读 git 历史。没有任何东西需要被推给它。
- **浏览器能显示的，VS Code 用原生方式显示。** 凡插件有东西要呈现——一个 diff、AI 指到的一个文件——它打开 VS Code 自己的编辑器，而不是在 webview 里重新实现一个查看器。webview 负责对话，编辑器负责代码。

被排除掉的东西和包含进来的东西一样，都是设计的一部分。把 DSH 注册成 **Copilot 语言模型提供方**，会在选择器里多一个下拉项，而背后接的是*别人*的 agent 循环——没有工具调用、没有审批、没有上下文管理，没有作为真正产品的那些编排。用 harness 去换一个模型条目是笔坏交易。改用 **ACP** 而不是 web 传输去驱动 DSH，是同一个错误的小号版本：`acp` profile 是一个自称 automation-only 的 stdio JSON-RPC 服务，既不带 elicitation 也不带 DSH 的展示卡——那样就会丢掉 HTTP+WS 传输已经送来的审批/提问瀑布和改动记录。

**「不启动任何进程」仍然是默认值。** 这套设计唯一被松口的地方就是托管启动，而松口的方式精神一致：它要显式开启，扩展只启动被要求启动的那个 Host，并且在退出时把它停掉。默认行为依然是附着到你已有的东西上。

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
- **启动 URL 是进程级密钥，不是一次性凭证。** 上游的 `authorizeIndex` 对 `/` 的*每一次*请求
  都用 `timingSafeEqual` 把 `token` 查询参数跟进程密钥比对，所以同一个 URL 可以兑换多次，重连也
  不需要新的 Host。这是量出来的、不是推出来的：`scripts/launch-probe.ts` 把同一个 URL 兑换两次，
  两次都期望 `303`。
- **`dsh web` 不会自我后台化。** 这个扩展 spawn 出来的进程就是持有端口的那个——连续采样若干秒，
  子进程活着时 Host 一直答 `401`，停掉之后端口立刻拒绝连接。这正是 `stop()` 所依赖的不变量：如果
  `dsh` 把自己重新孵化到后台去，杀掉我们的子进程就会留下一个用户无法解释的 Host 还在跑。
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

## 远程开发

**Harness 和 VS Code 窗口必须在同一台机器上。** 这不是偏好，也不是某个设置：只要
host 不是 `127.0.0.1`、`localhost` 或 `::1`，扩展就会拒绝，而且是在打开套接字之前
拒绝——做这个决定的代码集中在一个模块里（`src/harness/endpoint.ts`）。这个拒绝是
刻意的。DSH 写盘、下一步再读回来，所以「Harness 在改一台机器的文件、而你看的是另一
台机器的工作区」不是一种打了折扣的配置，而是另一种东西。

有两道互相独立的围栏，而且两道都得挪开才谈得上远程：

1. **本插件自己的围栏。** 就是上面那三个被接受的 host 字符串。局域网地址、转发端口、
   `0.0.0.0`、`host.docker.internal`、`172.17.0.1`，全都在发出任何请求之前就被拒绝。
   `0.0.0.0` 是两头都过不去：它不在集合里，而且它本身也不是一个合法的客户端
   `Host`/`Origin`。
2. **Host 自身的绑定。** `dsh web` 只监听回环。本机实测：Host 跑在 `127.0.0.1:3080`
   时，系统监听表里只有 `TCP 127.0.0.1:3080 … LISTENING`，同一个端口在本机局域网地址
   （`192.168.68.221:3080`）上回答 `ECONNREFUSED`。所以就算有一个客户端无视了围栏，
   它也同样找不到任何东西可谈。

于是剩下四种组合，各自诚实的状态是：

| 场景 | 状态 | 含义 |
| --- | --- | --- |
| **本地窗口** | ✅ **已实测** | 受支持的组合，也是本机唯一端到端跑过的组合：对 `127.0.0.1:3080` 上一个活 Host 跑通 **40/40** 条集成断言，外加 461 条协议断言和 91 条端到端断言。 |
| **Remote-SSH** | ⚠️ **未实测**——本机没有 SSH 服务（`localhost:22` 拒绝连接） | 当 Harness 跑在**远端机器上**时可用。扩展声明了 `extensionKind: "workspace"`，所以在远程窗口里它的扩展宿主就运行在远端：读远端的 `$DSH_HOME`、枚举远端的监听表、连远端的回环。你笔记本上的 Harness 从那里连不到——也不该连得到，因为它要改的工作区并不是你打开的这个。 |
| **WSL** | ⚠️ **未实测**——`wsl.exe` 在本沙箱的程序黑名单上，根本起不来 | 形状和 Remote-SSH 一样：在发行版里跑 `dsh web`。VS Code 把 WSL 当作一个普通远程交给扩展，所以不需要任何 WSL 专属处理。 |
| **开发容器** | ⚠️ **未实测**——本机没有装 `docker` | 形状还是一样：在容器里跑 `dsh web`。注意被读的是容器自己的 `$DSH_HOME/.credentials.yaml`，不是宿主机的。 |

三行写着**未实测**，这是量出来的答案，不是含糊其辞：沙箱拒绝启动 `wsl.exe`，`docker`
没有安装，也没有可连接的 SSH 服务。真正测到的是决定这四行的那部分——围栏和绑定——
而它在四种场景里完全一样。四行之间的区别只在于扩展宿主和 Harness 一起落在哪台机器上。

`@` 引用在任何地方都能用，包括远程窗口：远程文件是以 `vscode-remote:` URI 到达的，
而引用那条路接受它，所以 **Add to Harness Chat**、选面子菜单和改动子菜单在本地与远程
行为一致。范围策略刻意比「任何 URI 都行」要窄——`git:` URI 是某个版本的视图、不是盘上
的文件，`gitlens:` URI 是别人缓存的视图，两者都不会变成引用。

如果围栏真的拒绝了，面板会把它当作一条诊断说出来，而不是一个「未知失败」：它会列出
被接受的三个值，并且对远程用户指回这里，让你知道该动哪一头。

## 限制

- **仅限回环。** 插件只跟同一台机器上的 Harness 说话，Host 自己也只绑回环——四种场景
  （包括本机无法实测的那三种）见[《远程开发》](#远程开发)。
- **在 `sessionMode: "credentials"` 下，扩展能读到一个存着你 API key 的文件。** 要签会话 cookie 就必须读它——这也正是它不再是唯一模式的原因。见[《会话是怎么拿到的》](#会话是怎么拿到的)。
- **托管启动只覆盖「没有任何 Host 在跑」这一情况。** 别人启动的 Host——终端里的、桌面端的——永远不会把它的启动 URL 给我们看，所以那种情况最终仍然走 `paste`。两者各覆盖一半，谁也替代不了谁。
- **`managed` 启动的 Host 会在这扇窗口关闭时被停掉。** 这是刻意的（一个脱离控制、占着端口的 Host，正是这个扩展要避免制造的东西），但这也意味着你退出 VS Code 时，之前开着的那个 Web UI 标签页会失效。
- **托管启动需要一个真能跑起来的 `dsh`。** 一个过期的全局 `dsh` 可能读不懂桌面端写下的那份凭据文件，于是启动即退出——这种时候面板给的建议是去看日志，因为原因永远在子进程自己打出的最后几行里。升级它就好了。
- **图片能不能用取决于模型。** 模型是否吃图并不在 `session/modelCatalog` 里发布，插件只能把宿主的裁决透传：不吃图的模型会让 prompt 失败并返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`，面板会提示你去 Controls 换模型。已暂存的附件会**保留**，方便重试。
- **暂存文件绑定进程。** 上传回执同时绑定会话**和**正在运行的 `dsh web` 进程，宿主重启后必须重新选文件。
- 历史记录加载最近约 50 条消息；"加载更早"是未来版本的计划。
- "Open Web UI" 中的会话深链接不做猜测——只打开 Harness 首页。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；它们不会导致客户端崩溃，但也不会渲染。
- **一次回退是把抓到的 `before` 文本写回去——不走 `git checkout`。** 写之前它会检查盘上的文件是否仍等于 review 建立时抓到的 `after`，以及是否有编辑器带着未保存的改动。两者只要有一个变过，回退就会被拒绝并把该文件标为冲突，而不是覆盖。正是这道闸让「不用问就能撤销」这件事是安全的，也是它能说「不」的原因。
- **撤销一个 hunk 会重查整个文件，而不只是那个 hunk。** 一个撤了一半的文件，在撤销第 *n* 个 hunk 时的期望内容是「盘上现在的内容，加上每一个你还没撤的 hunk 的原文」——所以只要你在这期间编辑了文件的**任何**一处，hunk 撤销就会失败，包括你已经撤掉的那部分。这比严格需要的更严，而「宁可错在保守这一侧」是刻意的选择。
- **逐 hunk 撤销需要一个 Host 能点名的 hunk。** hunk 列表返回为空（文件工具没报 diff 的回合记录）时，只提供文件级回退；完全没抓到文本的 review 会以 `no-diff` 拒绝，而不是猜。hunk 撤销也没有跨文件能力：撤掉一个文件里两个 hunk，不会碰到第三个文件。
- **回合的改动卡片列出的是这个回合改了哪些文件，但其中只有文件工具自己的改动能从中撤销。** 撤销范围限定在该回合产出的 review 内，因为 Host 的摘要只带路径与行数，不带还原所需的文本。某个回合若只通过 shell 命令改了文件，它会直说。
- 改动摘要在宿主上只活到 Session 结束，所以宿主重启后卡片可能解析为「没有改动可显示」。这会渲染成没有卡片，与 Web UI 一致。

## 路线图（v0.3.0+）

- **还没写的那两条端到端链路**——会话一致性（浏览器发消息 → VS Code 同步 → 切换 → 重载 →
  历史一致）和流式输出（长回复 → 工具调用 → 断连 → 不重复、不丢失、不乱序）。两条都
  需要一个能掐掉单条连接而不自尽的 Host；假 Host 已经会「被杀掉再重启」，第 1 条和第 4 条
  用的就是它。
- **在 macOS 和 Linux 上跑那几条链路。** 协议测试和端到端套件已在 CI 里跑三平台；对活 Host
  的集成测试至今只在 Windows 上跑过。
- 按条目下发状态增量：流式推送目前仍整份发送对话流（40 轮会话约 52 KB/次）。渲染端已不再重建它，但跨 `postMessage` 的结构化克隆仍是每个分块剩下的代价。
- **在你真正改代码的地方逐 hunk 撤销。** 改动卡片已经有了；原生 diff 编辑器还没在你看的那
  个 hunk 旁边提供「撤销这个 hunk」。
- 检查器：过滤框 / 类型高亮 / 导出 JSONL
- 搜索：限定工作区、分页、命中高亮
- 内联补全（Inline Completion）
- VS Code 文件系统提供器
- 终端集成
- LSP / ACP 集成

## 许可证

MIT
