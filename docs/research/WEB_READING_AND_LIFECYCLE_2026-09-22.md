# Web 历史阅读、正文排版与异步面板

- Status: validated
- Created: 2026-09-22
- Verified: 2026-09-22（完整本地门禁、真实 SDK 与 Chromium；未部署）
- Source boundary: OpenPI `fbf15d2` + PR #598 后续变更，Pi SDK 0.85.1
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none；补充[第五轮](WEB_INTERACTION_ROUND5_2026-09-22.md)

## 已复现的问题

- 自建原生 Session 从 63 条增长到 264 条后，接口只返回尾部 250 条，最初用户消息缺失；124 条大输出也触发 2 MiB 截断。页面没有历史加载入口。
- 正文列表编号被基础样式清除，长文件路径占据正文并居中折行。新正文样式保持字号配置和执行过程设计，桌面与窄屏复测通过。
- 侧边对话 A 发送回执迟到时，覆盖用户已经切到 B 的导航和草稿。
- 用户已回主输入框，终端连接或重启结束后仍抢走焦点。
- 文件预览因设置或 Session 变化自动关闭，但外层面板状态没有清除。
- 浏览器被信号终止时只检查 exitCode，等待满 8 秒后误报超时；spawn 权限错误也没有正确接收。SIGTERM/EACCES 两项真实子进程修复验证通过。
- 背景任务切走后只在最终结束时发送进度，页面又混用了另一当前会话的 idle；返回原会话还会丢失计时/取消身份。现在按原生 Session owner 保存现有 trace，后台边界事件限频更新，输入控制与所看会话的状态分开。
- 同文 native 消息会一次删除多个待处理输入；历史已有同文内容或记录滑出窗口时，输入也可能消失或重新出现在末尾。现在区分准入与展示关联、保存作用域和发送时间，并保守保留 Pi 仍在排队的消息。
- 复制 JSONL 保留同一个 ID 时，界面可能显示另一文件的停止/设置控件。控制校验现在同时使用 Pi 当前 ID 和文件路径；旁观视图有显式激活入口。
- 运行中只显示 Stop，无法通过鼠标发送追加消息；旁观时还显示了另一会话的模型及旧排队回执。现在有草稿时可分别选择发送或停止，旁观隐藏这些控制者信息。

## 实现与验证边界

历史分页复用 Pi 原生 Session 分支 ancestry，不新增持久会话存储或服务端分支缓存。单页及客户端阅读窗口有界，默认跟随最新时不积累整个历史。prepend 后保持阅读锚点，Session 或分支改变时不混入旧页。

侧边三类问题的五项基线回归失败，修复后专项通过；移除导航代际检查再次复现错误回跳。导航不会取消已提交后台任务，上下文关闭不会恢复旧焦点或返回旧工具。

最终本地门禁：`bun run check` 通过；Node 1869 passed / 1 Windows-only skip；Vitest 459 passed；生产构建 Chromium 65/65 passed。真实历史用例包括找回最初问题、加载前后锚点偏移不超过 2px、流式追加、发送后回最新和迟到旧分支页拒绝。旁观用例通过真实 SDK/HTTP 验证发送按钮与 Enter、A/B 隔离、回到 A 后停止仅影响 A，以及界面最终退出运行状态。faux provider 不发送真实模型请求，这些结果不是模型能力或通用性能 Benchmark。

PR `fbf15d2` 的 Node 22/24/26 与 Windows CI 通过，Web E2E 60/61，失败为嵌入 Chromium 启动超时。原日志没有退出信号或 stderr，因此不能认定 AppArmor 是唯一原因。Linux CI 改用 runner 已安装 Chrome，保留原生 sandbox；新 CI 尚待验证。依据见 [Chromium 官方说明](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md)与 [runner 软件清单](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)。

用户“卡住”反馈的只读证据有两层：Git 拉取先在 240 秒后超时，后续两次约 75 秒后报告连接 GitHub 失败；后台仍消费后续消息并写入新工具结果。事件环则在两次会话切换后停止更新该后台任务。常驻 LaunchAgent 未显式配置工具 shell 所使用的代理，这与连接失败相关，但仅凭 plist 不能证明完整进程环境。没有修改该实例的代理、Git 配置或运行进程。

真实 SDK + WebHost + Chromium 的旁观用例已验证：A 工具挂起期间激活 B，A 页面仍保留自身消息、排队数及耗时；B 的同文输入不会混入 A；重新控制 A 后停止仅影响 A，B 继续运行。原始日志、截图及 SDK 调查保存在私有 `openpi-pr561-usage-20260920/round6-20260922`，manifest 记录文件名、大小及 SHA-256；没有发布凭据或用户 Session。用户 57161 常驻版本保持不变。

## 展示关联与原生事实

Pi SDK 0.85.1 的 UserMessage 没有请求 ID，message_end 先通知监听器，再追加到 Session。真实 SDK 反例中，外部原生同文 follow-up 先于 Web B/C 入队，按 Web trace FIFO 推断送达会把外部记录错误关联给 B。因此本轮没有发布伪 `prompt_delivered`，也没有包装 SDK 公共方法或加入新的调用上下文框架。

UI 只有在明确准入后才尝试合并重复展示，原生排队数量作为保留消息的下限；原生文本块与普通文本统一比较，图片身份不弱化成仅 MIME。展示关联只用于防止重复/回漂和释放本地临时数据，不作为模型执行、配置保存或磁盘落盘的证明。额外原生输入造成关联不明确时保守保留展示；更强的逐请求消息关联需要 SDK 提供创建消息时的正式扩展点，这只是调查建议，不是已采纳约束。
