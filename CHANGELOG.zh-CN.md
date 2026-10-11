# 变更日志

本项目所有重要变更均记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.1] — 2026-10-11

版本定位：**版本号再也没法各自跑偏，撤销也再没机会吃掉你的改动。**

### 新增

- **`npm run check-versions`——一个闸门管住所有手写的版本号。** 同一个扩展，看的地方不同就显示
  四个不同的版本：Marketplace 列表、`main` 上的 `package.json`、最新的 GitHub Release，以及
  一条从八月一直躺在 README 里的旧 `v0.0.3` 标题。这没有一处是代码缺陷——它们是四个各自手写、
  彼此从没被比对过的字符串，只能靠人发现。

  现在 `package.json` 是唯一书写版本号的地方。闸门拿它去比对：README 的「新特性」标题、安装命令
  里的 VSIX 文件名、两份 CHANGELOG 的第一条、`RELEASE.md` 的打包基线、文档里自称的断言条数，
  以及（加 `--online` 时）已发布的 GitHub Release 与 Marketplace 列表；加 `--release` 时还要
  求标签存在且指向 HEAD。
- **README 的徽章是推导出来的，不是手写的。** `badge/version-0.2.0-blue.svg` 这种 URL 是一个要靠
  人记住的数字，而它被忘了两次；现在换成 shields 的实时端点（`github/v/release`、
  `vs-marketplace/v`）。安装命令保留真实文件名，但是**被检查**的——那是读者要照抄的东西。
- **`DeepSeek Harness: Diagnostics`。** 运行时版本、扩展版本、连接状态、这台 Host 实际提供哪些
  能力、以及最近一次错误，全在一份以未命名 Markdown 打开的文档里，并带一个*复制脱敏报告*动作。
  它由纯函数构造，所以脱敏规则是被单测断言住的，而不是靠信任。
- **连接失败现在被分类，而不是被原样复述。** `Disconnected`、`ECONNREFUSED` 和「Host 拒绝了
  我们的 cookie」过去渲染成同一句耸耸肩。现在有五种——运行时没跑、认证失败、端口错了、协议不
  兼容、未知——各自带解释和一个修复动作。规则刻意按特异性从高到低排：来自 Host 的拒绝，文案里
  也会提到「没能访问 `/api/*`」，把可达性规则排在前面，就会拿「去启动 `dsh web`」去回答一个
  凭据问题。
- **GitHub Actions：`ci.yml`、`e2e.yml`、`release.yml`。** CI 卡住类型检查、版本一致性、协议测试
  以及打出来的 VSIX 内容（14 个文件、源码被排除）。端到端工作流在 Windows / macOS / Linux 三平台
  上跑——光是这一点就值得上矩阵，因为协议测试要解析三种系统监听表的写法。发布工作流由 `v*` 标签
  触发，以 `--release` 模式核验，把版本号**从打出来的 VSIX 里读回来**，并以对应的 CHANGELOG
  段落作为说明把它附上；Marketplace 发布只在存在 `VSCE_PAT` secret 时才会发生。
- **`test/e2e/`——第一条真正跑起来的用户动作链路。** 第 5 条是清单上唯一「有风险」而不是「有
  bug」的一条：agent 改了文件，你又改了它，然后点回退。15 项断言通过一个 `fs` 就是真实文件系统
  的桩，驱动 `ReviewMaterializer` 对着真实的临时目录跑——模拟一个文件系统只会让测试去附和实现，
  而不是抓住它。

### 变更

- **README 描述当前状态，不再兼作 changelog。** 所有 `v0.1.x 新特性` 段落和两节早已过时的
  `v0.0.3 做什么` 都搬走了；历史在本文件里。留在前面的是设计立场、凭据披露、一个版本的说明，
  以及限制。
- **凭据这件事被提到了最前面。** 扩展为了签会话 cookie 会读 `$DSH_HOME/.credentials.yaml`，而
  那个文件里同时存着你的模型 API key。这件事在这个版本之前就是这样、也写在文档靠后的位置；
  现在它有独立的一节，写明由此推出什么，以及一个正式的本地客户端授权流程本可以让它完全没有必要。

### 修复

- **被拒绝的回退把自己的原因丢掉了。** `markConflicted` 设了状态、扔掉了消息，于是卡片只能说
  `conflicted`——一个告诉你「什么都没发生」、却对下一步一字不提的词。现在原因存在文件上、随摘要
  传到 webview、在文件离开冲突态时被清掉，并且折进 review 的渲染签名（同一个文件被拒绝两次、
  理由不同，`state` 是一样的）。那一行显示为「⚠ 未回退」并带上原因。
- **整回合回退是每个文件报一次。** 一个动了 12 个文件、其中 3 个此后被编辑过的回合，会产生 12 条
  通知，把真正有信息的那 3 条埋掉。现在是一次带条数的报告，并明说没被动过的文件已还原、被编辑过
  的文件已被放过。
- **lockfile 从 0.1.5 起就一直带着旧版本号。** 别的面都往前走了，`package-lock.json` 还写着
  `0.1.4`。`npm ci` 不校验根包版本，所以没人发现。它对用户不可见——而这恰恰是值得点名的原因：
  它是本版本的号被写下的**第五个地方**，也是唯一一个既不参与检查、也不随包发出去的。现在它被检查了。

### 说明

- 门禁现在是 **342 项断言**（原 312）：新增的那些钉住了失败分类器（包括那条让认证拒绝不会被读成
  「进程死了」的顺序规则）、脱敏规则，以及「拒绝会留下原因」这件事。
- **端到端覆盖是 5 条里的 1 条，而且这套测试会把它报出来，而不是暗示。** 第 1~4 条打印为
  *未编写* 并附上各自需要什么；运行器只在「跑到且失败」时才返回非零。README 里挂着同一张表。
- 版本闸门当场就抓到了一件真事：`ARCHITECTURE.md` 和它的中文镜像引用的断言条数已经和文档其余部分
  对不上了。这正是它存在的意义。
- 打包基线：**14 个文件**（字节数记在 `RELEASE.md` 里，是在最后一次改动随包文档之后量的——
  本文件本身就是随包文档之一，所以把数字写在这里会让它自己作废）。

## [0.2.0] — 2026-10-11

版本定位：**两个只有用起来才会冒出来的 bug——一个把提示词吃掉的芯片，一张永远答不完的卡片。**

### 修复

- **输入框下面的引用芯片把提示词一起吞了。** webview 里那份 `@` 语法的副本是一个普通字符串，
  交给 `new RegExp` 使用——而字符串字面量会在 `RegExp` 看到它之前先把反斜杠吃掉：`'[^\s"]'`
  到手时已经是 `'[^s"]'`，一个能匹配空格、换行、以及后面那些 `@` 的字符类。于是输入
  `@readmefor_human.md 这里多了文字`，下一行再写 `@RELEASE.md`，只会得到**一个**芯片，
  内容是这全部；而 `:L10-L20` 的行号范围也彻底失效，因为 `\d` 退化成了字面量 `d`。

  现在它是正则字面量，模板自身的转义量正好合适——这也正是它下面两行的 `/\\s/` 一直没出问题的
  原因。文件里本来就有一条「模板会吃反斜杠」的注释；那条注释漏掉的是：**字符串需要四个，
  而正则字面量只需要两个**。
- **已经答完的提问、已经批准的审批，会一直留在屏幕上。** mux 客户端**永远不会**收到
  `question/resolved` 或 `approval/resolved`——只有撤回用的 `cancel`——所以那张卡就一直停在
  输入框上面显示「Answering…」，按钮全是死的，也没有任何东西会把它放掉。**那个 POST 本身就是
  结算**：2xx 意味着宿主已经收下了我们的值，所以现在由它来结算这张卡。POST 失败则把卡片退回
  待答状态，而不是留下同一个死胡同。

### 说明

- 回归防线现在是 **312 项断言**（此前 295）。新增的断言驱动的是**编译产物里的** webview 脚本
  ——只有那一层才看得见被模板吃掉的反斜杠——以及在真实控制器上验证瀑布的生命周期，包括
  顺利路径测不到的「POST 失败」那条路。
- 真机集成仍为 **39/39**。

## [0.1.9] — 2026-10-11

版本定位：**一张本回合改了什么的账本——以及一个撤销键，而不是一张许可单。**

### 新增

- **每回合一张改动卡片。** Host 会记录每个顶层回合动过什么，并以 `workspace/changes`
  Session 事件播报；插件现在把这个播报变成对话流工具行里的一张卡片。卡片的数据来自一个
  普通的带鉴权 GET：`GET /api/changes.summary?sessionId=&seq=`，用播报事件自己的 `seq`
  寻址——那个事件本身就是坐标。

  它和「按调用」的 review 卡片刻意不是一回事。review 是用文件工具自己的 `before`/`after`
  拼出来的，所以它只可能报告文件工具报告过的东西。回合记录是 Host 侧在回合开始与结束各
  对工作区做一次 git 快照（走私有索引、写进临时对象目录），再在 `write`/`edit`/会改盘的
  `str_replace_editor` 调用前后留整份文件副本拼出来的——所以它**也能覆盖 shell 命令里
  `sed -i` 改掉的文件**，而且它是唯一一个描述「整个回合」而不是「其中某一次调用」的来源。
- **单文件回退，或整回合回退。** 每个文件行有一个「回退此文件」，卡片上有一个「全部回退」。
  两者都只在**该回合产出的 review** 范围内生效，因为摘要只带路径与行数，不带还原所需的
  文本——只有 review 留着 `before`。如果某回合的改动全部来自 shell 命令，它会直说，而不是
  假装执行。
- **回合里任意文件的原生 diff**，以 VS Code 自己的 diff 编辑器打开。Host 只给 hunk、不给
  整份文件文本，所以两侧都从 hunk 列表重建，并保持逐行对齐（`+`/`-`/上下文），另一半补空行，
  让第 N 列在两侧都指同一行源码。点卡片里的路径可在编辑器中打开该文件，并定位到被改的那一行。

### 变更

- **review 卡片不再征求许可。** review 描述的是这个回合**已经写进磁盘**的改动——DSH 先写盘、
  下一步再读回来，它整套循环就建立在这个先后顺序上。因此「接受」是一个除了暗示「此前一直在
  等它批准」之外什么也没做的按钮。两个「接受」都已删除；两个拒绝按钮合并为一个「全部回退」，
  每文件那两个 `✕`/`✓` 合并为一个「回退此文件」。卡片标题改为「本次调用改动」，不再把自己
  摆成一份待批件。

### 修复

- **经原生 review provider 打开的每一个 diff 都是空白。**
  `Uri.parse('dsh-review://review-1/foo/before').path` 是 `/foo/before`——层级 URI 会保留
  开头的斜杠——而代码从 `path.split('/')[0]` 取 id，取到的是空字符串，store 查找永远不命中。
  id 现在从 `uri.authority` 读，它本来就该在那儿。新加的改动 provider 有同样的要求，也正是
  它让这个 bug 浮了出来。

### 说明

- 回归防线现在是 **295 项断言**（此前 268）。新增的一组钉住两条路由、hunk 到两侧的对齐、
  URI authority 契约，以及模型侧的卡片语义：每回合一张卡、重复播报是替换坐标而不是叠第二张
  卡、Host 已不再提供的摘要解析为「没有卡片」而不是报错。
- 真机集成 **29 → 39 项**全绿。新增的十条把一个真实回合跑过真实模型，因为最容易悄悄坏掉的
  正是那一次交接——播报给出的是**回合号**，而摘要路由是按**事件 seq** 寻址的，把前者换算成
  后者的只有模型。其中两条是夹具证明不了的：hunk 的前缀格式正是 `hunksToSides()` 用来切分的
  依据；404 等于「没有卡片」还是等于「面板坏了」，是两回事。
- 刻意不做，以及为什么：`POST /api/changes.open`（Host 自己的原生打开路由）跳过——VS Code
  自己的编辑器比桌面窗口是明显更好的目标；部分（hunk 级）回退没有实现——已记入路线图；
  也**没有** `onDidSaveTextDocument` 回流机制——DSH 每一步都重新读盘，一个在它身下被改掉的
  文件，对它来说没有什么需要被告知。

## [0.1.8] — 2026-10-11

**从未发布，也从来没有属于自己的改动。** 这个号只被切过一次，落在如今是 `806ce47` 的那份工作上；
随后改切为 `0.2.0`；回退时又被改切为 `0.1.9`。三个名字标的是同一份工作，也就是上面那条
`[0.1.9]`。中间没有丢掉任何东西，也没有别的功能曾用过这个号。

给它一个标签——`v0.1.8` → `806ce47`——是为了让版本序列没有静默的断档，同时**刻意不建对应的
GitHub Release**：这个名字下没有产物，一个重复 0.1.9 说明的 Release 页只是噪音。标签标的东西
本身已经够清楚了：在 `806ce47` 上，`package.json` 写的是 `0.1.8`，而你正在读的这个文件是以
`## [0.1.8]` 开头的。

## [0.1.7] — 2026-10-11

版本定位：**对话越长，每个流式分块越便宜。**

### 变更

- **webview 每个流式分块都会把整条对话流重画一遍。** `renderVersion` 每来一个分块就变，
  而 webview 拿它当重建信号——拆掉 `#messages`、逐行重来，顺带把每一条助手消息重新
  过一遍 markdown-it。于是一个分块的代价正比于会话长度，这才是「聊得越久越卡」的真实
  机制。在一条 40 轮的对话上实测，每 40 个字符新文本：

  | | 修复前 | 修复后 |
  |---|---|---|
  | 新建 DOM 节点 | 291 | **4** |
  | markdown 解析次数 | 约 42 | **1** |
  | 重解析的 markdown 字节 | 43 KB | **1.4 KB** |

  每个条目现在带两个字段：`uid`（它的 DOM key——流式增量更新、工具行拿到结果时都不变）
  和 `rev`（它自己的变更签名，每次被改都加盖）。webview 按这两个字段做调和，所以一个
  分块只重画一行，其余每一行都保留原有的节点——以及已经解析好的 markdown。`uid` 取自
  进程级计数器，所以为同一会话重建的模型（重连、fork、切换）不会发出一个 webview 手里
  已有节点的 id。
- **一次流式 flush 会按帧数重复投影模型。** `applyMuxFrame()` 在逐帧循环里把模型投影进
  `UiState`，而一次 flush 装着一整轮的增量。现在整批只投影一次，与这批本来就只有一次的
  推送对齐。
- **会话 `<select>` 每次状态推送都重建**——也就是每个流式分块都重建——会在用户正在操作时
  把选择丢掉，只为了重画一份完全一样的列表。现在加了签名守卫。

### 修复

- **回合已结束后到达的增量会多出一个重复的助手气泡。** 实时助手流与持久日志之间没有顺序
  保证，所以一个分块可能落在 `turn/end` 之后——或者落在它所重复的那条权威
  `assistant/message` 之后。它找不到流式占位符，就从空重建缓冲区，在已完成的答案下面再
  追加一个气泡。现在，属于已结束回合、或已定稿步骤的增量会被直接丢弃。

### 说明

- 检查器环形缓冲区的逐帧 `JSON.stringify` 是**实测**过的，不是猜的：一个典型的
  `assistant/stream` 增量约 **1.2 µs**，一条 20 KB 的 `assistant/message` 约 47 µs。按
  流式每秒约 33 帧算，合下来每秒钟几十微秒。所以这次**不动它**：改成惰性计算意味着要
  留住最多 300 个活的 frame 对象，而不是 300 个截断到 2 KB 的字符串——那是拿内存换空气。

## [0.1.6] — 2026-10-11

版本定位：**一次问答不再把整条对话流重画两遍。**

### 修复

- **一次问答会让整条对话流重建两遍。** 在一条 72 条记录的会话上实测：一个审批/提问事件
  产生 **2 次**全量状态推送、约 70 KB、**2 次**完整 DOM 重建；一次作答往返合计
  **6 次推送、约 212 KB、6 次重建**。三个原因，都修了：
  1. 事件到达会推送两次——`ApprovalStore` 自己的变更监听器一次，刚改完 store 的调用方
     再一次。两次落在同一个 tick 里，中间没有绘制的机会，所以第二次只是把主线程时间
     翻了一倍。
  2. `pushReviewApprovalState()` 无条件 `model.touch()`。但审批和提问**根本不在对话流里
     画**——`renderTool` 里写明了这件事——只有 review 卡片画在里面，所以只有 review 变化
     才该触发重建。
  3. `session/follow` 批处理的回调无条件 `pushState()`，批里什么都没变也照推。
  修复后：一个事件 **1 次推送、0 次对话流重建**；一次作答往返 **3 次推送、0 次重建**。
- **检查器的事件环形缓冲区搭上了每一次状态推送**，哪怕面板是关着的。它是 300 帧 ×
  最长 2 KB ≈ 600 KB 的结构化克隆，而 `pushState` 在流式输出里是逐块触发的。
  实测：缓冲填满后单次推送 **1,318,580 字节**，其中绝大部分没有任何人读。现在只有面板
  开着才发布（开面板时一次性补全历史），关掉立刻回落——实测 **1.29 MB → 35 KB**。
- **检查器列表会越堆越多。** 它每次都把整个数组 append 一遍，而缓冲区是环形的、头部会
  移动，于是每来一帧就多堆一份完整的行（300、600、900…）。改为整体重建，代价有界
  （最多 300 行）。
- **把提问或审批交给 Web UI 成功时，弹的是红色错误提示。** 那是正常操作，却走
  `notifyError`，看起来像失败。

### 移除

- `ToolItem.approvalRpcId` 和写它的 `ConversationModel.setApprovalRpcId()`。写进去之后
  没有任何地方读，而它带的 `renderVersion` 自增会在 store 监听器那次推送之上再逼出一次
  完整的对话流重建。

### 验证

- 回归门 **231 → 243 项**全绿，新增第 I 组：一个提问到达只推送一次状态、且**不动**
  `snapshot.renderVersion`；作答同理；环形缓冲区在面板关闭时不发布、打开时补全、关闭后
  清零。
- 真机闭环 **29/29** 不变（跑在桌面端 Host 上）。
- 一条 72 条记录会话上的实测对比（单次事件）：

  | | 推送次数 | 载荷 | 对话流重建 |
  |---|---|---|---|
  | 修复前 · 提问到达 | 2 | 70,794 B | 2 |
  | 修复后 · 提问到达 | 1 | 35,397 B | **0** |
  | 修复前 · 作答 | 2 | 70,800 B | 2 |
  | 修复后 · 作答 | 1 | 35,400 B | **0** |
  | 修复前 · 检查器缓冲满 | 2 | 1,318,580 B | 2 |
  | 修复后 · 检查器缓冲满 | 1 | 35,399 B | **0** |

## [0.1.5] — 2026-10-11

版本定位：**Host 换了端口、或者被重启之后，不用再重载 VS Code。**

### 新增

- **常驻的 Reconnect 按钮**（状态行里一个，视图标题里一个）。点它总是把旧连接拆干净、
  重新协商一次。为什么必须"强制"：Host 重启之后客户端这边的状态**仍然是 `connected`**
  ——流只是不响了——而普通的 `connect()` 会在这个状态上直接早退。这个空档正是过去
  "只能重载窗口"的原因。
- **Host 自动发现**（`deepseekHarness.autoDiscover`，默认开）。配置的端口没人应答时，
  先读 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里钉过的 `webserver.port`，再枚举本机
  loopback 监听端口，用 Host **自己的匿名拒绝文本**当指纹逐个确认——`401` +
  `dsh web authentication required; reopen the URL printed by dsh web.`。这句话来自
  connection carrier 的栅栏而不是 web 前端，所以哪个入口启动的 Host 都会这么说。
  为什么需要它：**桌面端用 `--port 0` 启动 Host**（`apps/desktop-host/src/index.ts`
  里写死），端口由系统每次重新分配，只通过 Node IPC 报给 Electron，不落盘。
  发现的端口只在本次会话内使用，**不写回设置**——那是一个每次启动都会变的端口，
  写进去只会留下一个下次必然过期的钉子。真机实测：46 个 loopback 监听里命中 1 个，
  并正确归因到 `desktop` profile 里钉的端口。
- `HarnessClient.target()`：取当前指向的 host/port。
- 连接请求**串行化**：一次点击对应一次尝试，重叠的点击排队等待，而不是两个协商互相
  拆掉对方的 socket。

### 修复

- **强制重连之后，原来打开的那个会话会丢。** `disconnect()` 拆掉了 `session/follow`
  订阅，而 `refreshSessions()` 在 `activeSessionId` 已设置时是**故意不动**它的——结果是
  对话还留在屏幕上、订阅已经没了。现在重连后会重新选中同一个会话（重建 model、重新订阅、
  重拉历史，也就是文档里写的"重建而不是游标续传"）。会话在这个 Host 上确实不存在时才
  退回到最新的那个。
- **每次切换会话都会泄漏一个 `session/follow` 订阅。** 它们被丢进 `disposables` 之后再
  也没被释放；而重连现在每次都会重新选中会话，泄漏会加速。改为显式持有，切换前先释放。
- **没有 cookie 的时候却报"签名密钥被轮换了"。** `authRequired()` 无条件调用
  `noteRejected()`，于是"压根没拿到会话"（`autoSession` 被关掉，或者
  `$DSH_HOME/.credentials.yaml` 还不存在）被描述成"运行中的 Host 拒绝了我们以为有效的
  cookie —— 它的签名密钥几乎肯定被重新生成了"。用户会去查错误的东西。现在只有真的
  发出过 cookie 才记录这次拒绝。
- **`connect()` 在 `connecting` 状态上早退**：一次卡住的连接会让重试按钮变成空操作。
  串行化 + 强制拆连之后，这条路径不再存在。

### 变更

- 面板打开时的自动连接改用新的**非破坏性** `ensureConnected`：光是把面板打开，不应该把
  扩展宿主已经建立的会话拆掉再重建。按钮依然是强制的那条路。
- 视图标题里的重连图标不再挂在 `deepseekHarness.offline` 条件上——那恰好让它在最需要
  重连的时候消失。`deepseekHarness.offline` 这个上下文键从此没有使用者，连同
  `syncOfflineContext()` 一起删掉了。

### 验证

- 回归门 **211 → 231 项**全绿。新增 G3 组：面板 boot 发的是 `ensureConnected` 而不是
  破坏性的 `connect`、点按钮发的是 `{type:'connect'}`、已连接时按钮仍在且读作
  `⟳ Reconnect`。新增 H 组：`webserver` 钉端口解析（只认 `webserver` 条目下的 `port`）、
  三平台监听表解析（含 `/proc/net/tcp6` 里 `::1` 的**字序**——`01000000` 不是
  `00000001`）、指纹的"是 Host / 是别的 HTTP / 静默"三条判定、发现的排序与负例。
- 真机集成 **25 → 29 项**全绿，其中四条为新链路实测：真实 Host 能被匿名指纹认出来、
  一个普通 HTTP 监听器**不会**被误认成 Host（指纹匹配一切就等于没有指纹）、强制重连后
  连接仍在、那个会话仍然在 Host 上。

## [0.1.4] — 2026-10-10

版本定位：**问题与审批现在真的能在 VS Code 里回答了 —— 而且点"允许"真的等于允许。**

### 修复

- **Agent 的提问（`user-questions/request`）在 VS Code 里完全没有出口。** 客户端一直把它
  正确翻译成 `question/requested`，然后控制器把这一帧丢在地上：既不渲染，也无法回答。
  后果比"少一张卡片"严重——Host 侧 `ask_user_question` **阻塞**着那次工具调用，没人回答，
  这一轮就停在那里。现在它和审批共用同一个待答面板。
  - 单问题单选：点选项即作答（与 Web UI 的选项卡片一致）；多问题或复选：显式点 Answer，
    一次提交整批，未作答的会就地报错而不是发一批空答案上去。
  - 自由文本始终可用，走 `custom` 字段（不是 `selected`）。
- **点"允许"从来没有允许过任何东西。** 审批的应答体发的是 `{ kind: 'result' }`，**没有
  `value`**。但 `value` 就是 Host 瀑布的返回值，省略它等于用 `undefined` 结算；而
  `ApprovalService.decide` 会把一切不在词表内的返回值（包括 `undefined`）归一化成
  `'unavailable'` —— 一次**静默的 fail-closed 拒绝**，而且照常写一条看起来正常的
  `approval/decided` 审计。真机实测：裸形状 → `outcome: "unavailable"`，工具报
  "requires approval, but no approval channel is available"；带值形状 →
  `outcome: "allowed-once"`，命令真的执行了。
- **点"拒绝"也被记成了"没有可用的审批通道"。** 原来把拒绝编码成
  `{ kind: 'rejected', error: … }`，那会 *取消* Host 瀑布，`decide` 里的 containment
  再把它归一化成 `'unavailable'`。拒绝是一个携带词表字符串的 **result**，不是传输层错误。
- **在 Web UI 里回答过之后，VS Code 的卡片永远点得动。** Host 对 mux 客户端**只**发一个
  `cancel` 帧表示撤销（0.2.1 不转发 `approval/resolved` / `question/resolved`），而旧代码
  只把它记进日志。现在 `cancel` 会被翻译成 `waterfall/resolved` 并撤掉对应卡片。
- **审批卡只在"能匹配到工具行"时才画得出来。** 它原来嵌在 ToolItem 里，靠 `callId` 匹配；
  没有匹配行就等于不存在。现在待答项有自己的面板，位于输入框上方——用户准备打字时
  正在看的地方。

### 变更

- **审批的放行门槛改成看"理由"，不再看工具名。** 原来的白名单是
  `write/edit/read/grep/…` ——它列的这些名字本机 Host 根本没有（shell 工具叫
  `pwsh`/`bash`），于是**每一次真实的 shell 升级都会被拒**，而这条路径恰好是最常见的。
  名字本来也说明不了申请有多大权限，理由才说明（"escalate sandbox to
  danger-full-access: …" 是 Host 自己写的风险陈述），而且理由会**原样显示**在按钮旁边。
  现在只在理由声明了 full/unrestricted access 时不给内联允许；那张卡仍会显示、仍可拒绝、
  并多一个 "Answer in Web UI" 把它交回浏览器。被拒绝时也不再是没有解释的灰按钮——
  `blockedBy` 会说明原因。
- 面板不再把"已解决"的请求画出来。

### 新增

- `delegateWaterfall`：把仍开着的瀑布交回 Host 链（`outcome: {kind:'next'}`）。这是真正的
  委托而非忽略——我们放弃自己的 delivery，请求继续留给 Web UI；只有当没有别的 delivery 时
  Host 才会用 `next()` 结算。

### 验证

- 回归门 **190 → 211 项**全绿，新增第 G2 组（面板渲染、Allow/Deny 发出的**确切**载荷、
  高危卡不给 Allow 但给交回、单选点击即答且按**标签**而非下标、多问题必须显式提交、
  空答案就地拦下、自由文本走 `custom`、已解决项离开面板），第 08 组补上四种信封的断言。
  webview 桩升级到可"驱动"（记录监听器、`innerHTML=''` 清空子树）。
- 真机集成 **21 → 25 项**全绿，其中两条为新链路实测：Host 把 `user-questions/request`
  交付给 mux 客户端且答案回到了被阻塞的工具调用；Host 交付 `approval/request` 且
  "允许"**真的授予了**越界升级（命令执行成功）。

## [0.1.3] — 2026-10-10

版本定位：**修好了"能连上但收不到回话"，补上了图片与真正的文件上传，顺手拔掉两个静默 bug。**

> 中文版此前停在 0.0.8；0.0.9 ~ 0.1.2 的完整记录见英文版 [CHANGELOG.md](./CHANGELOG.md)，
> 本段只记 0.1.3。

### 修复

- **"Connected" 之后一片安静。** 插件一直把传输层建模成"一条 `$events` 承载所有帧"。
  真机（`0.2.1-alpha.2`）上 `$events` 只发一个 `ready`（所以面板显示 Connected）然后
  **一条对话流量都没有**——它是一份固定的转发白名单。对话在另一条逻辑流
  `session/follow` 上：`snapshot` → `event` → 实时 `assistant-stream`。两条流现在各开一条
  socket。真机验证：`p` + `ong` → `pong`，模型快照 4 项。
- **没有 `start` 的 `chunk` 直接丢弃**，不猜归属（猜错就是把文本拼到别的回合上）。
- **`api-session/status` 不再被丢掉**，翻译成 `session/status`，Stop 按钮状态才对得上。
- **"没有这个方法"与"这个 workspace/会话不存在"被混为一谈。** 真机事实：方法不存在是
  **HTTP 404**，业务错误是 200 + `workspace/not-found`。原先过宽的正则会劝用户去"升级宿主"。
- **`@` 浮层曾根本打不开**：陈旧守卫拿的是"上一次回复所回答的查询"（初始 `undefined`），
  第一次敲 `@` 就被自己挡掉；且成功分支只写候选不写查询，而 composer 要求两者匹配。
- **历史永远是空的，而且每次重连都会把对话擦掉。** `session/page` 一直写死 `throughSeq: 0`，
  但它是**日志游标**不是条数（上游 `history.ts`：`-1` = 空页，`0` = 只要第 0 条，越界报
  `past cursor N`）。唯一来源是 `session/follow` **开场帧**的 `snapshot.cursor`——现在客户端
  记录该游标（单调不回退），没学到游标时**直接返回空页、不发请求**。第二层更致命：
  调用方把空页当事实折进模型，于是**每次 socket 重连都清空一次正在看的对话**；
  现在空页只记日志，绝不清屏。
- **参数形状重试把记住的正确形状排在最后试。** 每次调用先白烧两次失败往返，wire 形状还会
  因宿主宽容度而漂移。改为**记住的形状优先**。

### 新增

- **图片支持：粘贴 / 拖拽 / 选文件 → 待发 chip → 内联进 `session/prompt`。** 图片作为内联部件
  `{ type: 'image', mediaType, data, name? }`（`png/jpeg/webp/gif`）随 prompt 发出；
  只发图片不发文字合法。契约从 `deepseek-harness@0.2.1-alpha.2` 源码 + 真机双侧钉死：
  宿主上限单张 20 MiB / 单条 20 张 / 合计 200 MiB；`admitPromptContent` 会把内联图片**提升**为
  `ImageAttachmentRef`（归一化、可能缩放），落库的是 `sha256:…`。
  **模型能力不发布、无法预判**：不吃图的模型返回
  `session/attachment-invalid` + `details.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES`，
  面板把它翻译成"去 Controls 换模型"，并**保留**已暂存附件方便重试。
- **非图片文件走真实上传路径。** `session/attachment` 其实是"按 id **读**附件"
  （`{ request: { sessionId, attachmentId } }`），旧代码把它当上传接口，所以怎么发都是
  `boundary validation failed`。真正上传是裸 HTTP：
  `POST /api/session/uploadFileBinary?sessionId=<id>&name=<leaf>`，原始字节 body，
  返回 `{ ok: true, value: { receiptId, file } }`；prompt 里用 `{ type: 'file', receiptId }` 引用。
  回执同时绑定会话与 `dsh web` 进程，宿主重启即失效。
- **自动连接失败时有得点了：状态行 `Connect` 按钮 + 标题栏插头图标。** 按钮三态
  （`Connect` / `Retry` / `Connecting…`，进行中禁用）；`package.json` 贡献一条 `view/title`
  菜单，`when` 为 `view == deepseekHarness.sessionView && deepseekHarness.offline`，
  插头图标**只在未连接时**出现。（"auth 为什么返回未就绪"仍是未解问题，按钮是地板不是修复。）
- **附件字节永不进 `UiState`。** `pushState` 每个流式分片都触发，所以 `pending` 只放 chip 元数据；
  base64 留在 controller，webview 用本地 `URL.createObjectURL` 自建缩略图并复用其 `key` 当 chip id。
- **`@` 引用改用宿主自己的语法，且不再粘贴正文。** 支持 `@path`、`@"含空格的 path"`、
  `@dir/`，可带 `:L<n>` / `:L<n>-L<m>`；补全走 `fileReferences/list`（内层 args 是
  **裸对象**，没有 `request` 包装）。`someone@example.com` 不会被误判成引用。

### 移除

- **`DeepSeek Harness: Set Session Token from Launch URL` 命令及其标题栏菜单项。**
  本地自签已是实际唯一可用路径。

### 验证

- 回归门 **108 → 180 项**全绿；真机集成测试 **16 → 21 项**全绿，新增 08b 段落跑真图闭环：
  遍历 `modelCatalog` 找到肯收图的模型路由（默认 `deepseek-v4-flash` 被拒、`deepseek-flash` 收下）
  → 内联发图 → 经 `session/page` 找到持久图片引用（`sha256:97a3a410…`）→
  `session/attachment` 读回 73 字节并校验 PNG 签名 → `uploadFileBinary` 拿到回执 →
  再发一条引用该回执的 prompt 并被准入。
- **顺带修掉一条"偶然通过"的断言。** 两种持久消息记录嵌套方式不同，而且是静默失败：
  `user/message` 的内容在 `data.content`（图片的持久引用就在这），
  `assistant/message` 与 `system/message` 才在 `data.message.content`。集成测试那条
  "落库消息带持久图片引用"只查了嵌套形式，所以**永远找不到图片**——它此前"通过"过，
  是偶然命中而不是测量。现在这个不对称被协议层断言钉死，失败时还会打印实际记录形状。

## [0.0.8] — 2026-09-19

版本定位：**真实的线缆契约——DeepSeek Harness `0.2.0-rc.2`。**

v0.0.7 是按推断出的 `0.1.0-rc.6` 模型发布的，但它仍然和本机真正在跑的宿主对不上（本机是
**`0.2.0-rc.2`**）。握手已在该宿主上真机验证通过，传输层也据此重写为真实形状。本版本把文档
描述的契约钉死到宿主实际提供的样子。

### 修复（线缆契约更正为 0.2.0-rc.2）

- **一元 RPC 信封。** 调用为 `POST /api/<ns>/<method>`（斜杠风格），body 是
  `{ type:'client-request', rpcId, method, payload:{ args:<inner> } }`——`payload` **必须**包一层
  `{args}`。内层字段名：`session/list` 用 `_request`，多数方法用 `request`，少数无参方法用 `{}`。
- **响应信封。** `{ type:'server-response', rpcId, result:{ ok, value|error } }`。方法不存在时返回
  **HTTP 404 + 纯文本 `not found`**（不是 JSON 错误），因此能力探测能区分"不存在"与"参数写法不对"。
- **事件套接字。** `ws://host:port/api/remote.mux`——一条**双向**逻辑流 mux。客户端打开后发
  `{ type:'open', streamId, endpoint:'$events', payload:{args:{}} }`；宿主首帧为
  `{ type:'ready', clientId, host:{ home } }`。
- **审批流程。** 线缆事件是 `approval/request`（渲染为 `approval/requested`），通过
  `POST /api/$events/result` 带 body `{ clientId, eventId, outcome }` 来应答——而非旧的 `/api/respond`。
- **历史。** 通过一元 RPC `session/page` 拉取，**不是** `session/history`。
- **鉴权。** 宿主对每次 `/api/*` 调用都要求浏览器会话 cookie（无则 401）。autoSession 仍从
  `$DSH_HOME/.credentials.yaml` 本地自签。

### 变更

- **传输层重写为 rc.2。** `harness/protocol.ts`（信封 + 参数写法）、`harness/events.ts`
  （`RemoteMuxSocket` + `ready` 帧处理）、`harness/client.ts`（斜杠端点、`{args}` 载荷、`$events/result`
  审批、`session/page` 历史）、`harness/wire.ts`（协商 + 能力探测）现在都面向 `0.2.0-rc.2`。
- **控制面能力集（rc.2）。** 存在的：`session/fork`、`session/rename`、`session/selectModel`、
  `session/updateQueue`、`workspace/archiveSession`、`session/page`、`workspace/create`、
  `session/modelCatalog`。rc.2 中**不存在**：`session/command`、`agentPreset/*`、`subagent/*`、
  `host/describe`、`workspace/list`、`llm/models`、`session/history`、`goal/*`。UI 对每个控件都做实时
  探测门控，因此更老/更新的宿主只会显示更少的控件。
- **回归门重写。** `scripts/protocol-test.ts` 现在驱动真实的 rc.2 假 harness（斜杠端点、`{args}`
  包裹、`/api/remote.mux` + `ready` 帧、`$events/result` 审批、`session/page` 历史、404 not-found
  探测、rc.2 控制面门控）——**83 项断言通过**，无需 `dsh web`。
- `scripts/protocol-probe.ts` 打印协商出的 rc.2 控制面清单。

### 说明

- 端点字符串仍统一经过 `WireProfile`（协商斜杠/点分 + 参数写法），所以未来宿主若翻转任一维度，
  代码无需改动即可继续工作。

## [0.0.7] — 2026-09-30

> ⚠️ **协议更正。** 本版本基于一个**推断出的** `0.1.0-rc.6` 模型发布，但它仍然和本机真正在跑的宿主对不上。真实契约是 **`0.2.0-rc.2`**——见 [0.0.8] 的传输层更正。

版本定位：**握手成功——连上真实的 `dsh web`（rc.6）。**

插件此前按一个并不存在的线缆契约（`0.1.6-alpha`）实现，而本机真正安装的运行时是
`0.1.0-rc.6`，两者并不兼容：rc.6 没有 `ready` 帧、没有 `$events` 逻辑流 mux、没有
`session/follow` 流、也没有 `$events/result` RPC。于是 v0.0.6 在 **Windows 和 Ubuntu**
上都卡在死等一个永远不会到达的 `ready` 帧（10 秒超时）。本版本用真实的 rc.6 传输模型
替换掉那套虚构模型。

### 修复

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

### 变更

- **`harness/client.ts` 按 rc.6 契约重写**；`events.ts` / `protocol.ts` / `wire.ts` 修正为真实的帧形状
  （`server-request` 信封、`session/event` 以 `assistant/chunk` 承载流式）。UI 层
  （`controller` / `view` / `control`）未改动——它们消费的本来就是正确的 `MuxFrame` 联合类型。
- **回归门已更新。** `scripts/protocol-test.ts` 现在用真实的 rc.6 假 harness 驱动真实传输
  （86 项断言：协商、mux 下行、host.describe、session.history、/api/respond、控制面，以及对受限
  host 跑 autoSession cookie 机制）。

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

[0.0.1]: https://github.com/YichuAI/deepseek-harness-vscode/releases/tag/v0.0.1
