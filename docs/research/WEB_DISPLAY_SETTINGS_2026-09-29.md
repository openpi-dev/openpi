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
