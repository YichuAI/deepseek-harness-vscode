# 架构说明 — DeepSeek Harness VS Code v0.1.8

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
├──────────────────────────────────────────────────────────────────┤
│ view/provider.ts          — webview 组合（HTML + CSP）           │
│ view/styles.ts            — CSS                                 │
│ view/html.ts              — HTML 骨架                           │
│ view/client.ts            — webview 侧 JS（渲染 + markdown）     │
│ view/toolPresentation.ts  — 工具名 → 人类可读标题               │
├──────────────────────────────────────────────────────────────────┤
│ harness/client.ts         — HarnessClient: 唯一的网络边界        │
│ harness/events.ts         — RemoteMuxSocket（remote.mux WS）+ EventBuffer（30ms） │
│ harness/ws.ts             — 最小 RFC6455 客户端（可带 Cookie）   │
│ harness/auth.ts           — 浏览器会话 cookie（token 换 cookie） │
│ harness/http.ts           — node:http 封装（可控 Cookie/Set-Cookie）│
│ harness/protocol.ts       — 线缆类型（镜像 0.2.0-rc.2 Remote 契约）│
└──────────────────────────────────────────────────────────────────┘
```

- `harness/protocol.ts` **只有类型**——零运行时、零依赖。它镜像 DSH **`0.2.0-rc.2`** 的 Remote 契约（即本插件实际连接的宿主真正提供的契约）：斜杠风格 `POST /api/<ns>/<method>`，信封为 `{ type:'client-request', payload:{ args } }`；事件通道是双向的 `/api/remote.mux`（首帧 `ready` 携带 `clientId` + `host.home`）；审批走 `$events/result`；历史走 `session/page`。
- `harness/client.ts` 是**唯一**允许发起 HTTP 或打开 socket 的模块。其上层所有代码都通过 `HarnessClient` 访问网络。
- `harness/ws.ts` 自己实现握手与帧编解码，**不用**平台 `WebSocket`：浏览器形状的 WebSocket API 无法设置任意请求头，而 mux 升级现在必须带 `Cookie`。
- `harness/auth.ts` 是唯一的凭据来源。它读取 `dsh web` 启动 URL 里的进程 token，用 `GET /?token=…` 换回 `Set-Cookie`，并把 cookie 存进 VS Code SecretStorage（`context.secrets`），不写进 settings.json。autoSession 也可改为从 `$DSH_HOME/.credentials.yaml` 本地自签同一个 cookie。
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
  | ToolItem             // kind: 'tool'（call + result 按 callId 合并，另带 reviewId）
  | StatusItem           // kind: 'status'（turn start/end）
  | ChangesItem          // kind: 'changes'（v0.1.8：每回合一张改动卡片）
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
| `assistant/message` | 定稿 `assistant` 项（权威——替换流式文本） |
| `tool/call` | → 创建 `ToolItem`（state: `running`） |
| `tool/result` | → **更新**已有 `ToolItem`（按 `callId`，state: `completed`/`error`） |
| `turn/start` / `turn/end` | → `status` 行；设置 `running` |
| `workspace/changes` | → `changes` 卡片（v0.1.8）；每回合一张，重复播报是替换坐标 |
| `session/title` | 更新快照标题 |
| **任何其他类型** | **忽略**（harness 协议是可合并扩展的） |

重放是幂等的（`seq` 守卫），所以断线重连 → 重新获取历史是安全的。

> **助手流式增量就是普通的持久 `session/event` 帧。** 在 0.2.0-rc.2 中流式文本以
> `session/event` 且 `event.type === 'assistant/chunk'` 的形式下发，携带真实 `seq`，
> 因此走 `applyEvent` 的普通折叠——没有独立的 `assistant/stream` 帧，也不存在合成 seq 绕过。

## 线缆契约（连接时协商；由 `scripts/protocol-test.ts` 验证）

以下几项在 host 版本之间都漂移过，把任何一项写死都会导致插件失联。因此
`harness/wire.ts` 在每次连接时**探测**线缆，而不是假定某个版本：

| # | 维度 | 见过的取值 | 探测方式 |
| --- | --- | --- | --- |
| 1 | 认证 | 无 / 浏览器会话 cookie | 所有探测都返回 401 ⇒ 需要 cookie |
| 2 | 端点命名 | `session.prompt` 与 `session/prompt` | 两种都 POST，返回 `server-response` 者胜出；404 表示不是这种 |
| 3 | 事件通道 | `/api/remote.mux`（0.2.0-rc.2）与 `/api/events.mux`（更旧） | 只读响应头的 GET；非 404 即存在 |

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
- 默认**自动取得会话**（autoSession，默认开）：`auth.ts` 的 `tryMintLocalSession()` 会读同一份
  持久化 secret 自签一个字节级等价的 cookie，零粘贴（见 `harness/local-credentials.ts`）。
  能读到该凭据文件即等于对该 harness home 有完整权限，因此自签是权限等价而非越权。
  由 `deepseekHarness.autoSession`（默认 `true`）控制；关闭后回退到 URL 粘贴流程。
- 实现见 `harness/auth.ts`；cookie 存在 `context.secrets`，不进 settings.json。

### 一元 RPC — `POST /api/<namespace>/<method>`

```jsonc
// 请求头
Cookie: dsh-auth-…=v1.…          // cookie 受限的 host 必须带（0.2.0-rc.2 对 /api/* 全部鉴权）
Content-Type: application/json
// 请求体：payload 把参数包在 { args: … } 里
{ "type": "client-request", "rpcId": "<uuid>", "method": "session/prompt",
  "payload": { "args": { "sessionId": "…", "mode": "queue",
               "content": [{ "type": "text", "text": "…" }] } } }
// 响应体
{ "type": "server-response", "rpcId": "<相同>", "result": { "ok": true, "value": { … } } }
```

端点在 0.2.0-rc.2 上是 **斜杠** `namespace/method`（`POST /api/session/prompt`）；`harness/wire.ts`
协商 slash 与 dot 两种风格，所有调用都经 `HarnessClient.ep()` 渲染，没有任何模块写端点字面量。
`payload` 是 `{ args: <声明的参数对象> }`——这正是 host 期望的 `client-request` 信封。
唯一遗留的坑：`session/list` 的参数名在历史上出现过三种写法（`_request`、`request`、无），
`negotiateWire` 会逐个尝试并缓存 host 接受的那种。

业务错误返回 `200` + `{ ok: false, error: { code, message, details } }`；
**端点不存在**则返回 **HTTP 404 + 纯文本 `not found`**（不是 JSON 信封），能力探测正是
借此区分"不存在"与"参数写法不对"。HTTP 状态码其它情况只表示传输层
（`401` 未认证 / `404` 端点不存在 / `415` 非 JSON）。

### 事件通道 — `WS /api/remote.mux`（*双向逻辑流 mux*）

0.2.0-rc.2 暴露的是一条**双向** WebSocket。客户端打开 `ws://<host>:<port>/api/remote.mux`
（实际路径来自 `WireProfile.muxPath`，不写死），随后发一帧 `open` 去订阅 `$events` 逻辑流：

```jsonc
{ "type": "open", "streamId": "<uuid>", "endpoint": "$events", "payload": { "args": {} } }
```

宿主以 `ready` 帧应答（承载在首个 `server-request` 信封的 `payload` 里），携带 `clientId` 与 `host.home`：

```jsonc
{ "type": "server-request",
  "payload": { "type": "ready", "clientId": "…", "host": { "home": "/home/tester" } } }
```

后续每帧都是 `server-request` 信封，其 `payload` 即事件（`type: 'session/event'` 等）。
助手流式增量**以 `session/event` 帧且 `event.type === 'assistant/chunk'` 的形式到达**——
没有独立的 `assistant/stream` 帧，因此 `conversation/model.ts` 已有的 `assistant/chunk` 折叠
无需改动即可处理流式。持久历史**不**在此通道下发：`getHistory()` 改为调用一元 RPC
`session/page`（`{ request: { address, throughSeq, beforeSeq?, maxMessages? } }`）。

`throughSeq` 是**日志游标，不是条数**，而且猜不出来。上游（`history.ts`）把 `-1` 解析成
空页、`0` 解析成"只要第 0 条"、越界则报 `gateway/bad-request … past cursor N`。唯一被认可
的来源是 **`session/follow` 开场帧里的 `snapshot.cursor`**——`SessionPageRequest.throughSeq`
的文档注释就是这么写的（"来自对应的 follow 开场帧"）。所以客户端把 follow 流交给它的每个
游标都记下来（`noteFollowCursor`，单调不回退），而 `getHistory()` 在**还没学到游标时直接返回
空页、一个请求都不发**。搞错的代价不只是显示问题：原先写死的 `0` 让历史永远是空的，
而且调用方会把空页折进模型——于是**每次 mux 重连都会把正在看的对话擦掉**。

**审批应答**：`POST /api/$events/result`，带 `client-request` 信封：

```jsonc
{ "type": "client-request", "rpcId": "<uuid>", "method": "$events/result",
  "payload": { "args": { "clientId": "…", "eventId": "…",
                         "outcome": { "kind": "result", "value": "allowed-once" | "rejected" } } } }
```

**`outcome.value` 就是宿主瀑布的返回值**，而这一条事实就是整份契约：

- 省略 `value`（裸 `{ kind: 'result' }`）等于用 `undefined` 结算瀑布。
  `ApprovalService.decide` 会把一切不在词表内的返回值——包括 `undefined`——归一化成
  `'unavailable'`：一次**静默的 fail-closed 拒绝**，而且照常写一条看起来完全正常的
  `approval/decided` 审计。这正是 v0.1.4 修掉的那个 bug：点"允许"从来没有允许过任何东西。
- 因此"拒绝"也必须是一个携带词表字符串的 **result**（`value: 'rejected'`）。把它编码成
  `{ kind: 'rejected', error }` 会**取消**瀑布，而 `decide` 里的 containment 又会把它
  归一化成 `'unavailable'`——这就是"拒绝被记成没有可用的审批通道"的由来。
- `{ kind: 'next' }` 放弃**本客户端**这次 delivery，把请求留给其它客户端；只有当没有别的
  delivery 时，宿主才会用 `next()` 结算。`delegateWaterfall()` 发的就是它，仅此而已。

词表为 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`；UI 只能产出前两个
（类型上叫 `ApprovalDecision`）。

`approval/request` 帧携带 `sessionId` + `eventId`（瀑布事件，在 mux 上已被观察到）；
`respondApproval()` 据此查帧，连同我们的 `clientId` 一起 POST 出去。上游 `agentId` 就是 SessionId，
所以能做会话级过滤。

**`user-questions/request` 是同一个传输上的同一条瀑布**——帧形为
`{ type: 'waterfall', event, eventId, agentId, request }`，`request` 的形状是
`{ questions: AskUserQuestionItem[], agent?, signal?, wait?: { callId } }`。
注意这里**没有 `sessionId`**：会话身份来自 Agent 的作用域，`wait.callId` 是唯一能关联回
工具行的线索。`respondQuestion()` 用 `{ answers: [{ id, selected: string[], custom? }] }` 应答，
其中 `selected` 装的是选项 **label**，不是下标。v0.1.4 之前控制器把这一帧整个丢在地上，
代价不只是少一张卡片：`ask_user_question` 在宿主侧**阻塞**着那次工具调用，
于是这一轮就停在没人能回答的状态里。

**撤销信号只有 `cancel`，没有别的。** 对 mux 客户端，`0.2.1` 不转发 `approval/resolved`
或 `question/resolved`；唯一表示"这个请求已经不能再答"的信号就是 `cancel` 帧。
客户端把它翻译成 `waterfall/resolved` 并撤掉卡片——否则在浏览器里答过之后，
VS Code 的卡片会永远点得动。

**信任围栏**（上游 `api-request-trust.ts` / `browser-auth.ts`）：`Host` 必须是回环地址或
在 `--trusted-host` 中，且（在 cookie 受限的 host 上）必须通过 cookie 校验。我们只连回环，
因此天然通过前者。

## 方法白名单

传输与消息——总是会调用（统一经协商出的 profile 路由）：

`session/list`、`session/create`、`session/prompt`、`session/cancel`、
`session/page`、`session/modelCatalog`、`workspace/create`。

控制面——**仅在能力探测确认该 host 提供时**才调用（见 `harness/wire.ts` 的
`probeCapabilities`），因此面对旧版 host 保持开启也是安全的。在 0.2.0-rc.2 上**存在**的集合是：

`session/fork`、`session/rename`、`session/selectModel`、`session/updateQueue`、
`workspace/archiveSession`、`commands/execute`、`commands/list`、
`session/search`、`session/attachment`。

（`agentPreset/*`、`subagent/*`、`host/describe`、`workspace/list`、`llm/models`、
`goal/*` 同样不存在，一律门控关闭。）

这里有一个值得点名的坑：**`session/attachment` 不是上传接口**，它是"按 id 读附件"
——`{ request: { sessionId, attachmentId } }` → `{ attachment, data: base64 }`。
早期版本把它当成上传路径、对着它猜内层描述符，结果无论发什么都是
`boundary validation failed`。真正上传**新文件**根本不走 RPC，也不在这张表里（见 F8）。

绝不调用：`settings/*`、`credentials/*`、`terminal/*`、`directoryPicker/*`，
或上表之外的任何审批/权限变更操作。

改动卡片的两条路由（`changes.summary`、`changes.diff`）**根本不是 RPC**，也永远不会出现在
这张表里——见[改动记录与撤销](#改动记录与撤销v018)。

## 控制面（`src/conversation/control.ts`）

harness 把各种旋钮以持久会话事件的形式下发，而且都是**全量值**：后写的覆盖先写的，
重放时必须仅凭日志还原状态，不依赖任何 catch-up 通道。这让 `ControlSurface` 成为一个
纯折叠——按序 apply 每个事件就是真相，无论它来自 `session/page` 历史还是实时的 `session/event` 帧。

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

写路径按上游实际提供的方式分两类。在 0.2.0-rc.2 上**命令注册表**（`session/command`）并不提供，
因此计划模式、权限预设、压缩**仅显示（来自线缆事件），不可从 VS Code 写入**；fork / rename /
archive / 模型选择 / 队列调速各有专用端点（`session/fork`、`session/rename`、
`workspace/archiveSession`、`session/selectModel`、`session/updateQueue`），每个都经实时的能力探测
门控；若宿主不提供，`requireControl` 抛 `HarnessUnsupportedError` 并在消息里点名缺哪个端点——
于是 UI 表现为「少几个控件」，而不是「几个按了没反应的按钮」。

## 附件（图片内联 / 文件两步，v0.1.3）

选文件发生在扩展宿主（webview 读不到本地磁盘），但**落地走的是两条完全不同的线**。
v0.1.0 那个"所有东西都 base64 走 `session/attachment`"的猜测两个方向都错了；真实契约是从
`deepseek-harness@0.2.1-alpha.2` 源码里读出来、再在真机上确认的。

**图片直接内联在 `session/prompt` 里。** `content` 是部件联合，图片部件为
`{ type: 'image', mediaType, data, name? }`，`mediaType` 取
`image/png | image/jpeg | image/webp | image/gif`。上游准入上限：单张 20 MiB、单条消息
20 张、单条消息合计 200 MiB。

**非图片文件根本不走 RPC**，而是一条裸 HTTP 路由：

```
POST /api/session/uploadFileBinary?sessionId=<id>&name=<leaf>
content-type: application/octet-stream
<原始字节>                            → { ok: true, value: { receiptId, file } }
```

随后 prompt 里用 `{ type: 'file', receiptId }` 引用它。注意 receipt 同时绑定**会话**与
`dsh web` **进程**——宿主重启即失效，所以"已暂存但没发出去"的文件必须重新上传。

**`session/attachment` 是读回路径，不是写入路径。** 给它一个 `attachmentId`（`sha256:<hex>`）
它返回 `{ attachment, data }`，插件凭这个就能在不重发字节的情况下把已存图片再缩略显示一次。

到日志里把这个引用找出来，才是形状真正咬人的地方，而且是**静默**地咬。三种持久消息记录的
嵌套方式**并不一样**（真机实测）：

| 记录 | content 在哪 |
| --- | --- |
| `user/message` | `data.content` —— 被提升的图片引用就落在这里 |
| `assistant/message` | `data.message.content` |
| `system/message` | `data.message.content` |

只读嵌套形式的话，带图的那条用户消息看上去就是空的：不报错，只是永远找不到引用。
`conversation/model.ts` 的 `blocksToText` 对用户记录读 `data.content` 正是因为这个，
而 `scripts/protocol-test.ts` 第 12d 步把三种形状都钉住了。

两个必须由 UI 承担的后果：

- **宿主可能"提升"而非原样存储。** `admitPromptContent` 会把内联图片变成
  `ImageAttachmentRef`（做归一化、还可能缩放），所以落库的消息带的是 `sha256:…`，
  不是客户端发过去的字节。真机实测：一张 73 字节的 PNG 经 `session/attachment` 读回来
  字节一致，但那是**宿主的副本**，不是我们的。
- **模型能力不发布，因此无法预判。** 不吃图的模型会让 prompt 失败并返回
  `session/attachment-invalid` + `details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES`
  （`packages/api/session-controller/src/commands.ts`）。`session/modelCatalog` 里
  对此只字不提，所以唯一诚实的做法是**把宿主的裁决透传**——`describePromptFailure()`
  把这一条码翻译成"去 Controls 换一个支持图片的模型"，并且**保留**已暂存的附件，
  让重试不必让用户重新选一遍。

**字节绝不进 `UiState`。** `pushState` 每个流式分片都会触发，所以 `pending` 只放 chip 元数据
（id / kind / name / 字节数 / mediaType），base64 留在 controller。webview 用本地
`URL.createObjectURL` 自建缩略图，controller 复用 webview 传来的 `key` 当 chip id——
预览图片因此永远不会穿过状态桥回传（那也会撞上 CSP）。

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

## 改动记录与撤销（v0.1.8）

"改了什么"有两份彼此独立的记录，它们不能互相替代：

| | 按调用的 review | 按回合的改动记录 |
|---|---|---|
| 由谁构建 | 文件工具自己的 `before`/`after` | Host 侧，在回合边界 |
| 覆盖范围 | 那一次文件工具写入的内容 | 这个回合动过的一切 |
| 能看见 shell 命令里的 `sed -i` 吗 | **不能** | **能** |
| 能否撤销 | 能——它带着文本 | 只能经由与之重叠的 review |

**review** 在 `tool/call` + `tool/result` 配对完成时创建，用它自己报告的前后文本。它是唯一
保留了足够文本、能把文件还原回去的来源。

**回合记录**根本不是本插件构建的。Host 的 `@deepseek-ai/dsh-workspace-changes` 插件在回合
开始与结束各对工作区做一次快照——走一个**私有 git 索引**、写进临时对象目录
（`GIT_OBJECT_DIRECTORY` + `GIT_ALTERNATE_OBJECT_DIRECTORIES`），git 经由它的 `subprocess`
能力调用——另外在 `write`/`edit`/会改盘的 `str_replace_editor` 调用前后留整份文件副本。
这就是它**也能覆盖 shell 命令里 `sed -i` 改掉的文件**（任何工具结果都不会提到那个文件）、
以及它是唯一描述「整个回合」而不是「其中某一次调用」的来源的原因。它记录的是 **hunk**，
不是整份文件文本——它是一份 diff，不是一份备份。

### 播报，以及两条路由

在每个**改动了东西**的顶层回合结束时，Host 追加一个持久 Session 事件：

```json
{ "type": "workspace/changes", "seq": 412, "data": { "turn": 7 } }
```

事件自己的 `seq` **就是**坐标——路由按它寻址，不按回合号：

```
GET /api/changes.summary?sessionId=<sid>&seq=<seq>          → ChangesSummary
GET /api/changes.diff?sessionId=<sid>&seq=<seq>&index=<n>   → ChangesDiff
```

三个性质值得记住：

- 它们是**普通的带鉴权 GET**，带查询参数，**在网关旁边而不是网关后面**。没有 `{args}` 信封，
  也不是 `/api/<ns>/<method>` 路径。`harness/client.ts` 的 `getRoute()` 处理这种形状：
  `401` 抛错（并接上认证缺失路径），**`404` 返回 `undefined`**，空正文返回 `undefined`，
  而如果未来的 host 决定包一层网关形状的 `{ok, value}`，会被拆开。
- **`404` 的意思是「没有卡片」，不是「出错」。** Host 只在 Session 生命期内把摘要留在内存里，
  所以宿主重启就会丢。`undefined` 的答复把卡片解析成空，与 Web UI 一致。*抛错*不一样，它会
  保留那一行——一次瞬时失败不能读成「这个回合什么都没改」。
- 还有第三条路由 `POST /api/changes.open`，它请求**桌面应用**打开文件。它被有意不用：VS Code
  自己的编辑器是更好的目标，而那条路由是面向 Windows/桌面的。

### 卡片位置与模型语义

卡片是 `kind: 'changes'` 的 `ConversationItem`，住在**对话流的工具行**里、紧挨产生它的那次
调用——不是独立的树视图。它带通常的 `uid`/`rev` 渲染身份，所以 v0.1.7 的调和器把它当普通
条目对待。

每回合一张卡，靠 `Map<turn, index>` 而不是靠追加来保证：

- 对一张已在屏幕上的卡片的**重复**播报，**替换**坐标（`seq`、`summary`）而不是叠第二张卡
  ——一个回合在 `turn/end` 重新记录时会播报两次；
- 解析为 `undefined` 的摘要把该行**解析**成存在但不画，而不是删掉它——删条目会让
  `toolIndexByCallId` 与 `changesIndex` 失效；
- 取数是**串行**的（`changesFetchChain`），并限制在最近 `MAX_CHANGES_TURNS`（10）个回合内，
  且在 `await` 之后重新核对当前会话 id，所以中途切换会话不会把摘要落进另一条对话流。

### hunk 重建，与 URI authority 契约

`hunksToSides()` 从 hunk 列表重建两侧：`+` 只落在 after 侧，`-` 只落在 before 侧，上下文两侧
都有，一行不属于某一侧就在那侧写 `''`。那个空行正是重点——没有它，两列会错位，比较读起来
像"什么都移动过"。

两个虚拟文档 provider 现在都从 **`uri.authority`** 读 id：

```
dsh-review://<reviewId>/<encoded-path>/before|after
dsh-changes://<id>/before|after
```

从 `path` 读就是 v0.1.8 修掉的那个 bug：
`Uri.parse('dsh-review://review-1/foo/before').path` 是 `/foo/before`——层级 URI 会保留开头
的斜杠——于是 `path.split('/')[0]` 是空字符串，store 查找永远不命中，经该 provider 打开的
每一个 diff 都是空白。

### 撤销，以及为什么没有「接受」

review 行只提供**回退**。没有接受的对位物，因为改动落到磁盘是在 review 能由它的结果建出来
**之前**——"接受"只能把一件事标记为已知悉，而一个除了暗示"此前一直在等它批准"之外什么也不做的
按钮，比没有这个按钮更糟。这是设计立场（README 里有完整表述）：**写盘归 DSH，插件只观察、
不设闸。**

回退本身是**把抓到的 `before` 文本写回去**，并带一道漂移闸：它先核对盘上的文件是否仍等于
review 建立时抓到的 `after`，如果此后动过就拒绝（把该文件标为冲突）。正是这道闸让"不用问
就能撤销"是安全的，也是它能说「不」的原因。

从回合卡片撤销的范围**限定在该回合产出的 review 内**，因为摘要只带路径与行数、不带可还原的
文本。把摘要路径映射到某个 review 文件分三轮尝试——精确、唯一后缀、唯一 basename——后两者
只在恰好**一个**候选命中时才作数，因为在多个之间猜会回退错文件。某个回合若只通过 shell
命令改了文件，它会直说，而不是假装执行。

hunk 级回退在 `ReviewMaterializer` 里是存在的（`rejectHunk`，同样的漂移闸），但已经没有 UI
能触达它——今天的回退是每文件全有或全无。恢复它就是路线图上的「部分回退」一项。

## Markdown 渲染

`markdown-it`（`html: false`、`linkify: true`、`breaks: false`）在 **webview 侧**运行——不在 extension host 中。这保持 `ConversationModel` 纯语义（发送原始 markdown 文本；webview 负责展示）。

- Assistant 消息：`body.innerHTML = md.render(item.text)`
- User / System 消息：`body.textContent = item.text`（无 markdown）
- Tool 结果：`<pre>`（无 markdown）
- 链接：`target=_blank rel=noopener`；`javascript:` / `data:` URL 被剥离
- `markdown-it.umd.min.js` 打包在 `media/` 目录中供 VSIX 使用

## 流式性能

`EventBuffer` 合并高频 `assistant/chunk` 帧，最多每 **30 ms** 刷新一次。`turn/end` 和
`assistant/message` 强制立即刷新，使 UI 即时定稿。

下面的「推送预算」说：一次推送必须真的有东西可推。但光有这条不够——流式推送**确实**有东西
可推，而 webview 仍然让它的代价随会话长度增长。下面两节是同一个问题的两半。

### 推送预算（v0.1.6）

`pushState()` 不便宜，而且它在真正要紧的意义上**不幂等**：webview 收到一次
`snapshot.renderVersion` 变了的推送，就会把 `#messages` 拆掉、逐条重建、并把每条助手消息
重新按 markdown 解析一遍。所以本仓库对自己的要求是：**一次推送必须真的有东西可推。**
有三处没做到，都在瀑布（waterfall）路径上：

- **瀑布事件推送两次。** `ApprovalStore` 通知自己的变更监听器，监听器调用
  `pushReviewApprovalState()`；而刚刚改完 store 的调用方紧接着又调了一次。两次落在同一个
  tick 里，中间没有绘制机会——第二次纯粹是白烧主线程。现在
  `pushReviewApprovalState()` 会先算一个
  `(sessionId, 模型版本, reviews, approvals, questions)` 的签名，没变就直接返回。
- **它还无条件 `model.touch()`。** `touch()` 会增加 `renderVersion`，而那**正是** webview
  的重建信号。但审批和提问根本不在对话流里画（`renderTool` 里写明了），所以那次重建是在
  为"什么都没变"付账。现在只有 **review** 这一片有资格 touch——review 卡片确实画在对话流
  的工具行里。顺带删掉了没人写、也没人读的 `ToolItem.approvalRpcId`。
- **`session/follow` 回调无条件推送。** 一批帧覆盖整个会话，所以一次普通的 flush 很可能只是
  把屏幕上的东西重放一遍。现在它会在批处理前后比对字段身份，只有真的动了才发布。

一条 72 条记录的会话上实测：一个瀑布事件从 2 次推送 / 约 70 KB / 2 次完整对话流重建，
降到 **1 次推送 / 35 KB / 0 次重建**；一次作答往返从 6 次 / 约 212 KB / 6 次重建降到
3 次 / 约 106 KB / 0 次。`scripts/protocol-test.ts` 第 I 组把推送次数和"`renderVersion`
没动"都断言住了——这里若回归，是测试失败，而不是"感觉有点卡"。

### 逐条增量渲染（v0.1.7）

`renderVersion` 每个流式分块都会变——这是有意为之，webview 就是靠它知道有新内容。错在
**消费端**：任何变化都意味着 `msgs.innerHTML = ''` 然后对每个条目调用 `renderItem()`，于是一个
分块会把屏幕上每一条助手消息重跑一遍 markdown-it、重建每一行。一个分块的代价因此正比于
对话流长度，一整轮的代价正比于它的平方。在一条 40 轮的对话上实测，每 40 个字符新文本：

| | 修复前 | 修复后 |
|---|---|---|
| 新建 DOM 节点 | 291 | 4 |
| markdown 解析次数 | 约 42 | 1 |
| 重解析的 markdown 字节 | 43 KB | 1.4 KB |

这个修法靠 `ConversationItem` 上的两个字段（见 `ItemIdentity`），都由
`ConversationModel.stamp()` 加盖：

- **`uid`** —— DOM key。只赋一次并保持，所以流式文本更新、工具行拿到结果都不变。它只在条目
  被**替换**时改变（流式占位符变成持久的 `assistant/message`），而那正是确实需要新节点的时刻。
  计数器是**模块级**而不是实例级：webview 按 `uid` 缓存节点，而为同一会话重建的模型
  （重连、fork、切换）若从头计数，就会撞上上一份对话流已缓存的那些行。
- **`rev`** —— 变更签名。条目的每次变更都会推进它，于是「这一行变了吗」是一次整数比较，
  而不是内容 diff。

`renderTranscript()` 拿 `snap.items` 与一张 `Map<uid, {el, sig}>` 做调和。`sig` 没变的条目
保留原节点——也就保留了它的子树和已解析的 markdown。被复用的节点是**先摘下再按序挂回**，
而不是重建；代价是指针操作，不是一次解析加一次 DOM 构建。工具行的签名里还折进了挂在它上面的
review（`reviewSigFor`），因为 review 卡片是画在工具行**内部**的，而 review store 可以在任何
条目都没动的情况下变化。

这个守卫还带来第二个更大的效果：一次只差 `renderVersion` 的推送——`session/follow` 的重放，
或由对话流不显示的字段驱动的状态——现在**不建任何 DOM、不解析任何 markdown**。
`scripts/protocol-test.ts` 第 K 组用计数 DOM 桩驱动真实的 `CLIENT_SCRIPT`，把这一点和
「一个流式分块只重画一行」都断言住了。

同一类毛病还有两处较小的贡献者，一并收掉：

- **`applyMuxFrame()` 按帧数重复投影模型。** 它在逐帧循环里构建完整 `snapshot()`
  （对每个条目做一次 filter 加一次展开），而一次 flush 装着一整轮的增量。现在整批只投影一次，
  且只在 `model.version` 真的动了时投影——调用方本来每批只发布一次，两个计数从此对齐。
- **会话 `<select>` 每次推送都重建。** 重建选项会在用户操作途中把选择丢掉。现在加了签名守卫。

#### 已知的剩余代价

流式推送仍然整份发送对话流：40 轮会话约 **52 KB/次**，跨 `postMessage` 做结构化克隆。渲染端
已不再重建它，所以常数不大，但它的体积仍随对话增长。要砍掉它需要在协议层做按条目的增量
（`UiState.snapshotPatch` 之类），那是协议变更，不在 0.1.7 里。

#### 已实测、并有意不改的地方

`captureFrame()` 每帧都 `JSON.stringify` 一次来填检查器环形缓冲区，而 0.1.6 只是让它在面板
关闭时不**发布**。实测：一个典型的 `assistant/stream` 增量约 **1.2 µs**，一条 20 KB 的
`assistant/message` 约 **47 µs**——按流式每秒约 33 帧算，合下来每秒钟几十微秒。改成惰性计算
意味着要留住最多 300 个活的 frame 对象，而不是 300 个截断到 2 KB 的字符串：拿有界内存换一个
舍入误差。不动。

### 检查器缓冲区的发布时机

`AppController.captureFrame()` 每收到一帧就写进一个 300 条的环形缓冲区（每条 `raw` 截断到
2 KB）。这个缓冲区**照常填充，但只在面板位于屏幕上时才发布**——面板是纯 webview DOM，
只有那一侧知道它是否可见，于是它用 `inspectorToggle` 动作把状态变化报上来。过去它搭上
每一次 `UiState` 推送，代价是 300 × 2 KB ≈ 600 KB 的结构化克隆（缓冲填满后单次推送实测
1,318,580 字节），去喂一个默认关着、根本不读它的面板。打开面板时会把攒下的缓冲一次性发布，
所以历史当场就在。另外列表渲染改为**整体重建**而不是追加：缓冲区是环形的、头部会移动，
每次追加整个数组会每帧多堆一份全部行，无限增长。

## 重连

`MuxStream` 以退避策略重试（250 ms → 5 s）。在 `closed → open` 转换时，`AppController` 调用 `refetchHistory(activeSessionId)` 并重建模型——Harness 文档化的恢复语义是**重建**，不是游标续传。

这道重建有两道保险：`refetchHistory()` **拿到空页绝不清屏**——如果 `session/page` 返回空
（还没学到游标，或者本来就是空的），它只记一条日志就返回，因为旧行为会在**每次重连时把
眼前正在看的对话擦掉**；而 `session/follow` 会重发快照，所以模型最终是从宿主的日志折出来的，
不是从屏幕上的残留拼出来的。

### Reconnect（为什么按钮常驻、而且总是强制）

`AppController.doConnect()` 就是一次**强制重连**，也是唯一建立连接的路径：激活、`Reconnect`
命令、状态行里的按钮、面板标题里的图标，走的都是它。

强制才是重点。Host 重启之后，客户端自己的状态会**停在 `connected`**——流只是不响了，没有
任何东西告诉过我们——而 `HarnessClient.connect()` 会在这个状态上直接早退。这个空档正是过去
"只能重载 VS Code 窗口"的原因。所以 `connect({force:true})` **先拆再谈**。

两条结构性约束保证这么做是安全的：

- **尝试是串行化的。** `doConnect()` 往一条 promise 链上追加，所以连点两下是排队等一次新的
  尝试，而不是在第一个 socket 之上再谈一个——那种情况下后者的拆除会顺手杀掉前者的流。
- **打开着的会话要活下来。** `disconnect()` 拆掉 `session/follow` 订阅，却把 `activeSessionId`
  留着，于是对话会停在屏幕上而背后没有任何东西在喂它。`runConnect()` 会先把 id 抓在手里，
  连接后重新选中它——重建模型、重新订阅、重拉历史，也就是上文那个"重建而非游标续传"。
  只有当 Host 上确实没有这个会话时才退回到最新的那个。

webview 的启动请求**故意不走**这条路：面板打开时发的是 `ensureConnected`
（`doConnect({force:false})`），因为光是把面板显示出来，不应该拆掉扩展宿主已经建立的会话；
强制的是按钮。

`package.json` 把 `deepseekHarness.reconnect` 无条件贡献到 `view/title`。它原先挂在
`deepseekHarness.offline` 条件上，而那种写法恰好把它在最需要的时候藏了起来——面板还写着
Connected、socket 其实已经死了。

### Host 发现（为什么端口可能是错的）

`dsh web` 默认落在 `127.0.0.1:3080`，所以固定端口在大多数时候是对的。**桌面端是例外，而且是
它的设计使然**：它用 `--port 0` 启动 Host（`apps/desktop-host/src/index.ts`），端口由系统每次
重新分配，只通过 Node IPC 报给 Electron，**不落盘**。所以"面板一直卡到我重载 VS Code"实际上
是"插件还指着上一次启动的那个端口"。

当 `connect()` 的失败原因**不是**鉴权拒绝时（鉴权拒绝意味着我们找到了 Host、是它说了不；
拿端口问题去回答凭证问题就答错了），`AppController.attachToDiscovered()` 会跑
`harness/discovery.ts`：

1. **钉住的端口** —— `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里的 `webserver.port`。
   手工解析，因为用户层可能带 `!!js` 标签，通用 YAML 解析器根本读不了。
2. **Host 自己的拒绝** —— 枚举操作系统的监听表（netstat / lsof / `/proc/net/tcp`），对每个
   候选发一次匿名 `GET /`。dsh Host 会答 `401` +
   `dsh web authentication required; reopen the URL printed by dsh web.`；这句话来自
   connection carrier 的栅栏而不是 web 前端，所以哪个入口启动的 Host 都会这么说——而且本机
   没有第二个服务会这么说。带 `--dsh-boot-bg` 的 `200` 作为次优选接受，那是给关掉了浏览器
   栅栏的部署留的口子。

探测监听表而不是扫端口区间是刻意的：几十个监听大约一秒就能问完，而扫 16000 个临时端口既慢
又没礼貌。`deepseekHarness.autoDiscover`（默认开）控制这一切。

采用的端口**只在本次会话内有效，绝不写入设置**——系统分配的端口每次启动都会变，写进去只会
给用户留下一个下次必然过期的钉子。本机实测：探测 46 个 loopback 监听，命中 1 个 Host，并
正确归因到 `desktop` profile 里钉的端口；同一次扫描里的普通 HTTP 监听器**不会**被采纳。

## 安全边界

`HarnessClient.connect()` 拒绝任何不在 `{127.0.0.1, localhost, ::1}` 中的主机，提示：

> v0.0.x only supports local DeepSeek Harness instances.

`approval/request` 帧从侧边栏的待答面板经 `POST /api/$events/result` 应答（见上文）。理由中声明了 full/unrestricted access 的请求不给内联 Allow，改为提供 **Answer in Web UI** 交回入口；门槛读的是理由，不是工具名允许列表。这里没有任何东西调用 `/api/respond`。

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
│   └── types.ts              # ConversationItem 联合类型（6 种）
├── workspace/
│   └── binding.ts            # findHarnessWorkspace / ensureHarnessWorkspace
├── approval/
│   ├── store.ts              # 两条瀑布共用的待答生命周期
│   └── types.ts              # PendingApproval / 待答提问的形状
├── review/
│   ├── controller.ts         # review 生命周期（store ↔ materializer）
│   ├── store.ts              # 逐文件、逐 hunk 抓取的 before/after
│   ├── materializer.ts       # 唯一真正写回退的模块
│   ├── virtualDocument.ts    # dsh-review:// before|after provider
│   ├── changesDocument.ts    # dsh-changes:// provider + hunksToSides
│   └── types.ts              # Review / ReviewFile / ReviewHunk
├── context/
│   └── collector.ts          # 编辑器上下文（活动文件、选区）
├── harness/
│   ├── protocol.ts           # 线缆类型（镜像 0.2.0-rc.2 Remote）
│   ├── wire.ts               # 协议协商 + 能力探测
│   ├── client.ts             # HarnessClient — 唯一网络边界
│   ├── auth.ts               # 浏览器会话 cookie 生命周期 + 本地自签
│   ├── local-credentials.ts  # 读取 $DSH_HOME/.credentials.yaml（autoSession）
│   ├── discovery.ts          # 找 Host：profile 里钉的端口 + 401 栅栏指纹
│   ├── events.ts             # RemoteMuxSocket (WS) + EventBuffer (30ms)
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
├── protocol-test.ts          # 假 harness 协议测试，295 项断言（无需 dsh web）
├── protocol-probe.ts         # 向真实 `dsh web` 询问它实际提供什么
├── integration-test.ts       # 针对真实 dsh 的闭环测试
└── gen-icon.ts               # 从 origin.png 生成图标
test/fixtures/                # 脱敏协议快照
```

## KV-cache / 稳定性说明

扩展自身不跨重连持有任何模型状态——每次重连都从 `session/page`（一元 RPC，返回会话日志的一页）重新派生，它就是 Harness 的真相源；协商出的 `WireProfile` 决定适用哪些端点名与参数写法。唯一的长期客户端状态是事件套接字下行链路与两个内存折叠 `ConversationModel` 和 `ControlSurface`，二者都在恢复时从 `session/page` 重建。这使得缓存一致性不言自明：只有一个缓存（Harness 会话日志），VS Code 只是它的一个视图。
