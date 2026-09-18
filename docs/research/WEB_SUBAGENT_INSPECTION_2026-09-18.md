# Web 子代理：从启动回执到可查看的子对话

- Status: validated（限下述源码、确定性测试与真实模型体验边界）；不是性能 Benchmark。
- Created / verified: 2026-09-18。
- Source boundary: main `f6b49ae59605b1276b8267f2886d22c03f01533c`，前一批修复 `e48f2e1`，分支 `codex/web-experience-five-fixes`。
- Related: [Issue #560](https://github.com/openpi-dev/openpi/issues/560)；[前一批 5 个交互修复](WEB_EXPERIENCE_FIVE_FIXES_2026-09-18.md) / [#559](https://github.com/openpi-dev/openpi/issues/559)。PR 尚未创建。
- Supersedes: none。本文不是新增的项目架构约束。

## 用户实际遇到的问题

`subagent_spawn` 的成功回执被当作 completed 展示；子任务还在执行时，卡片已经有绿色完成标记。卡片展开的只是工具返回文本，活动栏子代理标签也不可进入。用户无法像查看一个独立任务那样浏览子 agent 的消息、工具和最终结果。

用户提供了 Codex 的任务总览与子对话截图，并要求参考 Pi Web、ZCode、Maka 的代码和组件。最终交互采用“分组总览 → 子对话 → 返回总览”：宽屏在父对话旁展开，窄屏切换为独立主视图，保留父对话和输入状态。没有全局遮罩，也没有把关闭面板解释为取消任务。

## 参考来源与真正复用的内容

| 来源 | 固定边界与观察 | 本次采用 |
| --- | --- | --- |
| Pi Web | `a345b2ac363b644d5ef43b1da75b9bc53cd055c4`，[WorkspacePanel](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/components/WorkspacePanel.ts)、`scrollWhenSelected.ts`：独立内容区域、清晰的选择导航、选中项可见性。实现为 Lit。 | 借鉴导航与内容区分离；不引入 Lit 或其运行系统。 |
| Apache Maka | `5b9db1ce8fdb83f0841cfd058084abe143847348`，[tool-activity.tsx](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/packages/ui/src/tool-activity.tsx#L425) 的 LinkedAgentList 使用 Astryx List/ListItem/StatusDot；[titlebar-session-identity.tsx](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/packages/ui/src/titlebar-session-identity.tsx#L93) 有父子返回导航。 | 直接复用 OpenPI **已安装的** Astryx 0.5.2 `List`、`ListItem`、`StatusDot`，包含键盘点击、语义状态和 reduced-motion 支持；借鉴紧凑任务行和返回方式。 |
| Maka 子会话契约 | [subagent-sessions.stories.tsx](https://github.com/apache/maka/blob/5b9db1ce8fdb83f0841cfd058084abe143847348/apps/desktop/stories/subagent-sessions.stories.tsx#L21) 实际采用链接子会话行并切换主聊天列。 | 不宣称 Maka 子代理使用右侧抽屉；宽屏并列是本项目结合用户工作台截图的适配。 |
| Codex | 用户提供的 2026-09-18 截图：运行/完成分组总览、子任务独立对话、返回入口。 | 交互参考；没有声称取得或复制桌面产品源码。 |
| ZCode | [官方 Subagents 文档](https://www.zcode.network/en/docs/subagents/)：隔离子上下文、继承配置、结果回传。 | 仅作能力语义参考；不以文档推断其前端组件实现。 |

Maka 的 `@maka/ui` 是依赖其 core、locale 和投影模型的私有工作区包，且使用不同版本的 Astryx / React，不能直接当成 OpenPI 的现成组件。本文所述改动没有复制第三方源文件、增加依赖、升级组件库，或替换 Pi 的 provider/session 栈。

## 实现与事实边界

- **运行时所有权**：复用既有 Session-scoped Web observer 和 `/api/capabilities/detail`。子代理 provider 直接读取 `manager.view.get(id)`；查询受父 Session 和精确资源 ID 约束。没有客户端路径读取或第二套 Session 存储。
- **真实状态**：卡片按当前能力快照展示运行、完成、失败或中断；spawn 回执单独折叠。没有当前状态时显示“已启动 · 状态未保留”，不推断完成。
- **可见过程**：子对话展示已保留的用户任务、assistant 文本、可折叠思考、工具参数/输出、实时文本和错误。完整同内容 finalText 不重复渲染。工具成功返回不替代子代理最终状态。
- **有界投影**：最多 64 条转录、每条 32 个片段、16 个实时工具、64 KiB 共享文本预算；显示遗漏与截断。工具 ID 只在可完整保留时投影，超长或超预算的工具记录被省略，不能截成相同尾缀/空 ID 后错误配对。redacted thinking 不带出原文。
- **读取生命周期**：打开的运行任务每秒读取一次；完成后停轮询；切换任务、返回、关闭会 abort 旧请求。响应同时验证父 Session 和子 ID，晚到结果不能覆盖另一任务。关闭不停止 agent。
- **历史降级**：运行时已释放或服务重启后，仍可打开父会话中按精确 ID 保存的 spawn / wait / check / result 回执。清楚标为已保存记录，批量结果可能包含同批其他任务；不假装这是完整子 Session 转录。非活动父会话只读自己的已保存投影，不请求当前会话的实时详情。
- **模型边界**：没有新增模型工具或配置字段；详情能力是 operator-facing 的只读投影。没有改写权限、继承规则、取消机制、执行并发上限。

## 真实体验与限制

沿用前文记录的 Node 24 / 独立 Pi 配置 / 唯一 worktree 来源。用户后续提供的新凭据仅进入本机私有配置并重启生效，未进入 Git 或 Issue。

已使用 `gpt-5.6-luna / medium` 运行两个只读子代理，检查两个子 Session 的模型、thinking 以及仅调用 `read` 的记录。更新后的界面另运行 `UI-detail-smoke`（普通子代理 `sa-3`），完成 package.json 核对；在真实页面点击卡片确认可见子对话、思考折叠项、read 参数/结果及最终文本，父对话仍可见。也实际打开了重启前子任务的已保存回执。

一次双子任务复测在启动子任务前收到 provider 的 `gateway_concurrency_limit`；降为单子任务后成功。用户授权最多 6 个不意味着服务商保证 6 并发。OpenPI 当前普通子代理池硬上限为 4，另有 2 个用户旁路槽，本次没有把它们改成 6 个普通子代理。

本次没有新增子对话发送/停止控件、完整子 Session 跨重启重建、分页获取超过保留窗口的历史，或文件修改的 diff 审阅。这些需要继续沿各自 Pi 原语处理，不能用卡片 UI 假装已支持。

## 验证和消融

- 后台专项：observer / subagent extension / Host 测试通过；包含跨 scope、精确 ID、克隆隔离、UTF-8 预算与 redacted thinking。
- 组件专项：15 个新增用例覆盖总览/子对话、返回/Escape、旧请求取消、错误与身份验证、实时轮询停止、历史记录、准确点击和 spawn 不等于完成；包括历史父会话不能借用当前父会话同 ID 子代理状态、近期更新的记录不被列表窗口误丢弃，以及实时 manager 消失后仍可打开总览。
- 正式浏览器：桌面 1280px 和手机 390px，用 6 个确定性任务验证列表可达、实时变为完成、工具详情、失败信息、父子导航、横向边界和 axe。这是合成 UI 数据，不是六个真实模型并发成功证据。
- 最终完整门禁：`bun run check` 通过；`bun run test` 的 Node 测试 1662 通过、1 个已有 skip、0 失败，Vitest 239 / 239 通过；正式静态构建 Playwright 全套 38 / 38 通过。另确认重复点击同一父卡片或总览入口，会准确重置面板导航而非停在之前的内部选择。
- 消融：移除早期 Dialog、全局遮罩与内嵌双列检查器；使用正常工作区布局和 List 原语仍满足可达性、切换与读取边界。未引入另一套路由/状态框架。动态读取与历史投影共享同一查看入口，但不混同其证据来源。

本机证据继续保存在 `~/.cache/openpi-web-experience-20260918/`，新增 `subagents-check-final.log`、`subagents-test-final.log`、`subagents-e2e-final.log`、`subagent-component-final.log`。私有会话、凭据、用户截图不发布；公共复核依赖提交的源码与测试。
