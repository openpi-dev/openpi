# OpenPI Harness 强度与模型能力研究协议

> 状态：validated（研究协议；不代表新的 Benchmark 结果）
>
> 创建日期：2026-08-30
>
> 最后核验：2026-08-30
>
> 关联 Issue：[#45](https://github.com/openpi-dev/openpi/issues/45)

## 目的

验证模型能力变化时，Harness 脚手架强度的收益是否变化，并区分 OpenPI 的稳定静态成本、动态执行轨迹和实际能力收益。本协议只定义可复现实验和解释边界，不要求 OpenPI 复制 OMP，也不改变默认运行时行为。

## 已核验事实

- Bare Pi 的默认编码面主要是 `read`、`bash`、`edit`、`write`；OpenPI 的能力组和 Workflow/Subagent/Background 生命周期沿 Pi extension seam 按需加载。
- OMP 同时改变 system prompt、工具面、执行反馈、上下文治理和恢复机制，因此它不是“多几个工具”的单变量对照。
- OpenPI 既有 ARM64 source-build-derived 诊断已观察到首请求工具面税、动态轨迹差异和显著样本方差；这些材料不是官方 Terminal-Bench 分数。
- 没有一次独立运行可以证明某个工具、提示或循环机制造成总体质量差异。

来源固定为：

- OpenPI：执行时记录完整 commit SHA、package version、Pi dependency version 和 active extension source。
- Pi：记录使用的 release/tag 或完整 commit SHA。
- OMP：记录完整 commit SHA 和公开版本。
- 任务与 verifier：记录任务集版本、每题输入 hash、verifier 版本及其 SHA-256。

## 事实、推断与未知

### 事实

每个 cell 必须从 trace 中直接计数：verifier outcome、protocol outcome、请求数、input/output/cache/reasoning tokens、wall time、tool calls、实际加载的 capability、compaction/recovery/loop-guard 触发次数和基础设施失败。

### 推断

只有在固定模型、任务、verifier、权限、隔离和调度后，且 paired trace 显示机制触发与结果变化同时出现时，才可提出“静态脚手架成本”或“动态恢复收益”的相关性解释。相关性不得写成单机制因果结论。

### 未知

- provider 的 implicit prompt cache 失效不一定等于 OpenPI 行为导致的 miss；
- 独立采样下的早期分叉可能放大后续 token 和 wall time；
- 不同 provider 的 usage 字段不能直接视为同一账本；
- 没有触发的机制不能用于解释该 cell 的结果。

## 对照设计

至少冻结四个 arm：

1. Bare Pi：Pi 原生最小编码面。
2. OpenPI Explicit：普通 turn 保持 Pi-native，明确请求时才加载能力。
3. OpenPI capability profile：只加载实验指定的一个能力组。
4. OMP：固定版本的完整公开 harness。

每个模型 × 任务 cell 使用 AB/BA 顺序反转；每个 arm 使用独立 workspace、HOME、TMP、Session 和 provider credential 投影。任务完成后才运行 hidden verifier，禁止模型读取 verifier 或其他 arm 的目录。

模型至少覆盖一个较弱执行模型、一个中等模型和一个强 coding model。模型、provider、thinking/reasoning、timeout、最大请求数和权限配置必须在运行前冻结，不能看到结果后调整。

## 主要指标

- 质量：verifier pass、paired outcome、错误类别和证据完整度。
- 成本：首请求 input、total input/output/cache/reasoning tokens、估算成本。
- 轨迹：turns、tool calls、重复失败、无新证据回合、wall time 和长尾。
- 机制：能力加载成功率、实际采用率、每种机制触发次数及触发前后结果。
- 安全：workspace 外访问、网络污染、verifier 泄漏、进程清理和 artifact 完整性。

## 解释门槛

- 普通编码赛道中，OpenPI 首请求 input、总 tokens、turns、tool calls 和 wall time 只有在预注册阈值内，才可称为“没有明显静态/动态回退”。
- 编排价值赛道必须预先声明任务确实需要委派、工作流或后台执行；只有能力被实际采用且主要质量、时间或人工步骤指标出现净改善，才可支持迁移建议。
- 质量非劣、成本可接受和机制证据必须同时满足，才能提出默认行为变更。
- 单次运行、基础设施失败、样本过小或未触发机制只能作为限制或待验证假设。

## 非目标

- 不把 OMP 的完整脚手架复制到 OpenPI。
- 不按模型名称硬编码“弱模型模式”。
- 不把 Issue、研究协议或静态源码比较当作产品 Decision。
- 不发布缺少 frozen identities、usage accounting、failure classification 或 raw-evidence reference 的正式 Benchmark 结果。

## 当前结论

Issue #45 的现有材料支持建立上述配对协议，但不足以证明 Harness 强度与模型能力之间已经存在可迁移曲线。下一步必须先完成隔离有效、身份冻结、可审计 trace 的小规模重复；在此之前 OpenPI 默认 runtime 保持不变。
