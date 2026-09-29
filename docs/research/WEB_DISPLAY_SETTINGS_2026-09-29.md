# Web 显示设置直写与上下文用量展示

- Status: validated
- Created: 2026-09-29
- Verified: 2026-09-29（源码、完整检查及本机隔离 Chromium；不是跨浏览器性能 Benchmark）
- Source boundary: PR #598，基于 `a316610`；Pi SDK 0.85.1
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: 无；补充先前设置记录，保留旧版按 setup 提交的历史事实

## 参考与采用范围

Pi Web `a345b2a` 的 [theme.ts](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/theme.ts) 直接应用主题并存入浏览器；[SettingsDialog.ts](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/components/SettingsDialog.ts) 和 [clients.ts](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/api/clients.ts) 用结构化接口处理其他配置，展示保存中、成功与失败。这里只采用明确控件值直接提交的交互，不复制其浏览器配置存储。

Maka `e98c2f4` 的 [ContextUsageAction](https://github.com/apache/maka/blob/e98c2f4cf31e0812e4c253758c119975c80303a2/packages/ui/src/composer.tsx) 以占比作为紧凑入口，说明实际占用和窗口上限。[VS Code 官方文档](https://code.visualstudio.com/docs/agents/run/sessions/manage-sessions#manage-session-context) 将当前上下文和展开后的用量详情分层展示。OpenPI 采用占比入口、进度条、完整已用/容量数字和折叠的累计统计；没有复制参考产品的费用统计、分类计数或压缩按钮，因为本次未取得对应运行时能力的验证。

## 实现与边界

用户在本次任务明确要求页面显示设置直接保存。主题、聊天宽度、字号、默认展开思考块通过认证及 Origin 校验后的窄 HTTP 接口写入现有 `updateSetupConfig`，复用配置锁、最新文件合并、校验、未知字段保留和原子保存。接口拒绝额外字段，不能借此修改权限、模型或 Agent 行为。显示偏好与 agent 执行无关，允许在运行中及 Plan 模式修改；其他 setup 请求继续受现有规则约束。自然语言 setup 仍可修改同一份配置。

保存回执直接更新设置页的已保存值，并通知其他快照消费者刷新。失败不显示成功，滑块恢复已保存值；不把设置请求写入 Session，也不触发模型调用。模型定义和凭据仍使用原有 Pi 原生接口。

顶部以前混排累计输入、输出、缓存和当前上下文，容易把不同口径混为一谈。现在入口只显示“上下文 N%”，展开后显示当前分支估算占用/模型窗口；会话累计的输入、输出、缓存读写另行展开。累计值来自 Pi `getSessionStats()`，包含已保存分支、摘要及有 usage 的工具结果；当前上下文来自 Pi `getContextUsage()`。未知占用显示未知，不伪造百分比。显示进度条最多填满，数值保留实际超过 100% 的事实。浮层使用原生 popover 的 Escape、点击外部关闭和顶层显示。

## 验证与简化

- `bun run check` 通过；完整 `bun run test`：Node 2004 通过、8 跳过，Vitest 843 通过。
- Host 专项 49 通过：认证与跨 Origin 拒绝、四字段校验、未知字段保留、并发局部更新不丢失、损坏配置拒写、无模型请求和无 Session 追加。
- 设置 UI 专项 29 通过：成功应用、失败恢复、运行中与 Plan 状态可改显示偏好；自然语言 setup 的阻塞与回执仍有效。
- 隔离 `57119` 的真实保存调用、刷新持久化、失败回退、零 `/api/prompt`、Session 原始条目不变均通过。五次成功 HTTP 保存观察为 15–22ms；仅本机单次烟测，不保证其他设备延迟。
- 1450px/390px Chromium 检查用量浮层、原生 Escape 关闭和边界；用量数字使用固定 fixture，设置保存使用真实隔离 Host。最终浮层背景不透明。
- 消融：移除保存回执对设置页的更新，主题选中态回归失败；恢复后通过。保留该更新，不添加另一份持久化配置、乐观回滚框架或额外模型工具。

本机日志、烟测脚本与截图保存在仓库外 `openpi-evidence/direct-settings-20260929`。真实长会话延迟调查包含私有数据，未写入本记录或提交 Git。

## 256K 压缩与状态展示补充

2026-09-29，用户在上述改动之后要求将当前模型窗口改为 256K 并验证自动压缩。实验在 `50fc082`、唯一来源为本地 Web runtime 的 Pi SDK 0.85.1 上执行；通过既有模型配置接口仅将窗口改为 **256,000 tokens**，不是 256 KB。原始模型配置和 Session 已在仓库外私有备份；窗口按用户要求保留，未修改包默认值。

真实长会话的原始上下文为 311,438 tokens，修改窗口后为 121.7%。下一次请求触发 Pi 原生自动压缩，预处理约 61.7 秒，首轮总计约 70.4 秒；原生 Session 保存了压缩摘要，首轮结束上下文为 30,165 tokens。第二次验证约 5.0 秒完成，正确复述验证标记及先前保存的 1040px 聊天宽度；上下文为 30,256 tokens（11.8%），未再次压缩。这只证明本次会话的两轮验证，不证明任意历史细节均无损保留或所有请求都有相同延迟。私有证据位于上述目录的 `compaction-256k/`，不提交模型回复、摘要、配置或 Session 原文。

该实验同时发现：发送前压缩尚未进入 `agent_start`，Web 仅检查 `isStreaming`，因此压缩期间显示空闲。用户要求先研究 Pi Web 和 Maka，再采用对话内的轻量状态提示。参考边界分别为 Pi Web `dd771618a9aa6df789539d692870e9b798266b0a` 和 Maka `e98c2f4cf31e0812e4c253758c119975c80303a2`：

- [Pi Web ChatView](https://github.com/jmfederico/pi-web/blob/dd771618a9aa6df789539d692870e9b798266b0a/src/client/src/components/ChatView.ts) 将压缩状态放在对话区域，解释正在整理历史；[PromptEditor](https://github.com/jmfederico/pi-web/blob/dd771618a9aa6df789539d692870e9b798266b0a/src/client/src/components/PromptEditor.ts) 提示新消息排队并提供停止动作。其服务端另有压缩期间的排队处理，不能仅复制文案。
- [Maka ChatTurn](https://github.com/apache/maka/blob/e98c2f4cf31e0812e4c253758c119975c80303a2/packages/ui/src/chat-turn.tsx) 使用分隔行、转圈和等待计时；失去活动观察时去掉转圈、改为状态不可用。其 host 管理的压缩回合在完成后由持久化系统记录替代运行提示。这里是源码和相关测试核对，未运行两个参考产品的压缩流程做体验 Benchmark。

OpenPI 使用现有 Pi `compaction_start` / `compaction_end` 事件和 `isCompacting`，将状态投影到精确 Session ID + 路径对应的 `selectedExecution`。只在内存中保留每个原生 Session 最近一次观察及运行计时，复用 `session_progress` 刷新快照；不新增模型工具、配置项或持久化生命周期。原生事件区分成功、失败、取消和无新摘要，错误与摘要原文不进入状态字段。成功的历史分隔行只从原生 `compaction` 条目生成，不根据消息文案推断。重连从快照恢复状态，未知开始时间不制造计时；进程重启后仅保留原生已保存的完成记录。

交互采用对话末尾的“正在压缩上下文…”和已等待时间，顶部仍显示实际上下文占比。压缩期间不把上一轮历史误标为运行中；结束后刷新占用。断线时停止转圈和计时，重连后核实状态。浏览器离线事件会及时关闭事件流，不必等到 45 秒静默超时。保留原有输入所有权：压缩期间可编辑草稿，按钮和 Enter 均不再发送；服务端也拒绝额外请求。原有停止按钮仅在已取得可取消回合身份时出现，不伪造发送前压缩的停止能力。草稿在本页的状态变化和断线重连中保留；不新增跨整页刷新的草稿持久化机制。

实现消融中移除 `isCompacting` 忙碌检查，回归测试立即复现错误的空闲状态；恢复后通过。同时移除了没有显示用途的终态计时存储，完成记录直接复用原生条目。状态验证覆盖发送前压缩、会话/文件隔离、失败/取消/无新摘要、断线去动画、重连、原生历史恢复、拒绝消息伪造完成记录以及保留草稿。

补充实现的完整 `bun run check` 和 `bun run test` 通过：Node 2005 通过、8 跳过，Vitest 850 通过。隔离 Chromium 在 1450px/390px 检查运行中、离线、重连、失败、取消、无新摘要、完成和仅持久化条目恢复；状态转换与重连保留草稿，页面零异常、零模型请求。该 UI 烟测使用明确的快照 fixture，不冒充又一次真实模型压缩；真实 256K 模型实验与展示验证分别保留证据。
