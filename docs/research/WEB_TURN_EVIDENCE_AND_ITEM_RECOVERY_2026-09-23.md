# Web 逐轮变更与历史条目恢复

- Status: validated locally; PR CI pending
- Created: 2026-09-23
- Verified: 2026-09-23（完整本地检查、单测与 Chromium 67/67；提交后 CI 待确认）
- Source boundary: PR #598 的 `codex/web-ux-597` 工作树，基线 `250731f`；Pi SDK 0.85.1
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none；补充[历史阅读与生命周期](WEB_READING_AND_LIFECYCLE_2026-09-22.md)和[Git 比较身份](WEB_GIT_REVIEW_IDENTITY_2026-09-23.md)

## 参考与问题边界

Codex 的公开 App Server 协议把按游标读取轮次与按需读取条目分开：[`thread/turns/list`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) 的 `nextCursor` 继续向前读取，`itemsView` 可选择摘要或完整条目；[`thread/items/list`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) 按条目读取。其 [`turn/diff/updated`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) 带轮次 ID 和聚合 diff。公开代码不包含 Codex 桌面端的 React 展示实现；本次卡片位置、三行预览及显式加载入口以用户截图为视觉参考，不声称复用了桌面组件。

OpenPI 原有 Web 快照每次最多投影 250 个 Pi Session 条目及 2 MiB；单条正文最多 12,000 字符和 64 段。旧的“加载更早的消息”只能取得更早的**条目**，不能恢复已经截断的**同一条消息正文**。因此“已到会话开头”和全局截断警告可以同时出现，却没有正文恢复操作。输入框的累计 Git 文件气泡也把发送前已经存在的脏文件算在当前对话旁边，不能表达某一轮的修改。

## 实现判断

- 历史页继续基于 Pi `SessionManager.getBranch()` 和原生条目 ID；超过 20 个用户回合的普通页对齐用户消息，同时保留 250 条/2 MiB 上限。未超过轮数上限的现有前序条目不额外裁掉，供新消息与本地发送锚点对齐。单轮超过预算时仍分段，不能跳过原生条目。客户端按 ID 去重、保留滚动锚点并在分支变化时拒绝迟到页。
- 可见用户/助手正文被截断时，用户显式触发 `/api/session/item`，以精确 Session ID、文件路径、原生条目 ID 及字符游标每次读取最多 32,000 字符。服务端只读当前 Pi 分支上的用户/助手正文或原生命令输入；工具结果不由此接口批量展开。跨 Session、跨文件或旧分支条目失败关闭。完整内容不进入常驻快照；隐藏工具输出的截断也不再生成全局会话警告。
- Web 专用 Pi extension factory 在原生用户 `message_start` 前等待隔离 Git 基线，遇到下一条用户消息或 `agent_settled` 时比较并保存有界 `openpi-web-turn-changes` 自定义条目。身份是持久化用户消息的原生 entry ID，不是渲染轮次序号；记录只投影路径和计数摘要，点击审阅再按同一分支读取持久化的 diff。既有右侧 Git 审阅工具仍用于当前工作树的未暂存、暂存、分支及会话基线范围。
- 逐轮比较是**该轮期间的工作区时间差**，不证明具体由 agent 写入；并发的外部文件修改可能包含在内。基线最多 64 MiB，记录最多 200 个文件/256 KiB。基线不可用与确认零修改分别持久化为 `unavailable` 和 `complete` + 0；超限使用 `partial`、未知总数和截断说明。旧 Session 没有逐轮记录，不按当前 Git 状态回填；不提供无可靠逆补丁依据的 Undo 操作。

## 验证与剩余风险

专项测试覆盖 205 个预存脏文件不归入后续回合、连续用户消息、重载后的原生 ID、零修改、非 Git/仓库切换、超限记录、超长正文与超过 64 段的恢复、复制 JSONL 同 ID 的文件身份、分页无漏条及 HTTP 认证。真实 Chromium 的桌面/窄屏夹具验证逐轮卡片和按需恢复；旧历史窗口发送新消息与后台观察者中的原生/本地消息去重也通过 3/3 专项浏览器回归。它使用原生 SessionManager + WebHost 测试宿主，不等于真实模型的文件修改可靠性测量。

本地最终版本 `bun run check` 通过；`bun run test` 为 Node 1948 通过、5 跳过、Vitest 498 通过；生产构建的完整 Chromium 回归 67/67 通过。此前完整浏览器运行先后出现右键 `mouseup` 超时，以及文件引用弹窗在 390px 宽度入场动画中途被 axe 取样而颜色对比度不足；两条各自单独复跑曾通过。文件引用说明文字现在使用更高对比度，弹窗可访问性检查等待 opacity 到 1，与同套件其他弹窗检查一致。最终整套 67/67 在该修复后实际通过；提交后 CI 与常驻 57161 进程仍未由此验证，57161 未重启。

## 消融

逐文件差异原本还要发起第二次详情读取；去掉该请求后，单轮卡片、选中文件、错误状态与桌面/窄屏浏览器验证仍通过，因此保留更小的单次详情读取。最初按“窗口中第一个用户消息”无条件裁去所有前序条目，导致本地已接收消息的原生锚点消失，完整浏览器回归出现重复气泡；保留未超过 20 轮上限的前序条目后恢复。对于确实被字节限制裁掉的锚点，只有原生 `parentId` 精确匹配才确认本地发送；反例测试仍保留无法证明归属的同文消息。旧阅读窗口中本地发送与实时用户事件重叠时，每条未确认本地输入最多压住一条实时回显；额外同文事件保留，且不会将回显当作提交回执。

当前仍不能从 Git 时间差区分同一工作树中的其他写入者；非 Git 或超过基线额度时无法给出准确逐轮差异。全文恢复限定用户/助手可见正文，工具原始输出仍使用既有有界证据与恢复引用。不可把专项验证或本地构建当作常驻 57161 的部署证据。
