# PR #561 使用测试与五项交互修复

- 状态：validated（限下述源码、组件、Host、Chromium 与真实模型验证；不是 Benchmark 或设计 Decision）。
- 创建 / 验证日期：2026-09-20。
- 源码边界：PR #561 head `089d3d48d5df80adcaf3a7a9d8b2bbd6a2d5de18`，修复分支 `codex/pr-561-usage-fixes`。
- 关联讨论：[Issue #559](https://github.com/openpi-dev/openpi/issues/559)、[Issue #560](https://github.com/openpi-dev/openpi/issues/560)；原始 [PR #561](https://github.com/openpi-dev/openpi/pull/561)。合并后的持续优化由 [Issue #597](https://github.com/openpi-dev/openpi/issues/597) 跟踪。
- Supersedes：none；补充此前体验记录，不改写历史结论。
- 后续提交：[PR #598](https://github.com/openpi-dev/openpi/pull/598) 将本轮与第二轮修复合并到一个 PR。

## 运行来源

原工作区存在大量用户修改，因此从 PR head 创建独立 worktree。使用 Node 24.20.0、Bun 1.4.2 和 frozen lockfile 安装依赖。隔离 `PI_CODING_AGENT_DIR` 中 `pi list` 的唯一 OpenPI 来源是此次修复的独立 checkout，完整本地路径保存在私有 provenance receipt。没有改写原工作区、全局 Pi 安装或既有 Codex 配置。

测试实例从该 worktree 的 `bin/openpi.js` 启动，提供真实生产静态产物。按本地 Codex 配置接入 loopback Responses 服务，使用 `gpt-6-astra` / `high`，保留普通模型工具。凭据仅存于仓库外隔离配置，文件权限 0600，不进入本文或测试夹具。

## 已验证的问题与修复

| 问题 | 修复前证据 | 修复与验收 |
| --- | --- | --- |
| 图片未读完就允许发送 | 延迟 `File.arrayBuffer()`，输入文字后发送按钮仍可用。发送代码没有导入锁，会提交不含待导入图片的草稿。 | 所有提交路径共用导入锁，按钮同步禁用；Enter 不提交，图片就绪后原文字和图片一起发送。 |
| 图片越过会话边界 | 会话 A 选图，读取完成前切到 B；旧读取完成后 B 的空草稿获得图片并启用发送。可控 Promise 组件测试复现，不声称普通磁盘读速下每次可手工触发。 | 读取以独立身份归属于当前草稿，切换或卸载后旧结果、错误和 finally 均不能影响新草稿。另验证 A → B → A 和新旧读取重叠。 |
| 内嵌浏览器无法粘贴 | 实际点击本地网页输入框，粘贴 `PASTE_中文_561` 后内容仍是原来的 `replace me`。 | 明确的文本动作经现有认证、活动 Session 检查和串行 CDP 生命周期送入 `Input.insertText`；实机输入框显示完整中文文本。每次限制 16,384 个 UTF-16 code units，超限显式提示且不截断发送。 |
| Shift 修饰键丢失 | 实际 Tab 后再 Shift+Tab，焦点继续前移到链接；页面键盘日志显示 `shift=false`。 | key down/up 传递 Shift 位，Host 验证 modifiers 范围；实机 Shift+Tab 回到第一输入框，页面日志显示 `shift=true`。 |
| 分栏只能用指针调整 | 实际页面两个手柄均为 `aria-hidden=true`、`tabIndex=-1`，没有可访问角色。 | 使用带名称、范围和当前值的可聚焦 separator。方向键按屏幕方向移动，Home/End 到边界，Enter 复位；实机左侧 280→296、右侧 520→536。保留拖动、阈值收起和恢复行为。 |

浏览器普通字母与 Shift 选择继续走已有键盘动作；本轮未宣称完整支持 IME、跨应用剪切/复制或所有系统快捷键。图片异步竞态的确定性证据来自组件测试；真实模型测试只证明普通文字与工具链路，不冒充图像理解验收。

## 验证与消融

- 新增回归在 PR 原始实现上：6 条失败，8 条既有用例通过（左右手柄各一条断言）。
- 修复后的专项组件测试：通过；新增 A → B → A 与交错导入覆盖。
- Host 专项：41 / 41 通过，覆盖文本与 Shift 动作、空值/超限/错误类型、非法修饰键、过期 Session 拒绝。
- `bun run check`：通过。
- `bun run test`：Node 1696 passed / 1 platform skip / 0 failed；Vitest 300 / 300 passed。
- 最终 `bun run test:web:e2e`：50 / 50 通过，含图片发送、真实 PTY、桌面/移动布局、键盘分栏、指针收起/恢复和 accessibility。首轮 4 条 accessibility 检查曾发现新增可聚焦手柄位于 landmark 外；最终将手柄归入命名面板调整区域，保留顶层 main，没有关闭或削弱 axe 规则。
- 真实模型：修复前 `bash` 返回 `OPENPI_561_LIVE_OK`；重建、重启后返回 `OPENPI_561_FIXED_OK`，页面均显示完成。
- 消融：移除仅用于本地取消标记的 `AbortController`，改用单一导入身份；原 14 条专项测试仍通过，因此保留更小实现。没有引入通用上传管理器、额外状态机、配置项或常驻模型工具。

新增逻辑归属现有 React 草稿生命周期、WebHost 输入验证和 Session-bound CDP 服务。Pi Session、权限、模型选择与工具执行事实仍由原有层拥有。

本地证据身份：`openpi-pr561-usage-20260920`，日志位于 `~/.local/state/openpi-pr561-usage-20260920/`，最终凭据为 `check-final.log`、`test-verified.log`、`e2e-verified.log`。`before-tests.log`、`ablation.log`、`host-tests.log` 和早期 `e2e*.log` 保留失败与消融过程。`provenance.json` 记录最终源码提交、加载来源和最终日志摘要哈希。其中隔离模型配置、凭据与 Session 为私有原始证据，不发布；公共可复现证据是仓库测试及本次代码差异。

## 局限

真实桌面测试使用本机 Chromium，自动化还覆盖已有移动布局与 accessibility 用例；未验证 Safari、手机软键盘、IME 组合输入、真实屏幕阅读器或长期断线。构建仍有原有的大于 500 kB chunk 提示。本轮只处理上述五项，不代表整个 PR 已无其他体验问题。
