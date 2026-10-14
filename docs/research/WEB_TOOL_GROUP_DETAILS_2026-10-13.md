# 工具组细节：Codex 安装包与 OpenPI PR #711

- Status: draft。源码事实已按下列边界核对；原生 Codex 的现场动态、悬停及刷新未验证。建议不是已接受的 Decision。
- Created / source-verified: 2026-10-13。
- Related Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)；用户指定基准 [PR #711](https://github.com/openpi-dev/openpi/pull/711)。本记录为本地草稿，未发布或向 Issue 发送评论，反向链接待发布时补充。
- OpenPI: `c0c176221826288430798a8ad75180eafa62dd28`，新 worktree `codex-tool-group-study/openpi`。不改原始 dirty checkout，不改正在使用的 Web 副本。
- Codex: `/Applications/ChatGPT.app/Contents/Resources/app.asar`，package `openai-codex-electron`，`26.1002.52244` / build `13536`；内置 CLI 元数据 `0.162.0-alpha.2`。
- Supersedes: none。既有 [`WEB_CODEX_ACTIVITY_2026-10-08.md`](WEB_CODEX_ACTIVITY_2026-10-08.md) 的历史边界保留。初始阶段先比较、再由用户选择；后续授权的本地实施与颜色选择见文末追加。

## 结论与选择

建议保留 OpenPI 的一级竖线、组内缩进、原生顺序、原始回执入口、运行时阅读接管。主要差距是摘要语义、额外徽标、图标占位和动效的注意力分配，而不是必须替换分组结构。

| 项目 | Codex 已观察或源码事实 | OpenPI #711 源码事实 | 可选择的改进 |
| --- | --- | --- | --- |
| 顶部摘要 | 完成组按固定语义类别生成过去式片段；文件修改在探索、命令前；图标取首摘要类别对应项 | 标题按工具首次出现顺序去重；仅全 done 时给整串加“已”；图标却优先 edit/write，可能是铅笔配“运行命令…” | 先统一标题顺序和图标含义；用自然动作短句，保留中文顿号，不照搬截图里连在一起的译文 |
| 行内噪声 | 截图及 read/search renderer 为“图标＋动作＋对象”；没有另一个 `read` 技术徽标 | read/write/edit 多一块徽标，bash 没有，因此文字起点不一致 | 优先去徽标；工具原名留在详情，不丢证据 |
| 图标 | 有独立 BookOpen 图形及共享资产 SVG；统一 rail/size token、低对比度；并非所有图标都是同一套 Lucide | Lucide BookOpen/Pencil/SquareTerminal；组头用 em，行内固定 16px，尺寸体系不同 | 保留开放图标库，统一占位、视觉大小和描边；不必复制私有 path |
| 对齐和字色 | 动作是主信息，对象较淡；文件有可识别的链接样式，悬停文件与悬停整行有不同反馈 | 文件目标更深；徽标挤开部分行；另有一级组缩进和 thinking→tools 二级连线 | 对齐每一层内部的图标中心和文字起点；保留一级层级，不把全部行强行拉到同一列 |
| 命令摘要 | `commandActions` → read/search/list/unknown → 专门 renderer；一条命令可投影多个活动，仍关联原 command ID | `bash` 一律终端图标＋原命令，`cd … && rg …` 仍是“已运行…” | 单独评估有界展示解析；不将关键词识别用于执行、权限或成功判断 |
| 运行感 | 活跃摘要切换有最短展示时间；文字 shimmer；展开列表抑制重复 shimmer；高度/透明度过渡 | 已有 6 秒文字 shimmer、1.5 秒蓝点 pulse、尾部“执行中”；native details 高度直接切换 | 保留一个主要动态焦点，调整扫光宽度/周期，平滑展开；不添加每行转圈 |
| 失败 | renderer 分别检查执行状态、退出码、中断、审批拒绝，不能从“已执行”文案判断成功 | 失败行红字；组右端红 X 是状态图标，**不是取消按钮**；组标题退回无时态 | 保留真实失败，改善摘要；可比较“少量失败”低强调提示，不能隐藏失败或把停止当成功 |

推荐先选择 **视觉精修**：去徽标、统一图标列、摘要与组图标一致、文件目标层级、箭头贴近标题。第二步选择 **动态精修**：单一活跃摘要、稳定切换、轻量高度过渡和减少动态支持。**Shell 语义摘要**是独立能力，成本和风险都高于 CSS，应最后单独验收。

## 先固定状态，再决定实施

下表中的 Codex 条件为安装包静态事实，只有普通/展开/折叠的可见构图同时有用户截图支持；不是原生交互实测。未来测试由这些状态与下节验收条件导出。

| 状态 | Codex 证据与边界 | OpenPI #711 | 建议验收条件 |
| --- | --- | --- | --- |
| 普通完成 | 组摘要使用类别过去式；内部按活动保留列表 | 类别串＋组代表图标；成功 check 隐藏 | 摘要和首图标一致；成功行不堆重复标记 |
| 悬停 | header 提升文字颜色并露出小箭头；文件链接 hover 有独立排除条件 | 淡底色，计数/箭头 140ms 露出 | 不移动文字、图标或行高；文件和整行的目标可区分 |
| 键盘焦点 | header 有 focus-visible 分支，箭头随焦点出现 | native summary；行有 focus-visible outline | Tab、Enter、Space 可展开；焦点可见且不会意外打开文件 |
| 展开 | 实际组是测量高度的本地 disclosure；组内容为纵向列表；通用工具 disclosure 是另一个组件 | 竖线＋缩进；最多 min(360px,50dvh)，边缘渐隐18px | 保留组感；内容变化不导致正在阅读的行跳动 |
| 折叠 | 保留摘要；实际组与单工具的默认展开逻辑不同 | active 组自动打开，用户能手动关闭；运行结束自动折叠 | 先保留 OpenPI 当前策略；不把通用 Codex 工具组件的默认行为套到整个组 |
| 菜单打开 | 未在组 header 链路发现专用“…”菜单；文件/命令详情有另外的动作 | 组无菜单；详情有文件打开、复制等动作 | 不凭参考图添加新菜单；现有动作在详情保留 |
| 运行 | 活跃标题有稳定窗口，列表内抑制重复 shimmer；精确视觉节奏未现场观察 | 折叠头/运行行 shimmer、蓝点 pulse、尾字；自动跟随但可被读者接管 | 只强调当前动作；快速连续返回时避免标题闪跳；不虚构进度百分比 |
| 成功收束 | group 本地折叠与父级 turn/activity slice 生命周期需分开；不能宣称所有组都会强制折叠 | active true→false 自动折叠 | 用原生终态触发收束，不用动画结束推断工具完成 |
| 失败 | exitCode / interrupted / declined 进入不同分支；全局“已执行”不等同 exit 0 | 行精确失败，组红 X；标题没明确失败摘要 | 混合成功/失败仍可检查每项结果；不把失败做成取消入口 |
| 取消 | 后端状态和 renderer 有 interrupted 分支；点击停止到回执的时延未知 | canonical terminal receipt 区分 cancelled / timeout / failed | 请求取消、确认已停止、结果未知分别可表达 |
| 刷新恢复 | 命令数据有原生 item 恢复路径；每组 disclosure 主要是本地状态，不能推断刷新保留展开 | 保存阅读锚点/偏移；需要时展开锚点祖先，未逐组持久化 expanded | 断线不把 running 变成功；恢复原生 pending；阅读位置可恢复 |
| 减少动态 | 需核对实际组的动画与整应用 reduced-motion 行为；原生未实测 | shimmer 有 reduced-motion；当前局部规则未证明 pulse 同时关闭 | 停止扫光/脉冲/高度动画；仍可静态识别运行与失败 |

## 功能链路与可复核位置

Codex 的混淆文件名不能当组件职责：`command-row` / `command-messages` 实际是键盘设置，已排除。实际活动视图包含在 `sites-end-resource-7e6c33984bd6.js`。

1. App-server `commandExecution.commandActions` → `app-shared` 的 `m1`。`Fhn` 将 read/listFiles/search/unknown 转成 `parsedCmd`；`fbr` 只加入 `isFinished`。多 action 用子 ID，同时保留 `commandExecutionItemId`，退出码和原始输出不丢失。
2. `local-conversation-turn` → `split-items-into-render-groups` → `agent-activity-item.ur` 分类 groupable / standalone → `inline-followup-markdown.I` 连续分组；prose、审批等会形成自己的边界。
3. `inline-followup-markdown.De/Oe` 构造完成摘要，顺序为来源/工具加载、文件修改、探索、命令等；`je` 选与第一摘要对应的图标项。`sites.h_ / CD` 本地化各片段并拼接。
4. `sites.Kx` 对 `parsedCmd.type` 分派：read→`lS`，search→`Zx`，list_files→`iS`，其他→`Jx`。读取、搜索对象从结构化字段取值；原始命令仍在详情。
5. `sites.d_` 决定行图标，`app-primary` 公用 activity header 管尺寸、间距、焦点、箭头；`app-initial` 的 shimmer 与 `app-shared` 过渡 token 共同决定动画。实际组 `sites.xg/hD` 与 `tool-activity-disclosure.x` 不能混为一谈。
6. 展开/折叠本身是呈现事件，不会运行命令。文件链接有独立打开事件；命令停止/输出入口使用精确 conversation/host/process 身份。这些操作与纯 UI 折叠分开。

精确原始 UTF-16 半开区间（格式化行号只用于方便阅读）：

| 源文件 | 符号或范围 | 职责 |
| --- | --- | --- |
| `app-shared-6c00c2afcf84.js` | `m1` `[4916443,4935317)`；`Fhn` `[3251370,3251763)`；`fbr` `[4895289,4895333)` | 原生执行项→语义显示项 |
| `sites-end-resource-7e6c33984bd6.js` | `d_` `[36138,38876)` | 图标分派 |
| 同上 | `h_` `[39133,40272)`；`b_` `[40782,46296)`；`CD` `[344999,345792)` | 完成摘要和本地化 |
| 同上 | `Kx` `[147022,149041)`；`Zx` `[155967,158204)`；`iS` `[158372,159818)`；`lS` `[159930,161417)` | 普通命令、搜索、目录、读取分支 |
| `inline-followup-markdown-393383ad831c.js` | 派生格式化行 350–615 | 连续分组、摘要优先级、摘要图标选择 |

OpenPI 链路对应：

- Pi `tool_execution_start/update/end` → [`pi-runtime.ts`](../../web/runtime/pi-runtime.ts) → [`live-tools.ts`](../../web/protocol/live-tools.ts) → Host 有界 SSE replay/resync → Store → Transcript。
- [`Transcript.tsx`](../../web/ui/src/features/transcript/Transcript.tsx) `ProcessSequence` 约1554行；摘要1644–1679；连续分组1837；持久化结果优先配对3088。
- [`ToolEvidence.tsx`](../../web/ui/src/features/transcript/ToolEvidence.tsx) 约58行证据投影；101行 badge；139行文件打开；168行复制。
- [`tool-activity.ts`](../../web/ui/src/features/transcript/tool-activity.ts) 只按 tool name 映射，不解释 shell；[`styles.css`](../../web/ui/src/styles.css) 的组图标约389行、滚动434行、shimmer465/641行、工具行1027行。
- `session-reading-state` 保存阅读位置；`live-tools` 把缺失真实终态的运行项保留为 unknown。不能为外观增加第二套执行状态。

## 图标与动态参数：值得借鉴的具体细节

- 主要命令/铅笔/搜索/目录资产按16×16画布设计；普通打开书本是独立20×20 SVG，再按 `icon-xs` 显示16×16。不是把任意24×24图标一起缩小就自然一致。尺寸仍受根字号、缩放和主题影响。
- 标题图标与文字默认间距6px，箭头14px，与摘要相隔约4px；箭头即便透明仍占位，因此悬停不推挤文字。展开时旋转90°，常显；hover/focus-visible才出现的逻辑也考虑文件链接独立悬停。
- 动态不是连续整行脉冲：首次等待600ms，一次扫光1秒，每4秒触发一次；蒙版水平从−50%扫至125%，`steps(48,end)`。基本文字保持，额外 overlay 对读屏隐藏。减少动态时不启 timer，卸载清理 timer。
- 活跃标题只有**不同动作 key**才受约1秒最短停留控制；同 key 内文更新直接显示，完成摘要立即切换。没有观察到标题滑入或交叉淡入的代码，不把节流写成转场。
- 实际工具组 `hD→xg` 默认 collapsed，本地 state 管 `opening/expanded/closing/collapsed`；没有终态自动折叠 effect。OpenPI 的运行自动开、结束自动关是自身策略，可以保留。
- 组 body 高度和透明度使用300ms、`[0.19,1,0.22,1]`；关闭动画结束才卸载。组内通过 context 禁用重复 shimmer。组内列表最多14rem，边缘渐隐1.5rem，scroll timeline支持是前提。
- `TKe` 在展开时暂时补偿外层 transcript scroll，保持被点击标题的 viewport位置，最长350ms；用户 wheel/touch/pointer/keyboard立即停止补偿。它不是内部列表自动滚底，不能与 OpenPI 的 reader-owned追尾混淆。

可复核原始范围：`sites` 的 `xg` `[13369,15285)`、`Tg` `[15848,16769)`、`hD` `[333206,337931)`；`app-primary` 的 `TKe` `[345188,345882)`、`DKe` `[345952,346572)`、`hI` `[346648,347149)`、`MKe` `[347220,348788)`；`app-initial` shimmer `[9084506,9086300)` 与 `[9086915,9087025)`；`app-shared` transition `[5872921,5873330)`。参数来自静态代码，不是现场测量。

## 证据覆盖、运行边界和未解项

本地可重用证据目录：`/Users/admin/.codex/research/codex-tool-groups-2026-10-13/`。保存安装包成员清单、逐成员声明 SHA-256 校验、原始选定文件、精确 AST 范围、派生格式化文件与 `rea-evidence.json`。最终选定的61个成员均通过 ASAR 声明 hash 校验；清单为 `member-manifest-final.json`。不把安装包代码、私有 Session 或凭据加入仓库。

- 初次整 ASAR 检查发现一个 unpacked 原生模块的声明 hash 不匹配。record-and-continue 全包分析随后主动终止，没有把它当成功证据；本次用逐成员校验通过的 JS/CSS 建立有界分析输入。
- REA batch UI parent：`ev_efa839fa23167b20d6084c9dd45db12d9efbe3e294f8a0750d37de60a10802f8`。8 JS、152631文本字节、46574 AST 节点；application **partial**，semantic **partial**；2999 semantic unknowns，local-conversation-turn 的扩展关系图超过父结果预算，其 static/module facts保留。页面 `complete-within-view` 只指该页。
- REA batch semantics parent：`ev_c5e8fd37a3ca00445f14cd6b92b5c087ea841db17f3ac26a9de36740579316ff`。14输入文件、62599文本字节、16948 AST 节点。这是一个原始小模块＋13个可定位源范围的派生切片；application **complete仅针对这14个输入**，semantic **unknown**，3120 unknowns。依赖按原始大包另行静态追踪，不把切片完整等同应用完整。
- `rea-evidence.json` 导出6条、36811859字节，SHA-256 为 `9efc1ff634700c7524c2517115edb5b634baaf95191e3441811a6f32604a8719`。export `unknowns:0` 描述导出账本，不表示上述语义未知消失。
- `app-initial`、`app-primary`、`app-shared` 与 CSS 分批直接读源补依赖。静态代码存在不证明当前 feature flag 命中；未声称整体 Codex 完整复刻。
- 电脑控制工具拒绝访问 `com.openai.codex`，理由为安全限制。没有借助其它通道绕过。原生 hover/focus、实时滚动、菜单浮层、动画连续帧、取消时延、刷新后的精确视觉表现仍未知。
- 用户截图没有 DPI/缩放信息。不能从截图的大字推导 Codex 的实际 CSS 像素，也不能把缩放比例当图标尺寸缺陷。
- 原始 cwd 的 `pi list` 指向一个已不存在的旧 worktree，不能证明 Web 加载身份。此次源码基准通过新 worktree 的 PR SHA 固定；运行副本虽然同 SHA，也未在本次重新启动或冒称 native smoke。

## 实施前验收与消融顺序

先用相同数据、相同缩放比较候选：去掉 badge 后，read/command/search 的动作文字必须同列；统一图标占位后，不应改变组的层级缩进。去掉重复“执行中”后，仍能从当前动作、运行标记和终态回执识别状态。去掉一级竖线的扁平参考只用于选择，不默认替换用户喜欢的结构。

实施时至少验证：连续快速工具返回、一个长命令、读取中文长路径、混合成功失败、取消确认前后、断线重连、刷新定位组内结果、上滚阅读期间新增输出、窄屏、键盘、减少动态。Shell语义单独加入含引号/管道/多个cd/未知子命令的负例，不得隐藏原始命令或改变工具ID/数量与终态的真实性。

既有可复用测试：`transcript-evidence-state.spec.ts`（运行/顺序/滚动/unknown/取消）、`transcript-reading-disclosure.spec.ts`（阅读恢复）、`evidence.test.ts`（原生回执）、`evidence-view.spec.ts`（详情）、`web-host.test.ts`（SSE replay）。不要以镜像新 JSX 的断言代替这些状态要求。

本次无产品实现、无 provider 调用、无安装部署。已提供三种受控数据预览：保留分组的细节精修、当前结构示意、扁平视觉参考。它们使用开放图标及合成记录，不能替代原生 Codex 或 OpenPI 浏览器验收。

已做设计消融：移除 read/edit 徽标后，动作文字回到同一列，动作、对象和结束状态仍可辨识；运行示意移除重复脉冲与尾部“执行中”，保留当前动作和终态文本。保留一级分组线以满足用户偏好，去线仅留作对照。预览曾使用重复文字 overlay，去掉后仍有扫光效果，并修复读屏重复；折叠内容添加 inert/aria-hidden。浏览器已验证预览展开、折叠、逐项执行和结束自动收起。失败/停止可在设计选项切换，但并非真实后端取消或失败测试。

## 本轮验证

- 环境：Node `24.20.0`、Bun `1.3.14`，使用隔离 `PI_CODING_AGENT_DIR`；其 `pi list` 唯一 OpenPI 来源为本次新 worktree，HEAD `c0c1762`。这是来源核验，不是 provider 或原生 UI smoke。
- `bun run check`：exit 0。`bun run test`：exit 0；Node 2485 passed、9 skipped、0 failed，Vitest 94 files / 1421 tests passed。
- 日志保存在上述证据目录的 `check-research-doc.log` 与 `test-research-doc.log`。本轮仅研究文档和索引变更，未新增镜像实现的测试；已有测试通过不表示候选视觉已经接入。
- 文档相对链接和 `git diff --check` 已通过。原生 Codex 动态、真实 OpenPI 候选样式、窄屏与减少动态的运行验收仍需在选择接入后完成。

## 补充：命令语义的后端来源与恢复

公开源码缓存位于 `/Users/admin/.local/share/openpi/research/codex-subagents-2026-10-13/app-server-source`，已确认 HEAD 为 `74e804deeb1241d5fe699b31fb319f7d46454c42`，读取前后工作区干净。未展开的 sparse 源文件通过已有 Git 对象只读查看，未构建或运行目标二进制。**公开同版本源码只能解释该版本的静态设计，不能证明已安装 app-server 二进制具有相同字节、编译开关或实际执行路径。**

`commandActions` 是后端针对 shell 命令生成的尽力而为的展示元数据。一个执行保持一个真实 call/item ID，展示数组可以有多个动作；安装包前端再把这些动作映射成多个行，并继续关联父 `commandExecutionItemId`。这些行没有独立的启动、退出码或成功回执。

| 链路 | 固定源码位置 | 已核对事实 |
| --- | --- | --- |
| argv → ParsedCommand | [`parse_command.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/shell-command/src/parse_command.rs#L54)，入口54、shell脚本1997 | 提取 shell script，解析受支持的命令序列，保留源码顺序，跟踪 `cd` 修正读取路径，去除受条件限制的格式助手和相邻重复。`rg --files`、普通 `rg`、单文件 `cat` 可分别产生列文件、搜索、读取。最外层只要存在一个 Unknown，整条原命令就回退为一条 Unknown；复杂命令不保证语义识别。 |
| 原生执行项 | [`tools/events.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/core/src/tools/events.rs#L228)，begin175、end581 | `unified_exec` 生成并保留 parsed_cmd。开始项为 InProgress；完成项复用同一 call ID，加入实际输出、退出码、耗时与 Completed/Failed/Declined。语义类型不参与成功判断。 |
| 兼容事件 | [`legacy_events.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/protocol/src/legacy_events.rs#L185) | canonical CommandExecutionItem 投影为 ExecCommandBegin/End，保留 id、turn_id、command、cwd 和 parsed_cmd；InProgress 不生成 End。该版本不能只按旧事件名描述主链。 |
| app-server v2 入口 | [`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server/src/bespoke_event_handling.rs#L973)，canonical入口1073 | 明确忽略旧 ExecCommandBegin/End 的 v2 转发，消费 ItemStarted/Completed(TurnItem)。开始项按真实 command ID 去重，避免审批提前通知与 canonical start 重复。 |
| 展示投影 | [`item_builders.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server-protocol/src/protocol/item_builders.rs#L46)，action转换145 | `CommandExecutionPresentation::from_raw` 格式化原命令、脱敏可识别秘密并映射 actions。读取路径相对执行器 cwd URI 解析；无法合法解析的 read action 被遗漏。搜索 query 和 command 同样经过展示脱敏。 |
| Wire shape | [`v2/item.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L130)，执行项291、canonical转换917 | CommandAction 为 read/listFiles/search/unknown。CommandExecution 仍是单一 id，保留 command/cwd/processId/status/output/exitCode/durationMs；canonical item 转换复用上一行的展示投影，接上安装包前端 `m1 → Fhn`。 |
| 持久化 | [`rollout/policy.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/rollout/src/policy.rs#L94) | Paginated history 保存 ItemCompleted 中的 TurnItem；ItemStarted、ExecCommandBegin、ExecCommandEnd、输出 delta 都列为 transient。因此不能写成“通过保存 Begin/End 恢复”。Legacy history 有不同选择规则，本次未验证任意旧记录的完整恢复。 |
| 恢复与迟到完成 | [`thread_history.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server-protocol/src/protocol/thread_history.rs#L355)，materialized转换618、兼容end693 | 同一 reducer 用于 rollout replay 与运行中内存事件；完成项复用 ThreadItem 转换，按原 turn ID upsert。兼容 End 也明确按 turn_id 归位，避免 PTY 晚退出时落到后续用户轮次。 |

这里的解析是展示层的近似解释，不是 shell 各分支确实执行过的证据。OpenPI 若选择接入，应保持 Pi 工具 ID、原命令、结果及 unknown 回退；不要把投影行创建为独立伪调用，也不要用关键词规则决定权限或成功。当前已追到公开源码的持久化与 replay 接缝，但实际 App 所用 history 模式、安装二进制对应、运行时刷新及 shell 平台矩阵仍未验证。

## 追加：2026-10-13 本地实施与视觉选择

本段记录同一 PR 基线上的本地候选，分支 `codex/tool-group-polish`，不是已发布结果或项目级设计约束。用户随后授权接入视觉和动态细节，保留分组、缩进、阅读接管和结束自动收起；命令语义解析仍独立。用户否决整列绿色图标与绿色动作文字，选择“灰色图标和正文＋淡底小标签”，并明确要求所有工具一起补齐。因此，最初“删除 read/edit 徽标”的建议被本次局部选择替代，不能继续当作最终验收要求。

| 项目 | 最终候选 | 验证边界 |
| --- | --- | --- |
| 摘要语义 | 保留首次出现顺序，代表图标跟随首摘要；运行中图标、动作、对象一起切换，思考时用灯泡 | 三种完成摘要首工具排列；组内原始顺序及回执保持 |
| 标签和对齐 | read/search/list/edit/write/web/run 使用同一 52px 标签列；灰色 16px 线框图标、1.65 描边，淡绿色仅用于小标签；未知工具保留原名，长名省略并可悬停查看 | 标签映射、辅助技术不重复朗读已翻译动作、工具原名、bash 内含 rg 仍是 run；浏览器检查文字起点 |
| 字体与层级 | 保留现有系统字体与用户字体设置；动作、文件名和路径用中性色；浅色和深色标签复用现有主题变量；失败红、取消/超时警告色，异常标签回到中性灰 | 浏览器检查真实 CSS、主题和窄屏；没有根据截图猜测字体名称 |
| 运行标题 | 不同调用的展示标题至少停留约一秒；同调用内容直接更新；终态立即退出运行标题 | 快速 command→read→edit、同调用路径更新、结束立即折叠、延迟回调不恢复旧标题 |
| 动效 | 600ms 后首次扫光，一秒扫过、四秒周期；仅组标题或单工具动作发光；组内不重复扫光，不显示重复运行蓝点/尾字 | 浏览器 computed animation 与组内无动画检查；不将动画当作执行状态 |
| 展开与阅读 | native details 的高度/透明度过渡，240/180ms；支持 interpolate-size 的浏览器启用，其他浏览器保留原生即时展开；减少动态禁用过渡及扫光 | 保留现有 reader-owned 滚动及恢复测试；浏览器 Enter/Space、完成自动收起；OS 减少动态实际开关未现场切换 |
| 原始证据和状态 | 标签只影响显示；真实工具名留在数据属性、标签 title 和原始证据区；失败、取消、超时、unknown、fork snapshot 仍由既有投影决定 | 既有状态、刷新/阅读恢复测试；组级错误仍为原有聚合语义，不新增独立取消按钮 |

浏览器预览位于隔离的本地开发服务，直接导入本 worktree 的 Transcript、ToolEvidence 与 CSS，执行数据为明确标注的模拟回执。它验证组件渲染，不证明真实 provider 调用或后端持久化链路。预览源码、截图和日志保存于 `/Users/admin/.codex/research/codex-tool-groups-2026-10-13/`，不提交到仓库。

消融：临时移除 `useProcessHeadline` 的调用，快速切换验收立即失败（200ms 内从 Run command 跳到 Edit file）；恢复后相关 46 项测试通过，因此保留这个局部展示计时。颜色探索中的整列着色、额外主题 token 和预览伪元素标签均已移除；最终只复用既有工具分类、主题变量及两个现有行 renderer，没有新的状态存储或设置项。

验证记录：基础细节版 `bun run check` 通过，隔离 `PI_CODING_AGENT_DIR` 和临时目录的 `bun run test` 为 Node 2485 passed / 9 skipped、Vitest 1425 passed。首次未隔离运行的六项 TUI 配置断言及一项共享临时目录清理断言失败；配置隔离后前六项独立通过，worktree 测试独立 19 项通过，完整隔离重跑通过。标签方案的最终检查记录将以下方结果为准。

最终标签方案：`bun run check` exit 0；`bun run test` exit 0，Node 2485 passed / 9 skipped，Vitest 94 files / 1426 passed。新增断言覆盖七类标签、无重复朗读和不解析 bash 中的 rg。浏览器现场核对七类动作起点一致、标签均为52px、正常图标与文案中性灰、失败行红色而标签中性、缺失回执保留“未确认”、执行结束自动收起。实际组件可交互预览以及浅色/深色截图保留于上述本地证据目录。`artifact-evidence.e2e.ts` 的旧徽标选择器随结构更新，本轮未重跑该完整端到端文件；不把组件预览当作后端、文件打开或持久化验收。

## 追加：Code Mode 与文件差异（实施前状态合同）

用户继续授权普通工具展示及文件增删统计。已在保留全部本地修改的情况下，将同一 worktree 快进到 PR #711 的 `cfc5537a297b7f14a73ac9d88d0a66eadd7c9c0d`。`pi list` 的唯一 OpenPI 来源仍是该 worktree。原有研究基线不改写。

| 状态 | 本次验收条件 |
| --- | --- |
| 普通／折叠 | Code Mode 子调用按真实工具显示图标、淡色标签、动作和目标；有可信差异时，文件名旁显示新增/删除数 |
| 悬停／焦点 | 复用现有行反馈和 native summary 键盘展开；差异标题中的文件打开、复制各有独立焦点，无嵌套按钮 |
| 展开／菜单 | 文件差异拥有文件名、计数、复制按钮、真实行号和淡色增删背景；不新增菜单；原始参数与回执仍可检查 |
| 运行／并行 | 子调用由 Pi 的 parentToolCallId 和实际调用 ID 关联；按首次出现顺序更新，不因完成顺序重排，不解析脚本猜工具 |
| 子失败／外层失败 | 子失败不被脚本成功覆盖；外层错误仍可检查；零子调用保留脚本结果入口 |
| 取消／未知 | 已返回子调用不被外层取消改写；未确认结果不伪装成功；live typed cancellation 使用警告状态 |
| 刷新恢复 | 使用 Pi 已保存 nestedCalls 恢复工具、参数和状态；未保存的子输出明确说明缺失，不冒充可恢复 diff |
| 新建／覆盖 | 新建必须由现有排他创建操作证明；覆盖仅用同轮已授权观察生成差异，不额外读取旧文件；未知旧内容保留 unavailable |
| 大差异／异常 | 截断明确标为部分，统计是当前显示差异的统计；失败、取消或缺失回执不由调用参数制造成功差异 |

公开源码固定于 `openai/codex@74e804deeb1241d5fe699b31fb319f7d46454c42`：[`code_mode/mod.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/core/src/tools/code_mode/mod.rs#L335) 将真实子工具经普通 runtime 分发；[`delegate.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/core/src/tools/code_mode/delegate.rs#L317) 保留独立调用身份；[`tools/events.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/core/src/tools/events.rs#L246) 发布 typed FileChange；[`item_builders.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/app-server-protocol/src/protocol/item_builders.rs#L342) 保留 path/kind/diff（Add/Delete 为内容，Update 为 unified patch）；[`rollout/policy.rs`](https://github.com/openai/codex/blob/74e804deeb1241d5fe699b31fb319f7d46454c42/codex-rs/rollout/src/policy.rs#L94) 与 history projection 恢复已完成 typed item。外层脚本生命周期和子工具回执独立。

本机 App 已更新为 `26.1007.30912`，旧 ASAR 索引不适用；重新读取当前索引并逐成员校验 SHA-256，未覆盖旧证据。当前 `sites-end-resource-78b98c374310.js` 的 `gT`（218063–229415）、`bT`（229487–231413）、`xT`（231413–231972）、`ST`（231972–232820）依次证明状态分支、标题/复制、差异渲染及 fallback；`app-shared-8bd9d0399038.js` 的 `d1`（4984671–5003537）按 commandExecution/fileChange/mcpToolCall 投影，不按 Code Mode 外层名称替代。统计模块 `patch-diff-stats-21625abcc254.js` 优先使用解析差异的计数和首变更行。

REA parent `ev_cb50e58e2e116c16fd1d084ff0c8be96dc999bc18220e253b7e69386b230c36f` 分析六个输入（五个可追溯 AST 切片与一个完整统计模块），34265 文本字节、10442 AST 节点。`complete` 仅针对六个输入；semantic unknown 1916，不能解释成整个 App 完整覆盖。原始成员、切片范围、manifest 和 9065461 字节 Evidence 导出保存在既有证据目录下 `codex-26.1007.30912/`。原生 Codex 动态访问限制仍在，悬停、键盘、动画和刷新不冒称实测；OpenPI 将通过自己的组件与原生 Pi 事件验收。

## 追加：Code Mode、文件回执与统一悬停的实施结果

本轮继续快进至 PR #711 的 `f628467167e9200b589606cf0523394e0e9e9bba`，保留之前的视觉修改。开发依赖为 Pi `1.2.0`；隔离目录下 `pi list` 再次确认唯一 OpenPI 来源为 `/Users/admin/.codex/worktrees/codex-tool-group-study/openpi`。这不是已安装服务升级，也不是付费 provider 验收。

补齐当前包的依赖后，`app-shared` 的 `jSr`（4960962–4961820，由 `be` 导入）将 add/delete 内容转换为带文件头的 unified diff，update 复用已有 diff，且有 1MiB 上限；`Cgn`（3277079–3277362）从 typed FileChange 提取这些字段。这两处是逐成员校验后的静态补读，不属于上述六输入 REA batch。没有把原生 Codex 运行时未知改记为已验证。

实施沿用 Pi 与现有 Web 接缝：`pi-runtime.ts` 转发原生 `parentToolCallId`，`live-tools.ts` 保持调用开始顺序，`types.ts` 将原生 `nestedCalls` 投影为最多 256 项、64KiB 的历史证据，`codemode-tools.ts` 关联精确身份，`Transcript.tsx` 复用普通工具组件。成功脚本保留低强调的原始入口；子失败、外层失败、无子调用、脚本仍在运行及未匹配账本项保持可检查。`models.*` 等无法匹配普通子工具的账本不被隐藏。未确认子调用仅能由精确匹配的最终回执细化；断连后的部分输出不算完成，已保存的 `ok/error` 不被覆盖。不解析 JavaScript 或 ID 前缀猜工具，不增加执行器或并行 Session 存储。

`turn-changes.ts` 通过现有操作观察生成逐次 write 回执；排他创建证明新文件，同轮已授权且指纹匹配的观察才能支持覆盖差异。没有增加旧文件读取。二进制、超限、外部变更和未知基线保留原来的证据缺失结果。`ToolEvidence.tsx` 复用统一差异解析器并适配 Pi edit 的编号行，显示文件名、当前可见差异的增删数、行号、复制和原始回执。失败、取消、运行中及 fork 缺失结果不制造成功差异。

所有工具行与组标题的 hover 统一复用 `--sidebar-hover`，替换泛用行原先固定的偏蓝背景；标签继续用用户接受的淡绿色小块，图标和正文保持灰色。浏览器实际读取 read 与 list 悬停背景均为 `rgb(232, 238, 235)`；无需新增主题变量或设置。

| 验收层 | 本轮已验证 | 边界 |
| --- | --- | --- |
| 原生 Pi／持久化 | Pi 1.2 执行、并行子调用、失败、取消与原生 Session 重载；新建和覆盖的逐次差异、空文件、同轮净变化区别、外部变更、二进制／超限及写入后取消 | 使用本地受控原生工具，无真实 provider 请求；Pi 未保存子输出时不声称刷新可恢复输出或 diff |
| 协议与组件 | 精确 parent/call 关联、乱序完成、账本上限、子错误与脚本错误、未匹配模型调用、迟到最终证据、未知结果、刷新缺失提示、两种差异格式、复制成功／失败及部分统计 | 测试按实施前状态表选择；不将 UI 文案当运行成功证据 |
| 实际浏览器 | 真实组件加明确标注的模拟执行数据：浅色、深色、375px 窄屏、统一 hover、Enter 展开、行号和计数、复制反馈、子失败／脚本失败／取消／刷新记录、播放后自动收起 | 非完整 Host→provider 链路；复制精确内容由组件测试验证；本轮未重跑 `artifact-evidence.e2e.ts`，未现场切换 OS 减少动态设置 |

消融已分别移除再恢复：逐次 write 观察回调（新建回执测试失败）、Code Mode 历史子调用投影（刷新恢复测试失败）、Pi 编号差异适配（原生 edit 的 `+2 −1` 退化为 `+0 −0`）。加上前述标题停留消融，保留的局部机制均有独立状态要求；统一 hover 直接复用已有变量，没有附加抽象。

最终源码检查：`bun run check` exit 0；`VITEST_MAX_WORKERS=1 bun run test` exit 0，Node **2511 passed / 9 skipped / 0 failed**，Vitest **94 files / 1439 passed**。日志为本地证据目录的 `check-final.log`、`test-final.log`；保留既有 bundle-size 与 JSDOM 能力提示。源码、测试和已跟踪的构建产物一起提交；私有 Session、安装包代码、预览服务及原始 REA 证据不加入 Git。新提交的 CI 另行判定，不用本地通过冒充 CI 通过。

推送前 PR 新增默认字体提交 `b31a3dd86da71cee9a169b1c5a81a3c5dcb3bfa1`；本轮修改已 rebase 到其上，保留字体设置并从合并源码重建产物。整合后再次核对唯一 `pi list` 来源，浏览器实际默认字体为 `-apple-system, system-ui, Segoe UI, sans-serif`。`bun run check` 和完整 `bun run test` 均 exit 0：Node **2512 passed / 9 skipped / 0 failed**，Vitest **94 files / 1439 passed**；最终日志为 `check-font-integrated.log`、`test-font-integrated.log`，组件截图为 `tool-groups-codemode-final.jpg`。本段是整合后验证，上文数字保留各自源码边界。

## 追加：2026-10-14 CI 回归修复

本轮先拉取 PR #711 最新 `bafef51f6f00a06f5ad35026c4414e390721e67f`，保留其会话连续性更新，并再次核对隔离 `pi list` 的唯一来源。[失败 CI 38419532850](https://github.com/openpi-dev/openpi/actions/runs/38419532850) 的直接原因是两项浏览器断言和一项 Windows 清理失败，其他聚合红灯来自这些依赖。

- 差异标题在 `#f4f6f5` 背景上使用 `#128252` 小字，对比度为 4.45，低于 AA 4.5。仅在差异卡片内将新增计数字色与现有正文色混合，保留绿色含义及灰色标题底。原来的完整 Axe 断言不删减；移除这一条 CSS 的消融重新得到同一 4.45 失败。
- 新的原生重试通过空文本和精确 `retryEntryId` 继续失败回复，旧 E2E 仍要求重新发送 `Question`。更新请求断言，并确认点击重试后用户消息仍只有一条；不把产品逻辑退回重复输入。
- Code Mode 外层取消可以早于实际 shell 结束，Windows 删除 cwd 因而出现 `EBUSY`。测试在保持订阅的情况下等待对应子调用的终态，设十秒失败上限，随后 dispose 并使用有界文件系统重试。保留真实 shell、取消和历史回执检查，无平台跳过。
- 文件证据 E2E 在展开动画尚未可交互时发送 Enter，复核中观察到焦点仍留在组标题并再次折叠。此文件改用等待可点击的原生摘要操作；独立键盘覆盖保留在既有测试中。

两个原 CI 浏览器失败均已在本地原样复现，修复后的真实浏览器用例通过。验收日志保存在 `/Users/admin/.codex/research/pr711-ci-2026-10-14/`。一次同时重建 `web/dist` 和运行 CLI 启动测试的本地尝试出现临时 HTTP 500；构建和使用构建产物的验收改为串行，不修改或放宽启动测试。Windows 的最终平台结论以新提交 CI 为准。

最终串行验证：`bun run check` exit 0；完整 `bun run test` exit 0，Node **2516 passed / 9 skipped / 0 failed**，Vitest **94 files / 1453 passed**。两项原失败浏览器用例 **2/2 passed**；Code Mode 原生测试通过。对应 `check-final.log`、`test-final.log`、`e2e-final.log`、`native-fixed.log`；`ablation-contrast-isolated.log` 记录移除样式后的预期对比度失败。原始本地并行干扰日志保留，未计为最终通过证据。

`ee5561cb` 的 [CI 38496397498](https://github.com/openpi-dev/openpi/actions/runs/38496397498) 已通过所有 Windows／Linux runtime 和 UI 检查，普通浏览器第一分片 **78/78 passed**。随后首次执行到的 Plan provider 步骤暴露另一项旧断言：它仍要求失去控制的已查看 Session 禁用输入框，而最新会话连续性功能允许编辑该 Session 的草稿。后续仅更新测试，实际编辑并验证切回后保留同一草稿；继续断言 provider 请求数不增长、文件未写入、Plan 保持 ready，重新准备并显式提交后才执行。实施授权失效仍由 Composer 对精确 Session／revision 的既有检查负责，与草稿是否可编辑分别验证；既有组件测试还直接验证切换后提交不携带旧授权。没有恢复旧产品行为或删除 Plan 门禁检查。

用户随后补充文件名下划线需求。工具摘要的文件名使用 1px 点状下划线，与文字间隔 `.2em`，正常状态为正文色的 55% 不透明度，悬停／键盘聚焦时加深；直接复用现有文件名元素和原生摘要交互，不增加组件或执行状态。真实组件预览已观察浅色、深色、375px 内容宽度及键盘聚焦：14px 字体的实际偏移为 2.8px，深色聚焦线条变为 `rgb(168, 176, 184)`，其余文件仍为 55% 透明度。路径、命令和动作文字不额外加线；截图 `tool-filename-underline.jpg` 位于上述本地证据目录。该预览使用模拟执行数据，与原生 Plan provider 5/5 浏览器验收分别记录。

后续最终验证：`bun run check` 与完整 `bun run test` 均 exit 0（Node **2516 passed / 9 skipped**；UI **1453 passed / 94 files**）；Plan provider **5/5**，两项原失败浏览器用例 **2/2**。日志为 `check-followup.log`、`test-followup.log`、`plan-followup.log`、`e2e-followup.log`。虚线消融去掉交互加深规则后，已聚焦文件仍只有 55% 不透明度；恢复后为完整正文色，保留这一条规则，未新增抽象。`underline-ablation.json` 保存该观察，Enter 展开／收起文件内容亦已验证。新提交 CI 结论仍需单独确认。
