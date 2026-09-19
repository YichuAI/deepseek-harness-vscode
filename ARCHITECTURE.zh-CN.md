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
│ harness/events.ts         — RemoteStreamMux + EventBuffer (30ms) │
│ harness/ws.ts             — 最小 RFC6455 客户端（可带 Cookie）   │
│ harness/auth.ts           — 浏览器会话 cookie（token 换 cookie） │
│ harness/http.ts           — node:http 封装（可控 Cookie/Set-Cookie）│
│ harness/protocol.ts       — 线缆类型（镜像上游 Remote 契约）     │
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` **只有类型**——零运行时、零依赖。它镜像 DSH 0.1.6-alpha 的 Remote（Typert Gateway）契约：`packages/client/connection/src/rpc-host.ts`、`packages/api/gateway/src/stream-protocol.ts`、`packages/api/session-controller/src/types.ts`、`packages/api/workspace-controller/src/types.ts`、`packages/api/remotes/src/remote-events.ts`。
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
| `assistant/stream`（帧，非持久事件） | 同上，但走 `applyStreamChunk()`（见下） |
| `assistant/message` | 定稿 `assistant` 项（权威——替换流式文本） |
| `tool/call` | → 创建 `ToolItem`（state: `running`） |
| `tool/result` | → **更新**已有 `ToolItem`（按 `callId`，state: `completed`/`error`） |
| `turn/start` / `turn/end` | → `status` 行；设置 `running` |
| `session/title` | 更新快照标题 |
| **任何其他类型** | **忽略**（harness 协议是可合并扩展的） |

重放是幂等的（`seq` 守卫），所以断线重连 → 重新获取历史是安全的。

> **0.1.6 起流式增量不再进持久日志。** 助手增量改由进程内的 assistant stream 下发，
> 它们没有真实 `seq`，因此**绕过** `applyEvent` 的单调 seq 守卫，走
> `ConversationModel.applyStreamChunk(turn, step, chunk)`。若硬塞进 `applyEvent`，
> 合成的 `seq` 会互相压制，只剩第一个 delta 生效。

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
- 我们**不自己签 cookie**：token 换 cookie 才是被认可的路径，自签等于绕过认证关口。
- 实现见 `harness/auth.ts`；cookie 存在 `context.secrets`，不进 settings.json。

### 一元 RPC — `POST /api/<namespace>/<method>`

```jsonc
// 请求头
Cookie: dsh-auth-…=v1.…
Content-Type: application/json
// 请求体：payload 必须恰好只有一个 args 字段，且是纯对象
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
  "payload": { "args": { "request": { "requestId": "…", "sessionId": "…", "mode": "queue",
                                     "content": [{ "type": "text", "text": "…" }] } } } }
// 响应体
{ "type": "server-response", "rpcId": "<相同>", "result": { "ok": true, "value": { … } } }
```

**`args` 的字段名就是上游方法声明的形参名**，多一个少一个都会被
`assertExactArguments` 拒绝（`gateway/arguments-invalid`）。两个易错点：

- `session/list` 的形参**字面就叫 `_request`**，所以是 `{ "_request": {} }`。
- 返回 `AbortSignal` 的取消位是**传输层参数**（形参名必须是 `signal`），**不是** JSON 字段。

业务错误返回 `200` + `{ ok: false, error: { code, message, details } }`；
HTTP 状态码只表示传输层（`401` 未认证 / `404` 端点不存在 / `415` 非 JSON）。

### 事件通道 — `WS /api/remote.mux`

升级同样要求 cookie；`401` 时服务端直接写 HTTP 响应，不发 `101`。

```jsonc
// 客户端 → 服务端
{ "type": "open", "streamId": "s1", "endpoint": "session/follow", "payload": { "args": { … } } }
{ "type": "cancel", "streamId": "s1" }
// 服务端 → 客户端
{ "type": "item",  "streamId": "s1", "value": { … } }
{ "type": "end",   "streamId": "s1" }
{ "type": "error", "streamId": "s1", "error": { "code": "…", "message": "…", "details": {} } }
```

本插件用两条逻辑流：

| endpoint | args | 用途 |
| --- | --- | --- |
| `$events` | `{}` | 转发的主机事件（含审批瀑布）；首个 item 是 `ready`，带 `clientId` 与 `host.home` |
| `session/follow` | `{ request: { address: { kind:'session', sessionId }, maxMessages, assistantStream: true } }` | 会话日志快照 + 后续持久事件 + 助手流帧 |
| `workspace/follow` | `{}` | 首个 item 是 `baseline`，替代已删除的 `workspace/list` |

`session/follow` 的 item 形态：`{ type:'snapshot', header, cursor, records, hasMore, projections }`、
`{ type:'event', event: SessionEvent }`、`{ type:'assistant-stream', frame }`。

### 客户端如何把新传输翻译回旧帧

`HarnessClient` 把新传输**翻译成 UI 层已经在读的旧帧形状**，因此 `conversation/model.ts`
与 `approval/store.ts` 无需改动：

| 新传输 | 交给 UI 的帧 |
| --- | --- |
| `session/follow` snapshot 的 records | `{ type:'session/event', sessionId, event }`（重放幂等） |
| `session/follow` 的 `event` item | 同上 |
| `assistant-stream` 的 `chunk` | `{ type:'assistant/stream', turn, step, chunk }` |
| `$events` 的 `waterfall`（`approval/request`） | `{ type:'approval/requested', sessionId: agentId, approvalId: eventId, toolName, callId, reason }` |

**审批应答**：`POST /api/$events/result`，`args` 为
`{ clientId, eventId, outcome: { kind:'result', value: 'allowed-once' | 'rejected' } }`。
`agentId` 就是 SessionId（上游 `agent.id`），所以能直接做会话过滤。

`user-questions/request` 也是瀑布，但侧边栏渲染不了问答表单，因此**故意不答**——
Host 以第一个应答为准，随便回 `next` 反而会抢在 Web UI 之前把事情结掉。

**信任围栏**（上游 `api-request-trust.ts` / `browser-auth.ts`）：`Host` 必须是回环地址或
在 `--trusted-host` 中，且必须通过 cookie 校验。我们只连回环，因此天然通过前者。

## 方法白名单

客户端只调用：
`session/list`、`session/create`、`session/prompt`、`session/cancel`、
`session/follow`、`session/modelCatalog`、`workspace/create`、`workspace/follow`、
`$events`、`$events/result`。
绝不调用 `settings/*`、`credentials/*`、`commands/*`、`terminal/*`、`directoryPicker/*`
或任何其他审批/权限变更操作。

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
│   ├── model.ts              # ConversationModel 折叠
│   └── types.ts              # ConversationItem 联合类型（5 种）
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── harness/
│   ├── protocol.ts           # 线缆类型（镜像上游）
│   ├── client.ts             # HarnessClient — 唯一网络边界
│   └── events.ts             # MuxStream (WS) + EventBuffer (30ms)
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
├── protocol-test.ts          # 假 harness 协议测试，50 项断言（无需 dsh web）
├── integration-test.ts       # 针对真实 dsh 的闭环测试
└── gen-icon.ts               # 从 origin.png 生成图标
test/fixtures/                # 脱敏协议快照
```

## KV-cache / 稳定性说明

扩展自身不跨重连持有任何模型状态——每次重连都从 `session/follow` 快照重新派生（Harness 真相源；`session.history` 在 0.1.6 已被移除）。唯一的长期客户端状态是 `remote.mux` 下行链路和内存中的 `ConversationModel`，二者在恢复时都从快照重建。这使得缓存一致性不言自明：只有一个缓存（Harness 会话日志），VS Code 只是它的一个视图。
