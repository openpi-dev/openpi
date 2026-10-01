# DSH 输入区参考与压缩期间排队

- Status: validated
- Created: 2026-09-29
- Verified: 2026-09-29，源码核对与本机 Chromium fixture；完整门禁结果见下方
- Source boundary: PR #598，基于 `295edfe`，合入工作区侧栏 `4ecc5a3`；Pi SDK 0.85.1
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: 仅替代 [Web 显示设置记录](WEB_DISPLAY_SETTINGS_2026-09-29.md) 中压缩期间禁止发送的交互；保留此前实验和验证的历史边界

## 源码事实与本次选择

用户接受压缩期间先排队、后投递的设计，要求输入区参考 DSH，移除独立的运行状态和凭据图标，不加入权限、下载日志、反馈入口。

DSH better-sidebar `9b5834f74ad197534c821c35b8357edac1ad3919` 是插件，截图中的完整输入菜单来自宿主。核对 [deepseek-harness presentation.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-commands/src/client/presentation.ts)、同目录 `locales.ts` 以及 [MenuView](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-input-trigger/src/client/MenuView.tsx) 和其样式：菜单位于输入区上方、与输入区同宽，分“添加”和“指令”，行内包含图标、标签、命令别名、右侧说明。这里是冻结源码研究，不是运行 DSH 的性能测量，也没有复制其框架。

[Pi Web PromptEditor](https://github.com/jmfederico/pi-web/blob/dd771618a9aa6df789539d692870e9b798266b0a/src/client/src/components/PromptEditor.ts) 与服务端 `piSessionService.ts` 在压缩期间接受排队输入，压缩结束后再调用原生 prompt。OpenPI 采用排队而非禁用输入，但失败和取消后保留消息等待明确重试，不照搬参考实现的失败后自动投递。

## 实现与事实边界

输入区保留工作区短名称、模型和思考级别，移除长会话面包屑及两个独立图标。“添加”包含文件、目标、计划；“指令”包含压缩、模型。文件子菜单复用图片上传与工作区引用；目标只填入 `/goal `，不覆盖已有草稿、不自动发送；计划复用原有控制接口，模型打开原有选择器。菜单支持箭头、Home/End、Escape、Tab、点击外部关闭；小屏换行、可滚动高度和 44px 行高不改变功能。设置页和模型设置仍承接原来的配置功能。

Web 当前用 Pi print 绑定扩展。目标命令改用现有的精确 Session Web feedback 桥输出结果；目标自动续行仅在原生交互模式或该 Session 仍附着 Web host 时允许。普通 print/json 不增加自动运行。用户显式提交目标才开始任务；换会话或关闭 host 后不通过 Web 例外调度新的目标续行，已开始的原生运行仍由原有生命周期管理。回到会话可用 `/goal resume`。原生 `edit` 和替换确认仍要求交互 UI，Web 可先明确 `/goal clear` 后重新设置；此菜单不是完整目标编辑器。

压缩等待队列按原生 runtime 保存完整文本、图片和请求身份，最多 16 条、合计 16 MiB；不生成新的持久化消息或压缩摘要。HTTP 确认接收后前端才清空原草稿，队列单独显示等待气泡。原生压缩结束后，经既有串行 admission 调用 `session.prompt`，忙碌时使用 Pi followUp；不绕过输入 hook、命令边界或原生 preflight。只有已接收的压缩队列允许投递到保留的原会话 runtime；普通未接收请求在切换会话后仍拒绝。后台队列中的扩展命令保留待重试，避免在缺失当前 Web 对话能力时静默执行。

压缩失败、取消、后续 admission 失败保留消息；重试/清空接口均验证认证、Origin 和精确当前 Session ID + 路径，拒绝额外字段。清空发送相关 discard 事件，只移除对应本地预览，不删除原生历史。人工压缩复用 Pi `compact()`，仅空闲、无待投递消息时可启动。队列属于进程内资源：刷新页面可从快照恢复，重启服务器不承诺恢复尚未投递的消息；不引入第二套持久化队列。

## 验证与消融

已验证原生队列 FIFO、附件保留、跨会话归属、拒绝普通过期 admission、失败后重试、清空、容量、精确 ID/路径和手动压缩生命周期；Host 接口测试独立验证认证、字段校验与错误状态。真正的 Pi Session + faux provider 验证 Web print 绑定下 `/goal` 能加载目标工具、执行续行并完成，未调用外部模型。

页面 Chromium fixture 验证 1450×1000、390×844、390×460，以及 390×330 的可视区域限制；浅色/深色、键盘焦点、文件子菜单、目标草稿、模型入口、手动压缩请求、压缩中发送确认、拒绝时保留草稿、失败队列清空均通过。快照/HTTP fixture 与原生运行时测试分开，不宣称是新的真实 256K 模型压缩实验；此前真实实验结果继续保留。

消融删除了不再使用的面包屑样式和独立菜单入口。临时去掉压缩消息保留机制，定向测试复现原生拒绝；恢复后通过。页面临时移除菜单高度限制，小高度窗口顶部越界 100px；恢复约束后可完整滚动访问。因此保留这两个有直接验收证据的机制。

私有证据：`/Users/admin/Documents/ChatGPT/openpi-evidence/direct-settings-20260929/` 中 `dsh-composer-smoke.mjs`、`dsh-composer-smoke.json`、`dsh-queue-ablation.log` 及对应截图。原始 Session、配置和凭据不提交。

合入 `4ecc5a3` 侧栏后，完整 `bun run check` 和 `bun run test` 通过：Node 2014 通过、8 跳过，Vitest 856 通过。检查保留既有的大 bundle 提示。最终页面 fixture 零异常；另外重启隔离源码 runtime 后，通过真实 HTTP 提交 `/goal` 状态命令，验证原生反馈可见、会话仍空闲且未开始模型运行。该检查不创建目标，也不替代上面的 faux provider 续行验证。
