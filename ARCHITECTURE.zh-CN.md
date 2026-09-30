# 架构说明 — DeepSeek Harness VS Code v0.0.2

一页纸。三个稳定边界：**接线**（`extension.ts`）、**编排**（`AppController`）、**语义**（`ConversationModel`）。后续 feature PR 从这些边界向外扩展，而非向内侵入。

## 分层（高内聚，低耦合）

```
┌──────────────────────────────────────────────────────────────────┐
│ extension.ts              — 纯接线（activate、命令、配置）       │
├──────────────────────────────────────────────────────────────────┤
│ app/controller.ts         — AppController: 连接/ws/session/       │
│ app/state.ts              — UiState 形状 + 纯映射辅助函数         │
├──────────────────────────────────────────────────────────────────┤
│ conversation/model.ts     — ConversationModel: 事件 → 对话项     │
│ conversation/types.ts     — ConversationItem 联合类型（5 种）    │
│ workspace/binding.ts      — findHarnessWorkspace / ensureHarness │
├──────────────────────────────────────────────────────────────────┤
│ view/provider.ts          — webview 组合（HTML + CSP）           │
│ view/styles.ts            — CSS                                 │
│ view/html.ts              — HTML 骨架                           │
│ view/client.ts            — webview 侧 JS（渲染 + markdown）     │
│ view/toolPresentation.ts  — 工具名 → 人类可读标题               │
├──────────────────────────────────────────────────────────────────┤
│ harness/client.ts         — HarnessClient: 唯一的网络边界        │
│ harness/events.ts         — DownlinkSocket（events.mux WS）+ EventBuffer（30ms） │
│ harness/ws.ts             — 最小 RFC6455 客户端（可带 Cookie）   │
│ harness/auth.ts           — 浏览器会话 cookie（token 换 cookie） │
│ harness/http.ts           — node:http 封装（可控 Cookie/Set-Cookie）│
│ harness/protocol.ts       — 线缆类型（镜像上游 Remote 契约）     │
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` **只有类型**——零运行时、零依赖。它镜像 DSH **`0.1.0-rc.6`** 的 Remote 契约（即已安装的 `@deepseek-ai/dsh-client-connection` 运行时）：`packages/client/connection/src/client.js`（信封 + `/api/<method>`）、`api-path.js`（`/api/events.mux`）以及 `muxFrameSchema` / `hostFrameSchema`。
- `harness/client.ts` 是**唯一**允许发起 HTTP 或打开 socket 的模块。其上层所有代码都通过 `HarnessClient` 访问网络。
- `harness/ws.ts` 自己实现握手与帧编解码，**不用**平台 `WebSocket`：浏览器形状的 WebSocket API 无法设置任意请求头，而 mux 升级现在必须带 `Cookie`。
- `harness/auth.ts` 是唯一的凭据来源。它读取 `dsh web` 启动 URL 里的进程 token，用 `GET /?token=…` 换回 `Set-Cookie`，并把 cookie 存进 VS Code SecretStorage（`context.secrets`），不写进 settings.json。
- `conversation/model.ts` 是纯折叠函数（`SessionEvent[] → ConversationItem[]`）；无网络、无 VS Code 依赖，可在纯 Node 环境下单测。
- `app/controller.ts` 接管全部编排（连接/断开、workspace 生命周期、session 生命周期、prompt/cancel、mux 分发、UiState 推送）。`extension.ts` 是纯接线。
- `view/provider.ts` 是**纯组合层**：从 `styles.ts` + `html.ts` + `client.ts` + markdown-it UMD 组装 HTML，并桥接状态/动作。provider 内不持有状态。

## ConversationItem 投影（v0.0.2 升级）

旧的 `SessionModel` 将事件 1:1 映射为渲染瓦片（`tool-call` → 一张卡片，`tool/result` → 另一张卡片）。v0.0.2 用**对话语义投影**取代：

```ts
type ConversationItem =
  | UserMessageItem      // kind: 'user'
  | AssistantMessageItem // kind: 'assistant'（streaming 标记、usage、reasoning）
  | SystemItem           // kind: 'system'（独立类型，不是 UserItem + 标记）
  | ToolItem             // kind: 'tool'（call + result 按 callId 合并）
  | StatusItem           // kind: 'status'（turn start/end）
```

关键变化：
- **Tool call + result 合并**：`tool/call` 创建 `ToolItem`；`tool/result` 按 `callId` **更新同一个** `ToolItem`（state → `completed`/`error`）。不再有独立的 result 瓦片。
- **SystemItem 是独立类型**：没有 `UserItem { system: true }` 标记。过滤条件是 `item.kind === 'system'`，不是 `user && system`。
- **`renderVersion`**：在每次模型变更时单调递增（包括流式文本增量）。webview 以此作为唯一的变更检测签名——修复了"流式文本变了但 seq 不变 → 不重渲染"的 bug。

### 事件折叠

`ConversationModel.applyEvent` 按 `event.type` 分发：

| 事件 | 折叠 |
| --- | --- |
| `user/message` | → `user` 或 `system` 项（`source.kind !== 'user'` 时为 system）；乐观回声已对账 |
| `assistant/chunk`（`text-delta` / `reasoning-delta`） | 累积到尾部的流式 `assistant` 项 |
| （无独立的 `assistant/stream` 帧） | rc.6 的流式增量即 `session/event`（`event.type==='assistant/chunk'`），走普通 `applyEvent` 折叠 |
| `assistant/message` | 定稿 `assistant` 项（权威——替换流式文本） |
| `tool/call` | → 创建 `ToolItem`（state: `running`） |
| `tool/result` | → **更新**已有 `ToolItem`（按 `callId`，state: `completed`/`error`） |
| `turn/start` / `turn/end` | → `status` 行；设置 `running` |
| `session/title` | 更新快照标题 |
| **任何其他类型** | **忽略**（harness 协议是可合并扩展的） |

重放是幂等的（`seq` 守卫），所以断线重连 → 重新获取历史是安全的。

> **助手流式增量就是普通的持久 `session/event` 帧。** 在 rc.6 中流式文本以
> `session/event` 且 `event.type === 'assistant/chunk'` 的形式下发，携带真实 `seq`，
> 因此走 `applyEvent` 的普通折叠——没有独立的 `assistant/stream` 帧，也不存在合成 seq 绕过。

## 线缆契约（连接时协商；由 `scripts/protocol-test.ts` 验证）

以下几项在 host 版本之间都漂移过，把任何一项写死都会导致插件失联。因此
`harness/wire.ts` 在每次连接时**探测**线缆，而不是假定某个版本：

| # | 维度 | 见过的取值 | 探测方式 |
| --- | --- | --- | --- |
| 1 | 认证 | 无 / 浏览器会话 cookie | 所有探测都返回 401 ⇒ 需要 cookie |
| 2 | 端点命名 | `session.prompt` 与 `session/prompt` | 两种都 POST，返回 `server-response` 者胜出；404 表示不是这种 |
| 3 | 事件通道 | `/api/events.mux` 与 `/api/remote.mux` | 只读响应头的 GET；非 404 即存在 |

还有第四个维度同样协商：`session/list` 的形参名出过三种写法（`_request`、`request`、
干脆没有），逐个尝试直到某个返回 `ok`。结果存为 `WireProfile`，一次连接内缓存，
并统一经 `HarnessClient.ep()` 生成端点字符串——其它模块不再写端点字面量。

还有一个第五维回答的是另一个问题：**到底有哪些控制方法存在？** 每次连接时
`probeCapabilities()` 询问一次并把结果记在 `WireProfile.capabilities` 上，因此侧边栏
只在宿主真的提供某控件的写路径时才把它显示出来（见下方「控制面」）。

对真实 `dsh web` 跑 `npm run protocol-probe` 即可打印该 host 实际提供的内容。

### 认证：浏览器会话 cookie

```
dsh web 打印：dsh web: http://127.0.0.1:3080/?token=<43 字符 base64url>   ← 每进程随机，不落盘
GET /?token=<token>            → 303 See Other + Set-Cookie
之后每个请求：Cookie: dsh-auth-<base64url(sha256("<host>:<port>"))>=v1.<payload>.<hmac>
```

- cookie 名由 **authority（Host 头，即 `host:port`）** 派生，所以换端口就失效。
- 签名 secret 持久化在 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session`，
  因此 cookie 能跨 `dsh web` 重启复用（默认 30 天）。
- 默认**自动取得会话**：`auth.ts` 的 `tryMintLocalSession()` 会读同一份持久化 secret
  自签一个字节级等价的 cookie，零粘贴（见 `harness/local-credentials.ts`）。能读到该
  凭据文件即等于对该 harness home 有完整权限，因此自签是权限等价而非越权。
  由 `deepseekHarness.autoSession`（默认 `true`）控制；关闭后回退到 URL 粘贴流程。
- 实现见 `harness/auth.ts`；cookie 存在 `context.secrets`，不进 settings.json。

### 一元 RPC — `POST /api/<namespace>.<method>`

```jsonc
// 请求头
Cookie: dsh-auth-…=v1.…          // 仅 cookie 受限的 host 需要；rc.6 的 /api/* 不鉴权
Content-Type: application/json
// 请求体：payload 就是参数对象本身——绝不包在 {args}/{request} 里
{ "type": "client-request", "rpcId": "<uuid>", "method": "session.prompt",
  "payload": { "sessionId": "…", "mode": "queue",
               "content": [{ "type": "text", "text": "…" }] } }
// 响应体
{ "type": "server-response", "rpcId": "<相同>", "result": { "ok": true, "value": { … } } }
```

端点在 rc.6 上是 **点分** `namespace.method`（`POST /api/session.prompt`）；`harness/wire.ts`
协商 slash 与 dot 两种风格，所有调用都经 `HarnessClient.ep()` 渲染，没有任何模块写端点字面量。
`payload` 就是声明的参数对象本身——这正是已安装运行时的 `callUnary(method, payload)`。
唯一遗留的坑：`session/list` 的参数名在历史上出现过三种写法（`_request`、`request`、无），
`negotiateWire` 会逐个尝试并缓存 host 接受的那种。

业务错误返回 `200` + `{ ok: false, error: { code, message, details } }`；
HTTP 状态码只表示传输层（`401` 未认证 / `404` 端点不存在 / `415` 非 JSON）。

### 事件通道 — `WS /api/events.mux`（*下行单向，路径协商得到*）

rc.6 只暴露**一条下行单向**的 WebSocket。浏览器打开 `ws://<host>:<port>/api/events.mux`
（实际路径来自 `WireProfile.muxPath`，不写死）；Host 推送 `server-request` 信封，
**每帧即 `envelope.payload`**。这里**没有 `ready` 帧**，客户端也从不向该套接字发送任何东西——
连接成功（open）即就绪信号，`HarnessClient.awaitMuxOpen()` 在首次 `open` 状态即 resolve。

```jsonc
// 服务端 → 客户端，每帧一个（包在 server-request 信封内）
{ "type": "server-request",
  "payload": { "type": "session/event", "sessionId": "…",
    "event": { "type": "assistant/chunk", "seq": 1, "time": 2,
               "data": { "chunk": { "type": "text-delta", "index": 0, "text": "po" } } } } }
```

助手流式增量**以 `session/event` 帧且 `event.type === 'assistant/chunk'` 的形式到达**——
没有独立的 `assistant/stream` 帧，因此 `conversation/model.ts` 已有的 `assistant/chunk` 折叠
无需改动即可处理流式。持久历史**不**在此通道下发：`getHistory()` 改为调用一元 RPC
`session.history`（`{ sessionId, maxMessages? }`）。

**审批应答**：`POST /api/respond`，带 `client-response` 信封：

```jsonc
{ "type": "client-response", "rpcId": "<uuid>",
  "result": { "sessionId": "…", "approvalId": "…", "outcome": "allowed-once" | "rejected" } }
```

`approval/requested` 帧携带 `sessionId` + `approvalId`；`respondApproval()` 据此查帧
（它已在 mux 上被观察到）并 POST 这一对。上游 `agentId` 就是 SessionId，所以能做会话级过滤。

`user-questions/request` 也是瀑布，但侧边栏渲染不了问答表单，因此**故意不答**——
Host 以第一个应答为准，随便回 `next` 反而会抢在 Web UI 之前把事情结掉。

**信任围栏**（上游 `api-request-trust.ts` / `browser-auth.ts`）：`Host` 必须是回环地址或
在 `--trusted-host` 中，且（在 cookie 受限的 host 上）必须通过 cookie 校验。我们只连回环，
因此天然通过前者。

## 方法白名单

传输与消息——总是会调用：

`session/list`、`session/create`、`session/prompt`、`session/cancel`、
`session/history`、`host/describe`、`workspace/list`、`workspace/create`。

控制面——**仅在能力探测确认该 host 提供时**才调用（见 `harness/wire.ts` 的
`probeCapabilities`），因此面对旧版 host 保持开启也是安全的：

`session/command`、`session/fork`、`session/rename`、`session/selectModel`、
`workspace/archiveSession`。

绝不调用：`settings/*`、`credentials/*`、`commands/*`、`terminal/*`、`directoryPicker/*`，
或上表之外的任何审批/权限变更操作。


## 控制面（`src/conversation/control.ts`）

harness 把各种旋钮以持久会话事件的形式下发，而且都是**全量值**：后写的覆盖先写的，
重放时必须仅凭日志还原状态，不依赖任何 catch-up 通道。这让 `ControlSurface` 成为一个
纯折叠——按序 apply 每个事件就是真相，无论它来自 `session.history` 还是实时的 events.mux 帧。

| 事件 | 载荷 | 面板展示 |
| --- | --- | --- |
| `plan/mode` | `{ active }` | 计划模式开关 |
| `permission/preset` | `{ preset }` | 预设选择器的当前值 |
| `sandbox/mode` | `{ mode }` | 沙箱限制徽标 |
| `approval/policy` | `{ policy }` | 审批策略徽标 |
| `todo/write` | `{ todos }` | 待办清单（整表替换） |
| `goal/change` | `{ operation, goal \| cleared }` | 目标 + 阶段 + 轮次 |
| `subagent/start` / `end` / `descriptor` | 作用域身份 | 运行中的子代理 |
| `compaction/start` / `end` / `summary` | provenance + 摘要 | 压缩状态 |
| `request/header` | `{ header: { config } }` | 当前生效的 provider / model / 推理强度 |

写路径按上游实际提供的方式分两类：计划模式、权限预设、压缩走**命令注册表**
（`session/command` + `/plan`、`/permission <name>`、`/compact`），而 fork / rename /
archive / 模型选择有各自的专用端点。每次写之前先查协商出的能力表
（`requireControl`），否则抛 `HarnessUnsupportedError` 并在消息里点名缺哪个端点——
于是 UI 表现为「少几个控件」，而不是「几个按了没反应的按钮」。

## Workspace 生命周期（v0.0.2：惰性创建）

```
连接
  ↓
pickVsCodeFolder()              — 解析当前 VS Code 文件夹
  ↓
findHarnessWorkspace()          — 只读：匹配文件夹 ↔ harness workspace
  ↓
找到?  → 加载 sessions，选择第一个非空
没找到? → binding 保持 pending，UI 显示"尚未注册"
                ↓
          用户发送第一条提示
                ↓
          ensureHarnessWorkspace() — 按需创建（无弹窗）
                ↓
          createSession() → selectSession() → prompt()
```

无确认弹窗。workspace 是**发送时按需确保的资源**，不是连接时的资源。

## Markdown 渲染

`markdown-it`（`html: false`、`linkify: true`、`breaks: false`）在 **webview 侧**运行——不在 extension host 中。这保持 `ConversationModel` 纯语义（发送原始 markdown 文本；webview 负责展示）。

- Assistant 消息：`body.innerHTML = md.render(item.text)`
- User / System 消息：`body.textContent = item.text`（无 markdown）
- Tool 结果：`<pre>`（无 markdown）
- 链接：`target=_blank rel=noopener`；`javascript:` / `data:` URL 被剥离
- `markdown-it.umd.min.js` 打包在 `media/` 目录中供 VSIX 使用

## 流式性能

`EventBuffer` 合并高频 `assistant/chunk` 帧，最多每 **30 ms** 刷新一次。`turn/end` 和 `assistant/message` 强制立即刷新，使 UI 即时定稿。webview 仅在 `renderVersion` 变化时重渲染——绝不按 token 逐次重渲染。

## 重连

`MuxStream` 以退避策略重试（250 ms → 5 s）。在 `closed → open` 转换时，`AppController` 调用 `refetchHistory(activeSessionId)` 并重建模型——Harness 文档化的恢复语义是**重建**，不是游标续传。

## 安全边界

`HarnessClient.connect()` 拒绝任何不在 `{127.0.0.1, localhost, ::1}` 中的主机，提示：

> v0.0.x only supports local DeepSeek Harness instances.

`approval/requested` 和 `question/requested` 帧**仅**显示一条信息消息（"该操作需要在 DeepSeek Harness Web UI 中审批"），绝不调用 `/api/respond`。

## 目录结构

```
src/
├── extension.ts              # 纯接线（activate、命令、配置）
├── disposable.ts             # CompositeDisposable 辅助
├── app/
│   ├── controller.ts         # AppController — 编排
│   └── state.ts              # UiState 形状 + 映射辅助
├── conversation/
│   ├── model.ts              # ConversationModel 折叠（"它说了什么"）
│   ├── control.ts            # ControlSurface 折叠（"它能做什么 / 在做什么"）
│   └── types.ts              # ConversationItem 联合类型（5 种）
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── harness/
│   ├── protocol.ts           # 线缆类型（镜像上游）
│   ├── wire.ts               # 协议协商 + 能力探测
│   ├── client.ts             # HarnessClient — 唯一网络边界
│   ├── auth.ts               # 浏览器会话 cookie 生命周期 + 本地自签
│   ├── local-credentials.ts  # 读取 $DSH_HOME/.credentials.yaml（autoSession）
│   ├── events.ts             # 逻辑流多路复用 (WS) + EventBuffer (30ms)
│   ├── http.ts               # 最小 http 客户端（无 fetch 时的回退）
│   └── ws.ts                 # RFC6455 客户端（无运行时依赖）
└── view/
    ├── provider.ts           # webview 组合（HTML + CSP + 状态桥接）
    ├── styles.ts             # CSS
    ├── html.ts               # HTML 骨架
    ├── client.ts             # webview 侧 JS（渲染 + markdown + 动作）
    └── toolPresentation.ts   # 工具名 → 人类可读标题
media/
├── icon.png                  # Marketplace + webview 品牌图标
├── icon.svg                  # 活动栏图标（currentColor）
├── origin.png                # 源材料（VSIX 排除）
└── markdown-it.umd.min.js    # VSIX 打包用（114 KB）
scripts/
├── protocol-test.ts          # 假 harness 协议测试，98 项断言（无需 dsh web）
├── protocol-probe.ts         # 向真实 `dsh web` 询问它实际提供什么
├── probe-shapes.ts           # `{args}` 写法的临时探针
├── integration-test.ts       # 针对真实 dsh 的闭环测试
└── gen-icon.ts               # 从 origin.png 生成图标
test/fixtures/                # 脱敏协议快照
```

## KV-cache / 稳定性说明

扩展自身不跨重连持有任何模型状态——每次重连都从 `session.history`（一元 RPC，返回 `{ events, hasMore }` 形式的会话日志）重新派生，它就是 Harness 的真相源；协商出的 `WireProfile` 决定适用哪些端点名与参数写法。唯一的长期客户端状态是事件套接字下行链路与两个内存折叠 `ConversationModel` 和 `ControlSurface`，二者都在恢复时从 `session.history` 重建。这使得缓存一致性不言自明：只有一个缓存（Harness 会话日志），VS Code 只是它的一个视图。
