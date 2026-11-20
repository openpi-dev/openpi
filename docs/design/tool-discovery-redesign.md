# 工具发现重设计：稳定前缀，而不是中途 `toolsAdded`

- Status: `draft`。设计探索，不是已接受的 Decision，也不改变运行时。
- Created: 2026-10-17。本记录只核对了写出时能读到的源码与公开文档，没有复跑模型、Terminal-Bench 或 Harbor。
- Source boundary: OpenPI `708a44b52cb260cb6c35c25c4f5bd63ebfec369c`；锁文件中的 `@earendil-works/pi-coding-agent` 1.2.0。Pi 行为以下列公开文档和 changelog 为准，不是对 `resolveTranscriptTools` 的逐行复核。
- Related: [#19](https://github.com/openpi-dev/openpi/issues/19)、[#20](https://github.com/openpi-dev/openpi/issues/20)、[#644](https://github.com/openpi-dev/openpi/issues/644)（已关闭，原主张被作者撤回）、[Decision 0004](../decisions/0004-capability-name-discovery.md)、[`CAPABILITY_GATEWAY_BOUNDARY_2026-08-30.md`](../research/CAPABILITY_GATEWAY_BOUNDARY_2026-08-30.md)、[`CODEMODE_DEFAULT_2026-10-13.md`](../research/CODEMODE_DEFAULT_2026-10-13.md)。
- Supersedes: none。未写入 [`docs/design/README.md`](README.md)，以免把讨论稿当成已归档设计。

## 两分钟结论

OpenPI 用两道闸门省首轮 token：能力组按意图加载，组内生命周期工具再按资源显隐。第二道闸门会在会话中途调用 `setActiveTools`。工具定义处在提示前缀的最前面；不支持「中途添加工具」的提供方会因此重放整段已缓存对话。支持该能力的提供方也只在「只增不删、且系统段不被折回开头」时保住前缀。

这不是再调一调 `bg_start` 就能结束的局部问题。Pi 已经有不改声明集的发现面：`exposure: "deferred"` / `"codemode"`、`tool_search`，以及 MCP 的默认 Code Mode。Anthropic 与 OpenAI 的缓存指导也是同一句话：顶层工具定义保持稳定，后发现的定义追加到对话末尾。

建议拿来讨论的方向：可选工具不要再靠 OpenPI 的显隐进入模型；要么在会话第一轮就冻结进声明集，要么永远留在 Pi 的 Code Mode / tool search 里，只在后缀展开。生命周期工具（`bg_status` 等）和 `context_pivot` 的按轮显隐应先停。不要为此再做一个代码执行器或第二套 MCP 客户端。下面五条方案都不是决议。

---

## 1. 问题

### 1.1 要省的成本和实际付的成本

普通父会话在 `explicit` 发现下不常驻任何 OpenPI 工具，首轮只有 Pi 的 `read` / `bash` / `edit` / `write`，再加上 OpenPI 默认打开的原生 `codemode`。用户点名能力后，`before_agent_start` 加载对应组；组内管理工具仍要等资源出现才进入活动集。后台终端是最清楚的例子：先只有 `bg_start`，成功之后才打开 `bg_status`、`bg_list`、`bg_kill`、`bg_watch`。

省下的是首轮 schema 和 `promptGuidelines`。付出的是：下一次模型请求的工具列表或系统段和上一次不一样。

Anthropic 把缓存层次写成 `tools` → `system` → `messages`。改工具名、描述、参数或顺序，工具缓存以及它后面的系统和消息一起失效。OpenAI 同样把 `tools` 算进可复用前缀；诊断码 `tools_changed` 的建议是保持定义和顺序不变，用 `tool_choice: "none"` 或 `allowed_tools` 限制可调用集，或者用 `defer_loading` 把后发现的定义追加到上下文末尾。

所以「晚一点再注册工具」节省的是第一次请求的输入，打掉的是这次改动之后每一次请求对既有前缀的复用。会话越长，后面的损失越大。讨论发起方转述的取舍是：这个晚到的 cache miss 不可接受，需要重做工具发现，而不是在现有显隐上再抠几个工具。

### 1.2 任务里引用的 Terminal-Bench 数字

任务陈述给出的对照是：重叠前缀上 cache hit 大约 59%，opencode 大约 90%。**本记录没有复跑，也不把这个数字当作已验证的 Benchmark。** 它只说明讨论要解释的现象：延迟 `toolsAdded` 与稳定工具定义之间，命中率可以差出一大截。

已有的公开测量边界不同，不能拿来填这个数字：

- [#644](https://github.com/openpi-dev/openpi/issues/644) 在 Pi 0.99.2 / OpenPI 0.9.0、DeepSeek `deepseek-flash`（`openai-completions`）上，曾把工具显隐与前缀失效联系在一起，并给出过「紧跟变更的请求命中率 22%–35%、全天命中率仍有 93%–98%」这类会话统计。作者随后用三次五轮会话复查，报告变更后仍有 90%–100% 命中，并关闭了该 Issue。撤回的理由是：当时一起变化的还有系统段；在不声明 `supportsMidConvoSystemMessages` 的自定义提供方上，Pi 会把系统段折进开头的系统消息。作者没有把「工具数组本身」和「系统段」拆开核实。
- [#20](https://github.com/openpi-dev/openpi/issues/20) 和 [能力网关研究](../research/CAPABILITY_GATEWAY_BOUNDARY_2026-08-30.md) 支持的是另一件事：普通回合零常驻 OpenPI 表面，可以去掉可重复测量的静态 schema 税。它们没有测量「中途把工具加进声明集」的缓存代价。

两份材料可以同时为真：零常驻降低第一轮输入；中途改变声明集在部分提供方上推翻前缀。59% 对 90% 仍待按提供方、模型兼容标志和「只改工具 / 只改系统段」拆开测量。见第 6 节。

### 1.3 为什么现有的「单调加载」不够

`loadOpenPiCapabilities` 故意没有卸载：组一旦加载就留在本会话，避免工具反复出现和消失。这条不变量只覆盖能力组。组内和第二层状态工具仍然会增也会删：

| 表面 | 何时进入声明集 | 会不会再消失 |
| --- | --- | --- |
| 能力组的 `entry` | 意图匹配，或 `adaptive` 下模型调用 `openpi_load_tools` | 组本身不卸载 |
| `bg_status` / `bg_list` / `bg_kill` / `bg_watch` | `bg_start` 成功之后 | 每个 `session_start` 先关掉 |
| `tasks_update` / `tasks_list` | 存在可行动任务 | 批次关闭后关掉 |
| `get_goal` / `update_goal` | goal 处于 active | 清除后关掉 |
| `context_pivot` | 上下文估计 ≥ 30_000 token，且每次 `agent_start` 重算 | 低于阈值就关掉。#644 的一份本地统计里，这种开关发生了 88 次，同期调用次数为 0 |
| `plan_ready`、`ask_user`、`human_handoff` | Plan 或 Setup 情节 | 情节结束就关掉 |
| `configure_my_pi_setup` | `/openpi-setup` 情节 | 情节结束就关掉，下一次情节再打开 |
| `openpi_browser` | 设置里打开浏览器控制 | 设置关闭就关掉。注册时还带了 Pi 的 `exposure: "deferred"` |

[#644](https://github.com/openpi-dev/openpi/issues/644) 对 Pi 0.99 的阅读是：只有 `supportsToolAdditions` 为真、且这次没有删除或重定义工具时，新增才锚在对话中部；否则顶层 `tools` 变成当前完整集合。Pi 1.0.1 的 changelog 写明，Anthropic 中途新增或同名重定义改为对话内联，以免重发整份工具列表。本记录没有核对 1.2.0 在「同一次变更里既有 `toolsAdded` 又有 `toolsRemoved`」时是否仍放弃锚定。

即便添加本身能锚定，OpenPI 的工具还带 `promptSnippet` 和 `promptGuidelines`。活动集一变，系统提示里的工具清单和规则也会变。不支持中途系统消息的提供方会把这段折回开头。#644 的撤回把这个通道当成比工具数组更可疑的原因。两条通道都要测，不能用「Pi 已经会发 `toolsAdded`」推出「前缀没变」。

OpenPI 自己的 Cursor / Antigravity 投影把这个问题写死了。`extensions/ai-providers/transcript.ts` 的 `resolveTranscript` 用 `getCurrentSystemPrompt()` 和 `getCurrentTools()` 得到**当前有效**的一份系统提示和一份工具列表，再丢掉原来的 system 消息。中途追加的 `toolsAdded` 到了这两条线上会重新变成开头的 `tools`。

## 2. 本仓库现在怎么发现工具

事实与推断分开。本节的机制描述对应当前检出；缓存后果在第 1 节已经标明哪些仍是推断。

### 2.1 两套名字都叫 deferred

OpenPI 的 `OPENPI_TOOL_SURFACE.*.deferred` 不是 Pi 的 `exposure`。它只是 `patchOwnedTools` → `pi.setActiveTools()` 的期望名单。工具用 `pi.registerTool` 注册，默认 `exposure` 为 `direct`，注册时就会激活，再由 `session_start` 上的 patch 从活动集拿掉。活动集就是声明给模型的那一组。

Pi 1.2 的 `ToolExposure` 是另一套：

| `exposure` | 声明给模型 | 谁能调用 |
| --- | --- | --- |
| `direct` | 活动时声明 | 活动时可被 `ctx.executeTool` 调用 |
| `model-only` | 活动时声明 | 不能被别的工具调用 |
| `codemode` | 不声明，除非被显式激活 | 一旦注册就可被 Code Mode 调用，并出现在 `codemode` 的列表里 |
| `deferred` | 不声明，除非被显式激活 | Code Mode 能调用，但 `codemode` 的描述不列出它；`tool_search` 能找到并激活 |
| `hidden` | 激活也无效 | 不可达 |

OpenPI 只有 `openpi_browser` 设置了 Pi 的 `exposure: "deferred"`。后台、任务、goal、plan、setup、context 都走 OpenPI 自己的显隐，不走这套 exposure。

### 2.2 能力加载

`extensions/capabilities/index.ts` 在 `session_start` 调用 `resetOpenPiToolSurface`，把父会话收成最小面。`explicit`（默认）不留下 `openpi_load_tools`；`adaptive` 只留下这一个网关。`before_agent_start` 在用户提示匹配时直接 `loadOpenPiCapabilities`。匹配规则是运行时不变量，不是模型路由器：`subagent` / `workflow` 及其余中文名按 [Decision 0004](../decisions/0004-capability-name-discovery.md) 点名即加载；search、background、session 仍要明确动作。加载不执行工具。Delegate、Workflow、Background 还会在上下文里追加一条 Skill 路径提示。

组内 `entry` 在组可见后进入活动集。`deferred` 仍由各 owner 的第二道闸门决定。Subagent 和 Workflow 的 `deferred` 名单是空的：一组加载就整组声明，这已经是缓存上更干净的形状。Background、Tasks、Goal 不是。

### 2.3 Code Mode 与 MCP 没有接成一条 OpenPI 管道

`extensions/code-mode/index.ts` 只在父会话 `session_start` 把 Pi 已经注册、默认不活动的 `builtin:codemode` 放进活动集。`codeMode.enabled` 默认 true。它不解释脚本，不注册第二执行器，不改写 Pi 的 `defaultTools`，也不把 OpenPI 工具改成 `exposure: "codemode"`。子会话的工具白名单仍是权威边界；这个默认值不放宽子会话。

MCP 由 Pi 的 `builtin:mcp` 拥有，不是 OpenPI 包一层 `list_tools`。按 Pi 当前 MCP 文档：

- 服务器默认 `exposure: "codemode"`。工具可从脚本里用 `searchTools()`、`describeTool()` 或 `ALL_TOOLS` 找到，不声明给模型。
- `deferred` 的服务器会激活 `tool_search`。`tool_search` 加载过的工具写进记录，并在该分支上保持声明。
- 只有 `direct`，或 `toolExposure` 点名的工具，才作为经典 schema 出现。
- `codemode` 与 `deferred` 的服务器写在系统提示的 `mcp_servers` 段里，一行摘要。段变了就**追加**到对话，而不是改工具声明，以便前面的消息继续命中缓存。
- `codemode` 的描述故意不包含 deferred 工具、工具数量和 MCP 说明，避免服务器连上时描述变长。`codemode.inlineBudget` 默认约 3000 token，用来列出它确实要内嵌的声明。

因此：**MCP 在 Pi 里默认走 Code Mode，不走「每个 MCP 工具一个经典 schema」。** OpenPI 没有把 MCP `tools/list` 再包进自己的代码工具。OpenPI 自己的工具则几乎全部是经典 schema，再用 `setActiveTools` 延迟声明。两条路现在是并列的，不是同一条发现管道。

子会话会加载 Pi 内建工厂，所以 `tool_search` 和 `codemode` 可以注册；父级活动面里有的名字，会在子会话里再激活一次，但 parent-only 名单（含全部 `bg_*`、subagent、workflow、goal、tasks、setup、`context_pivot`）仍然排除。嵌套调用的现有测试覆盖 `codemode` 与 `deferred`：允许表之外的调用失败，权限钩子仍生效。发现方式不能变成绕过这道交集的旁路。

### 2.4 和缓存诊断的缝

`extensions/model-info` 在 `before_agent_start` 对 `selectedTools` 和系统提示做指纹，把工具面或系统提示变化记成**相关**，不是已证实原因。`cacheRead === 0` 也不能单独区分「提供方没报」和「真的没命中」。以后的实验如果只看这个诊断，得同时保留请求里 `tools` 和系统提示的字节身份。

## 3. 外面在怎么做

以下是 2026-10-17 读到的公开文档，不是对这些产品的运行测量。

### 3.1 稳定的全量声明

OpenAI 的缓存说明把「工具变了」列为前缀失效。推荐的做法是工具数组、顺序和 schema 保持不动；本轮不许调用就用 `tool_choice` 或 `allowed_tools`，不要把定义从数组里拿掉。这是方案 A/B 的依据：执行期拒绝，而不是把 schema 从请求里删掉。

### 3.2 提供方原生的延迟加载

Anthropic 的 tool search：请求里仍带上全部定义，但 `defer_loading: true` 的工具不进入系统前缀。模型通过 tool search 得到 `tool_reference`，定义在对话中部展开。前缀不动，所以发现本身不打碎缓存。`defer_loading` 的工具不能再带 `cache_control`。至少要有一个非延迟工具。Claude Code 在支持的模型上默认把 MCP 放在这条路径后面：工具搜索开着时，增删一条 MCP 定义不必改请求里的工具前缀；搜索不可用时，增删定义就会失效。

OpenAI 的 tool search 同样把新发现的工具加在上下文末尾，并区分托管搜索和客户端执行的 `tool_search_call`。Codex 已把「MCP 工具默认走 tool search」当成支持该能力时的路径；不支持时仍直接暴露，避免旧模型失去工具。Codex 也有过反例：MCP 工具顺序不稳定会把命中率打到接近 0，后来靠稳定排序恢复。顺序本身就是前缀的一部分。

Pi 1.2 把这些接进了传输层，而不是让每个包自己拼：

- Anthropic 上，中途工具用对话内的 `tool_addition`（`inline-tools-2026-09-15`），同名重定义不再退回重发整表。
- 带 `supportsAdditionalTools` 的 OpenAI Responses / Codex 用消息上的 `additional_tools`，顶层 `tools` 保持最初那一组。
- 不支持的模型退回顶层完整列表。也有 `supportsToolSearch` 时改发客户端 `tool_search_call` / `tool_search_output` 的路径。
- 编码代理侧，第一次渲染出的提示应成为基线；之后的工具与提示变化尽量变成 system 消息增量。不支持中途变更的模型则仍替换顶层提示。Pi 的 [PR #9117](https://github.com/earendil-works/pi/pull/9117) 描述了这套增量，随后关闭并重做；1.0.1 之后的 changelog 保留了 Anthropic 内联这条结果。增量是否覆盖 OpenPI 这种「先删再加、还改 guidelines」的用法，仍是未知。

[Pi #10489](https://github.com/earendil-works/pi/issues/10489) 还记录了一个相邻失效：扩展从 `before_agent_start` 返回整段 `systemPrompt` 时，强制投影会把后来的 `toolsAdded` 折进第一条系统消息，`additional_tools` 消失，发现一次就重计 80k–115k token。OpenPI 当前能力扩展返回的是自定义消息，不是替换 `systemPrompt`。这条用来提醒：以后谁若在 `before_agent_start` 里重写系统提示，会把 Pi 的锚定一起拆掉。

### 3.3 Code Mode：代码是工具界面

两套实现，同一句话：模型面对的工具定义保持短且稳定，大量 schema 留在执行器里。

**Pi Code Mode**（QuickJS，无 Node、无网络、无文件系统；外部动作只能通过工具和 `models`）：

- 脚本里 `tools.<name>(args)`、`searchTools`、`describeTool`、`describeNamespace`、`ALL_TOOLS`。
- 默认 `codemode.mode = "on"`：已经声明的工具仍声明，描述里注明如何从脚本调用。`only` 会把内建和扩展工具从模型面前藏起来，只留在 `codemode` 描述中。后者会让描述随工具集变化，和缓存目标相反。
- deferred / 默认 MCP 工具不写进 `codemode` 描述，避免连接服务器时描述变化。

**Cloudflare Code Mode** 是 MCP 服务器侧的包装，不是 Pi 的执行器：

- 已有 MCP 服务器可用 `codeMcpServer()` 收成一个 `code` 工具，上游工具变成沙箱里的类型化方法。
- 很大的 OpenAPI 用 `search` + `execute`：`search` 对规范跑代码，只把需要的操作返回模型；`execute` 再带宿主提供的请求函数去调用。规范留在沙箱里。
- 出站网络默认关闭，授权留在宿主。它不提供逐个上游工具的持久审批。

OpenPI 不需要把 Cloudflare 的 Worker 执行器搬进来。Pi 的 `codemode` 已经是这个包里的代码执行缝。

### 3.4 搜索 / RAG，以及「搜索并执行」

客户端也可以只暴露一个搜索工具，把命中的 schema 放进工具结果。结果在对话后缀，不改前缀，但模型下一轮要真的调用，仍得让该工具出现在 `tools` 里，除非搜索工具自己完成调用。

OpenCode 的公开讨论里，这两条都还没成为稳定默认：有提案用 `mcp_lazy` / `mcp_search` 把 MCP schema 换成分组摘要再按名调用；也有提案给 MCP 打上 Anthropic `deferLoading` 并挂 `tool_search_tool_bm25`，内建的 read/bash/edit 保持直接声明。Issue 里也有人指出 `defer_loading` 在 `dev` 上并没有真正接通。不能把「opencode 命中率约 90%」解释成「opencode 用了某一种延迟加载」；那次对照的工具定义是否全程没变，本记录不知道。

### 3.5 对照

| 做法 | 前缀是否随发现变化 | 首轮 schema | 发现发生在哪 |
| --- | --- | --- | --- |
| 静态全量 direct | 不变 | 全部 | 无 |
| 组一次加载、组内不再显隐 | 每个组第一次加载时变一次；之后不变 | 当时已加载的组 | 意图或网关 |
| 提供方 `defer_loading` + tool search | 支持时不变，定义在后缀展开 | 非延迟的小集合，外加搜索工具 | 模型搜索 |
| Code Mode，schema 不进描述 | `codemode` 描述不变则前缀不变 | 一个 `codemode` | 脚本内 `searchTools` / `describeTool` |
| 搜索并执行，schema 只在结果里 | 网关 schema 不变则前缀不变 | 一个网关 | 网关的 list/search/call |
| 今天的 OpenPI 显隐 | 每次 `setActiveTools` 都可能变，删除尤其危险 | 最小 | `setActiveTools` |

## 4. 五条可讨论的改法

每条都回答：机制、缓存、首轮 token、MCP、迁移、还没回答的问题。没有一条被选定。

### 方案 A — 会话开始就声明全部 direct 工具

**机制。** `session_start` 之后活动集不再变化。33 个 OpenPI 工具和 Pi 内建一起声明。资源不存在时，工具执行返回明确的空态或失败，而不是把 schema 拿掉。模式工具（plan、setup、context）也留着，由执行层检查情节。

**缓存。** 工具数组和工具相关系统段从第一轮起不变。之后的命中只受压缩、换模型、换思考级别、其他系统段和消息编辑影响。这是唯一不依赖提供方「中途工具」标志的做法。

**首轮。** 最大。这正是 [#20](https://github.com/openpi-dev/openpi/issues/20) 要从大约 31 个常驻工具退到零常驻的原因。Anthropic 也写过：直接摆在模型面前的工具多过大约 30–50 个，选择会变差。33 个 OpenPI 工具再加内建和 `codemode`，落在这条线附近。首轮税是真实的，只是它只付一次，并且随后每次都能复用。

**MCP。** 不解决。MCP 工具若改成 direct，会把这份清单再放大，并重新引入「服务器连上才出现」的前缀变化。MCP 应继续用 Pi 的默认 exposure。

**迁移。** 代码小：去掉 disable。产品说明、Decision 0004 的「点名才出现」、`explicit` 零常驻都会被推翻，那是文档和默认行为的大回退。子会话必须继续用现有 denylist，不能因为父会话声明了 `bg_start` 就让子会话启动后台进程。

**未决。** 33 个 schema 加 guidelines 的真实 token；选择错误率是否回升；用户是否愿意用首轮 token 换全程命中。

### 方案 B — 能力组一次声明，组内永不显隐

**机制。** 保留 `explicit` / `adaptive` 和 Decision 0004 的点名加载。组加载时，`entry` 和 `deferred` 一起进入活动集，并且只增不减。`bg_start` 不再在成功回调里 `showLifecycleTools`。Tasks、Goal 的隐藏，以及 `context_pivot` 在每个 `agent_start` 上的开关，改为执行期检查：没有任务、没有 goal、上下文不够，就返回现在已经写好的那种明确错误。Plan / Setup 的写入工具更敏感：它们今天隐藏是为了不在情节之外调用。可以改成始终声明、执行时拒绝，也可以在情节开始的**那一次**加入后再也不移除。第二种仍会在情节边界改前缀；若情节中途才开始，长会话仍会 miss 一次。

**缓存。** 去掉了「添加后又删除」。在「删除会使锚定失效」的实现上，这是必要的。组第一次加载仍会改变声明集。支持中途添加的模型可以把这次添加留在后缀；不支持的模型会在加载那一轮重计前缀，之后恢复命中。`context_pivot` 若不再翻转，#644 里那种零调用、反复开关会消失。

**首轮。** 与今天的 `explicit` 相同，直到某个组被点名。组内多出来的是生命周期工具的 schema，不是整包 33 个。后台组从 1 个工具变成 5 个，发生在加载时，而不是 `bg_start` 的下一次请求。

**MCP。** 不变，仍然是 Pi 的默认 Code Mode。

**迁移。** 中等，而且局限在 OpenPI 的工具面。模型必须接受「工具在，但资源还没有」。现有失败文案已经接近这个形状。系统段若随整组 guidelines 一起出现，不支持中途系统消息的提供方仍会在组加载时失效一次。子会话 denylist 不用放宽。

**未决。** 一次中段加载的绝对 token 是否仍被看成「晚到的 miss」。若要求零次中段失效，B 不够，得把可能用到的组提前到第一轮（向 A 靠拢），或改走 C/D。

### 方案 C — 可选工具用 Pi 的 `deferred` / `tool_search`，OpenPI 停止用 `setActiveTools` 做发现

**机制。** 不常驻的 OpenPI 工具注册为 `exposure: "deferred"`（浏览器已经是这样注册的，但又被 `patchOwnedTools` 提升成声明工具）。父会话激活 Pi 的 `tool_search`，而不是在运行中改活动集。模型先搜索，Pi 在支持的传输上把定义放到 `tool_reference`、`additional_tools` 或 `tool_addition`。执行仍是原来的 `registerTool` 实现、权限和子会话交集。

失败关闭要写死，不能再退回显隐：模型或提供方不能做中途工具变更时，这些工具改为第一轮就声明（A 或 B 的冻结集），整个会话不再改名单。`resolveTranscript` 今天会把有效工具折成一份开头的列表；Cursor 和 Antigravity 要么学会保留增量的位置，要么在这两条线上禁用后加载、改用冻结集。

**缓存。** 支持延迟加载的模型上，发现不改前缀，这是 Anthropic、OpenAI 和 Claude Code 都在用的性质。不支持时，冻结集让前缀变大但稳定，避免 #644 那种「变更请求 + 下一请求」连续两次 miss。

**首轮。** 支持时接近今天：小的 direct 集合，外加一个 `tool_search`。完整 schema 仍可能出现在请求体里供服务端搜索（Anthropic 就是这样），但不进入计费前缀。不支持时首轮等于冻结集。

**MCP。** 对齐，不重做。Pi 已经用 `deferred` / `codemode` 接 MCP，并会为 deferred 服务器打开 `tool_search`。OpenPI 不要再把 `tools/list` 同步进自己的活动集。

**迁移。** 中高。每个 owner 要选定 exposure，并删掉对应的 patch。`tool_search` 今天不在子会话的默认活动面上；父会话打开它不应让子会话因此搜索到 parent-only 工具。Pi 的 `reachesTools` 用来在调用前等 MCP 注册完成，OpenPI 工具若被搜索到，也要落在同一条等待和权限路径上。质量上多一轮搜索往返，内建的 read/bash/edit/write 不应放进 deferred，否则每一步都先搜索。

**未决。** Pi 1.2 在「搜索结果会不会改写 `codemode` 或邻居工具的描述」上的字节稳定性；自有 provider 投影的改法；`tool_search` 激活之后会不会把工具永久留在该分支的声明集里，从而在不支持锚定的模型上仍然改前缀。Pi 文档写明：`tool_search` 加载的工具会留在该分支的声明中。若留在声明里的方式是增大顶层 `tools`，C 在不支持的模型上就必须走冻结失败关闭，不能走「搜到再声明」。

### 方案 D — 可选能力只通过 Code Mode 发现

**机制。** direct 声明停在 `read`、`bash`、`edit`、`write` 和 `codemode`。OpenPI 的可选工具和 MCP 使用 `exposure: "codemode"` 或 `"deferred"`，不调用 `setActiveTools` 把它们变成声明工具。脚本用 `searchTools` / `describeTool` / `describeNamespace`。`codemode.mode` 保持 `on`，不要用 `only`：`only` 会把内建工具藏进 `codemode` 的描述，描述会随清单变化。

这和 Cloudflare 的单工具 `code`，以及大目录的 search/execute，是同一类界面。执行器仍是 Pi 的 QuickJS 和 `ctx.executeTool`，不是新沙箱。

**缓存。** 前缀里的工具定义只有那五个，且 `codemode` 的描述不收录 deferred 工具，MCP 连接不再改它。风险集中在 `prepareLoadout`：`mode: "on"` 会给**已声明**工具的描述加上「可从脚本调用」。这句若在 `codemode` 激活时写一次然后不变，前缀仍稳；若每次活动集变化都重写 read/bash 的描述，D 就失败。所以本方案禁止再把可选工具升为 direct。

**首轮。** 低，而且 OpenPI 已经默认打开 `codemode`。可选 schema 不进首轮。脚本里 `describeTool` 的声明出现在工具结果里，按后缀计费。

**MCP。** 这就是 Pi 的默认。OpenPI 要做的是停止把同类工具排成第二套经典 schema，而不是再包一个 `codeMcpServer`。

**迁移。** 行为变化大。Subagent、Workflow、后台终端都要靠模型写脚本才能用到，除非保留一小份 direct（见推荐）。权限、取消和子会话排除必须仍由 `executeTool` 执行；现有嵌套测试是下限，不是完整证明。`CODEMODE_DEFAULT` 只证明了一次 Web/CLI 烟测里模型能把两次 read 写进一个脚本，没有证明它会稳定地用脚本启动后台进程。子会话继承 `codemode` 时不能因此叫到 `bg_start`。

**未决。** 模型把「启动后台命令」写成脚本的成功率；脚本失败时的证据是否够家长会话看懂；`inlineBudget` 和 `ALL_TOOLS` 的结果大小；不擅长工具型代码的模型是否必须退回 B。

### 方案 E — 一个不变的「搜索并执行」网关

**机制。** 扩展今天的 `openpi_load_tools`：同一个 schema 做 list、search、describe 和 call。call 在进程内执行已经注册的实现，schema 只出现在工具结果里，永不进入 `tools`。MCP `tools/list` 也由这段代码查询。

**缓存。** 网关定义不变则前缀不变。发现的 token 是一条工具结果，不会推翻此前的前缀。这是客户端能模拟 `defer_loading` 的方式，但不依赖提供方标志。

**首轮。** 一个小工具。`explicit` 今天连这个网关都没有，所以会比现在的首轮多一块，比 A 小得多。

**MCP。** 能包住经典 MCP，但会绕开 Pi 已经实现的 exposure、`mcp_servers` 段和 Code Mode。那是第二套发现平面：权限、OAuth、`list_changed`、命名空间和取消都要重接。和「Pi 拥有工具生命周期」冲突。

**迁移。** 高。流式输出、嵌套工具证据、子会话交集和审批都要在网关里再做一遍。`openpi_load_tools` 今天只改活动集，并不执行组内工具；把它改成执行器是新的权威面。

**未决。** 搜索文本的排序和截断；模型能否从一段散文 schema 稳定构造参数；和方案 D 相比多出来的价值。本记录看不到这份价值。

## 5. 建议拿去讨论的方向

不是决议，也不是实现授权。

1. **先停「会删除的显隐」。** `context_pivot` 的按轮开关、后台工具在 `bg_start` 之后才出现、Tasks/Goal 的隐藏，是当前设计里最确定会改声明集的部分。组的单调加载已经承认「反复出现和消失对缓存和模型都更差」，第二道闸门还在做这件事。
2. **主方向用 C，失败关闭用冻结，不用显隐。** 能锚定或能 `defer_loading` 的模型，让 Pi 的 `tool_search` / 内联工具定义把 schema 放在后缀。不能的模型，从第一轮或从组加载那一次起冻结名单，本会话不再改。Cursor / Antigravity 的 `resolveTranscript` 在改投影之前算「不能」。
3. **D 用作 MCP 和低频 OpenPI 工具的暴露，不替代四个内建工具。** OpenPI 已经默认打开 `codemode`，MCP 默认也不进声明集。把后台、浏览器、setup 写工具放在同一条「脚本里发现」的路上，比再造 Cloudflare 式执行器更贴 Pi。read / bash / edit / write，以及真正每轮都要的少量工具，保持 direct。
4. **A 只作为不支持中途变更时的失败关闭，不作为所有模型的新默认。** 它缓存最好，也直接回到已经测过并放弃的常驻税，还压在「30–50 个直接工具」的选择质量线上。
5. **不做 E，除非 C 和 D 都证明模型无法发现工具。** E 是第二个执行器和第二个 MCP 客户端。`openpi_load_tools` 可以继续只负责「加载一组」，前提是加载本身改成冻结的一次声明（B），而不是网关里再 `call`。

这个方向不改 Decision 0004 的分工：点名决定发现，模型决定用不用。它改的是发现之后工具以什么形式进入请求。点名可以打开一组 deferred 工具的可搜索性，或把一组冻结进声明集；它不应该在 `bg_start` 的成功回调里再改一次 `tools`。

## 6. 下一步实验

只描述，不执行。不要跑 Harbor，不要使用真实密钥，也不要把这些实验写成 Benchmark。

1. **请求字节，而不是命中率叙事。** 用 Pi 的 faux provider 或本地回放，固定模型兼容标志，跑一条会 `bg_start` 的会话。保存每次请求的顶层 `tools` 字节、第一条系统消息字节，以及中部 `toolsAdded` / `tool_addition` / `additional_tools` 的位置。至少四个格子：Anthropic 且支持内联工具、OpenAI Responses 且 `supportsAdditionalTools`、`openai-completions` 且两个标志都关、Cursor 或 Antigravity 的 `resolveTranscript` 投影。成功标准是指出哪一格改写了前缀，而不是报告一个命中率。
2. **只加不删的对照。** 同一条会话，A 臂保持今天的 `bg_start` 后再打开四个工具；B 臂在后台组加载时一次声明五个工具，之后不再 patch。看第 2 轮及以后的前缀字节是否相同。用 faux 即可。若要看提供方计数，一次短会话、一个已授权的测试模型就够，不要进 Terminal-Bench。
3. **`context_pivot` 消融。** 把「≥ 30_000 才声明」改成「始终声明、执行期拒绝」的假会话，比较 `agent_start` 前后的工具字节。这个工具在 #644 的统计里开关很多次、调用零次，适合作为最小行为样本。
4. **`codemode` 描述的稳定性。** 哈希 `codemode` 工具描述和 `read` 的描述：会话开始、MCP deferred 服务器连上、OpenPI `setActiveTools` 加一个 direct 工具，这三处各取一次。D 只有在前两处哈希不变、且第三处不再发生时才成立。
5. **明确不做。** 不重跑 59% / 90% 的 Terminal-Bench，不改默认发现模式，不新增执行器，不把本文件升级成 Decision。

## 7. 未知与非目标

**未知**

- Pi 1.2.0 在同一次变更同时包含添加和删除时，顶层 `tools` 是否仍被替换。changelog 证明了 Anthropic 的内联添加，没有证明删除无害。
- 任务陈述中的 59% 与 90% 来自哪次运行、哪个模型、命中率的分母是重叠 token 还是整段输入。没有这份身份之前，不能把原因归到 `bg_*`。
- `promptGuidelines` 的变化在 1.2 上是增量 system 消息，还是在缺少 `supportsMidConvoSystemMessages` 时折回开头。#644 的撤回使这条比工具数组更需要实验 1。
- 方案 C 的 `tool_search` 成功之后，声明集是否在不支持锚定的模型上变大。
- 方案 D 的任务成功率。现有 Code Mode 证据只覆盖加载和一次组合 read。

**非目标**

- 不增加第二套 provider、代码沙箱、MCP 客户端或工具 RAG 索引。
- 不把发现做成关键词路由或固定编排。Decision 0004 已经把「用不用」留给模型。
- 不放宽子会话的 parent-only 名单，也不让 Code Mode 的嵌套调用绕过权限钩子。
- 不把本讨论稿写成架构约束。若采用其中一条，需要新的 Decision，并改 `extensions/shared/tool-surface.ts`、对应 owner、`SETUP.md` / `README.md` 里关于「组内管理工具事后出现」的句子，以及 child-session 对 `tool_search` 的分类。

## 执行摘要

OpenPI 今天把工具发现做成了运行中的 `setActiveTools`：能力组按意图出现，`bg_status` 一类工具再等 `bg_start` 成功，`context_pivot` 还会按 token 阈值反复开关。工具定义在缓存前缀的最前部。提供方不能把后加的工具锚在对话中部时，这一下会让已经缓存的整段对话作废；能锚定的提供方也会被「又删又加」和系统段折回开头打破。OpenPI 的 Cursor / Antigravity 投影用 `getCurrentTools()` 把有效工具收成一份开头的列表，锚定到了那里就没了。

Pi 自己的 MCP 并不这么做。默认 exposure 是 `codemode`：工具留在脚本里用 `searchTools` 发现，`codemode` 描述不跟着服务器变，变化的说明追加到对话后面。Anthropic 和 OpenAI 的写法相同：顶层工具保持稳定，延迟工具用 `defer_loading`，发现结果放在上下文末尾。Codex 对 MCP 也偏向 tool search，同时要求工具顺序稳定。

因此不建议把 33 个工具重新全部声明成新的默认，那是已经为了首轮成本退掉的表面，也挤在「直接工具多了不好选」的区间里。也不建议再做一个搜索执行器。值得讨论的是：可选工具改用 Pi 的 `deferred` / `tool_search` 或 Code Mode，使发现只加在后缀上；模型或自有投影做不到这一点时，改为一次冻结、会话内再不显隐。最小的事实实验是对比请求字节，而不是再跑一轮 Terminal-Bench。
