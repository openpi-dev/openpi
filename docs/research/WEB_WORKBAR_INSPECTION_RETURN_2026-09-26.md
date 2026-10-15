# Web 工作栏：检查与返回

- Status: validated
- Created: 2026-09-26
- Verified: 2026-09-26（冻结源码、完整检查/测试及隔离 Web 预览；不代表生产部署）
- Source boundary: OpenPI PR #598，基于 `d364bc3` 的本轮工作树；Pi SDK 0.85.1；下列冻结参考
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none；补充既有交互记录，不改写此前结果，不采用新的项目约束

## 参考事实与限制

Maka checkout `5b9db1ce8fdb83f0841cfd058084abe143847348`、Pi Web checkout `a345b2ac363b644d5ef43b1da75b9bc53cd055c4` 均只读核对，没有在本轮启动参考产品。

- Maka [artifact-pane.tsx](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/apps/desktop/src/renderer/features/workbar/tools/artifacts/artifact-pane.tsx)：预览 Escape 返回保留选择的列表，列表 Escape 才收起；内部菜单拥有自己的按键。源码未证明列表滚动恢复。
- Maka [session-terminal-panel.tsx](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/apps/desktop/src/renderer/features/workbar/tools/terminal/session-terminal-panel.tsx) 与 Pi Web `pi-web-plugins/terminal/terminalKeys.ts`：终端输入送入所属 PTY，Pi Web 显式将 Escape 映射为 `\x1b`。外层检查面板不能把终端输入当关闭命令。
- Maka `use-workbar-controller.ts` 关闭 terminal tab 会停止 terminal；这不同于收起检查面板。OpenPI 不复制这个副作用，仍由现有 Pi 资源生命周期管理 PTY。
- Pi Web `FilesPanel.ts`、`git-panel.ts` 为并列列表与预览，未见这些组件统一声明 Escape dismiss；不能宣称所有参考产品采用同一种导航。
- 本机 Codex 访问重试仍被工具拒绝：`Computer Use is not allowed to use the app 'com.openai.codex' for safety reasons.` 工具没有给出具体规则来源；没有 Codex 本机窗口交互实测，不推断为 macOS 权限问题，不绕过限制。此前 Codex 队列源码与用户截图证据见[排队消息记录](WEB_QUEUED_COMPOSER_2026-09-26.md)。

以下选择是 OpenPI 的设计与验证，不是逐项产品对等声明。

## 交互与实现

1. **由最内层处理按键。** Diff 的第一次 Escape 只返回原文件行和滚动位置；列表中的 Escape 交给 Workbar 收起并回到原入口。终端输入 Escape 仍由 xterm 发送给 PTY；工具栏 Escape 可以收起。已消费事件、输入法 composition 不触发外层关闭。
2. **刷新是现有检查的动作。** Git 列表、空状态和 diff 共用小型范围/刷新工具栏；加载禁重复操作，失败仍显示可检查的旧内容和错误。单文件读取结果和错误按 source/path/revision 隔离；自动快照变化不会抢 Composer 焦点。保持原有轮询调度。
3. **预览返回来源。** Files 在预览期间保持原列表与按钮挂载；鼠标打开显式提供来源按钮。预览内继续打开链接不替换第一来源。关闭后先提交界面，再恢复仍连接、可见且属于原上下文的来源焦点；失效的焦点请求被取消。Refresh 不重新申请焦点。
4. **导航不同于返回。** 顶部 Tools 关闭预览并恢复上一工具；明确选择另一个工具则撤销历史 Files 返回意图。显式导航不触发旧预览的延迟焦点恢复，不同时展示两个检查面板。
5. **上下文撤销优先。** Artifact UI 同时检查 Session id/path，Session 切换或进入工作区草稿时立即撤销预览。关闭仍区分 user/context；context 不重开旧 Files、不恢复旧焦点。已取得及迟到取得的 grant 都沿用原 Session 释放。

权限与展示分开：Files 记录可以供后台会话读者检查；实际文件内容仍通过现有、绑定当前 runtime 的 ArtifactReader 和单文件只读授权读取，HTML/SVG 不执行。没有增加背景会话实时文件读取权限、控制权获取、队列/调度 API、数据库或另一套导航框架。

## 验证边界

- 定向组件回归覆盖真实 Workbar 祖先、原列表/按钮/滚动容器、嵌套文件链接、Tools 导航互斥、相同 ID 不同路径、Session switching、IME/已消费 Escape、grant 释放与迟到结果。
- 终端组件测试证明 Escape 仍进入现有输入队列，Workbar 不关闭；卸载不调用停止 PTY。不是本轮真实 PTY 应用验收。
- 本机隔离预览 `http://127.0.0.1:57162/`：桌面实际 diff 第一次 Escape 返回原行，第二次收起并返回 Tools。`1280x900` 与 `390x844` 截图核对工具栏和 diff；移动端 document width 为 390、刷新按钮右边界 380，无页面横向溢出；列表刷新从 12 项读取到当前 18 项变更。恢复默认视口。
- 当前空白隔离 Session 没有生成文件，Files 返回以真实 App 组件回归验证；未声称真实模型生成文件或外部授权验收。浏览器观察保留于当前任务，不作为正式 Benchmark。
- 开始诊断前已核对 README 开发运行时规则、checkout `d364bc3` 与隔离 agent 的 `pi list`：唯一 OpenPI 为当前 PR worktree。常驻 `57161` 未更新或重启，私有配置与 Session 不提交 Git。
- 完整 `bun run check` 通过，保留原 bundle-size 警告。完整 `bun run test` 通过：Node 1956 通过、5 跳过；Vitest 566/566。最终日志为 `/private/tmp/openpi-pr598-workbar-check-complete-20260926.log`、`/private/tmp/openpi-pr598-workbar-tests-complete-20260926.log`，不提交 Git。
- 首轮完整验证暴露 UI 库不接受 title 属性、测试夹具类型错误以及旧测试同步 focus 假设；改用既有原生 icon-button，修正夹具类型、等待真实 RAF，并共用 jsdom 显式可见性夹具。没有修改生产行为去迁就旧断言，没有固定等待。初次失败日志仍留在 `/private/tmp/`；按用户要求没有运行 E2E。

## 消融

- 临时移除 Review 返回时的 scrollTop 恢复，真实 Workbar 测试从期望 112 得到 0；恢复后通过。
- 将预览关闭后的焦点恢复改回同步调用，隐藏来源测试失败；恢复提交后的可取消 RAF 后通过。
- 删除 App 返回意图中额外复制的 Session 身份，保留 `files` 意图。身份继续由 ArtifactProvider 的 id/path scope 和 App 已有 workbarBound 校验承担，不建立第三份身份来源；跨路径、切换和嵌套返回回归验证此精简。

## 尚未完成

Session 的草稿、图片与阅读位置恢复，以及其他 Web 细节仍在 #597 内继续迭代。本记录不是 Web 体验整体完成、生产部署、Safari 或全部 IME 验收的声明。
