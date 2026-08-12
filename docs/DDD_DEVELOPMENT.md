# DDD 开发规范（openpi 默认开发模式）

> 业主指令（2026-08-13）：**所有 openpi 的修复与新增功能，默认按 DDD 模式开发。**
> 本文件是约定本身；新代码偏离时，review 以本文件为准。

## 分层（从内到外，依赖方向单向）

```
领域层（纯逻辑）   →   应用层（编排/折叠）   →   基础设施/UI 层（端口适配器）
  domain.ts            manager.ts / index.ts      navigation.ts / ui.ts
  零 I/O、零 UI        事件折叠、用例             只读 ctx.ui 端口，不直接操作
  完全可单测           调用领域函数               扩展注册绑定，不各自实现基础设施
```

| 层 | 职责 | 禁止 |
|---|---|---|
| **领域层** | 状态机、值对象（VO）、纯函数（判定/归一/匹配/渲染文本）、领域事件类型 | I/O、计时器、ctx.ui、模型调用 |
| **应用层** | 折叠事件进快照、维护不变量、编排领域函数、持久化（appendEntry） | 直接渲染；UI 结构操作 |
| **基础设施/UI 层** | 组件渲染、键盘路由、widget/编辑器装配 | 业务规则；重复实现共享机制 |

## 共享内核（Shared Kernel）

横切关注点必须收敛到 `extensions/shared/`，扩展之间**不互相 import**，只依赖 shared。

样板：`extensions/shared/editor-strip-port.ts`（端口-适配器）
- 扩展**注册绑定**（数据+回调），不各自 `setEditorComponent`
- 内核提供**单一安装器**（一次装配、幂等、顺序=注册序）
- 同类问题的判定标准：**"两个扩展是否各自实现同一份基础设施逻辑？"是 → 收敛到 shared**

## 关键纪律

1. **扩展不直接操作 UI 结构**（setEditorComponent/setHeader/setFooter）：走 shared 端口；已存在的直接调用必须幂等 + 收敛
2. **领域逻辑不进 UI**：判定/匹配/归一/格式化是纯函数（如 `subagents/src/domain.ts` 的 `isStalled/lastIntentOf`、`tasks/tasks.ts` 的 `taskMatchesDescription/tasksToMarkdown`），测试只测领域层
3. **事件驱动，不轮询**：状态变化通过折叠事件表达（如 manager 折叠 SubagentEvent → 快照），UI 订阅快照
4. **诚实降级**：数据源不可得时（如内核无 retry 事件）用可推断信号（失败连击）并注释依据，不臆造字段
5. **测试分层**：领域层全量单测；应用层行为测试（mock 事件流）；UI 层只测渲染与键盘路由

## 样板文件

| 关注点 | 领域层 | 应用层 | 基础设施 |
|---|---|---|---|
| tasks 状态机 | `tasks/tasks.ts`（纯函数+校验） | `tasks/index.ts`（工具/命令/对账/recap） | `tasks/ui.ts`（渲染） |
| subagent 可见性 | `subagents/src/domain.ts`（isStalled/lastIntentOf…） | `subagents/src/manager.ts`（事件折叠） | `subagents/navigation.ts`（HUD） |
| 编辑器装配 | — | — | `shared/editor-strip-port.ts`（端口+单一安装器） |
| 跨扩展对账 | — | `shared/task-reconcile.ts`（桥） | tasks widget / subagents onSettled |
