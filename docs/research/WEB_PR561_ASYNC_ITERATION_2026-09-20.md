# PR #561 第二轮：异步取消、会话边界与编辑焦点

- 状态：validated（限下述源码、组件、runtime、Chromium 与真实模型验证；不是 Benchmark 或新的设计 Decision）。
- 创建 / 验证日期：2026-09-20。
- 源码边界：第一轮修复 `2ea045f290b0df4217a730a61948e8160714620b`，分支 `codex/pr-561-usage-fixes`，在同一独立 worktree 上继续。
- 关联：[Issue #559](https://github.com/openpi-dev/openpi/issues/559)、[Issue #560](https://github.com/openpi-dev/openpi/issues/560)、原始 [PR #561](https://github.com/openpi-dev/openpi/pull/561)。合并后的持续优化由 [Issue #597](https://github.com/openpi-dev/openpi/issues/597) 跟踪。
- Supersedes：none；补充[第一轮记录](WEB_PR561_USAGE_ITERATION_2026-09-20.md)，保留其历史验证范围。
- 后续提交：[PR #598](https://github.com/openpi-dev/openpi/pull/598) 将前两轮修复合并提交。

## 运行与证据边界

先核对 README 运行时来源约定、干净的 `2ea045f` checkout 及隔离 `pi list`。唯一 OpenPI 来源仍为此次修复的独立 checkout，完整本地路径保存在私有 provenance receipt。真实服务和正式 `web/dist/` 均来自该 worktree；修改后重建并重启后端。沿用 Node 24.20.0、Bun 1.4.2，以及仓库外的本地 Responses provider、`gpt-6-astra` / `high` 配置。

测试工作区为仓库外的人工夹具。将该目录初始化为独立 Git 仓库，然后在新 Web Session 中让真实模型通过普通 `write` 工具创建 `round2-note.txt`。没有修改用户原工作区、全局安装、已有密钥或模型配置。

## 五类已复现问题

| 问题 | 证据 | 修复边界 |
| --- | --- | --- |
| Git 变更串到新会话 | 组件复现 A 已有结果后切到 B，B 请求失败仍保留 A 的文件；A 的迟到返回还能在 B 的 200ms debounce 窗口内更新结果。 | 用稳定 Session id/path 作为目标；切换前清空旧投影，清理时立即中止旧请求，完成、错误与 finally 都检查取消状态。 |
| Diff 刷新抢走输入焦点 | 真实页面打开 `round2-note.txt` 的差异，在主输入框输入未发送草稿；模型轮次引发刷新后，焦点从输入框跳到差异区域。组件测试同样复现。 | 焦点跟随选中文件路径的改变，而不跟随每次网络响应中新建的文件对象。浏览器回归确认刷新后还能继续输入，草稿保留。 |
| 终端停止后继续发送排队输入 | 用可控 Promise 阻塞首个输入，排队第二条命令，再分别触发首条失败、组件卸载或输出流断开。旧实现仍发送第二条命令。 | 队列在每次实际派发前检查连接、终止和卸载状态。已发出的请求不冒充可撤销，未发出的命令不自动重放。 |
| 已取消的终端创建仍会启动 PTY | Runtime 测试分别在排队和加载阶段调用 dispose、切换 Session、切换工作目录；旧实现仍调用 spawn。 | pending create 归属精确创建请求，清理撤销其身份；开始创建及异步加载后、spawn 前再次检查。容量预留按独立请求标识释放，取消请求不能清掉较新请求的预留。dispose 后仍可为后续活动 Session 正常创建终端。 |
| 文件引用校验不能完整取消 | 校验时“取消”按钮禁用；Session 改变或组件卸载不会中止请求，迟到的成功返回仍可调用旧的插入回调。 | 校验中保留取消按钮；关闭、卸载与 Session 改变均取消请求。迟到返回不插入引用，并释放已取得的 artifact handle；旧 finally 不清除新请求身份。 |

后三类时间窗口以确定性组件 / runtime 测试为主要证据，不宣称人工点击可每次稳定触发。终端测试不使用真实危险命令，也不把已派发命令的网络失败解释为“远端未执行”。

## 验证与消融

- 修改前新增 9 条组件断言、6 条 runtime 断言失败；另一个原有快速交互用例暴露菜单 next-frame 焦点尚未就绪的测试同步问题。该用例改为等待 Astryx 菜单焦点就绪后选择，不改变产品焦点代码来迎合测试。
- 专项：4 个组件文件 25 / 25 通过，PTY runtime 8 / 8 通过。
- 新增正式浏览器专项：diff 刷新保持草稿焦点、文件校验期间取消，2 / 2 通过。
- `bun run check`：通过。
- `bun run test`：Node 1702 passed / 1 platform skip / 0 failed；Vitest 309 / 309 passed。
- 完整 `bun run test:web:e2e`：52 / 52 通过，包括新增两项回归和既有桌面 / 移动端 / accessibility 检查。
- 消融：删除 Git review 中与请求 AbortSignal 重复的 generation 计数器，保留已有请求取消机制；25 条专项仍通过，因此保留简化实现。没有新增通用异步任务管理器、重试框架、用户配置项或模型工具。

真实模型在修复前成功创建文件并回复 `ROUND2_FOCUS_TEST`。修复后首次请求遇到本地网关 `gateway_concurrency_limit`；页面显示失败，草稿及输入焦点保留。重试成功返回 `ROUND2_FIXED_FOCUS`，刷新后焦点仍在原输入框。真实 PTY 返回 `ROUND2_TERMINAL_OK`，退出显示状态码 0；点击重新启动后返回 `ROUND2_RESTART_OK`，再次正常退出。网关限流属于本地服务状态，未计入五类产品问题。

本地证据身份为 `openpi-pr561-usage-20260920/round2`，在 `~/.local/state/openpi-pr561-usage-20260920/round2/` 保留 `before-ui.log`、`before-runtime.log`、`after-runtime.log`、`ablation-final.log`、`check-final.log`、`test.log`、`targeted-e2e.log`、`e2e.log`。`provenance.json` 记录最终提交、加载来源与日志摘要哈希。这些不是公开 Benchmark 原始数据；配置、认证与私有 Session 不入库。

未验证 Safari、真实屏幕阅读器、手机输入法或长期断线。编译仍有既有的 >500 kB bundle 提示。本轮保证限定在上述生命周期和交互边界。

## 合并后整合范围

2026-09-20，PR #561 的最终 head `c2f5b10` 已补入 PTY 创建取消修复，并通过 `45f12a4` 合并到 main。为 Issue #597 准备后续 PR 时，从该 main 建立 `codex/web-ux-597`，保留其 `InteractiveTerminalManager` 实现，只增加本轮的六条取消边界回归。本记录表格保留原始发现与当时验证的历史事实；后续 PR 的新增修复范围因此为其余九类问题，不能将上游已合并的实现再次算作新增贡献。

整合后在 `45f12a4` main 加本轮修复上重新验证：`bun run check` 通过；`bun run test` 为 Node 1703 passed / 1 platform skip / 0 failed，Vitest 309 / 309；Chromium 端到端 52 / 52。日志另存于原本地证据目录下的 `publish-597/`。此前真实模型、真实 PTY 和界面观察仍只证明上文明确标出的原验证版本，不能替代新基线的人工验证。
