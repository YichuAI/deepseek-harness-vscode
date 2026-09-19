# 变更日志

本项目所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.0.6] — 2026-09-19

版本定位：**控制面补齐——这些旋钮 harness 一直在下发。**

宿主一直在发 `plan/mode`、`permission/preset`、`sandbox/mode`、`todo/write`、
`goal/change`、`subagent/*`、`compaction/*`，而插件一个都没渲染。结果是：会话确实
是共享的，但侧边栏看起来比官方 Web UI 少了半壁江山。这一版把它们显示出来，并且
在宿主支持时允许你直接改。

### 新增

- **`src/conversation/control.ts` —— 控制面折叠。** 这些事件在上游都是**全量值**
  （后写的覆盖先写的，且重放必须仅凭日志还原状态），所以折叠就是一个纯粹的
  「最后写入生效」投影，输入是历史 + 实时帧。`request/header` 额外给出当前生效的
  provider / model / reasoningEffort。
- **能力探测。** `wire.ts` 现在会询问宿主提供哪些控制方法（`session/command`、
  `session/fork`、`session/rename`、`session/selectModel`、
  `workspace/archiveSession`、`agentPreset/*`、`subagent/list`、`llm/models`），
  结果缓存在 profile 上。探测**故意发空参数**：形参校验在处理器执行之前，因此
  「参数被拒」恰好证明方法存在，而且绝不可能改动会话状态。
- **`HarnessClient` 上的控制面写方法**：`runCommand`（公共写路径——上游把 plan、
  permission、compact 都路由到命令注册表）、`togglePlanMode`、
  `setPermissionPreset`、`compactSession`、`forkSession`、`renameSession`、
  `selectModel`、`archiveSession`。
- **`rpcVariants()`** —— 容忍上游出过的多种 `{args}` 写法（`request`、`_request`、
  裸字段）：把「参数形状被拒」当作「写法不对」而非「方法不存在」。缓存的是**写法**，
  绝不是参数值。
- **侧边栏 Controls（控制）面板**：计划模式开关、权限预设选择器、沙箱/审批/模型
  徽标、待办清单、当前目标、子代理活动、最近一次压缩摘要，以及 Fork / Rename /
  Compact / Archive 动作；每一项都只在这台宿主提供对应写路径时才出现。
- 六条命令：`Toggle Plan Mode`、`Set Permission Preset`、
  `Compact Session Context`、`Fork Session`、`Rename Session`、`Archive Session`。
- `npm run protocol-probe` 现在会打印协商出的控制面清单。

### 变更

- `protocol-test` 从 64 增至 **98 项断言**：覆盖能力探测（存在 / HTTP 404 不存在 /
  not-found 码不存在 / 参数被拒视作存在）、控制面写调用、完全没有控制面的宿主，
  以及全量值折叠语义（目标清除、子代理名单对账、reset 等）。

### 说明

- 控制端点缺失时抛 `HarnessUnsupportedError`，消息会点明缺什么，而不是抛出一个裸 404。

## [0.0.5] — 2026-09-19

版本定位：**线缆是协商出来的，不是猜出来的。**

v0.0.4 把线缆形状写死了（斜杠端点、`/api/remote.mux`、cookie 认证）。而本机所有
证据都不支持这套写法：已安装运行时（`0.1.0-rc.6`）用的是 `/api/session.list` +
`/api/events.mux` 且完全不需要 cookie；而当初报 401 的那台 host 又确实要求认证。
猜是猜不准的，这一版改成实测。

### 新增

- **`src/harness/wire.ts` —— 协议协商。** 每次连接时客户端自动探测：端点风格
  （`session/list` 还是 `session.list`）、`/api/*` 是否需要 cookie、事件套接字路径，
  以及 `session/list` 实际接受的形参名。结果缓存为 `WireProfile`，客户端里所有
  端点字符串都改由它生成。
- **`npm run protocol-probe`** —— 直接问真实 `dsh web` 提供了什么：端点风格、
  事件套接字，以及 29 个候选方法中哪些存在。今后任何线缆疑问都以它为准。
- `httpStatus()` 与 `httpRequest({ timeoutMs })` —— 只读响应头的探测，带超时上限，
  避免事件流把探测挂住。

### 变更

- `rpc()` 不再无条件要求 cookie：只有协商结果表明 host 需要认证时才要求，
  免认证的 host 不会再被推进"粘贴 token"流程。
- `404` 报错改为提示已协商出的线缆风格，不再写死某个上游版本号。
- `session/list` 的 args 来自协商结果，不再写死 `_request`。
- `protocol-test` 断言数从 50 增至 **64**，新增点分风格 host、免认证 host、
  需 cookie host、以及端口不通四种场景。

### 修复

- 移除客户端里最后一批硬编码的 `0.1.6-alpha` 假设。

## [0.0.4] — 2026-09-18

版本定位：**DeepSeek Harness 0.1.6-alpha 线缆协议迁移。**

Harness 0.1.6-alpha 对线缆协议做了三处破坏性变更，导致本扩展的每一次调用都返回 `401` / `404`。现在这三处全部按新协议原生实现。

### 上游的破坏性变更（本次发布的原因）

1. **`/api/*` 现在要求浏览器会话 cookie。** cookie 名为 `dsh-auth-<b64url(sha256(host:port))>`。没有它每个调用都 401 —— 这正是旧的 `host.describe` 失败表现。
2. **RPC 端点被重命名**：从 `a.b`（`host.describe`）改为 `namespace/method`（`session/list`）。`host.describe` 本身被彻底删除（`packages/host/apiproxy` 整包移除），`session.history` 与 `workspace/list` 同样被删。
3. **事件通道变成双向**：仅下行的 `/api/events.mux` WebSocket 被 `/api/remote.mux` 取代，后者是逻辑流多路复用器 —— RPC 与订阅都作为流跑在同一条 socket 上。

### 新功能

- **浏览器会话认证。** 新增 `src/harness/auth.ts`：接收 `dsh web` 启动 URL，跟随 303 的 `Set-Cookie` 交换，并持久化 cookie。cookie 存在 VS Code `context.secrets`（系统钥匙串）中 —— **不**写入 `settings.json`。
- **新命令** —— `DeepSeek Harness: Set Session Token from Launch URL` 与 `DeepSeek Harness: Clear Session Token`。两者也可从会话视图标题栏触发。
- **可操作的报错。** 缺失/过期会话现在会说明*原因*并给出该执行的具体命令，而不是抛一个光秃秃的 `401`。已删除的端点会报 `HTTP 404 on /api/host.describe — the running harness does not expose that endpoint` 并附升级指引。
- **连通性由 `$events` 就绪证明。** `connect()` 不再相信一次成功的 HTTP 探测，而是等待 `$events` 的 `ready` 帧（该帧同时携带 `clientId` 与 `host.home`）。

### 协议映射（旧 → 新）

| 旧 | 新 |
| --- | --- |
| `host.describe` | `$events` ready 帧（`home`、`clientId`）+ `session/modelCatalog`（`provider`、`model`） |
| `events.mux`（仅下行） | `remote.mux`（双向逻辑流） |
| `session.history` | `session/follow` 快照（或 `session/page`） |
| `workspace/list` | `workspace/follow` baseline 帧 |
| `POST /api/respond` | `$events/result` RPC —— `{clientId, eventId, outcome:{kind:'result', value:'allowed-once'\|'rejected'}}` |
| `assistant/chunk`（持久日志） | 经 `session/follow` 旁路下发的 assistant 流帧 |
| `{...params}` RPC payload | `{args:{<声明的形参名>: value}}` —— 如 `session/list` 为 `{_request:{}}` |

### 新增模块

- `src/harness/auth.ts` —— `BrowserSessionAuth`、cookie 派生、启动 URL 接管、持久化
- `src/harness/http.ts` —— 基于 `node:http` 的客户端（平台 `fetch` 没有 cookie jar）
- `src/harness/ws.ts` —— 最小 RFC 6455 WebSocket 客户端，因为浏览器形状的 `WebSocket` 无法携带 mux 升级所需的 `Cookie` 头
- `scripts/protocol-test.ts` —— 假 harness 协议测试，34 项断言

### Bug 修复

- 0.1.6 把流式 assistant 增量移出了持久日志且不带真实 `seq`，因此被模型的 seq 守卫静默丢弃。新增 `ConversationModel.applyStreamChunk(turn, step, chunk)` 绕过守卫。
- 审批应答改用 `eventId`（瀑布事件）作键，而非旧的 `approvalId`；`agentId` 即会话 id。
- 修改 `host`/`port` 现在调用 `client.retarget()` + 重连，而不是重建 client（旧实现会泄漏原来的 mux socket）。
- 编辑器上下文通过 `renderContextBlock()` 渲染进提示文本，因为新的 `session/prompt` 没有 `context` 字段。
- 格式正确、未过期、authority 也匹配、但仍被 host 拒绝的 cookie，之前被报成"已过期"，
  把用户引向错误的修复方向。现在会明确报告 host 的签名密钥已被轮换。
- 被拒绝的 `/api/remote.mux` 升级之前会一直等到超时，然后归咎于一个笼统的超时。
  现在会立刻失败并给出可操作的认证错误（mux 状态携带被拒升级的 HTTP 状态码）。

### 会话有效期

启动 URL 里的 **token** 随 `dsh web` 进程消亡，但它换来的 **cookie** 是用持久化在
`$DSH_HOME/.credentials.yaml` 里的密钥签名的，**默认 30 天**有效。扩展保存的就是这个 cookie，
所以**重启 `dsh web` 不需要**重新执行 Set Session Token。只有三种情况需要重新填：
超过 30 天有效期、改了 `host`/`port`（cookie 名是 `dsh-auth-<sha256(host:port)>`）、
或凭据文件被删除/重新生成。

### 验证结果

- `tsc --noEmit` —— 0 错误
- 生产构建 —— `dist/extension.js` 98.4 kb
- `scripts/protocol-test.ts` —— 针对假 0.1.6 harness，50/50 断言通过
  （含凭据存储本地自签、autoSession 关闭守卫、cookie 跨重启存活、密钥轮换的报错措辞）

## [0.0.3] — 2026-08-16

版本定位：**Diff 审查、审批工作流 & 文件内容内联。**

补齐与 Cursor/Cline 最大的体验差距：代码变更可以在 VS Code 内完成审查和审批，无需切换到 Web UI。

### 新功能

- **Diff 审查与内联代码应用。** Agent 写入或编辑文件时，侧边栏自动出现审查卡片，展示每个变更文件的 `+新增`/`-删除` 行数。点击 **Diff** 打开 VS Code 原生 diff 编辑器（通过 `dsh-review://` 虚拟文档）。支持逐文件 Accept（保留）/ Reject（通过 `git checkout` 安全回退），也可批量操作。审查事务以 `callId` 关联到原始工具调用。
- **审批工作流集成。** `approval/requested` 事件现在以内联卡片形式展示，带 **Allow once** / **Deny** 按钮 — 不再需要切浏览器审批。安全允许列表限制哪些工具可以在 VS Code 内审批，高风险操作仍需 Web UI。响应通过 `POST /api/respond` 发送。
- **@file 内容内联。** 文件引用（`@file:path` 或 `@file:path:L10-L20`）的内容现在被直接读取并内联到用户消息文本中（用 `<file path="…">` 标签包裹），确保 agent 始终能看到文件内容，即使后端不处理 `context` 字段。`context` 元数据（活动文件、选区）仅在会话**首次发送**时附带，避免冗余传递。
- **右键菜单集成。** 在资源管理器中右键文件 → **Add to Harness Chat** 插入 `@file:` 引用。在编辑器中选中文本 → 右键 → **Send Selection to Harness** 插入 `@file:path:L10-L20`。均使用工作区相对路径，便于阅读。

### Bug 修复

- **Windows 下 @file 正则解析。** 添加负向前瞻 `(?!L\d)`，防止 `:L<digits>` 行范围被当作文件路径的一部分（对 Windows 路径如 `e:\folder\file.ts:L10` 至关重要）。
- **Webview 正则转义。** 修复模板字符串中 `\s`/`\d` 的双重转义 — 不修复时 `[^\s:]` 会变成 `[^s:]`，无法排除空白字符。
- **跳过非文件文档。** `collectEditorContext` 现在跳过 URI scheme 非 `file` 的文档（Output 面板、设置页等）。
- **仅含 @file 时输入被清空。** 当输入仅包含 `@file:` 引用时，聊天现在显示可读摘要如 `(See: file.ts:L10-L20)`，而非被清空。

### 新增模块

- `src/review/` — `ReviewController`、`ReviewStore`、`ReviewVirtualDocumentProvider`、`ReviewMaterializer`（6 文件，约 500 行）
- `src/approval/` — `ApprovalStore`、类型定义（2 文件，约 150 行）

---

## [0.0.2] — 2026-08-15

版本定位：**对话 UX & 架构基线版。**

这是 main 分支最后一次直推版本。整理主干结构、渲染正确性和交互体验，使 v0.0.3+ 可以全部基于稳定边界通过 feature PR 并行开发，不再产生冲突中心。

### 架构（结构边界收口）

- **新增 `src/app/controller.ts` + `state.ts`** — `AppController` 接管全部编排职责：连接/断开、workspace 生命周期、session 生命周期、prompt/cancel、mux 分发、UiState 推送。`extension.ts` 保持纯 wiring：只有 `activate() / deactivate()`、`readConfig()`、命令注册、依赖装配四件事。
- **新增 `src/conversation/`** — `ConversationModel` 取代平铺的 `SessionModel`。事件不再 1:1 映射 UI 瓦片，而是投影为对话语义的 `ConversationItem[]`（`user`、`assistant`、`system`、`tool`、`status`）。
- **新增 `src/workspace/binding.ts`** — workspace 建立拆为 `findHarnessWorkspace()`（连接时只做探测）与 `ensureHarnessWorkspace()`（首次发送时按需创建）。旧的 `resolveHarnessWorkspace()` 在 connect 流程中急切弹窗创建的机制已被移除。
- **`src/view/` 拆分** — `provider.ts` 仅保留组合逻辑，与 `styles.ts`、`html.ts`、`client.ts`（Webview 侧 JS）、`toolPresentation.ts` 物理分开。刻意不引入 React/Preact/Vite；原生 DOM 再撑一两个版本没问题。

### 交互修正

- **首次 Send 惰性创建 workspace + session。** 用户打开 repo 没有对应 Harness workspace 时，侧边栏仍可操作，并显示"尚未注册 — 第一次发送时会自动创建"的提示条。第一次点击 Send 时，隐式完成 workspace 创建 → session 创建 → prompt 发送，完全不弹确认框。文本框在 optimistic echo 到达 snapshot 后才清空，创建失败时用户输入不会丢失。
- **Tool 调用与结果合并为一张卡片。** `tool/call` 与对应 `tool/result` 以 `callId` 合并为单一 `ToolItem`。侧边栏渲染为一条折叠的标题 `🔧 read src/session.ts → ✓ done`，点击展开 Arguments / Result 两段。彻底消灭"粉色整块 result"的噪声。`toolPresentation.ts` 针对 read / grep / bash / write / edit / git_* 等工具名给出语义化标题。
- **System message 升级为独立 item 类型。** `SystemItem` 不再复用带 `system: true` 标记的 `UserItem`。全链路过滤只看 `item.kind === 'system'`，不再到处出现 `if user && system` 的条件分支。默认 UI 是一条折叠行 `▸ Runtime context · @deepseek-ai/dsh-system-prompt`。
- **Assistant 支持 Markdown 渲染。** `markdown-it`（`html: false`, `linkify: true`）在 **Webview 侧**运行，Extension Host 侧不做渲染，保持 `ConversationModel` 纯语义。用户 / system 消息保持 `textContent` 纯文本。链接自动以 `target=_blank rel=noopener` 打开，`javascript:` / `data:` 开头的被剥离。Tool 结果第一版保留 `<pre>`。
- **Streaming 文本现在一定触发重渲染。** 每次 model 变更都会自增 `renderVersion`。Webview 只以 `snapshot.renderVersion` 作为重建消息列表的唯一签名，修复了旧版只看 `lastSeq` / `items.length` 导致 streaming 内容变化但 UI 不刷新的 bug。

### 测试覆盖

- 集成测试升级到 `ConversationModel`。新增断言：
  - `renderVersion` 在一次 prompt 结束后严格递增（标准 "pong" 用例从 1 → 19）。
  - `ConversationItem` 中不再出现 `tool-call` 或 `tool-result` 两种旧瓦片——它们在 model 层已被合并，类型与运行时双重保证。
  - `systemMessageCount` 单独统计系统消息数量。

### 红线纪律

- **v0.0.2 明确不做**：Diff Review、approval/respond、inline completion、context injection、filesystem provider、terminal integration、LSP/ACP/SDK 抽象、transport 接口。全部从 v0.0.3 起在 feature branch / PR 中逐步引入。

---

## [0.0.1] — 2026-08-15

首次公开发布。此版本只证明**一件事**：VS Code 和浏览器共享同一个 DeepSeek Harness 会话。

```
浏览器 ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘

同一个工作区。同一个会话。同一个 Agent 运行时。
```

### 新增

- **连接**到本地 `dsh web` 实例，通过 `HTTP /api/*` + `WebSocket /api/events.mux`。
  仅限回环的信任围栏（`127.0.0.1` / `localhost` / `::1`）；其他主机会被拒绝并给出明确提示。
- **工作区映射**——按规范路径将当前 VS Code 文件夹匹配到已有的 Harness
  工作区；若不存在则提示创建（不产生第二个工作区 ID）。
- **会话列表**按解析到的工作区过滤，带 `+ 新建会话`。
- **会话历史**从 Harness 加载（唯一真相源——无本地会话数据库，
  无 `.vscode/deepseek-sessions.json`）。
- **纯文本提示**发送到当前会话。
- **实时流式传输** `assistant/chunk` 增量和工具活动，由
  `EventBuffer` 合并，最多每约 30 ms 刷新一次（不逐 token 重渲染）。
- **停止/取消**当前回合。
- **重连**——WebSocket 断开→重连时，重新打开流并重新获取历史
  （Harness 文档化的恢复语义是*重建*，非游标续传）。
- **打开 Web UI** 命令（打开 `http://127.0.0.1:<port>`；会话深链接不做猜测）。
- **显示日志** 命令 → `DeepSeek Harness` 输出通道。
- **侧边栏 webview**（原生 JS，无 React），含连接状态、工作区、
  会话下拉、消息列表、输入框 + 发送/停止。
- **右侧停靠**——"移至右侧边栏"命令（webview 头部的 ⇲ 按钮）将
  视图移至辅助侧边栏，不再与文件浏览器争抢左侧空间。
- **系统消息隐藏**——插件注入的 `user/message` 帧（如
  `@deepseek-ai/dsh-system-prompt` 运行时上下文、`user-approval` 通知）
  通过 `source.kind !== 'user'` 检测，默认隐藏。头部 `SYS`
  按钮可显示它们；`deepseekHarness.showSystemMessages` 设置控制默认值。
- **品牌图标**——生成的 128×128 PNG（`media/icon.png`）作为
  Marketplace 图标和 webview 头部 Logo；SVG 活动栏图标使用
  `currentColor` 适配主题。通过 `npm run gen-icon` 重新生成。
- **协议固件**（`test/fixtures/`）——线缆格式的脱敏快照，
  用于检测上游协议漂移。
- **协议探测**（`scripts/protocol-spike.ts`）和**集成测试**
  （`scripts/integration-test.ts`）——独立的 Node 验证脚本，在运行的
  `dsh web` 上测试完整闭环。

### 安全

- 方法白名单：仅 `host.describe`、`workspace.{list,create}`、
  `session.{list,history,create,prompt,cancel}`。
- 绝不调用 `/api/respond`、`settings.*`、`credentials.*`、`commands.*` 或任何
  审批/权限变更操作。
- `approval/requested` 和 `question/requested` 帧**仅**显示一条
  信息消息（"该操作需要在 DeepSeek Harness Web UI 中审批"），
  绝不代用户响应。

### 已验证版本

- DeepSeek Harness host `v0.0.1`（`@deepseek-ai/dsh-root`），默认 `dsh web`
  端口 `3080`。
- 线缆契约来源：`packages/host/apiproxy/src/api/`（权威）。
- 集成测试：11/11 检查通过（针对运行中的本地 `dsh web`）。

### 限制

- 仅限回环——不支持远程 / 局域网 / WSL 桥接的主机。
- 仅支持文本提示（不支持图片附件）。
- 历史记录加载最近约 50 条消息；"加载更早"已推迟。
- "Open Web UI" 中的会话深链接不做猜测。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；
  不会导致客户端崩溃，但也不会渲染。

[0.0.1]: https://github.com/liangwythu/deepseek-harness-vscode/releases/tag/v0.0.1
