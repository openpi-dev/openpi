# OpenPI 零常驻工具面三臂诊断复盘

> 状态：validated（历史诊断复盘；不是正式 Benchmark 或产品 Decision）
>
> 创建日期：2026-08-30
>
> 最后核验：2026-08-30
>
> 关联 Issue：[#20](https://github.com/openpi-dev/openpi/issues/20)、[#19](https://github.com/openpi-dev/openpi/issues/19)

## 结论边界

OpenPI 从多个常驻入口收敛到普通 turn 零常驻 OpenPI 工具，消除了稳定的 schema 和 Skill catalogue 静态税。现有 DeepSeek 0731 ARM64 source-build-derived 三臂诊断显示 OpenPI、Bare Pi、Maka 在小样本中通过数相同，但轨迹 token、turn 和 wall time 仍有较大方差。

这组材料证明了工具面收敛方向和隔离/账本的重要性，不能证明 OpenPI 在总体质量、成本或速度上优于其他 Harness，也不能把结果归因给某一个 runtime 机制。

## 已核验观察

- 早期约 31 个模型工具会让普通任务支付完整高级能力 surface；该批任务很少实际采用 Subagent、Workflow、Background、Goal 或 Task。
- 7 个 compact entry 能降低工具数量，但仍可能把能力入口和 Skill catalogue 带入每个首请求。
- capability gateway 与后续 zero-resident surface 将高级能力改为按明确意图加载，能力组在 Session 内保持稳定。
- 三臂诊断的 candidate、HOME、TMP、Session 和 verifier 隔离经历多轮修复；早期越界访问和 verifier 可见性问题会使正式排名失效。
- 固定首请求 payload 后，独立模型采样仍可能产生完全不同的错误恢复轨迹；静态税与动态轨迹必须分账。

## 证据账本

每个诊断 cell 应记录：OpenPI/Pi/Maka 完整源码身份、provider/model/thinking、任务与 verifier 身份、candidate 隔离根、首请求 payload hash、工具 schema、请求与工具调用数、input/output/cache/reasoning usage、wall time、protocol/verifier 结果、基础设施失败和完整 trace 位置。

`cacheRead`、provider cost 和未冻结的模型账单字段不能在缺少明确口径时自行推导。任何 candidate root 外访问、verifier 泄漏、残留进程或 artifact 不完整都应分类为 harness invalid，而不是模型失败。

## 当前产品边界

- 普通父 Session 只保留 Pi 原生核心工具；OpenPI 能力按需加载。
- capability discovery 是渐进机制，不是固定 workflow 或模型名称路由器。
- 搜索、委派、Workflow、Background、Session 等组的生命周期仍由各自 owner 管理。
- 结果投影、重试和 artifact 保留必须与模型上下文、用户 UI 分离。
- 在新的配对证据达到预注册门槛前，不因单次诊断扩大默认 prompt 或工具面。

## 后续实验门槛

先完成干净 workspace、网络和 verifier 隔离，再使用 AB/BA 顺序反转与多次重复比较 Bare Pi、OpenPI Explicit、指定 capability profile 和固定版本 OMP。至少同时报告质量、首请求静态税、总 usage、轨迹长度、机制采用率和失败分类。

只有在普通 coding 赛道质量非劣且成本边界通过，并且编排价值赛道确实观察到能力采用带来的净收益，才可提出新的默认行为变更。

## 来源与关联

- [Issue #20](https://github.com/openpi-dev/openpi/issues/20)：零常驻表面与 DeepSeek 三臂诊断原始讨论。
- [Issue #19](https://github.com/openpi-dev/openpi/issues/19)：从 compact entry 到 capability gateway 的设计分析。
- [Issue #45](https://github.com/openpi-dev/openpi/issues/45)：模型能力 × Harness 强度配对研究协议。
- [OpenPI documentation contract](../README.md)：研究记录状态与证据边界。
