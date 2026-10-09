# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-10-10

Tagline: **修好了"能连上但收不到回话"，补上了图片与真正的文件上传，顺手拔掉两个静默 bug。**
Tagline (EN): **fix: the sidebar connected and then went silent; plus inline images, real file uploads, and two silent bugs.**

### Fixed

- **"Connected" 之后一片安静：会话流走的是另一条逻辑流。** 插件一直把传输层建模成
  "一条 `$events` 承载所有帧"。真机（`0.2.1-alpha.2`）上这个假设错得很隐蔽：`$events`
  确实会发一个 `ready` 帧（所以面板老老实实显示 "Connected"），然后**一条对话流量都没有**
  ——因为 `$events` 是一份固定的转发白名单（`api-session/status`、`approval/request`、
  `user-questions/request`、插件清单……）。对话在**另一条**逻辑流 `session/follow` 上，
  词汇表完全不同：`snapshot`（积压记录）→ `event`（持久记录）→ 实时 `assistant-stream`
  （`start`/`chunk`/`end`）。两条流现在各开一条 socket，`DownlinkSocket` 从"events 专用"
  改成通用的单逻辑流载体（`endpoint` / `openArgs` / `expectReady`）。真机验证：30 帧，
  `p` + `ong` → `pong`，模型快照 `Turn 1 — started / user / assistant pong / Turn 1 — completed`。
  *EN:* Conversation rides `session/follow`, not `$events`; the two streams are now opened
  separately and translated on their own vocabularies.
- **一条没有 `start` 的 `chunk` 会被丢弃，而不是猜个归属。** 只有 `start` 带
  `turn`/`step`，而 chunk 是进程内的（从不进持久日志），所以孤儿 chunk 没有正确落点——
  猜错就是把文本拼到别的回合上。
- **`api-session/status` 不再被丢掉。** 它从 `$events` 的转发帧翻译成 `session/status`，
  Stop 按钮的状态才对得上。
- **"没有这个方法"和"这个 workspace 不存在"被混为一谈。** 在真机上量出来的事实是：
  方法不存在 → **HTTP 404**（body 甚至不是 JSON 信封）；而 `session/rename` 指向一个已删除的
  会话 → 200 + `code: session/not-found`，`session/create` 拿到一个过期的 workspaceId →
  200 + `code: workspace/not-found`。`MISSING_METHOD_CODE` 里那个裸的 `/not-found/` 把后两者
  塌进了第一类，于是普通的业务错误被抛成
  *"this harness does not serve `session/create` — upgrade the host"*。现在只认
  dispatch 层的码（`gateway/method-unavailable`、`gateway/unsupported`、`unknown_method`、
  `method-not-found`、`unimplemented`）；带域命名空间的一律按业务错误处理，
  原样把宿主的措辞交给调用方。附带两个效果：参数形状的重试逻辑不再提前放弃；
  一个过期 id 不会再劝用户去升级宿主。
  *EN:* A bare `/not-found/` made the client report business errors
  (`workspace/not-found`, `session/not-found`) as missing capabilities. Narrowed to
  dispatch-layer codes.
- **`@` 浮层曾根本打不开。** `queryFileReferences` 拿 `UiState.refQuery`（**上一次回复**
  所回答的查询，初始是 `undefined`）当陈旧守卫，于是第一次敲 `@`（查询为空串）就被自己的
  守卫挡掉，什么都没发布；即便绕过了守卫，成功分支也只写 `refCandidates` 而不写
  `refQuery`，而 composer 只接受能匹配上查询的那批结果——菜单永远是关着的，还一声不响。
  现在守卫比的是"最近一次请求的查询"（单独跟踪的 `refQueryLatest`），且两个字段**一起**
  发布。这个 bug 的教训是：协议层断言再多也抓不到"某个字段压根没写"，
  所以新增的断言直接检查**发布出去的 state**，并用真控制器 + 真 client 打假宿主。
  *EN:* The `@` completion menu could never open: the staleness guard compared against
  the query the last *reply* answered (initially `undefined`), so a bare `@` swallowed
  its own request, and the success path published candidates without the matching query.
- **历史永远是空的——而且每次重连都会把对话擦掉。** `session/page` 一直写死
  `throughSeq: 0`。但 `throughSeq` 是**日志游标**，不是条数：上游 `history.ts` 把 `-1`
  解析成空页、`0` 解析成"只要第 0 条"、越界则报 `gateway/bad-request … past cursor N`。
  唯一被认可的来源是 `session/follow` **开场帧**里的 `snapshot.cursor`
  （`SessionPageRequest.throughSeq` 的文档注释原话就是"来自对应的 follow 开场帧"）。
  现在客户端记录 follow 流交给它的每个游标（单调不回退），而 `getHistory()` 在还没学到
  游标时**直接返回空页、一个请求都不发**。更要命的是第二层：调用方会把空页当事实折进模型，
  于是**每次 socket 重连都会把眼前正在看的对话清空**——现在空页只记一条日志，绝不清屏。
  *EN:* `throughSeq` is a journal cursor, not a count; the hard-coded `0` made history
  permanently empty and the resulting empty page erased the live transcript on every
  reconnect. The cursor now comes from the `session/follow` opening frame, and an empty
  page no longer clears the screen.
- **参数形状重试把记住的正确形状排在最后试。** `rpc()` 的候选顺序是
  `[...all.filter(没记住的), 记住的那个]`，于是**每次调用都先白烧两次失败往返**才轮到对的那个；
  更糟的是最终停在哪个 `inner` 形状取决于宿主的宽容度，同一个会话里可能漂移。
  改为**记住的形状优先**（`[all[remembered], ...其余]`）。这条是修上面那条历史问题时
  被顺带照出来的：断言在"历史为空"的假象下暴露了 `inner` 停在 `_request` 形状。
  *EN:* The remembered endpoint shape was tried *last*, so every call burned two failing
  round-trips first and the wire shape could drift with host leniency. Now tried first.

### Added

- **图片支持：粘贴 / 拖拽 / 选文件 → 待发 chip → 内联进 `session/prompt`。**
  剪贴板图片、往输入区拖拽、或 `Attach File to Session` 命令，都会在输入框上方排成一条
  待发附件（带本地缩略图）；点发送时图片作为内联部件
  `{ type: 'image', mediaType, data, name? }`（`png/jpeg/webp/gif`）随 prompt 发出。
  只发图片不发文字是合法的。契约不是猜的——是从
  `deepseek-harness@0.2.1-alpha.2` 源码读出来、再在真机上跑通的：宿主上限为单张 20 MiB、
  单条 20 张、合计 200 MiB；`admitPromptContent` 会把内联图片**提升**为
  `ImageAttachmentRef`（做归一化、可能缩放），所以落库的是 `sha256:…` 而不是客户端发去的字节。
  **模型能力不发布、无法预判**：不吃图的模型会让 prompt 失败并返回
  `session/attachment-invalid` + `details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES`，
  `describePromptFailure()` 把这一条码翻译成"去 Controls 换个支持图片的模型"，
  并且**保留**已暂存附件让重试不必重选。
  *EN:* Images ride `session/prompt` as inline parts (paste / drop / picker → staging chips);
  model image support is unpublished, so the host's refusal code is translated and the
  staged attachments are kept for the retry.
- **非图片文件走真实上传路径。** 旧代码把字节往 `session/attachment` 上怼，但那根本不是上传
  接口——它是"按 id 读附件"`{ request: { sessionId, attachmentId } }` →
  `{ attachment, data }`，这也正是当初无论发什么都是 `boundary validation failed` 的原因。
  真正的上传是裸 HTTP：`POST /api/session/uploadFileBinary?sessionId=<id>&name=<leaf>`，
  `content-type: application/octet-stream`，body 是原始字节，返回
  `{ ok: true, value: { receiptId, file } }`；prompt 里用 `{ type: 'file', receiptId }` 引用。
  注意回执同时绑定**会话**与 `dsh web` **进程**，宿主重启即失效。
  *EN:* File upload goes over `POST /api/session/uploadFileBinary` (raw bytes → receipt);
  `session/attachment` is the read-back path, which is what the old code got wrong.
- **自动连接失败时有得点了：状态行 `Connect` 按钮 + 标题栏插头图标。**
  自动连接是尽力而为，本机实测在宿主一切正常时 `auth` 也可能返回未就绪——把可用性押在
  一次成功的自动连接上，失败时用户面对的就是"没得点、也没得读"。现在状态行按钮三态如实
  （`Connect` / `Retry` / `Connecting…`，进行中禁用），并在 `package.json` 里贡献一条
  `view/title` 菜单，`when` 为 `view == deepseekHarness.sessionView && deepseekHarness.offline`，
  于是插头图标**只在未连接时**出现。上下文键边沿触发，`start()` 里先置 `true`，
  按钮从第一帧起就可见。（"auth 为什么返回未就绪"仍是未解问题——按钮是地板，不是修复。）
  *EN:* A manual `Connect` button (status row, three honest labels) plus a context-key-gated
  `view/title` plug icon, so a failed auto-connect is no longer a dead end.
- **附件字节永不进 `UiState`。** `pushState` 每个流式分片都会触发，所以 `pending` 只携带
  chip 元数据（id / kind / name / 字节数 / mediaType），base64 留在 controller；
  webview 用本地 `URL.createObjectURL` 自建缩略图，controller 复用 webview 传来的 `key`
  当 chip id——预览图片因此永远不穿过状态桥回传（那也会撞上 CSP）。
- **`@` 引用改用宿主自己的语法，且不再粘贴正文。** 原来的 `@file:path` + `readFileSync`
  内联是插件自己发明的：宿主早就有一套，语法不同，还自带补全源。现在支持
  `@path`、`@"含空格的 path"`、`@dir/`，可带 `:L<n>` / `:L<n>-L<m>`；
  `someone@example.com` 不会被误判成引用（必须行首或空白之后才触发）。补全走
  `fileReferences/list`，它的描述符是位置的 `(agentId, query)`——**内层 args 是裸对象，
  没有 `request` 包装**。除了对齐，还有个实际收益：内联会让提示随文件大小变长、并且每轮
  都改动前缀，等于每次发送都作废 KV cache。
- **`@` 补全浮层。** 90ms 防抖、陈旧响应丢弃、`mousedown` 而非 `click` 选中，引用文本的
  转义与宿主的 `formatFileMention` 逐字节一致。回复里的查询只有是当前 token 的**前缀**时
  才继续沿用（正常快速输入的情形），否则等自己的回复——避免每敲一个字就闪一次空，
  又不会拿无关的结果顶上去。

### Removed

- **`DeepSeek Harness: Set Session Token from Launch URL` 命令及其标题栏菜单项。**
  从 `$DSH_HOME/.credentials.yaml` 本地自签已经是实际唯一可用的路径；一个每次 `dsh web`
  重启都换的 token 只剩维护成本。连接失败时的报错改为点名那个凭据文件和 `autoSession`
  设置（后者的含义现在是"拒绝自签"，不再是"弹个框问我要 token"）。

### Verified

- 回归门 **108 → 178 项**。假宿主按 `0.2.1-alpha.2` 重建（`$events` 白名单 + `session/follow`
  流），新增断言把两条流的 open payload、快照回放、`api-session/status` 翻译、`waterfall`
  审批信封、"孤儿 / 迟到 chunk 必须被丢弃"，以及"业务级 `x/not-found` 不是能力缺失"全部钉死。
  本轮又补了四组：`session/attachment` **读图**形状 vs. 暂存两条路、三种 prompt content 组合
  （纯文本 / 图+文 / 纯图）、`session/page` "无游标不发请求、有游标才透传"、
  `session/follow` 快照教会客户端游标；假宿主也补上了 `uploadFileBinary` 的**原始字节**路由
  （连 415/400 边界一起）。第 G 组新增六条 Connect 按钮断言（已连接时隐藏、断开时显示可点的
  `Connect`、失败后显示 `Retry`、连接中显示 `Connecting…` 且禁用）。
- **真机集成测试 16 → 21 项全绿**，新增的 08b 段落跑的是**真图闭环**：遍历 `modelCatalog`
  找到肯收图的模型路由（默认 `deepseek-v4-flash` 被拒、`deepseek-flash` 收下）→ 内联发图
  → 落库后经 `session/page` 找到持久的图片引用（`sha256:97a3a410…`）→
  `session/attachment` 读回 73 字节并校验 PNG 签名 → `uploadFileBinary` 拿到回执 →
  再发一条引用该回执的 prompt 并被准入。顺带修掉了测试自身的两个问题：① 原先硬要求
  `DSH_LAUNCH_URL`（一个得从终端里手动复制、且随进程失效的 token），现在默认走本地自签，也就是扩展实际用的
  那条路，启动 URL 换 token 保留为可选路径；② 第 03 步把 `listWorkspaces()` 派生的
  **路径形** `workspaceId` 直接喂给了 `session/create`。workspace 是两步的：先从
  `session/list` 派生，再用 `workspace/create` 归一化——这正是
  `ensureHarnessWorkspace()` 做的事，现在测试也照做。
- 仓库链接 `liangwythu` → `YichuAI`（仓库已迁移）。

## [0.1.2] — 2026-10-09

Tagline: **修复：webview 脚本自 v0.0.4 起就是语法错误的——面板其实从未启动过。**
Tagline (EN): **fix: the webview script had been invalid JavaScript since v0.0.4 — the panel never actually booted.**

### Fixed

- **面板"永远 Disconnected"的真正根因：webview 脚本是一个语法错误的 JS。**
  `src/view/client.ts` 的脚本是**模板字符串**，`tsc` 看不到里面的内容。里面混进了一句
  TypeScript：`const bits: string[] = [];`。浏览器解析这段脚本时直接抛
  `SyntaxError: Missing initializer in const declaration`，于是**整个脚本从头到尾没有执行**——
  第 1030 行那条 `window.addEventListener('message', …)` 从未注册，面板永远停在
  `html.ts` 里写死的静态占位 `<span id="status-text">Disconnected</span>`，所有按钮全部失效。
  这条错误由 **v0.0.4（commit `ac1cb2c`）** 引入，**v0.0.8 / v0.0.9 / v0.1.0 / v0.1.1
  每一个发布版本都带着它**。这也解释了为什么 v0.1.1 修好工作区发现之后面板仍然
  "Disconnected"——工作区那条修复是必要的，但不是充分的：面板压根没在运行。
  *EN:* A TypeScript annotation inside the webview template string made the whole
  client script a syntax error, so it never executed and the panel stayed on the
  static "Disconnected" placeholder with dead controls. Present since v0.0.4.
- **同一模板转义坑的第二处：`/^\/\S*$/` 被吃掉反斜杠。** 模板字符串会把 `\/` 变成 `/`、
  `\S` 变成 `S`，于是 Slash 补全的判定正则变成 `/^/S*$/`（`Invalid regular expression flags`）。
  已改为等价的、不依赖斜杠转义的写法，并在注释里标明这个坑（与既有的 `AT_FILE_RE` 注释一致）。
  *EN:* The template literal also ate the backslashes in the slash-command regex;
  rewritten without needing slash escapes.

### Hardened

- **启动失败不再静默。** 脚本开头装了 `window.addEventListener('error', …)` 兜底：
  今后任何启动期异常都会把原因直接打印在消息区，而不是把一个"看起来是 Disconnected、
  其实是死的"面板留在那里。
- **markdown-it 降级路径修好。** 覆盖链接渲染器的那段代码此前无条件访问
  `md.renderer.rules`；而扩展在没有 markdown-it UMD 时用的兜底 stub 恰好没有
  `renderer`，于是**兜底本身就会让脚本崩溃**（"优雅降级"其实不优雅）。现在加了特性判断，
  并让 provider 的兜底 stub 也带 `renderer.rules`，两条路都能启动。
- **webview 脚本纳入回归门（新增第 G 组断言）。** 三条检查：
  ① 脚本必须能被 `new Function()` 解析（任何 TS 语法泄漏、被吃掉的反斜杠都会在这里现形）；
  ② 脚本里每一个 `$('id')` 都必须在 HTML 骨架里有对应元素；
  ③ 用 DOM 桩**真实启动**脚本并投喂一份 state，断言能注册监听并把状态渲染成 `Connected`
  ——正常 markdown-it 与"无 markdown-it 兜底"两种模式各测一遍。
  回归门 **102 → 108 项断言**全绿。

### Verified

- 用真实传输代码对本机 `dsh web`（`127.0.0.1:3080`）连接：`connecting → connected`，
  `session/list` 返回 1 条、`listWorkspaces` 派生 1 个工作区（`default-workspace`）。
- 把 webview 脚本单独导出后 `node --check` 通过；DOM 桩启动测试两种模式均
  `render(state) → status-text = "Connected"`。



## [0.1.1] — 2026-10-09

Tagline: **修复：工作区发现恒为空导致面板永远显示 Disconnected。**
Tagline (EN): **fix: workspace discovery always returned empty, so the panel stayed "Disconnected".**

### Fixed

- **工作区绑定不再恒为空（`listWorkspaces`）。** 该方法此前是一个硬编码的空数组桩，
  注释写"等 projection 接上再说"。后果是连锁的：`findHarnessWorkspace()` 对空数组
  做 `find()` 必然返回 `undefined` → `binding.harness` 永远不赋值 → 面板一直停在
  **Disconnected**，尽管握手、鉴权（cookie + ready 帧）全部正常。唯一能走通的路径
  是发送时的 `createWorkspace()` 兜底，而它只活在内存里，窗口一重载就还原。
  现在改为**从 `session/list` 的 `cwd` 派生工作区注册表**——这正是原注释指明的路径。
  rc.2 没有 `workspace/list`（真机 HTTP 404，宿主源码零匹配），但每条 `session/list`
  记录都带宿主规范化的 `cwd`，且这些目录与工作区注册表 1:1（工作区以路径为键，
  对已存在路径调用 `workspace/create` 会返回既有工作区且 `created:false`）。
  *EN:* `listWorkspaces()` derives the registry by grouping `session/list` rows on
  their host-canonical `cwd`, instead of returning a hard-coded empty array that
  made workspace binding impossible and left the UI permanently "Disconnected".
- **派生的 workspaceId 不再被当作宿主 id 写入。** 派生出的 `workspaceId` 就是路径，
  直接传给 `session/create` 是错的。现在写入前统一走一次幂等的 `workspace/create`
  取回宿主签发的权威 id（`WorkspaceBinding.confirmed` 标记，避免重复确认），
  `newSession()` 与 `sendPrompt()` 均已改道。

### Verified

- 真机（`127.0.0.1:3080`）验证：1 个 session、1 个 distinct cwd → 派生 1 个工作区，
  `title` 取自目录名，中文路径正常。
- 回归门 **95 → 102 项断言**全绿；新增断言覆盖派生条目数、cwd 聚合、排序、
  "从不调用 workspace/list" 以及 `findHarnessWorkspace` 端到端解析。
  同时修正两条被新数据推翻的旧断言（session/list 条数、以及那条断言
  "listWorkspaces 应为空"的用例——它正是本次要推翻的行为）。

## [0.1.0] — 2026-10-01

Tagline: **会话级工具链 — 全文搜索、实时事件检查器、附件上传。**
Tagline (EN): **session tooling — full-text search, live event inspector, file attachments.**

v0.0.9 补齐了交互闭环；v0.1.0 把三类"会话级工具"接入侧栏：搜回旧会话、看清线上
每一帧、把本地文件交给 agent。三个功能都走 rc.2 已证实存在的端点，且全部由能力
探测门控——宿主不提供时按钮照常显示但动作给出明确解释，绝不渲染死按钮。

### Added

- **F6 会话搜索（`session/search`）。** 侧栏新增 🔍 面板：输入全文关键词，返回
  会话标题 + 命中摘要，点击直接跳转到该会话。请求形状为
  `{ request: { query } }`（真机实证）。
  ⚠️ **部署开关**：本机 `dsh web` 当前**禁用**了 session search（宿主回答
  `gateway/internal: session search is disabled`）。此时面板显示
  "Search is disabled on this host deployment" 而非报错崩溃；在启用搜索的
  部署上开箱即用。
  *EN:* full-text session search panel (query → title + snippet → click to
  jump). Gated by capability probing; a deployment with search disabled shows
  a clear notice instead of an error.
- **F7 实时事件检查器。** 侧栏新增 📡 面板：把插件收到的**每一帧** mux 消息
  （`session/event`、`assistant/stream`、`stream/error`…）按序号/时间/类型/
  摘要流水展示，点击任意一行复制该帧的完整 JSON（截断至 2 KB）。环形缓冲
  保留最近 300 帧，可一键清空。**零新协议**——数据完全来自插件已在消费的
  事件流，对宿主零额外请求；排查"为什么 agent 做了这件事"时不必再开 Web UI。
  *EN:* live event inspector — every mux frame the plugin sees, listed with
  seq/time/type/summary; click a row to copy its raw JSON. 300-frame ring
  buffer, one-click clear, zero extra host traffic.
- **F8 附件上传（`session/attachment`）。** 侧栏新增 📎 按钮与命令
  `DeepSeek Harness: Attach File to Session`：选择本地文件（可多选）后以
  base64 经 `{ request: { sessionId, attachments: [{ name, content }] } }`
  发给宿主，由 agent 在后续回合消费。
  ⚠️ **形状坦白**：宿主确认该端点为 JSON + `{request}` 包裹，但**内部
  descriptor 未能通过盲探钉死**（所有猜测形状均答 `boundary validation
  failed`，multipart 被 415 拒绝即排除）。本实现采用最可能的内部形状并在
  错误时把宿主原文透传；在本部署上若形状不符会得到明确报错而非静默失败，
  待上游 schema 可读后一处常量即可修正。
  *EN:* attach local files (multi-select, base64) to the active session.
  The `{request}` wrapper is empirically confirmed; the inner descriptor could
  not be pinned by blind probing and is documented as best-known-shape with
  verbatim error passthrough.
  - **更正（见 [0.1.3]）**：上面这条描述的上传线**从未存在过**。
    `session/attachment` 是"按 id **读**附件"，不是上传接口；图片内联在 `session/prompt`，
    真正的文件上传走 `POST /api/session/uploadFileBinary`。
    *EN:* The upload wire described here never existed — see [0.1.3].

### Changed

- **能力探测集合扩容。** `session/search`、`session/attachment` 加入
  `CONTROL_METHODS`，连接时与其它控制面方法一起探测；侧栏据此门控。
  *EN:* both endpoints join the probed control set and gate the new UI.
- **回归门扩到 95 项断言。** 假 harness 新增 `session/search`、
  `session/attachment` 端点；覆盖两方法的返回值解析与 `{request}` 信封形状。
  *EN:* regression gate grown to **95 assertions**.

### Notes

- F7 的检查器帧缓冲在扩展宿主内存中（每帧截断 2 KB、上限 300 帧），不落盘、
  不外发；重启侧栏即清空。
- F6/F8 在不提供端点的旧宿主上自动隐藏为不可用提示——与 fork/rename 等
  既有控制面的门控策略一致。

## [0.0.9] — 2026-10-01

Tagline: **交互闭环 — 模型选择器、审批自动通过、排队/转向、Slash 命令、Token 用量面板。**
Tagline (EN): **the interaction loop — model picker, auto-approve, queue/steer, slash commands, token usage panel.**

v0.0.8 把线缆钉死到了真实契约（`0.2.0-rc.2`）但控制面只读；本版本补齐 P1 交互闭环，
并新增 Token 用量统计（含官方网页同款的缓存命中率）。

### Added

- **F1 模型 + 推理强度选择器。** `session/modelCatalog` 拉取目录（分组/模型/推理档位），
  `session/selectModel` 下发切换；UI 按能力探测门控。
  *EN:* model + reasoning-effort picker backed by `session/modelCatalog` /
  `session/selectModel`, capability-gated.
- **F2 审批自动通过。** 新设置 `deepseekHarness.autoApproveApprovals`（默认 `false`）：
  开启后插件对 `approval/request` 自动回 `allowed-once`（走既有 `/api/$events/result`）。
  *EN:* auto-approve incoming approval requests via the new setting (off by default).
- **F3 沙箱模式切换。** v0.0.8 只渲染 `sandbox/mode`，本版本可切换（与 permission 面板同构）。
  *EN:* the sandbox-mode control now switches, not just renders.
- **F4 排队 / 转向消息。** 队列条渲染 `inbox.next-turn` 投影；运行中可 steer 注入当前回合
  （`session/prompt` mode:'steer'）或 `session/updateQueue` 转向/移除队列项。
  *EN:* queued-message bar with steer/remove (`session/updateQueue`) and
  steer-mode prompts (`session/prompt`).
- **F5 Slash 命令面板。** 输入 `/` 弹出 `commands/list` 注册表补全；执行走 **`commands/execute`**
  （`{agentId, line, submittedAttachments:[]}`）。
  *EN:* slash-command completion popup from `commands/list`; execution goes through
  `commands/execute`.
- **Token 用量面板。** 双通道数据：`assistant/message.data.usage` 事件折叠 +
  `session/list` 投影（权威全量）。展示输入/输出/缓存读/缓存写/推理 token、
  总量与**缓存命中率**（官方网页同口径），以及回合/步数/LLM 耗时等会话统计。
  *EN:* token-usage panel (input/output/cache-read/cache-write/reasoning, totals,
  cache-hit percentage) folded from events and reconciled with host projections.

### Fixed

- **`session/command` → `commands/execute`。** v0.0.8 的 `runCommand`（plan/permission/compact
  命令路径）依赖 rc.2 **不存在**的 `session/command`，对真机永远是 404。现改为真机写路径
  `commands/execute`。*EN:* slash-command execution moved from the non-existent
  `session/command` to the real rc.2 write path `commands/execute`.
- **`session/prompt` 补 `requestId`**（rc.2 必填的客户端自签身份），并支持 `mode` 参数。
  *EN:* prompts now carry the required client-minted `requestId` and a `mode`.
- **`session/selectModel` 参数修正**：`{request:{sessionId, provider, model, reasoningEffort?}}`
  （provider 必填）；`session/updateQueue` 走 `{request:{sessionId, itemId, action}}`。
  *EN:* corrected arg shapes for `selectModel` (provider required) and `updateQueue`.

### Changed

- 回归门扩到 **91 项断言**（假 harness 新增 `commands/execute`、`commands/list`、
  rc.2 形状的 `modelCatalog`；覆盖 selectModel/updateQueue/prompt-requestId/commands 形状）。
  *EN:* regression gate grown to **91 assertions** covering the new methods and shapes.

## [0.0.8] — 2026-09-19

Tagline: **the real wire contract — DeepSeek Harness `0.2.0-rc.2`.**

v0.0.7 was released against an inferred `0.1.0-rc.6` model that still did not match
the host actually running on the machine (which is **`0.2.0-rc.2`**). The handshake was
verified live against that host, and the transport layer is now rewritten to its real
shape. This release pins the documented contract to what the host truly serves.

### Fixed (wire contract corrected to 0.2.0-rc.2)

- **Unary RPC envelope.** Calls are `POST /api/<ns>/<method>` (slash style) with body
  `{ type:'client-request', rpcId, method, payload:{ args:<inner> } }` — `payload` **must**
  wrap `{args}`. The inner field is `_request` for `session/list`, `request` for most
  methods, and `{}` for the few no-arg ones.
- **Response envelope.** `{ type:'server-response', rpcId, result:{ ok, value|error } }`.
  A missing method returns **HTTP 404 + plain-text `not found`** (not a JSON error), so
  capability probing distinguishes "absent" from "wrong arg shape".
- **Event socket.** `ws://host:port/api/remote.mux` — a **bidirectional** logical-stream
  mux. The client opens it and sends `{ type:'open', streamId, endpoint:'$events',
  payload:{args:{}} }`; the host's first frame is `{ type:'ready', clientId, host:{ home } }`.
- **Approval flow.** The wire event is `approval/request` (rendered as
  `approval/requested`); it is settled by `POST /api/$events/result` with body
  `{ clientId, eventId, outcome }` — not the old `/api/respond`.
- **History.** Fetched via the unary `session/page` RPC, **not** `session/history`.
- **Auth.** The host requires the browser-session cookie on every `/api/*` call (401
  without it). autoSession still mints it locally from `$DSH_HOME/.credentials.yaml`.

### Changed

- **Transport rewrite (rc.2).** `harness/protocol.ts` (envelope + arg spellings),
  `harness/events.ts` (`RemoteMuxSocket` + `ready`-frame handling), `harness/client.ts`
  (slash endpoints, `{args}` payload, `$events/result` approval, `session/page` history),
  and `harness/wire.ts` (negotiation + capability probing) now target `0.2.0-rc.2`.
- **Control-surface capability set (rc.2).** Present: `session/fork`,
  `session/rename`, `session/selectModel`, `session/updateQueue`,
  `workspace/archiveSession`, `session/page`, `workspace/create`, `session/modelCatalog`.
  **Absent** in rc.2: `session/command`, `agentPreset/*`, `subagent/*`, `host/describe`,
  `workspace/list`, `llm/models`, `session/history`, `goal/*`. The UI gates each control
  on a live probe, so older/newer hosts simply show fewer controls.
- **Regression gate rewritten.** `scripts/protocol-test.ts` now drives a real rc.2 fake
  harness (slash endpoints, `{args}` wrapper, `/api/remote.mux` + `ready` frame,
  `$events/result` approval, `session/page` history, 404-not-found probing, rc.2 control
  gating) — **83 assertions pass**, no `dsh web` required.
- `scripts/protocol-probe.ts` reports the negotiated rc.2 control surface.

### Notes

- Endpoint strings still go through `WireProfile` (negotiated slash/dot + arg spelling),
  so a future host that flips any axis keeps working without a code change.

## [0.0.7] — 2026-09-30

> ⚠️ **Protocol correction.** This release targeted an *inferred* `0.1.0-rc.6` model that
> still did not match the host actually running on the machine. The real contract is
> **`0.2.0-rc.2`** — see [0.0.8] for the corrected transport layer.

Tagline: **握手成功——连上真实的 `dsh web`（rc.6）。**

插件此前按一个并不存在的线缆契约（`0.1.6-alpha`）实现，而本机真正安装的运行时是
`0.1.0-rc.6`，两者并不兼容：rc.6 没有 `ready` 帧、没有 `$events` 逻辑流 mux、没有
`session/follow` 流、也没有 `$events/result` RPC。于是 v0.0.6 在 **Windows 和 Ubuntu**
上都卡在死等一个永远不会到达的 `ready` 帧（10 秒超时）。本版本用真实的 rc.6 传输模型
替换掉那套虚构模型。

### Fixed

- **握手不再超时。** 事件套接字改为下行单向 WebSocket（`ws://…/api/events.mux`）；连接打开即就绪信号，
  因此 `connect()` 在套接字一打开就继续，而不再死等某个帧。
- **正确的 RPC 信封。** 一元调用发送 `POST /api/<ns>.<method>`，`payload` 就是参数对象本身
  （`callUnary` 的契约）——绝不再包一层 `{args}` / `{request}`。整套 `RemoteStreamMux` /
  `session/follow` / `$events/result` 机制已删除。
- **历史改回一元 RPC。** `getHistory()` 调用 `session.history`（`{ sessionId, maxMessages? }`）
  并折叠返回的事件；已删除的 `session/follow` 快照路径被移除。
- **审批改走 `POST /api/respond`。** `approval/requested` 帧携带 `sessionId` + `approvalId`；
  `respondApproval()` 用这对信息 POST 一个 `client-response` 信封。
- **恢复 `host.describe`。** 该端点在 rc.6 中存在，连接时调用一次以获知 host 身份
  （version/cwd/provider/model）。

### Changed

- **`harness/client.ts` 按 rc.6 契约重写**；`events.ts` / `protocol.ts` / `wire.ts` 修正为真实的帧形状
  （`server-request` 信封、`session/event` 以 `assistant/chunk` 承载流式）。UI 层
  （`controller` / `view` / `control`）未改动——它们消费的本来就是正确的 `MuxFrame` 联合类型。
- **回归门已更新。** `scripts/protocol-test.ts` 现在用真实的 rc.6 假 harness 驱动真实传输
  （86 项断言：协商、mux 下行、host.describe、session.history、/api/respond、控制面，以及对受限
  host 跑 autoSession cookie 机制）。

## [0.0.6] — 2026-09-19

Tagline: **the control surface — the knobs the harness has always shipped.**

The host has been sending `plan/mode`, `permission/preset`, `sandbox/mode`,
`todo/write`, `goal/change`, `subagent/*` and `compaction/*` all along, and the
plugin rendered none of them. That made the sidebar look half-finished next to
the official Web UI even though the session itself was shared. This release
shows them and — where the host allows — lets you change them.

### Added

- **`src/conversation/control.ts` — the control-surface fold.** Those events are
  *whole values* upstream (the latest occurrence wins, and replay must
  reconstruct state from the log alone), so the fold is a pure last-write-wins
  projection over history plus live frames. `request/header` additionally yields
  the effective provider / model / reasoning effort.
- **Capability probing.** `wire.ts` now asks the host which control methods it
  serves (`session/command`, `session/fork`, `session/rename`,
  `session/selectModel`, `workspace/archiveSession`, `agentPreset/*`,
  `subagent/list`, `llm/models`) and caches the answer on the profile. Probes
  send empty args on purpose: parameter validation runs before any handler, so a
  rejection proves the method exists and can never mutate session state.
- **Control writes** on `HarnessClient`: `runCommand` (the shared write path —
  upstream routes plan, permission and compaction through the command registry),
  `togglePlanMode`, `setPermissionPreset`, `compactSession`, `forkSession`,
  `renameSession`, `selectModel`, `archiveSession`.
- **`rpcVariants()`** — tolerates the several `{args}` spellings upstream has
  shipped (`request`, `_request`, bare fields) by treating an argument-shape
  rejection as "wrong spelling", not "missing method". The winning *spelling* is
  cached, never the argument values.
- **A Controls panel** in the sidebar: plan toggle, permission-preset picker,
  sandbox/approval/model badges, todos, the active goal, subagent activity, the
  last compaction summary, and Fork / Rename / Compact / Archive actions — each
  offered only when this host serves its write path.
- Six commands: `Toggle Plan Mode`, `Set Permission Preset`,
  `Compact Session Context`, `Fork Session`, `Rename Session`,
  `Archive Session`.
- `npm run protocol-probe` now prints the negotiated control surface.

### Changed

- `protocol-test` grew from 64 to **98 assertions**, covering capability probing
  (present / HTTP-404 absent / not-found-code absent / shape-rejection present),
  the control writes, a host with no control surface at all, and the whole-value
  fold semantics including goal clear, subagent roster reconciliation and reset.

### Notes

- `HarnessUnsupportedError` is raised when a control's endpoint is absent; its
  message names what is missing rather than failing as a bare 404.

## [0.0.5] — 2026-09-19

Tagline: **the wire is negotiated, not assumed.**

v0.0.4 hardcoded a single wire shape (slash endpoints, `/api/remote.mux`,
cookie auth). None of the artifacts on the machine agreed with it: the installed
runtime (`0.1.0-rc.6`) serves `/api/session.list` over `/api/events.mux` with no
cookie at all, while the host that produced the original 401 clearly *is*
cookie-gated. Guessing lost; this release measures instead.

### Added

- **`src/harness/wire.ts` — protocol negotiation.** On every connect the client
  discovers: endpoint style (`session/list` vs `session.list`), whether `/api/*`
  is cookie-gated, the event-socket path, and the declared-parameter spelling
  `session/list` actually accepts. The result is cached in a `WireProfile` and
  every endpoint string in the client now goes through it.
- **`npm run protocol-probe`** — asks a live `dsh web` what it serves: endpoint
  style, event socket, and which of 29 candidate methods exist. This is now the
  authoritative way to settle any wire question.
- `httpStatus()` and `httpRequest({ timeoutMs })` — header-only probing with a
  bounded wait, so an event stream cannot hold a probe open.

### Changed

- `rpc()` no longer demands a cookie unless the negotiated profile says the host
  is cookie-gated, so unauthenticated hosts no longer fall into the paste flow.
- A `404` now names the negotiated wire style instead of a hardcoded upstream
  version.
- `session/list` args come from negotiation rather than the `_request` literal.
- `protocol-test` grew from 50 to **64 assertions**, including a dot-style host,
  an unauthenticated host, a cookie-gated host, and a dead port.

### Fixed

- Removed the last hardcoded `0.1.6-alpha` assumptions from the client.

## [0.0.4] — 2026-09-18

Tagline: **DeepSeek Harness 0.1.6-alpha wire-protocol migration.**

Harness 0.1.6-alpha made three breaking changes to the wire protocol that
returned `401` / `404` for every call this extension made. Every one of them
is now implemented natively.

### Breaking changes upstream (the reason for this release)

1. **`/api/*` now requires a browser session cookie.** The cookie is named
   `dsh-auth-<b64url(sha256(host:port))>`. Without it every call 401s — which
   is what the old `host.describe` failure looked like.
2. **RPC endpoints were renamed** from `a.b` (`host.describe`) to
   `namespace/method` (`session/list`). `host.describe` itself was deleted
   outright (`packages/host/apiproxy` removed), along with `session.history`
   and `workspace/list`.
3. **The event channel became bidirectional.** The downlink-only
   `/api/events.mux` WebSocket was replaced by `/api/remote.mux`, a logical
   stream multiplexer: RPC and subscriptions both run as streams over one
   socket.

### New features

- **Browser-session authentication.** New `src/harness/auth.ts` adopts a
  `dsh web` launch URL, follows the 303 `Set-Cookie` exchange, and persists the
  cookie. Cookies live in VS Code `context.secrets` (OS keychain) — never in
  `settings.json`.
- **New commands** — `DeepSeek Harness: Set Session Token from Launch URL` and
  `DeepSeek Harness: Clear Session Token`. Both are also reachable from the
  session-view title bar.
- **Actionable errors.** A missing/stale session now reports *why* and names the
  exact command to run, instead of surfacing a bare `401`. A deleted endpoint
  reports `HTTP 404 on /api/host.describe — the running harness does not expose
  that endpoint` with upgrade guidance.
- **Connectivity is proven by `$events` readiness.** `connect()` no longer
  trusts a successful HTTP probe; it waits for the `$events` `ready` frame,
  which also carries `clientId` and `host.home`.

### Protocol mapping (old → new)

| Old | New |
| --- | --- |
| `host.describe` | `$events` ready frame (`home`, `clientId`) + `session/modelCatalog` (`provider`, `model`) |
| `events.mux` (downlink only) | `remote.mux` (bidirectional logical streams) |
| `session.history` | `session/follow` snapshot (or `session/page`) |
| `workspace/list` | `workspace/follow` baseline frame |
| `POST /api/respond` | `$events/result` RPC — `{clientId, eventId, outcome:{kind:'result', value:'allowed-once'\|'rejected'}}` |
| `assistant/chunk` (durable log) | out-of-band assistant stream frames via `session/follow` |
| `{...params}` RPC payload | `{args:{<declaredParamName>: value}}` — e.g. `{_request:{}}` for `session/list` |

### New modules

- `src/harness/auth.ts` — `BrowserSessionAuth`, cookie derivation, launch-URL adoption, persistence, optional local mint
- `src/harness/local-credentials.ts` — reads the harness signing secret to mint a cookie without a paste
- `src/harness/http.ts` — `node:http` client (platform `fetch` has no cookie jar)
- `src/harness/ws.ts` — minimal RFC 6455 WebSocket client, because browser-shaped `WebSocket` cannot send the `Cookie` header required by the mux upgrade
- `scripts/protocol-test.ts` — fake-harness protocol test, 50 assertions

### Bug fixes

- Streaming assistant deltas moved out of the durable log in 0.1.6 and have no
  real `seq`, so they were silently dropped by the model's seq guard. Added
  `ConversationModel.applyStreamChunk(turn, step, chunk)` to bypass it.
- Approval replies are keyed by `eventId` (the waterfall event), not the old
  `approvalId`; `agentId` is used as the session id.
- Changed `host`/`port` now calls `client.retarget()` + reconnect instead of
  rebuilding the client (which leaked the old mux socket).
- Editor context is rendered into the prompt text via `renderContextBlock()`
  because the new `session/prompt` has no `context` field.
- A cookie that is well-formed, unexpired and authority-correct but still
  rejected by the host was reported as "expired", sending users after the wrong
  fix. It now reports that the host's signing secret was rotated.
- A refused `/api/remote.mux` upgrade sat until the open timeout and then blamed
  a generic timeout. It now fails fast with the actionable auth error (the mux
  status carries the HTTP status of the refused upgrade).
- **Zero-paste connection.** With `deepseekHarness.autoSession` on (default), the
  extension mints the browser-session cookie from the harness's own persisted
  signing secret in `$DSH_HOME/.credentials.yaml` — byte-identical to one `dsh web`
  would issue — so no launch URL is ever pasted. Set it to `false` to force the
  sanctioned token exchange. The path used is logged on every connect.

### Session lifetime

The launch **token** dies with the `dsh web` process, but the **cookie** it buys
is signed with a secret persisted in `$DSH_HOME/.credentials.yaml` and is valid
for **30 days** by default. The extension stores that cookie, so restarting
`dsh web` does **not** require re-running Set Session Token. Re-entry is only
needed after the 30-day expiry, a `host`/`port` change (the cookie name is
`dsh-auth-<sha256(host:port)>`), or a wiped/regenerated credentials file.

### Verification

- `tsc --noEmit` — 0 errors
- Production build — `dist/extension.js` 98.4 kb
- `scripts/protocol-test.ts` — 50/50 assertions pass against a fake 0.1.6 harness
  (includes local mint from the credential store, autoSession-off guard, cookie-survives-restart and rotated-secret reporting)

## [0.0.3] — 2026-08-16

Tagline: **Diff Review, Approval Workflow & File Context Inlining.**

Closes the biggest experience gap with Cursor/Cline: code changes can now be
reviewed and approved entirely inside VS Code, without switching to the Web UI.

### New features

- **Diff Review & Inline Code Application.** When the agent writes or edits
  files, a review card appears in the sidebar showing each changed file with
  `+added`/`-removed` line counts. Click **Diff** to open VS Code's native
  diff editor (via `dsh-review://` virtual documents). Accept (keep changes)
  or Reject (safe revert via `git checkout`) per-file or all at once. Review
  transactions are tracked by `callId` and linked to the originating tool call.
- **Approval Workflow Integration.** `approval/requested` events now render
  inline as cards with **Allow once** / **Deny** buttons — no more switching to
  the browser. A security allowlist restricts which tools can be approved from
  VS Code; high-risk operations still require the Web UI. Responses are sent
  via `POST /api/respond`.
- **@file Content Inlining.** File references (`@file:path` or
  `@file:path:L10-L20`) now have their content read and inlined directly into
  the user message text (wrapped in `<file path="…">` tags), guaranteeing the
  agent can see file content even when the backend doesn't process the
  `context` field. The `context` metadata (active file, selection) is only
  attached on the **first prompt** of a session to avoid redundant sends.
- **Context Menu Integration.** Right-click a file in the explorer →
  **Add to Harness Chat** inserts an `@file:` reference. Select text in the
  editor → right-click → **Send Selection to Harness** inserts
  `@file:path:L10-L20`. Both use workspace-relative paths for readability.

### Bug fixes

- **@file regex on Windows.** Added negative lookahead `(?!L\d)` to prevent
  `:L<digits>` line ranges from being consumed as part of the file path
  (critical for Windows paths like `e:\folder\file.ts:L10`).
- **Webview regex escaping.** Template literal double-escaping for `\s`/`\d`
  in the webview's `parseAtFilePreview` — without it, `[^\s:]` became
  `[^s:]` which does not exclude whitespace.
- **Skip non-file documents.** `collectEditorContext` now skips documents
  whose URI scheme is not `file` (Output panel, Settings, etc.).
- **Input clearing on @file-only input.** When the input contains only
  `@file:` references, the chat now shows a readable summary like
  `(See: file.ts:L10-L20)` instead of being cleared.

### New modules

- `src/review/` — `ReviewController`, `ReviewStore`, `ReviewVirtualDocumentProvider`,
  `ReviewMaterializer` (6 files, ~500 lines)
- `src/approval/` — `ApprovalStore`, types (2 files, ~150 lines)

---

## [0.0.2] — 2026-08-15

Tagline: **Conversation UX & Architecture Baseline.**

The "main-branch last direct-push release": hardens structure, rendering
correctness, and interaction UX so that v0.0.3+ can be developed entirely via
feature PRs onto stable boundaries.

### Architecture (structural boundary hardening)

- **`src/app/controller.ts` + `state.ts`** — new `AppController` owns all
  orchestration (connect/disconnect, workspace lifecycle, session lifecycle,
  prompt/cancel, mux dispatch, UiState push). `extension.ts` stays as pure
  wiring: `activate() / deactivate()`, `readConfig()`, command registration,
  and dependency instantiation only.
- **`src/conversation/`** — `ConversationModel` replaces the flat `SessionModel`.
  Events no longer map 1:1 to renderable items; instead they project into
  conversation-semantic `ConversationItem[]` (`user`, `assistant`, `system`,
  `tool`, `status`).
- **`src/workspace/binding.ts`** — workspace creation is split into
  `findHarnessWorkspace()` (discovery, connect-time) and `ensureHarnessWorkspace()`
  (create-on-demand, send-time). The old `resolveHarnessWorkspace()` that
  eagerly prompted for creation inside the connect flow has been removed.
- **`src/view/` split** — `provider.ts` (composition only) is now joined by
  sibling modules: `styles.ts`, `html.ts`, `client.ts` (webview-side JS), and
  `toolPresentation.ts`. React/Preact/Vite are deliberately NOT introduced;
  vanilla DOM continues to carry a couple more releases.

### UX fixes

- **Lazy workspace + session on first Send.** When the user opens a repo
  without a matching Harness workspace, the sidebar stays usable and shows a
  *"Not registered yet — will be created lazily on first send"* banner. The
  first `Send` implicitly creates workspace → creates session → sends the
  prompt, with no confirmation modals. The input textarea is only cleared
  after the optimistic echo reaches the snapshot; prompt text is not lost on
  creation failure.
- **Tool cards are now one item.** `tool/call` + matching `tool/result` are
  merged into a single `ToolItem` owned by `callId`. The sidebar renders a
  collapsed header `🔧 read src/session.ts → ✓ done` that you click to expand
  Arguments + Result. This eliminates the "pink tool-result block" noise.
  `toolPresentation.ts` provides a name-aware pretty title (read, grep, bash,
  write, edit, git_*, …).
- **System messages are their own item kind.** `SystemItem` no longer reuses
  `UserItem` with a `system: true` flag. All downstream filtering is based on
  `item.kind === 'system'` — no more `if user && system` spreads. Default UI
  is a single collapsed line `▸ Runtime context · @deepseek-ai/dsh-system-prompt`.
- **Assistant Markdown rendering.** `markdown-it` (with `html: false`,
  `linkify: true`) runs **inside the webview**, not the extension host, so
  `ConversationModel` stays semantic-only. User/System messages still render
  with `textContent`. Links open with `target=_blank rel=noopener` and
  `javascript:`/`data:` URLs are stripped. Tool results stay `<pre>` for now.
- **Streaming text now always re-renders.** Each model mutation bumps a
  monotonically increasing `renderVersion`. The webview rebuilds the message
  list **solely** on `snapshot.renderVersion` change — previously, an
  assistant streaming update would often fall through stale `lastSeq` /
  `items.length` signature checks and skip the re-render entirely.

### Test coverage

- Integration test upgraded to exercise `ConversationModel`. New assertions:
  - `renderVersion` strictly increases after a prompt run (1 → 19 in the
    standard "pong" flow).
  - No `tool-call` / `tool-result` kinds leak into `ConversationItem` (they
    are merged; this is enforced both at the type level and at runtime).
  - `systemMessageCount` is tracked separately from user items.

### Discipline

- Explicit **NOT in v0.0.2**: Diff review, approval/respond, inline
  completion, context injection, filesystem provider, terminal integration,
  LSP/ACP/SDK abstractions, transport interfaces. All of these start life as
  feature branches / PRs from v0.0.3 onward.

---

## [0.0.1] — 2026-08-15

The first public release. This version proves **one** thing: VS Code and the
browser share the same DeepSeek Harness session.

```
Browser ─────┐
             │
             ▼
       DeepSeek Harness
             ▲
             │
VS Code ─────┘

Same Workspace. Same Session. Same Agent Runtime.
```

### Added

- **Connect** to a local `dsh web` instance via `HTTP /api/*` + `WebSocket /api/events.mux`.
  Loopback-only trust fence (`127.0.0.1` / `localhost` / `::1`); any other host
  is refused with a clear message.
- **Workspace mapping** — match the active VS Code folder to an existing Harness
  workspace by canonical path; offer to create one if absent (no second workspace ID).
- **Session list** filtered by the resolved workspace, with `+ New Session`.
- **Session history** loaded from the Harness (the single source of truth — no
  local session DB, no `.vscode/deepseek-sessions.json`).
- **Plain-text prompt** sent to the active session.
- **Live streaming** of `assistant/chunk` deltas and tool activity, coalesced by
  an `EventBuffer` that flushes at most every ~30 ms (no per-token re-render).
- **Stop / cancel** the active turn.
- **Reconnect** — on WebSocket close→open, the stream reopens and history is
  refetched (the documented Harness resume semantic is *rebuild*, not cursor-resume).
- **Open Web UI** command (opens `http://127.0.0.1:<port>`; session deep-links are
  intentionally not guessed).
- **Show Logs** command → the `DeepSeek Harness` output channel.
- **Sidebar webview** (vanilla JS, no React) with connection status, workspace,
  session dropdown, message list, input + Send/Stop.
- **Right-side docking** — a "Move to Right Side Bar" command (⇲ button in the
  webview header) relocates the view to the secondary side bar so it no longer
  competes with the file explorer.
- **System-message hiding** — plugin-injected `user/message` frames (e.g.
  `@deepseek-ai/dsh-system-prompt` runtime context, `user-approval` notices)
  are detected via `source.kind !== 'user'` and hidden by default. A `SYS`
  toggle in the header reveals them; the `deepseekHarness.showSystemMessages`
  setting controls the default.
- **Brand icon** — a generated 128×128 PNG (`media/icon.png`) serves as the
  Marketplace icon and the webview header logo; the SVG activity-bar icon uses
  `currentColor` to adapt to the theme. Regenerate with `npm run gen-icon`.
- **Protocol fixtures** (`test/fixtures/`) — sanitized captures of the live wire
  format for detecting upstream protocol drift.
- **Protocol spike** (`scripts/protocol-spike.ts`) and **integration test**
  (`scripts/integration-test.ts`) — standalone Node validation of the full loop
  against a running `dsh web`.

### Security

- Method allowlist: only `host.describe`, `workspace.{list,create}`,
  `session.{list,history,create,prompt,cancel}`.
- Never calls `/api/respond`, `settings.*`, `credentials.*`, `commands.*`, or any
  approval / permission mutation.
- `approval/requested` and `question/requested` frames surface **only** an
  information message ("Action requires approval in DeepSeek Harness Web UI") and
  never respond on the user's behalf.

### Verified against

- DeepSeek Harness host `v0.0.1` (`@deepseek-ai/dsh-root`), default `dsh web`
  port `3080`.
- Wire contract source: `packages/host/apiproxy/src/api/` (authoritative).
- Integration test: 11/11 checks pass against a live local `dsh web`.

### Limitations

- Loopback only — no remote / LAN / WSL-bridged hosts.
- Text prompts only (no image attachments).
- History loads the last ~50 messages; "load older" is deferred.
- Session deep-links in "Open Web UI" are intentionally not guessed.
- Unknown harness event types are ignored (the protocol is merge-extensible);
  they do not crash the client but also do not render.

[0.0.1]: https://github.com/YichuAI/deepseek-harness-vscode/releases/tag/v0.0.1
