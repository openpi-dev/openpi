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
| M08 | 只读变更证据视图逐次展示 write/edit 工具回执，未知或歧义 ID 不配对；明确不是当前 Git 工作树或 staged diff，有界历史可缺失。 |
| M09 / M10 | 已保留命令的可见输出复制，未知退出码不推断；区分已保存 Trust 决策与当前 Session 权限，配置仍指向唯一 `/openpi-setup`。 |
| M11 / M12 | 768px、390px、短高度、高缩放和组合输入浏览器回归；生产 bundle 的空/长/100/500 条合成场景和断线恢复测量。 |

## 组件来源与复用结果

本次直接复用仓库现有 React、Astryx、ReactMarkdown、Lucide、Pi Session/Host API、工具证据组件和剪贴板 helper；没有新依赖、复制第三方代码或更换 provider/session 栈。Maka 的导航和 linked-agent 列表、Pi Web 的独立内容区域与工具证据、DeepSeek Harness 的 Markdown/附件/只读子任务组件可作交互及代码组织参考，具体固定源码与版本见既有 [子代理调查](WEB_SUBAGENT_INSPECTION_2026-09-18.md)。Harness Web 不是消费者 DeepSeek 聊天客户端；本次没有取得 Codex/Claude Desktop 客户端的公开组件源码，不能声称其 UI 技术栈已知。

## 真实页面复验补充

在当前源码启动的真实 Host 中，使用 `gpt-5.6-luna / medium` 创建并重载一个 Web Session；模型实际调用 `read` 读取工作区 `package.json`，最终回答顶层 `scripts` 数量为 `24`。这只验证单次 provider、工具证据和 Session 持久化链路，不代表并发或跨 provider Benchmark。

真实操作侧栏搜索、输入区、斜杠菜单、工具证据和轨迹后，修复了七项连续性问题：完整历史搜索仍显示“0 条未加载”、工作区绝对路径破坏换行、输入目标重复完整首条提示、轨迹默认选中无信息的尾部事件、成功工具被描述为仍可能运行、空斜杠菜单被 Web 不可运行命令淹没，以及 `/ps` 因描述文本误匹配 `/btw` 和 `/usage`。对应补强覆盖 M02、M03、M04、M05 和 M12；没有新增并行状态机或第二套 Session 来源。

消融时移除命令名优先过滤，专项测试立即重新出现 `/ps` 的描述误匹配；因此保留两阶段过滤。其余改动复用现有格式化、轨迹投影和命令可用性数据，没有引入新的组件依赖或框架抽象。

用户复验指出服务商凭据不应继续挤在运行状态模态中。对照 Maka 的页内搜索列表与 DeepSeek Harness 的独立 Models 设置区域后，Web 将服务商状态拆为独立全屏设置页：运行状态不再请求整张 provider 列表；composer 和运行状态只提供入口；新页面按已配置优先排列，并提供搜索、全部/已配置/待配置筛选、认证方式、刷新和明确的 Pi 只读权限边界。页面对旧 Host 省略 `authMethods` 的投影降级显示，避免滚动升级时白屏。

该设置页在真实 Host 的 740px 页面中完成搜索、筛选、关闭和焦点返回复验，并在 Playwright 1280px/390px 下通过 axe。消融时移除只有一个项目的设置侧栏，独立页面、搜索和筛选仍满足目标且减少无效层级，因此没有保留为未来功能预建的导航抽象。

后续真实 `gpt-5.6-luna / medium` 只读任务实际调用 `read` 与 `bash`，从差距记录和 Composer 源码指出：统一 `+` 菜单只有 Slash Commands，缺少文件上下文入口。Web 因此复用现有 Astryx `DropdownMenu`、`Dialog`、`TextInput` 与 Host artifact grant，加入“引用工作区文件”：活动 Session 先验证路径仍是工作区内的普通文件，再把反引号包裹的可见路径插入当前光标；新 Session 首条消息只插入路径，不声称文件已上传，实际读取仍由 Pi 工具权限决定。非空草稿继续保留 `+` 入口，Slash Commands 在会覆盖正文时显示禁用原因。

真实 Host 复验覆盖合法 `README.md`、非空草稿继续引用、焦点返回及 `../outside.txt` 越界拒绝；实测还发现 Host 英文错误直接泄漏到中文 UI，随后按 artifact 错误码映射为本地化提示。Playwright 在 1280px/390px 下覆盖合法引用、禁用状态、越界失败与 axe。消融移除了菜单项与对话框重复的二级说明；移除 artifact 校验则会破坏越界拒绝测试，因此保留该运行时边界和独立异步组件。

继续用同一真实 `gpt-5.6-luna / medium` Session 通过新入口连续引用 App、Transcript 和 E2E 文件。模型先因只看 Composer 误判“provider 失败不可见”，补齐证据后修正为：错误、partial output、取消与 admission unknown 已有闭环，剩余最小高频缺口是失败卡片没有直接恢复动作。实现因此只在当前活动 Session 的最后一条用户请求失败时显示“重试消息”，复用既有 `onResend` 和 admission 合同；点击期间锁定，历史失败不提供旧请求重放，运行中也不可重试。消融若移除本地 pending 状态会恢复双击重复提交风险，因此保留小型 `ProviderOutcome`，没有新增重试状态机。

## 验证与限制

- `bun run check` 与 `bun run test`、静态资产 Playwright、真实 Host 的文件/变更视图 E2E 通过；具体最终计数写在 PR Validation。
- 真实 `gpt-5.6-luna / medium` 单次请求返回 `2` 并在重载后保留；未把合成六任务或页面性能结果冒充真实模型并发。既有 [子代理调查](WEB_SUBAGENT_INSPECTION_2026-09-18.md)单独记录过真实只读子任务和 provider 并发限制。更低的账户/池限制仍优先于声明的上限。
- Playwright Chromium 结果不覆盖 Safari 真机、Android/iOS 软键盘、长期断网或竞争产品性能。M12 原始合成回执保存在本机临时目录，不是具有冻结模型/任务/验收器/成本与可公共检索证据的正式 Benchmark。
- 消融：保持纯粹的 `changeCalls` 提取，因为入口数量和面板共用它；重复 ID 的 fail-closed 检查不能移除，专项测试会发现错误配对。保持预览复制代际，因为嵌套跳转晚到回执测试会失败。没有引入虚拟列表、终端 PTY、Git 写入 API、第二套路由或外部组件运行时；当前证据不足以支持它们带来的权限与焦点成本。

本机私有凭据、用户截图、真实 Session 和原始日志未纳入此公开提交。
