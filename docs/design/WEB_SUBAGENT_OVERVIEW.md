# Web 子代理概览

- Status: validated（限固定源码、组件测试与合成浏览器交互）；用户已确认提交，不是新增架构约束。
- Created / verified: 2026-09-29。
- Source boundary: 基于 OpenPI `9a3e595b2f1ecb012a8cbb7206866dc2620ac8b0` 的 PR #598 子代理概览改动；第三方边界见下表。
- Related: [Issue #597](https://github.com/openpi-dev/openpi/issues/597)、[PR #598](https://github.com/openpi-dev/openpi/pull/598)、[既有子代理检查设计](../research/WEB_SUBAGENT_INSPECTION_2026-09-18.md)。
- Supersedes: none；沿用已有子会话读取边界。

## 观察与取舍

用户提供 Codex 两张截图：会话信息小窗内的子代理摘要；点击摘要后打开按运行/完成分组的独立列表。截图是产品交互依据，不是取得 Codex Desktop 源码的证据。

| 来源 | 核实的实现 | 本次取舍 |
| --- | --- | --- |
| [Maka 子会话 story](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/apps/desktop/stories/subagent-sessions.stories.tsx)、[LinkedAgentList](https://github.com/apache/maka/blob/ae71ab319c920b856c2f18ee6c8d022e38376f71/packages/ui/src/tool-activity.tsx) | Astryx 紧凑可点击行；打开子会话切换主聊天列，标题栏提供父子导航。没有截图中的同款右侧概览。 | 最适合参考行式信息密度与子会话导航。继续使用项目已有 Astryx；右侧列表由 OpenPI 自己适配。 |
| [pi-web SessionList](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/components/SessionList.ts)、[WorkspacePanel](https://github.com/jmfederico/pi-web/blob/a345b2ac363b644d5ef43b1da75b9bc53cd055c4/src/client/src/components/WorkspacePanel.ts) | 根据 parentSessionPath 组织父子会话；工作区工具拥有独立面板。实现为 Lit。 | 借鉴导航和内容分离；不移植框架、会话树或运行系统。 |
| [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar/blob/9b5834f74ad197534c821c35b8357edac1ad3919/src/client/SubagentView.tsx) | 任务图/树、节点概览、点击进入 transcript、完成节点聚合；包含工作流与团队信息。 | 支持渐进展开，但拓扑图比本次要求复杂，不作为主布局。 |
| [Claude Code 官方文档](https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background) | 主会话展示后台子代理权限请求并标明请求者；完成通知是结果到达依据。 | 参考状态和身份语义。未取得 Claude Desktop 对应组件源码，不声称其布局与截图一致。 |

上述比较是固定源码和官方文档观察，不是这些产品的同环境性能或交互测试。没有复制第三方源文件或引入新的包。

## 界面设计

- 顶栏“会话概览”使用既有 Astryx Popover。展示工作区文件入口、当前更改入口和子代理摘要；没有数据接入的 PR / 来源区块不展示。
- 摘要和列表共用同一个只读投影。使用同款机器人图标，颜色由父 Session 与子代理 ID 确定，只辅助辨认身份，不表达状态。
- 列表保留运行中、完成两组；失败/中断和无法确认当前状态的已保存记录单独归组，避免把所有非运行记录都称为完成。
- 运行中的条目全部可见；其余各组先展示 10 条，明确提供展开余下记录的按钮。返回列表保留展开和滚动位置。
- 点击行复用已有详情读取、实时轮询、工具/思考折叠和历史回执降级。宽屏与父会话并排，窄屏使用完整内容区。
- 关闭概览或详情不停止代理，不自动创建代理，也不增设模型选择、权限或并发配置。

## 生命周期与验证边界

Pi 子 Session 和现有 subagent manager 仍拥有运行生命周期。Web observer 提供当前父 Session 的受限只读投影；历史父 Session 只用其保存的回执，不能借用活动父 Session 的同名子代理。保存的 running 回执只证明过去运行过，不能计入当前运行中。没有增加第二套存储、协议或模型工具。

组件验证覆盖实时/历史去重、历史 running 不冒充活动、失败/中断不计完成、26 条完成记录渐进展开、返回保留滚动与不触发历史网络读取。

- `bun run check` 通过；`VITEST_MAX_WORKERS=4 bun run test`：2019 个 Node 测试通过、8 个跳过，862 个 Vitest 测试通过。未修改测试时限或运行契约。
- Chromium 正式子代理专项在 1280px / 390px 下 2/2 通过，覆盖概览打开、面板边界、关闭焦点恢复、原有详情读取与 axe 检查。
- 最终图标和预览在 1440px / 390px 下核对机器人图标、26 条完成记录展开、详情、返回、Escape 和横向边界。概览入口另核对两圆点列表图标与打开行为。
- 设计消融：删除六种不同几何图形，只保留同款机器人与稳定颜色，仍满足摘要/列表/详情的身份辨认和导航标准；保留简化实现。没有引入依赖或通用运行框架。
- 首轮全量检查与浏览器并行时，其他终端/设置/侧栏测试出现异步超时；完整复跑通过。浏览器首轮发现按钮缺少可访问的运行状态，补齐后通过。

本地证据目录为 `openpi-evidence/subagent-overview-20260929/`，包含检查日志、演示验证和截图；不发布私有会话或本地服务配置。演示页使用明确标识的合成数据，不代表新增的真实模型执行验证。
