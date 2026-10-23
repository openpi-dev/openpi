# DeepSeek 风格执行轨迹

- 状态：`validated`，限定于下述源码投影、组件与固定数据浏览器验收；不代表模型性能结论或正式发布。
- 创建与最近核查：2026-10-14。
- 初始核查范围：以 OpenPI `7daee1eb818e60d3bf52e79edb1b3ef1cfecd9a1` 为基线的独立轨迹改动；Pi `1.2.0`。
- 跟踪与认领：[#785](https://github.com/openpi-dev/openpi/issues/785)，由 `@testikun` 认领。
- 来源：DeepSeek Harness [`d743267388641bc76f17c45ce8b4c231aed1d32c`](https://github.com/deepseek-ai/deepseek-harness/tree/d743267388641bc76f17c45ce8b4c231aed1d32c/packages/client/ui-trajectory)，MIT。移植许可位于 `web/ui/src/features/trajectory/LICENSE.dsh`。
- 替代关系：无；既有轨迹研究的历史验证保持原边界。

## 问题与结果

原轨迹以消息卡片为主，长回合中很难定位模型响应、Code Mode 的内部调用及某次工具耗时。本次采用 DeepSeek 的紧凑执行列表、上下文／模型／工具三轨总览和右侧详情结构，把已存在的 Pi 事实显示出来。

用户可以通过总览点击或键盘选择记录，通过拖动选区突出对应记录；列表支持搜索、按回合折叠、整体折叠工具与历史读取。Code Mode 子调用在父调用后缩进排列，状态、原生 duration 和结果缺失提示分别保留。详情提供输入、结果、时间与模型响应的用量，代码和结果可以复制原文、切换换行；Code Mode 源码使用有界、清理后的高亮。

## 数据所有者

Pi Session 仍是消息与结果的来源。`projectMessage()` 只补充 provider 原生的单次 input、output、cacheRead、cacheWrite 与模型身份；未报告的字段不补零，失败／取消的全零占位用量不作为用量证据，非零的原生计数仍保留。当前会话的原生 live tool 结果可补充临时详情；其他会话不复用该 live ledger。

`buildTrajectory()` 保持调用配对规则；浏览器投影补上没有正文的 assistant 响应，并使用现有 `codemodeChildren()` 读取父子调用。重复外层调用身份不建立 live 子调用关系。不解析脚本文本来推测调用，不从 ID 前缀建立父子关系，不把脚本输出当作子工具结果。

持久 Code Mode 子调用摘要可能只有调用、状态和 duration，没有子工具返回体。刷新后保留这个限制，明确提示结果正文未保存。外层工具返回成功和后续模型失败可以同时显示。Pi 原生证据能够区分执行中、取消或超时时，详情保留相应状态；摘要只记录 error 而无法细分时保持该证据边界。

## 时间与用量口径

总览本轮采用等宽记录序列，明确标注宽度不表示耗时。当前保存时间不是工具开始时间，子调用的 duration 也没有提供其绝对开始位置，不能将这些字段拼成真实并行时间线。时间详情只显示已有原生 duration；首段输出等待、生成时间、吞吐未采集时显示“未记录”。最近回合耗时来自已有的 `openpi-web-turn-timing` 记录，单独标明为最近已记录回合。

单次模型用量与已加载响应／调用数量分别展示。数量只覆盖有界读取窗口，不宣称覆盖整个 Session。真正的逐次 provider 阶段、精确 HTTP attempt、网关内部重试和异常 SSE 原字节仍是后续观测工作，不能用本次 UI 验收代替。

## 阅读与生命周期

历史读取复用 `useSessionHistory()` 的分支身份、分页、取消和验证机制。初始展示最近 50 条轨迹记录，用户可显式增加已加载记录的展示范围；选中较早记录时维持当前窗口，提供回到最新记录。当前投影仍受 Session 数量与字节上限约束，不提供全量请求或无限日志端点。

新记录追加保留选中身份和详情 tab。向上滚动暂停自动滚入；显式选中记录恢复定位。分页前后的高度补偿保留阅读位置。总览选区仅应用于选择时的确切记录窗口；搜索或窗口变化不会把旧坐标应用到不同记录。窄面板上下排列执行列表与详情，沿用现有主题、翻译和键盘交互。

## 验证与消融

专项测试覆盖原生调用配对、工具专用响应、Code Mode 子调用及缺失结果、已记录耗时、模型错误、单次用量和键盘选中。浏览器用例覆盖桌面／手机、明暗主题、原生结果搜索、代码文本安全、无横向溢出与可访问性。

本轮消融移除了总览里重复的 click 选中处理，只保留 pointer settlement 与键盘激活；移除了将 Code Mode 源码包装成 Markdown 的中间路径，改为保留精确文本并按需高亮；移除了选区重置 Effect，改为记录身份匹配后才投影选区。分别由真实浏览器点击／拖动、原始参数／精确复制、搜索后选区用例验证。没有引入通用 span 框架、第二套 Session 存储、provider 栈或自动重试。

验收结果（2026-10-14）：

- `bun run check` 通过：配置／文档合同、构建、格式、lint、类型检查；生成的 `web/dist` 随实现提交。
- 空的 `PI_CODING_AGENT_DIR` 下运行 `bun run test`：Node 2519 通过、9 跳过，Vitest 95 文件／1460 用例通过。首次读取本机个人 TUI 配置时有 6 项渲染测试失败，隔离配置后消失。
- Playwright 轨迹专项 3/3 通过：桌面／手机、明暗主题、总览点击与拖动、选区身份、嵌套调用、时间／用量、输入／结果、键盘 tab、无横向溢出与 Axe。
- 浏览器通过真实本地测试 Host 加载当前 checkout 的构建；测试启动器先执行 `scripts/provenance.mjs`，验证 `pi list` 的唯一 OpenPI 来源与 checkout 一致。使用固定消息与 SSE fixture，不调用真实模型。
- 本地证据身份：`openpi-trajectory-deepseek-20261014`，收据及日志／截图保存在仓库外的 `~/.local/state/openpi-web/evidence/trajectory-deepseek-20261014/`。源文件、构建和证据文件的 SHA-256 在收据中记录。

真实用户 Session 的手工 smoke 尚未验证；现有 `57161` 常驻运行副本未随本 PR 更新。测试仅证明这批投影和 UI 的行为，不证明运行更快；本次没有新的模型速度 Benchmark。
