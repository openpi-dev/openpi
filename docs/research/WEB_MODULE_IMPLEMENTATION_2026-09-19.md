# Web 工作区模块实现与验证边界

- Status: validated（限本提交源码、自动化测试与下述单次实际模型 smoke）；不是正式 Benchmark 或产品发布声明。
- Created / verified: 2026-09-19 JST。
- Source boundary: PR #561 原有 Web 基线 `beb0841b56c10dbe40e5eda8a7db9589c86ab857` 加本文所在实现提交；验证针对该提交的工作树与构建资产。
- Related: [Issue #559](https://github.com/openpi-dev/openpi/issues/559)、[Issue #560](https://github.com/openpi-dev/openpi/issues/560)、[PR #561](https://github.com/openpi-dev/openpi/pull/561)。Supersedes: none。

## 已实现的范围

| 模块 | 本次可见行为 / 边界 |
| --- | --- |
| M01 / M05 | 工作区身份、加载重试、侧栏会话搜索与作用域、窄屏导航；沿用现有 Session store。 |
| M02 / M03 | 输入目标与命令入口、IME 和草稿回归、表格横向阅读与回到底部；Markdown 仍由现有 renderer 清理。 |
| M04 | assistant/provider 停止原因、失败与部分输出分开显示；事件和提示失败文本先有界消毒，再经现有协议投影。 |
| M06 | 子任务详情不可见时停止轮询、重新可见时继续；总览、历史降级及精确身份来自 PR 既有实现。合成六任务 UI 不等于六个真实并发模型。 |
| M07 | 文件预览显示路径、只读性质、revision、复制状态；保留 Host handle、权限、释放和 abort；内层文件跳转关闭后返回原始焦点。 |
| M08 | 只读 Git 分支／工作区快照：比较当前分支与已识别基准的 merge-base，并合并 staged、unstaged、untracked 文件；底部摘要、文件弹层和直接 diff 与 Session 精确绑定，不提供 Git 写操作。 |
| M09 / M10 | 已保留命令的可见输出复制，未知退出码不推断；区分已保存 Trust 决策与当前 Session 权限，配置仍指向唯一 `/openpi-setup`。 |
| M11 / M12 | 768px、390px、短高度、高缩放和组合输入浏览器回归；生产 bundle 的空/长/100/500 条合成场景和断线恢复测量。 |

## 组件来源与复用结果

本次直接复用仓库现有 React、Astryx、ReactMarkdown、Lucide、Pi Session/Host API、工具证据组件和剪贴板 helper；没有新依赖、复制第三方代码或更换 provider/session 栈。设置外形与导航以实际运行的 [`@agegr/pi-web@0.9.1`](https://github.com/agegr/pi-web/releases/tag/v0.9.1) General / Models 页面为视觉和交互参照；文件栏状态转换参考 Apache Maka 固定提交 `5b9db1c` 的 [`ArtifactPane`](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/apps/desktop/src/renderer/features/workbar/tools/artifacts/artifact-pane.tsx)“列表 ↔ 单个全栏预览”，早期的 Maka `SessionReviewPanel`、Pi Web 工具证据和 DeepSeek Harness [`ChangedFiles`](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-deliverables/src/client/ChangedFiles.tsx) 仍只作为信息组织参考。实现直接使用 OpenPI 已安装的 Astryx `Dialog`、`Button`、`Banner`、`Skeleton`、`EmptyState`、`Text` 与布局组件；本仓库的 `0.5.2` 已具备本轮所需接口，因此没有为了版本数字对齐 Maka 的 `0.6.1` 或 npm 后续版本而做全站升级。Maka 私有 workspace 包没有导入，本地 `DiffCodePreview` 只负责有界解析和代码行展示，并非第三方源码移植。Harness Web 不是消费者 DeepSeek 聊天客户端；本次没有取得 Codex/Claude Desktop 客户端的公开组件源码，不能声称其 UI 技术栈已知。

## 真实页面复验补充

在当前源码启动的真实 Host 中，使用 `gpt-5.6-luna / medium` 创建并重载一个 Web Session；模型实际调用 `read` 读取工作区 `package.json`，最终回答顶层 `scripts` 数量为 `24`。这只验证单次 provider、工具证据和 Session 持久化链路，不代表并发或跨 provider Benchmark。

真实操作侧栏搜索、输入区、斜杠菜单、工具证据和轨迹后，修复了七项连续性问题：完整历史搜索仍显示“0 条未加载”、工作区绝对路径破坏换行、输入目标重复完整首条提示、轨迹默认选中无信息的尾部事件、成功工具被描述为仍可能运行、空斜杠菜单被 Web 不可运行命令淹没，以及 `/ps` 因描述文本误匹配 `/btw` 和 `/usage`。对应补强覆盖 M02、M03、M04、M05 和 M12；没有新增并行状态机或第二套 Session 来源。

消融时移除命令名优先过滤，专项测试立即重新出现 `/ps` 的描述误匹配；因此保留两阶段过滤。其余改动复用现有格式化、轨迹投影和命令可用性数据，没有引入新的组件依赖或框架抽象。

用户复验指出服务商凭据不应继续挤在运行状态模态中。对照 Maka 的页内搜索列表与 DeepSeek Harness 的独立 Models 设置区域后，Web 将服务商状态拆为独立全屏设置页：运行状态不再请求整张 provider 列表；composer 和运行状态只提供入口；新页面按已配置优先排列，并提供搜索、全部/已配置/待配置筛选、认证方式、刷新和明确的 Pi 只读权限边界。页面对旧 Host 省略 `authMethods` 的投影降级显示，避免滚动升级时白屏。

该设置页在真实 Host 的 740px 页面中完成搜索、筛选、关闭和焦点返回复验，并在 Playwright 1280px/390px 下通过 axe。消融时移除只有一个项目的设置侧栏，独立页面、搜索和筛选仍满足目标且减少无效层级，因此没有保留为未来功能预建的导航抽象。

后续真实 `gpt-5.6-luna / medium` 只读任务实际调用 `read` 与 `bash`，从差距记录和 Composer 源码指出：统一 `+` 菜单只有 Slash Commands，缺少文件上下文入口。Web 因此复用现有 Astryx `DropdownMenu`、`Dialog`、`TextInput` 与 Host artifact grant，加入“引用工作区文件”：活动 Session 先验证路径仍是工作区内的普通文件，再把反引号包裹的可见路径插入当前光标；新 Session 首条消息只插入路径，不声称文件已上传，实际读取仍由 Pi 工具权限决定。非空草稿继续保留 `+` 入口，Slash Commands 在会覆盖正文时显示禁用原因。

真实 Host 复验覆盖合法 `README.md`、非空草稿继续引用、焦点返回及 `../outside.txt` 越界拒绝；实测还发现 Host 英文错误直接泄漏到中文 UI，随后按 artifact 错误码映射为本地化提示。Playwright 在 1280px/390px 下覆盖合法引用、禁用状态、越界失败与 axe。消融移除了菜单项与对话框重复的二级说明；移除 artifact 校验则会破坏越界拒绝测试，因此保留该运行时边界和独立异步组件。

继续用同一真实 `gpt-5.6-luna / medium` Session 通过新入口连续引用 App、Transcript 和 E2E 文件。模型先因只看 Composer 误判“provider 失败不可见”，补齐证据后修正为：错误、partial output、取消与 admission unknown 已有闭环，剩余最小高频缺口是失败卡片没有直接恢复动作。实现因此只在当前活动 Session 的最后一条用户请求失败时显示“重试消息”，复用既有 `onResend` 和 admission 合同；点击期间锁定，历史失败不提供旧请求重放，运行中也不可重试。消融若移除本地 pending 状态会恢复双击重复提交风险，因此保留小型 `ProviderOutcome`，没有新增重试状态机。

用户随后要求 M08 改为真实 Git 分支快照，而不是从对话工具回执推断最终文件状态。Host 新增 Session 绑定的只读 `/api/git-review`：只接受当前投影中的精确 Session id/path，固定调用 Git 的只读 diff/name-status/ls-files 接口，关闭 external diff 与 textconv，并限制 10 秒、200 文件、最终 4 MiB Web 响应。基准优先取 `origin/HEAD`、`origin/main`/`master`、本地 `main`/`master`；可用时比较 merge-base 到当前工作区，从而同时覆盖分支提交、staged 和 unstaged，再追加 untracked 普通文件。找不到可信基准时明确退化为 HEAD/工作区范围，不伪造分支归因。

UI 参考 Maka `SessionReviewPanel` 的摘要、可折叠文件行和直接 diff，同时保留用户给出的 Codex 风格底部“文件已更改”入口。真实仓库达到响应上限时，仍返回可列出的文件身份和统计；未载入的单文件 diff 明确标记截断，最终 JSON 再按协议字节数硬收口。真实 Host 在当前分支展示 200 个有界文件、`+20035/-5751` 和截断提示；桌面弹层根据触发按钮上方空间定高，390×844 页面与审查面板均无水平溢出，文件展开可直接阅读 diff。这里展示的是仓库当前分支和工作区的快照，可能包含 Session 开始前已有改动，不宣称全部由当前模型产生。

## 设置与独立文件栏复验补充

2026-09-19 的后续实页对照使用本机实际运行的 `@agegr/pi-web@0.9.1`，而不是早期记录中的另一个同名仓库。1440×960 下，参照设置面板为 `1080×806`、左侧模型栏为 `240px`；OpenPI 最终面板为 `1080×808`、模型栏同为 `240px`。General、Models、OpenPI 作为顶部分段页签，Models 保持“服务商分组列表 → 当前模型详情”结构，并通过既有 `selectModel` action 切换模型。General 只展示主题、当前模型、thinking 与工作区等已有状态；服务商凭据仍是 Pi 只读投影，包级配置继续由唯一 `/openpi-setup` 拥有，未为了视觉一致而复制另一套配置写入来源。

此前记录的“文件行内展开 diff”仅代表中间迭代的 UI，现由最终交互取代；Git 快照接口、Session 绑定、只读命令与响应上限等运行时事实不变。底部摘要弹层仍快速列出文件和增删统计，但点击文件后会打开与对话区并列的独立右栏，列表态再切换为单文件全栏预览；返回按钮和 `Escape` 回到列表，关闭后焦点返回原关闭按钮。1440×960 下最终布局为 `240px` 侧栏、`595px` 对话区和 `605px` 审阅栏；390×844 下审阅栏占满视口，桌面和移动端均无水平溢出。

artifact 文件也从浮层改成应用网格的直接第三列，保留原 Host handle、权限、刷新、下载与释放语义。变更审阅和 artifact 预览互斥，避免窄屏或桌面同时打开两个辅助栏。真实 Chromium E2E 覆盖“底部弹层 → 文件栏 → 返回/关闭”、独立 artifact 第三列、桌面/移动设置页和无障碍检查；实页焦点探针确认返回后焦点为关闭按钮，随后 `Escape` 能关闭审阅栏。

消融复验移除了 `ReviewPanel` 未使用的 Session prop，专项测试与类型检查仍通过，因此不保留该耦合；设置、Git 审阅和 artifact 各自拥有不同数据与生命周期，没有合并成总控状态机。`DiffCodePreview` 保留，因为它集中承担统一 diff 解析、双行号、增删/上下文状态和行数上限；移除后会把同一协议解析重新散落到列表和预览层。Astryx `0.5.2` 的现有组件已满足 Dialog、按钮和状态呈现要求，升级不能改善本轮验收结果，因此未产生依赖锁文件噪声。

## 验证与限制

- 本机未安装 `bun`，因此逐项运行 `bun run check` / `bun run test` 对应的配置、文档、纪律、Biome、TypeScript、构建和测试命令；静态资产 Playwright、真实 Host 的文件／Git 变更视图 E2E 也通过。具体最终计数写在 PR Validation。
- 真实 `gpt-5.6-luna / medium` 单次请求返回 `2` 并在重载后保留；未把合成六任务或页面性能结果冒充真实模型并发。既有 [子代理调查](WEB_SUBAGENT_INSPECTION_2026-09-18.md)单独记录过真实只读子任务和 provider 并发限制。更低的账户/池限制仍优先于声明的上限。
- Playwright Chromium 结果不覆盖 Safari 真机、Android/iOS 软键盘、长期断网或竞争产品性能。M12 原始合成回执保存在本机临时目录，不是具有冻结模型/任务/验收器/成本与可公共检索证据的正式 Benchmark。
- 消融：旧 `changeCalls` 聚合、逐轮变更卡和全局 review store 已移除；真实 Git snapshot 已能直接满足文件列表与最终工作区审阅，保留两套“变更事实”反而会混淆来源。未加入树状文件浏览、双栏 diff、base 选择器、虚拟列表、Git 写入 API、终端 PTY 或外部组件运行时。保留独立只读 Host 接口，是因为浏览器不能安全地直接执行 Git，且 Session 身份、命令限制、超时和最终响应字节上限必须由运行时强制。

本机私有凭据、用户截图、真实 Session 和原始日志未纳入此公开提交。
