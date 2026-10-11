# DeepSeek Harness Connector for VS Code (v0.2.0)

[English](./README.md) | [简体中文](./README.zh-CN.md)

[![VS Code Marketplace](https://img.shields.io/badge/VS%20Code-Marketplace-blue.svg)](https://marketplace.visualstudio.com/items?itemName=lucasliang.harness-connector-deepseek)
[![Version](https://img.shields.io/badge/version-0.2.0-blue.svg)](https://github.com/YichuAI/deepseek-harness-vscode/releases/tag/v0.2.0)

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

## v0.2.0 新特性

**两个只有用起来才会冒出来的 bug。**

- **修复：输入框下面的引用芯片把提示词一起吞了。** webview 里那份 `@` 语法副本是一个普通字符串，交给 `new RegExp` 使用——而字符串字面量会在 `RegExp` 看到它之前先吃掉反斜杠：`'[^\s"]'` 到手时已是 `'[^s"]'`，一个能匹配空格、换行、以及后面那些 `@` 的字符类。所以先写 `@readmefor_human.md 这里多了文字`、下一行再写 `@RELEASE.md`，只会得到**一个**芯片，内容包含这全部；`:L10-L20` 的行号范围也彻底失效。现在它是正则字面量——它旁边两行的 `/\\s/` 一直就是这么写的。
- **修复：已经答完的提问（或已经批准的审批）会一直留在屏幕上。** mux 客户端**永远不会**收到 `question/resolved` / `approval/resolved`，只有撤回用的 `cancel`，所以那张卡就一直停在输入框上面显示「Answering…」，按钮全死、也没有东西放它走。现在那个 POST 本身就是结算；POST 失败则把卡片退回去。

门禁：**312 项断言**（原 295），新增的驱动的是编译产物里的 webview 脚本与真实控制器——包括「POST 失败」那条顺利路径测不到的支线。真机集成仍为 **39/39**。

完整差异见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## v0.1.9 新特性

**一张本回合改了什么的账本——以及一个撤销键，而不是一张许可单。**

- **新增：每回合一张改动卡片。** Host 会记录每个顶层回合动过什么，并以 `workspace/changes`
  Session 事件播报；卡片现在出现在对话流工具行里，数据来自一个普通的带鉴权
  `GET /api/changes.summary`，用播报事件自己的 `seq` 寻址。

  它和「按调用」的 review 卡片刻意用了不同的来源。review 是用文件工具自己的 `before`/`after`
  拼的，所以只可能报告文件工具报告过的东西。回合记录是 Host 侧在回合开始与结束各对工作区做一次
  git 快照、再在会改盘的调用前后留整份文件副本拼出来的——所以**也能覆盖 shell 命令里
  `sed -i` 改掉的文件**，而且它是唯一描述「整个回合」而不是「其中某一次调用」的来源。
- **新增：单文件回退，或整回合回退。** 每个文件行一个「回退此文件」，卡片上一个「全部回退」。
  两者都只在**该回合产出的 review** 范围内生效，因为摘要只带路径与行数，不带还原所需的文本
  ——只有 review 留着 `before`。如果某回合的改动全部来自 shell 命令，它会直说，而不是假装执行。
- **新增：回合里任意文件的原生 diff**，以 VS Code 自己的 diff 编辑器打开。Host 只给 hunk、不给
  整份文件文本，所以两侧都从 hunk 列表重建并保持逐行对齐，一行不属于某一侧就在那侧补空。点
  卡片里的路径可在编辑器中打开该文件。
- **变更：review 卡片不再征求许可。** 两个「接受」都已删除，两个拒绝按钮合并为一个「全部回退」，
  每文件那两个 `✕`/`✓` 合并为一个「回退此文件」。原因见[设计一节](#设计写盘归-dsh插件只观察与告知)。
- **修复：经原生 review provider 打开的每一个 diff 都是空白。**
  `Uri.parse('dsh-review://review-1/foo/before').path` 是 `/foo/before`——层级 URI 会保留开头
  的斜杠——而代码从 `path.split('/')[0]` 取 id，取到的是空字符串，store 查找永远不命中。

门禁：回归测试现为 **295 项断言**（原 268）。新增的一组钉住两条路由、hunk 到两侧的对齐、
URI authority 契约，以及卡片语义——每回合一张卡、重复播报是替换坐标而不是叠第二张卡、Host
已不再提供的摘要解析为「没有卡片」而不是报错。真机集成现为 **39/39**（原 29）：新增的十条断言
让一个真实回合跑过真实模型，所以「播报→路由」的交接、按索引寻址某个文件、hunk 的前缀、
以及每个 hunk 头与它自己正文的一致性，都是对着活的 Host 量出来的，不是对着夹具。

完整差异见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

> **关于版本号。** 一份改动，三个名字：先切成 **v0.1.8**，再改切为 **v0.2.0**，回退之后以
> **v0.1.9** 发布。`v0.1.8` 有标签（`806ce47`）但没有对应的 Release——那个名字下没有产物。

## v0.1.7 新特性

**对话越长，每个流式分块越便宜。**

- **修复：webview 每个流式分块都会把整条对话流重画一遍。** `renderVersion` 每来一个分块就
  变，而 webview 把「变了」当作「把 `#messages` 拆了重来」——顺带把每一条助手消息重新过
  一遍 markdown-it。于是一个分块的代价正比于会话长度，这才是「聊得越久越卡」的真实机制。
  在一条 40 轮的对话上实测，每 40 个字符新文本：

  | | 修复前 | 修复后 |
  |---|---|---|
  | 新建 DOM 节点 | 291 | **4** |
  | markdown 解析次数 | 约 42 | **1** |
  | 重解析的 markdown 字节 | 43 KB | **1.4 KB** |

  每个条目现在带 `uid`（它的 DOM key——流式增量更新、工具行拿到结果时都不变）和 `rev`
  （它自己的变更签名，每次被改都加盖）。webview 按这两个字段做调和，所以一个分块只重画
  一行，其余每一行都保留原有节点——以及已经解析好的 markdown。`uid` 取自进程级计数器，
  所以为同一会话重建的模型（重连、fork、切换）不会发出一个 webview 手里已有节点的 id。
- **修复：回合已结束后到达的增量会多出一个重复气泡。** 实时助手流与持久日志之间没有顺序
  保证，所以一个分块可能落在 `turn/end` 之后——或者落在它所重复的那条权威
  `assistant/message` 之后。它找不到流式占位符，就从空重建缓冲区，在已完成的答案下面再
  追加一个助手气泡。现在，属于已结束回合、或已定稿步骤的增量会被直接丢弃。
- **修复：一次流式 flush 会按帧数重复投影模型。** `applyMuxFrame()` 在逐帧循环里构建完整
  快照，而一次 flush 装着一整轮的增量。现在整批只投影一次，与这批本来就只有一次的推送对齐。
- **修复：会话 `<select>` 每次状态推送都重建**——也就是每个流式分块都重建——会在用户正在
  操作时把选择丢掉，只为了重画一份完全一样的列表。现在加了签名守卫。

门禁：回归测试现为 **268 项断言**（原 243），新增两组：一组在模型层钉住流式身份契约与
「不产生僵尸气泡」的规则；另一组直接驱动真实 webview 脚本，断言「`renderVersion` 变了但
条目没变」的推送**不建任何 DOM、不解析任何 markdown**，而一个流式分块只重画一行。真机
集成仍为 **29/29**。

完整差异见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## v0.1.6 新特性

**问一句、答一句，不再把整条对话流重画两遍。**

- **修复：一次审批/提问事件会把对话流重建两遍。** 一个审批或 `ask_user_question` 会推送
  两次完整状态——`ApprovalStore` 自己的变更监听器一次，刚改完 store 的调用方再一次——
  而每一次被接受的状态推送都会让 webview 把 `#messages` 拆掉、逐条重建（连带 markdown
  重新解析）。两次落在同一个 tick 里，中间没有绘制的机会。在一条 72 条记录的会话上实测：
  每个事件 **2 次推送 / 约 70 KB / 2 次完整重建**，一次作答往返合计 **6 次推送 / 约 212 KB
  / 6 次重建**。另外两个同伙也一并收掉：`pushReviewApprovalState()` 无条件 `model.touch()`
  （审批和提问**根本不在对话流里画**，`renderTool` 里写明了），以及 `session/follow` 批处理
  回调即使批里什么都没变也照推。现在：**每个事件 1 次推送、0 次重建**。
- **修复：检查器的事件环形缓冲区搭上了每一次状态推送**，开着关着都搭。最多 300 帧 × 2 KB
  ≈ 600 KB 的结构化克隆，而推送在流式输出里是逐块触发的——实测**单次推送 1,318,580 字节**，
  而且没人读。现在只有面板在屏幕上才发布（打开的那一刻一次性补全历史）：**1.29 MB → 35 KB**。
- **修复：检查器列表无限膨胀。** 它每次变化都把整个数组 append 一遍，而缓冲区是环形的、头
  部会移动——于是每来一帧就多堆一份全部行（300、600、900…）。改为整体重建，上限 300 行。
- **修复：把提问交回 Web UI 成功时反而报错。** 一次成功的交接弹的是红色错误提示。
- **移除 `ToolItem.approvalRpcId`** 及其写入方 `setApprovalRpcId()`——写的人没有、读的人也没有，
  而它带的 `renderVersion` 自增会在每次审批时逼出第二次对话流重建。

完整差异见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## v0.1.5 新特性

**Host 换了端口、或者被重启之后，不用再重载 VS Code 了。**

- **Reconnect 按钮常驻**（状态行一个，面板标题一个）。点它总是把旧连接拆干净、重新协商
  一次——这才是重点，因为最需要它的场景恰恰是**面板还显示着 Connected** 的那种：Host 被
  重启了，我们握着的 socket 其实已经死了，而没有任何东西告诉过我们。普通的 `connect()`
  会在那个过期的状态上直接早退，这正是过去"只能重载窗口"的原因。连接请求是串行化的，
  连点两下是排队，不会两个协商互相拆台。
- **Host 自动发现。** 配置的端口没人应答时，先读 `$DSH_HOME/profiles/<name>/cordis.patch.yml`
  里钉过的 `webserver.port`，再枚举操作系统的 loopback 监听表，用 Host **自己的匿名拒绝
  文本**逐个确认（`401` + `dsh web authentication required; reopen the URL printed by dsh web.`
  ——这句话来自 connection carrier 而不是 web 前端，所以哪个入口启动的 Host 都会这么说）。
  这正是**桌面端**需要的：它用 `--port 0` 启动 Host，端口由系统每次重新分配，只通过
  Node IPC 报给 Electron。本机实测：46 个 loopback 监听，命中恰好一个，并正确归因到
  `desktop` profile 里钉的端口。发现的端口只在本次会话内使用，**不写回设置**——它每次
  启动都会变，写进去只会留下一个下次必然过期的钉子。
- **修好了「强制重连之后，你正在看的那个会话会丢」。** `disconnect()` 拆掉了
  `session/follow` 订阅，却把 `activeSessionId` 留着，于是对话还停在屏幕上、背后已经没有
  任何东西在喂它。现在重连会重新选中同一个会话（重建 model、重新订阅、重拉历史，也就是
  文档里写的**重建**而不是游标续传），只有当 Host 上确实没有这个会话时才退回最新的那个。
- **修好了「每次切换会话泄漏一个 `session/follow` 订阅」。** 它们被丢进一个 disposable 袋
  里再也没被释放；而重连现在每次都会重新选中会话，泄漏只会加速。
- **修好了「明明没发 cookie，却报签名密钥被轮换」。** `authRequired()` 无条件记录了一次
  拒绝，于是"压根没有会话"（`autoSession` 关了，或者 `$DSH_HOME/.credentials.yaml` 还不
  存在）被描述成"运行中的 Host 拒绝了我们存储的 cookie——它的签名密钥几乎肯定被重新生成
  了"。这会让人去查错误的东西。

完整 diff 见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## v0.1.4 新特性

**审批和 Agent 提问现在都能在侧边栏里回答了 —— 而且点"允许"真的等于允许。**

这次的起因只有一句话：*"云端提问题的时候无法在 vscode 里审批。"* 而把它修好，靠的是先把一条
契约钉死：**`POST /api/$events/result` 上的 `outcome.value` 就是宿主瀑布的返回值。**
下面五条修复里有三条，其实是同一个事实的三个侧面。

- **修好了 Agent 提问（`user-questions/request`）在 VS Code 里完全没有出口。** 客户端一直把它
  正确翻译成 `question/requested`，然后控制器把这一帧丢在地上：既不渲染，也无法回答。
  后果比"少一张卡片"严重——宿主侧 `ask_user_question` **阻塞**着那次工具调用，
  没人回答，这一轮就停在那里。现在它和审批共用同一个待答面板。
  - 单问题单选：点选项即作答（与 Web UI 的选项卡片一致）；多问题或复选：显式点 **Answer**
    一次提交整批，未作答的会就地报错，而不是把一批空答案发上去。
  - 自由文本始终可用，走 `custom` 字段（不是 `selected`）。
- **修好了"点'允许'从来没有允许过任何东西"。** 审批的应答体发的是 `{ kind: 'result' }`，
  **没有 `value`**。但 `value` 就是宿主瀑布的返回值，省略它等于用 `undefined` 结算；
  而 `ApprovalService.decide` 会把一切不在词表内的返回值（包括 `undefined`）归一化成
  `'unavailable'` —— 一次**静默的 fail-closed 拒绝**，而且照常写一条看起来完全正常的
  `approval/decided` 审计。真机实测：裸形状 → `outcome: "unavailable"`，工具报
  *"requires approval, but no approval channel is available"*；带值形状 →
  `outcome: "allowed-once"`，命令真的执行了。
- **修好了"点'拒绝'也被记成'没有可用的审批通道'"。** 原来把拒绝编码成
  `{ kind: 'rejected', error: … }`，那会**取消**宿主瀑布，`decide` 里的 containment
  再把它归一化成 `'unavailable'`。拒绝是一个携带词表字符串的 **result**，不是传输层错误。
- **修好了"在 Web UI 里回答过之后，VS Code 的卡片永远点得动"。** 对 mux 客户端，宿主
  **只**用一个 `cancel` 帧表示撤销（0.2.1 不转发 `approval/resolved` / `question/resolved`），
  而旧代码只把它记进日志。现在 `cancel` 会被翻译成 `waterfall/resolved` 并撤掉对应卡片。
- **修好了"审批卡只在能匹配到工具行时才画得出来"。** 它原来嵌在 ToolItem 里，靠 `callId`
  匹配；没有匹配行（会话没在前台、工具行还没折进来）就等于不存在。现在待答项有自己的面板，
  位于输入框上方——正是你准备打字时会看的地方。
- **改了：审批的放行门槛改成看"理由"，不再看工具名。** 原来的白名单是
  `write/edit/read/grep/…`——它列的这些名字本机宿主根本没有（shell 工具叫 `pwsh`），
  于是**每一次真实的 shell 升级都会被拒**，而这条路径恰好最常见。名字本来也说明不了
  申请有多大权限，理由才说明（*"escalate sandbox to danger-full-access: …"* 是宿主自己
  写的风险陈述），而且理由现在会**原样显示**在按钮旁边。现在只在理由声明了
  full/unrestricted access 时不给内联允许；那张卡仍会显示、仍可拒绝、并多一个
  **Answer in Web UI** 把它交回浏览器。被拒绝的按钮不再没有解释——`blockedBy` 会说明原因。
- **新增 `delegateWaterfall`** —— 把仍开着的瀑布交回宿主链（`outcome: {kind:'next'}`）。
  这是真正的委托而不是忽略：我们放弃自己的 delivery，请求继续留给 Web UI；
  只有当没有别的 delivery 时，宿主才会用 `next()` 结算。
- 面板不再把"已解决"的请求画出来。

验证：回归门 **190 → 211 项**全绿（新增 G2 组，覆盖面板渲染、Allow/Deny 各自发出的**确切**载荷、
高危卡不给 Allow 但给交回、单选点击即答（按**标签**而不是下标）、多问题必须显式提交、
空答案被就地拦下、自由文本走 `custom`、已解决项离开面板）；真机集成 **21 → 25 项**全绿，
其中两条为新链路实测：宿主把 `user-questions/request` 交付给 mux 客户端且答案回到了被阻塞的
工具调用；宿主交付 `approval/request` 且"允许"**真的授予了**越界升级（命令执行成功）。

完整 diff 见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## v0.1.3 新特性

**回话终于能收到了，图片终于能发了，`@` 引用改用宿主自己的语法。**

> 中文版 README 的"新特性"长期停在 v0.0.3；0.0.9 ~ 0.1.2 的完整记录见英文版
> [README.md](./README.md) 与 [CHANGELOG.md](./CHANGELOG.md)，本段只记 0.1.3 与 0.1.4。

- **修好了"能连上但收不到回话"。** 插件一直把传输层建模成"一条 `$events` 承载所有帧"。
  真机（`0.2.1-alpha.2`）上 `$events` 是一份固定的转发白名单：它会发一个 `ready`
  （所以面板老老实实显示 Connected），然后**一条对话流量都没有**。对话在**另一条**逻辑流
  `session/follow` 上（`snapshot` → `event` → 实时 `assistant-stream`）。两条流现在各开一条，
  各按自己的词汇表翻译。
- **图片支持：粘贴、拖拽、选文件都行。** 剪贴板里的图、拖进输入区、或走
  `DeepSeek Harness: Attach File to Session` 命令，都会变成输入框上方的一个待发 chip（带本地缩略图），
  发送时作为内联图片部件走 `session/prompt`。只发图片、不发文字可以；一次发多张也可以。
  （chip 是**暂存**区，没点发送之前什么都不会发出去。）
- **非图片文件现在真的能送到 agent 手里。** 旧版本把字节往 `session/attachment` 上怼，
  但那根本不是上传接口——它是"按 id 读附件"。真正上传走
  `POST /api/session/uploadFileBinary`（原始字节），prompt 里用返回的 receipt 引用。
  一个必须说清的限制：receipt 同时绑定会话**和** `dsh web` 进程，宿主重启即失效。
- **`@` 引用不再粘贴文件正文。** 原来的 `@file:path` + `readFileSync` 内联是插件自己发明的。
  现在支持 `@path`、`@"含空格的 path"`、`@dir/`，可带 `:L<n>` / `:L<n>-L<m>`，
  补全走宿主自己的 `fileReferences/list`。选中候选**不附任何东西**，文件由 agent 自己去读。
  （除了对齐宿主，内联还有个实际代价：它每轮都改动提示前缀，等于每次发送都作废 KV cache。）
- **修好了"历史永远是空的"——而且更糟：每次重连都会把对话擦掉。** `session/page` 原先写死
  `throughSeq: 0`，但那是个**日志游标**，不是条数。游标只在 `session/follow` 的开场帧里发布，
  现在客户端从那里学。空页原先会被当成事实折进模型，于是每次 socket 重连都清空一次记录。
  现在空页不再清屏。
- **自动连接失败时有 `Connect` 按钮可点了。** 自动连接是尽力而为，本机实测在宿主一切正常的情况下
  `auth` 也可能返回未就绪——那时面板"没得点、也没得读"。现在状态行会显示
  `Connect` / `Retry` / `Connecting…`，并且**只在未连接时**在面板标题栏显示一个插头图标。
  （v0.1.5 把这个门禁换成了**常驻的 Reconnect 按钮**——连接已经死掉、面板却还写着
  Connected 的那种情况，恰恰是旧门禁把它藏起来的时候。）
- **移除 `DeepSeek Harness: Set Session Token from Launch URL`。** 从 `$DSH_HOME/.credentials.yaml`
  本地自签已经是实际唯一可用路径；一个每次 `dsh web` 重启都换的 token 只剩维护成本。
- **修掉一处误诊。** "没有这个方法"（HTTP 404）和"这个 workspace 不存在"
  （200 + `workspace/not-found`）曾被混为一谈，于是普通业务错误会劝你去**升级宿主**。
- **修掉一个让每次调用都变慢的参数形状重试。** 记住的正确形状原先被排在**最后**试，
  于是每次调用先白烧两次失败往返，wire 形状还会因宿主宽容度而漂移。现在记住的形状优先。

完整 diff 见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

## v0.0.3 新特性

**Diff 审查、审批工作流 & 文件内容内联** —— 补齐与 Cursor/Cline 最大的体验差距：代码变更可以在 VS Code 内完成审查和审批，无需切换到 Web UI。

- **Diff 审查与内联代码应用** —— Agent 写入或编辑文件时，侧边栏自动出现审查卡片，展示每个变更文件的 `+新增`/`-删除` 行数。点击 **Diff** 打开 VS Code 原生 diff 编辑器。支持逐文件 Accept（保留）/ Reject（通过 `git checkout` 安全回退），也可批量操作。
  - **已在 v0.1.9 更正：** Accept 已经删除。改动落到磁盘是在 review 被建出来之前，所以「接受」除了暗示「此前一直在等它批准」之外什么也没做；剩下的按钮是「回退此文件」与「全部回退」。回退也不是 `git checkout`，而是把抓到的 `before` 写回去，并先校验文件没有漂移。详见上面的 v0.1.9 段与[设计一节](#设计写盘归-dsh插件只观察与告知)。
- **审批工作流集成** —— `approval/requested` 事件现在以内联卡片形式展示，带 **Allow once** / **Deny** 按钮。不再需要切浏览器审批。安全允许列表限制哪些工具可以在 VS Code 内审批，高风险操作仍需 Web UI。
  - **已在 v0.1.4 更正：** 这里的"内联卡片"是靠 `callId` 匹配工具行画出来的，匹配不上就不显示；门槛用的是一份工具名允许列表，
    而本机宿主的 shell 工具叫 `pwsh`，白名单里没有它——所以每次真实升级都被拒。现在待答项走独立面板，
    门槛改成读宿主给出的**理由**。详见上面的 v0.1.4 段。
- **@file 内容内联** —— 文件引用（`@file:path` 或 `@file:path:L10-L20`）的内容现在被直接读取并内联到用户消息中，确保 agent 始终能看到文件内容。`context` 元数据（活动文件、选区）仅在会话首次发送时附带。
  - **已在 v0.1.3 更正：** `@file:path` 这套语法和"内联正文"都是插件自己发明的，宿主另有语法。
    现在改用 `@path` / `@"含空格的 path"` / `@dir/`（可带 `:L<n>` 行号后缀），
    **并且不再粘贴正文**——文件由 agent 自己读。详见上面的 v0.1.3 段。
- **右键菜单集成** —— 在资源管理器中右键文件 → **Add to Harness Chat**。在编辑器中选中文本 → 右键 → **Send Selection to Harness**。均使用工作区相对路径。

详见 [CHANGELOG.zh-CN.md](./CHANGELOG.zh-CN.md)。

### 历史版本

- **v0.0.2** —— 对话 UX & 架构基线版：Assistant Markdown 渲染、Tool 卡片合并、System 消息折叠、惰性创建 workspace/session、流式渲染修复、架构加固。
- **v0.0.1** —— 首个公开版本：验证 VS Code 与浏览器共享同一个 Harness 会话。

## v0.0.3 做什么

- 连接到**本地** `dsh web`（仅限回环地址——`127.0.0.1` / `localhost`）。
- 将当前 VS Code 文件夹匹配到 Harness 工作区。若无匹配，工作区在**首次发送时惰性创建**——无弹窗。
- 列出该工作区已有的会话。
- 打开会话并渲染其历史记录。
- 向该会话发送纯文本提示。若无会话，自动创建。
- 实时流式传输助手回复，支持 **Markdown 渲染**（代码块、列表、表格、链接）。
- 将工具调用显示为**折叠卡片**，带语义化标题（`Read src/foo.ts`、`Search "pattern"`、`Run npm test`）。
- **看见 Agent 改了什么** —— 每回合一张改动卡片（包含被 shell 命令改掉的文件）、任意文件的 VS Code 原生 diff，以及撤销：单文件或整回合。文件工具的按调用 diff 卡片同理，并在原生 diff 里自带一个「回退此文件」的 CodeLens。这里没有任何一处征求批准——改动已经在盘上了，原因见[设计一节](#设计写盘归-dsh插件只观察与告知)。
- **审批或拒绝 Agent 操作** —— 输入框上方的待答面板，带 Allow once / Deny 按钮（门槛看的是宿主给出的**理由**，不是工具名允许列表）。
- **引用文件** —— 在提示中使用 `@<相对路径>`；提及按原样发出，由宿主用自己的文件系统工具解析。右键资源管理器或编辑器可快速插入。
- 默认隐藏插件注入的系统消息；通过 `SYS` 按钮切换。
- 停止当前回合。
- 断线时重新打开流并重新获取历史记录。
- "在 Harness Web UI 中打开"命令。
- 通过 ⇲ 按钮将视图停靠在右侧边栏（像聊天面板一样）。

## v0.0.3 刻意不做的事

为安全起见，以下仍不在范围内：

- 不调用 `commands/execute`，不访问 `credentials` 或 `settings` API。
- 不切换模型。
- 不做内联补全、终端/LSP 集成。
- 理由中声明了 full/unrestricted access 的审批不能在侧边栏内放行——卡片只给 Deny 和一个 **Answer in Web UI** 交回入口。
- 不建立第二份会话数据库——Harness Session 是**唯一**的真相源。
- 不自动安装/启动/升级 `dsh`。
- 不 fork 或修改 Harness 源码。

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
   code --install-extension harness-connector-deepseek-0.2.0.vsix
   ```

3. **不用配置任何东西。** 扩展会自动连接：它读取 `dsh web` 写在 `$DSH_HOME/.credentials.yaml` 里的浏览器会话签名密钥，自己签出同一个 `dsh-auth-…` cookie。**没有需要粘贴的 token。**

   需要 cookie 鉴权的 Harness 会对所有 `/api/*` 强制校验该 cookie。该文件是 0600 权限、
   只有你自己能读，所以"能读它"本身就等价于"能完全控制这个 harness home"——自签不是提权。
   详见下文《浏览器会话是怎么来的》。

4. 在 VS Code 中打开一个你想绑定到 Harness 工作区的文件夹。

5. DeepSeek Harness 活动栏图标出现；扩展自动连接。如果你的文件夹匹配到一个已有的 Harness 工作区，其会话会出现在下拉列表中。选择一个，继续对话。

6. **没有匹配的工作区？** 直接输入提示按 Send——工作区和会话会自动创建。

7. **用 `@` 引用文件** —— 在输入框里打一个 `@`，会弹出补全列表；选中即插入为引用（`@src/main.ts`）。也可以在资源管理器右键文件选 **Add to Harness Chat**，或在编辑器里选中文本后右键选 **Send Selection to Harness**（插入 `@src/main.ts:L10-L20`）。**不会把文件内容贴进消息里**：引用只是一个*指针*，宿主会提示 agent 自己去读该文件。这样无论文件多大，你的提示文本（以及它的 KV cache）都保持稳定。

8. 在浏览器中打开 `http://127.0.0.1:3080/` 的同一会话——两端看到的是同一轮对话。

> 没有"设置会话 token"这条命令。cookie 每次连接都从
> `$DSH_HOME/.credentials.yaml` 本地签发，没有任何需要粘贴的东西。

### 浏览器会话是怎么来的

需要 cookie 鉴权的 Harness 会拒绝所有不带浏览器会话 cookie 的 `/api/*` 调用。上游的
官方做法是拿每个进程一次性生成的 launch token 去换——但那个 token **不落盘**，官方文档
要求你手动从终端复制；而且每次 `dsh web` 重启都会换一个。

cookie 本身并不包含 token 的任何痕迹：它是对 `{version, authority, issuedAt,
expiresAt}` 的 HMAC，密钥持久化在 `$DSH_HOME/.credentials.yaml`
（`client-connection/browser-session`），只生成一次、之后每个 `dsh web` 进程复用。
所以任何能读到该文件的东西都能签出**字节级相同**的 cookie——扩展就是这么做的，
你什么都不用粘。这是插件提供的**唯一**路径：粘贴启动 URL 的命令已经删掉，因为一个
每次重启都变的 token，在本地自签可用之后只剩下维护成本。

**安全吗？** 该文件权限是 0600（仅属主可读），里面还存着你的模型 API key——
能读它就已经等于能完全控制这个 harness home。从中签发是*权限等价*，不是提权。
它确实绕过了那个每进程 token 闸门，但那个闸门防的是**远程调用者**（DNS rebinding、
CSRF），不是防已经以你的身份运行的代码。

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
| `deepseekHarness.host` | `127.0.0.1` | **v0.0.x 仅允许 `127.0.0.1` 或 `localhost`。** 其他值会被拒绝。 |
| `deepseekHarness.port` | `3080` | 默认 `dsh web` 端口。如果你用 `dsh web --port <n>` 启动则需修改。 |
| `deepseekHarness.showSystemMessages` | `false` | 显示插件注入的系统消息（运行时上下文、审批通知）。默认隐藏；可通过 webview 头部的 `SYS` 按钮实时切换。 |
| `deepseekHarness.autoSession` | `true` | 从 `$DSH_HOME/.credentials.yaml` 本地签发浏览器会话 cookie。关掉它扩展就没有鉴权了——这是安全开关，不是便利开关。 |
| `deepseekHarness.autoApproveApprovals` | `false` | **v0.0.9+** 自动用 `allowed-once` 回应所有审批请求。默认关闭——开启意味着工具调用不再逐次确认。 |
| `deepseekHarness.autoDiscover` | `true` | **v0.1.5+** 配置的端口没人应答时，在回环地址上另找 dsh Host（先看各 profile patch 里钉的 `webserver.port`，再枚举系统监听表，用 Host 自己的拒绝文本确认）。桌面端需要它——桌面端用系统分配的端口启动 Host。发现的端口只在本次会话内使用，绝不写回设置。 |

## 命令

- `DeepSeek Harness: Connect` / `Reconnect` / `Disconnect`（连接 / 重连 / 断开）——**Reconnect**（同时也是面板标题的 ⟳ 按钮、以及状态行里常驻的那个按钮）会先拆掉当前连接再重新协商一次
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

一个独立的 Node 脚本用真实客户端代码驱动一个**假**的 harness（不预设具体版本——插件是协商的，这个假实现也是）—— 不需要 `dsh web`：

```bash
npm run protocol-test    # 312 项断言：双流传输拆分（$events 白名单 vs
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

想让**真实**的 `dsh web` 自己报出它提供了什么（端点风格、事件套接字，以及
30 个候选方法里哪些存在）：

```bash
npm run protocol-probe            # 默认 127.0.0.1:3080
npm run protocol-probe 127.0.0.1 3080
```

要对**真实** `dsh web` 做闭环验证，用集成测试（需先启动 `dsh web`）：

```bash
DSH_LAUNCH_URL='http://127.0.0.1:3080/?token=<token>' npm run integration-test
```

## 开发

```bash
npm install
npm run build        # esbuild → dist/extension.js
npm run watch        # 变更时自动重建
npm run typecheck
npm run package      # → harness-connector-deepseek-0.2.0.vsix
npm run protocol-test      # 针对假 harness 的 312 项协议断言
npm run protocol-probe     # 报告真实 dsh web 暴露了什么
```

在 VS Code 中按 `F5` 启动带有该扩展的扩展开发宿主。

## 已验证版本

- 默认 `dsh web` 端口 `3080`，且 host 必须位于回环地址。
- **线缆是协商出来的，不是猜出来的。** 端点风格（`session/list` 还是 `session.list`）、
  是否需要 cookie、事件套接字在 0.2.0-rc.2 上是 `/api/remote.mux`、旧版上是 `/api/events.mux`——都在连接时
  自动探测，同一个构建因此能跨 host 版本工作。跑 `npm run protocol-probe` 可以看到
  你的 host 到底提供了什么。
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
- **图片能不能用取决于模型。** 模型是否吃图并不在 `session/modelCatalog` 里发布，插件只能把宿主的裁决透传：不吃图的模型会让 prompt 失败并返回 `MODEL_DOES_NOT_SUPPORT_IMAGES`，面板会提示你去 Controls 换模型。已暂存的附件会**保留**，方便重试。
- **暂存文件绑定进程。** 上传回执同时绑定会话**和**正在运行的 `dsh web` 进程，宿主重启后必须重新选文件。
- 历史记录加载最近约 50 条消息；"加载更早"是未来版本的计划。
- "Open Web UI" 中的会话深链接不做猜测——只打开 Harness 首页。
- 未知的 harness 事件类型会被忽略（协议是可合并扩展的）；它们不会导致客户端崩溃，但也不会渲染。
- **一次回退是把抓到的 `before` 文本写回去——不走 `git checkout`。** 它还会先检查盘上的文件是否仍等于 review 建立时抓到的 `after`；如果文件此后动过，回退会被拒绝并把该文件标为冲突，而不是覆盖。正是这道闸让「不用问就能撤销」这件事是安全的，也是它能说「不」的原因。
- **回合的改动卡片列出的是这个回合改了哪些文件，但其中只有文件工具自己的改动能从中撤销。** 撤销范围限定在该回合产出的 review 内，因为 Host 的摘要只带路径与行数，不带还原所需的文本。某个回合若只通过 shell 命令改了文件，它会直说。
- 改动摘要在宿主上只活到 Session 结束，所以宿主重启后卡片可能解析为「没有改动可显示」。这会渲染成没有卡片，与 Web UI 一致。

## 路线图（v0.2.1+）

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
