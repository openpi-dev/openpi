# OpenPI Capability Gateway 边界研究

> 状态：validated（设计研究；不代表新增 runtime 实现）
>
> 创建日期：2026-08-30
>
> 最后核验：2026-08-30
>
> 关联 Issue：[#19](https://github.com/openpi-dev/openpi/issues/19)

## 研究结论

Issue #19 的核心问题是能力入口是否应常驻模型上下文。现有证据支持“普通 turn 零常驻 OpenPI surface，明确意图时加载稳定 capability group”的方向；它不支持增加第二套 provider、固定编排器或按模型名称路由。

## 已确认边界

- Pi 原生 `read`、`bash`、`edit`、`write` 仍是普通编码的基础执行面。
- Search、Delegate、Workflow、Background、Session 是可独立加载的能力组；组内 lifecycle 工具由各 owner 按资源状态管理。
- capability discovery 只改变模型可见 surface，不拥有 Subagent、Workflow 或 Background 的执行生命周期。
- 已加载组在 Session 内单调保持，避免频繁增删 schema 导致 cache churn。
- 第三方同名工具不能被 OpenPI 误隐藏；无法证明 source ownership 时必须保留并 fail open。
- child Session 不得通过 gateway 改变父会话工具面，工具仍需通过 child-safe drift guard。

## 设计选择

### Explicit

普通 turn 默认不暴露 OpenPI 工具。用户明确表达需要某类能力时，运行时加载对应组并附带最小 Skill 指针。该路径不做通用自然语言 planner，也不调用隐藏分类模型。

### Adaptive

用户显式选择 Adaptive 后，只保留紧凑的 gateway。主模型阅读完整任务后自行决定是否加载一个或多个能力组；gateway 不是执行器，也不代替模型判断。

### Setup 例外

持久化配置继续只通过 `/openpi-setup` 用户入口开启。Setup 不应成为普通 capability group，也不能由 gateway 自动加载配置写工具。

## 证据与限制

零常驻工具面消除了可重复测量的静态 schema/Skill catalogue 成本，但独立模型采样仍可能造成动态轨迹差异。首请求一致或接近，不能证明后续质量或成本因果；任何 benchmark 都必须同时报告 adopted capability、turn、tool、usage、wall time 和失败分类。

## 非目标

- 不增加常驻的每能力请求工具。
- 不复制 OMP 的完整工具注册、全局 hub、memory 或 workflow runtime。
- 不按 provider/model 名称硬编码策略。
- 不把 gateway 变成关键词路由器、固定数量 planner 或第二 authority plane。
- 不因为一次小样本诊断改写默认产品行为。

## 后续门槛

先在隔离有效的配对任务上比较 Bare Pi、OpenPI Explicit、OpenPI Adaptive 和按需加载组。只有在能力实际被采用且对预注册主要结果产生净收益时，才考虑新增 runtime seam；否则保持当前 Pi-native 最小面。

## 来源

- [Issue #19](https://github.com/openpi-dev/openpi/issues/19)：工具面复盘与 gateway 提案。
- [Issue #20](https://github.com/openpi-dev/openpi/issues/20)：三臂诊断复盘。
- [`docs/README.md`](../README.md)：研究记录状态与证据边界。
