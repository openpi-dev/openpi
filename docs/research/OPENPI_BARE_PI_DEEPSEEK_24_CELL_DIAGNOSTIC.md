# OpenPI 与 Bare Pi 的 DeepSeek 0731 24-cell 派生诊断

## 状态与范围

本报告整理 Issue [#22](https://github.com/tt-a1i/openpi/issues/22) 中已经公开的实验收据。它记录的是冻结源码、相同模型、相同首请求、相同任务和 AB/BA 顺序下的 Terminal-Bench 2.1 source-build-derived 诊断，**不是官方 Terminal-Bench 2.1 成绩或排行榜提交**。

实验包含 4 个多语言编码任务，每个 Harness、每题重复 3 次：

```text
2 harnesses × 4 tasks × 3 repeats = 24 cells
```

Harness 是 Bare Pi 与当前 OpenPI。模型为 `seal/deepseek-v4-flash-0731-baidu`，Thinking 为 `off`；OpenPI 的 capability calls 与 nested usage 均为 0。

本报告只转录 Issue #22 已公开的结果、消融和限制，不把小样本观察写成总体质量或速度结论。

## 实验契约

- 任务：Go Book Store、Python Bottle Song、JavaScript Connect、Rust Nucleotide Codons；
- 每个 arm、每题 3 repeats；
- AB/BA 顺序轮换；
- 每格独立 candidate、HOME、TMP、agent root 和 session；
- hidden verifier 仅在模型进程退出后注入；
- 首请求、provider/model、source hash、runtime guard 和隔离 canary fail closed；
- 记录 hidden verifier、physical tokens、turns、tool calls、wall time 和 timeout。

最终运行中，12/12 对首请求完整 prompt 精确相等，两臂首请求合计均为 25,026 tokens；没有通过额外 Subagent 或 Workflow 预算换分。

## 最终结果

| 指标 | Bare Pi | 当前 OpenPI | OpenPI 相对 Pi |
| --- | ---: | ---: | ---: |
| Hidden verifier | 6/12 | **10/12** | +4；paired 5 win / 1 loss / 6 tie |
| Physical tokens | 1,074,754 | **669,522** | -37.71% |
| Turns | 99 | 101 | +2.02%；配对中位 +1 |
| Tool calls | 89 | 89 | 总数持平；配对中位 +1 |
| Wall time | 1,802.2s | **605.2s** | -66.42%；配对中位 -1.63s |
| Timeout | 2 | **0** | OpenPI 12/12 正常 settle |
| Capability / nested calls | 0 / 0 | 0 / 0 | 相同 |

Bare Pi 的两个 timeout 来自 Go Book Store 的 600 秒超时，因此预注册的“两臂都无 timeout”条件未满足。

### 逐题结果

| 任务 | Pi pass | OpenPI pass | Pi / OpenPI tokens | Pi / OpenPI turns | Pi / OpenPI tools | Pi / OpenPI wall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Go Book Store | 1/3 | **3/3** | 281,502 / 198,257 | 26 / 31 | 25 / 28 | 1,231.9s / 183.1s |
| Python Bottle Song | 1/3 | **2/3** | 44,947 / 68,393 | 16 / 20 | 13 / 17 | 29.3s / 47.2s |
| JavaScript Connect | 1/3 | **2/3** | 322,309 / 304,850 | 25 / 34 | 22 / 31 | 278.4s / 262.4s |
| Rust Nucleotide Codons | 3/3 | 3/3 | 425,996 / 98,022 | 32 / 16 | 29 / 13 | 262.6s / 112.6s |

OpenPI 机制在 4/12 cells 中实际命中：18 次 ActiveEvidence projection、4 个 epochs、累计移除 526,210 个 replay 字符；另有 10 次 validation timeout 默认值写入和 1 次 recovery hint。没有命中 repeated-failure block、超长 Bash result projection、真实 validation timeout 或 trajectory hint。

因此，不能把 +4 pass 因果归因到某一个机制；多个质量分叉发生在机制能够介入之前。

## 收敛消融

### 关闭 ActiveEvidence

第一轮单次 campaign 中 tokens、turns、tools 和 wall 均下降，但 hidden verifier 从 8/12 降到 6/12，违反预注册质量门槛。交换 profile 位置的镜像确认合并后，当前 ActiveEvidence 为 15/24，no-active 为 13/24；no-active 的效率优势没有稳定复现，因此不设为默认。

### 移除 recovery / trajectory 提示

快速 12-cell 消融两边都是 6/6，但实验组没有触发本应被抑制的提示，同时 turns、tools 和 wall 上升。由于命中不足且动态更差，没有扩大实验。

### 将首次历史投影从第 9 个事务延后到第 15 个

实验组的 tokens、turns、tools 和 wall 下降，但质量为 5/6，对照为 6/6；所有轨迹都在 15 个事务前结束，实际 projection 命中为 0。因此不能证明 delayed policy 有效。

## 保留的设计与结论边界

本轮记录的最终取舍是：

- 普通 coding turn 使用 `explicit` capability discovery，不常驻 OpenPI 模型工具；
- 用户明确请求能力时才加载对应能力组；
- 保留 ActiveEvidence capacity controller、exact repeated-failure gate、workspace safety、validation timeout、Bash 输出边界和 recovery / trajectory 行为；
- no-active、mirror、no-model-hints、delayed 仅作为 benchmark profile，且需要 `OPENPI_BENCHMARK_AGENT_ROOT`，不改变普通 session。

这批数据支持一个窄结论：在这 4 个任务、12 个重复的对照中，OpenPI 达到本轮定义的“实用持平”，通过数高于 Bare Pi；但 Bare Pi 有两个超时，DeepSeek 0731 长轨迹方差很大，不能据此宣称 OpenPI 稳定领先或提速 3 倍。

## 可审计身份

```text
finishedAt=2026-08-17T12:04:25.850Z
cells=24/24
openpiContentSha256=fbecff74e2637147d123205cf1e3a17d3cc37d94e8ec6c3edbd719e42dde066c
runnerSha256=49d6f8a6aae578406e22da629466cc70be385c421710823ff6780fe8e2c628d1
runtimeGuardSha256=246e5c33f9c20f74bd094e8831b8a595f96c917d515ec2ffd4dd10a6e43b5bdf
```

Issue #22 还记录了 `run.json`、`cells.jsonl`、`summary.json`、逐格 `result.json`、provider/session trace、hidden verifier 输出和 execution-convergence telemetry。原始逐格 artifacts 未随本次提交新增，因此本报告不声称第三方已经能够从 GitHub 独立复算这些本地结果。

## 下一步

下一步应先把冻结源码、测试、benchmark runner 和报告整理成可审计远端 commit，再在 Issue [#21](https://github.com/tt-a1i/openpi/issues/21) 跟踪原生 x86_64 Docker 环境下与 Maka 对齐的 OpenPI 89 题单臂运行；无论结果好坏，都应发布逐题结果、token 口径和失败分类。

