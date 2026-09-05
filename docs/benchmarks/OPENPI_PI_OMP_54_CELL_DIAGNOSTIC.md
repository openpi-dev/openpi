---
status: draft
created: 2026-08-29
last-reviewed: 2026-08-29
applies-to: "OpenPI 0.3.0 / Pi 0.84.2 / Terminal-Bench 2.1 source-build-derived ARM64 diagnostic"
owner: OpenPI maintainers
related-issues: "#46, #277"
related-prs: "#271"
supersedes: none
source-task-revision: d1f1920f2d817a831f466d0ff363ef795a9a3b00
models: "seal/glm-5.3, seal/gpt-5.6-luna"
thinking-level: "high for both models"
tasks: "git-leak-recovery, sqlite-db-truncate, cancel-async-tasks"
sample-size: "54 cells (2 models × 3 tasks × 3 repeats × 3 harnesses)"
verifier: "Harbor 0.20.0"
isolation: "Linux ARM64 VM; strict serial Latin-square; global concurrency 1"
failure-classification: "pass / fail / indeterminate"
accounting: "provider tokens, wall time, physical POST, and logical attempts where available"
evidence-status: pending-independent-review
evidence-reference: "receipts/openpi-issue-46-arm64-54-cell-v1.md"
rerun-boundary: "Requires the pinned ARM64 VM, package versions, task revision, schedule hash, lock fingerprints, and credential-free evidence boundary"
---

# OpenPI 0.3.0、Pi 与 OMP 的 54-cell ARM64 派生诊断

## 状态与范围

本报告整理 Issue [#46](https://github.com/openpi-dev/openpi/issues/46) 中已经公开的实验收据。它记录的是 Linux ARM64 VM 上运行的 Terminal-Bench 2.1 source-build-derived 诊断，**不是 Terminal-Bench 官方成绩、排行榜成绩或正式提交**。

实验矩阵为：

```text
2 models × 3 tasks × 3 repeats × 3 harnesses = 54 cells
```

模型是 `seal/glm-5.3` 和 `seal/gpt-5.6-luna`；Harness 是 Bare Pi、Pi + OpenPI 与 OMP；任务是 `git-leak-recovery`、`sqlite-db-truncate` 和 `cancel-async-tasks`。

本报告只转录已公开的结果，不把小样本观察写成通用排名，也不声称 OpenPI 相对 Bare Pi 有普遍质量或速度提升。

## 冻结条件

| 项目 | 值 |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent 0.84.2` |
| OpenPI | [`@tt-a1i/openpi 0.3.0`](https://github.com/openpi-dev/openpi/releases/tag/v0.3.0) |
| OMP | `@oh-my-pi/pi-coding-agent 17.2.12` |
| Bun | `1.3.14` |
| Harbor | `0.20.0` |
| Container runtime | Podman server `6.0.2`，Linux ARM64 VM |
| Task source | Terminal-Bench 2.1 ARM64 source-build-derived，commit `d1f1920f2d817a831f466d0ff363ef795a9a3b00` |
| Repeats | 每个模型、任务、Harness 3 次 |
| Schedule | strict serial Latin-square |
| Cell deadline | 1,800 秒 |
| Schedule SHA-256 | `974fdc67aad36c4c890a83d6705e7a687610a0ecbef00a0c0ca4e7efac369a62` |
| Credential boundary | host forwarding proxy + 每格短命 bearer；candidate 不持有真实 provider key |

模型参数：

| 模型 | Thinking |
| --- | --- |
| `seal/glm-5.3` | `high` |
| `seal/gpt-5.6-luna` | `high` |

## 结果

### GLM-5.3

结果使用 `pass / fail / indeterminate`。Wall 包含 indeterminate 等待时间。

| Harness | 结果 | Wall | Provider tokens | Physical POST |
| --- | ---: | ---: | ---: | ---: |
| Bare Pi | 7 / 1 / 1 | 2,647.724s | 249,625 | 94 |
| OpenPI | 7 / 2 / 0 | 1,107.098s | 331,851 | 87 |
| OMP | 7 / 2 / 0 | 1,081.746s | 2,176,017 | 106 |

| Task | Bare Pi | OpenPI | OMP |
| --- | ---: | ---: | ---: |
| Git leak recovery | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| SQLite truncate | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| Cancel async tasks | 1 / 1 / 1 | 1 / 2 / 0 | 1 / 2 / 0 |

可支持的效率观察：OpenPI 与 OMP 都是 7 pass；OpenPI 使用的 provider tokens 是 OMP 的 15.3%，少 84.7%。OpenPI 相对 Bare Pi 多 32.9% tokens，因此本批次不能声称 OpenPI 比原生 Pi 更省 token。Bare Pi 的一次 indeterminate 与 cancel 的 process-group 行为有关，不能用总 wall 宣称稳定提速。

### GPT-5.6 Luna

该路线没有返回可用 token usage，因此只比较 verifier、物理请求数和 wall，不作 token 或成本结论。

| Harness | 结果 | Wall | Physical POST | Logical attempts | 额外物理 POST |
| --- | ---: | ---: | ---: | ---: | ---: |
| Bare Pi | 7 / 2 / 0 | 1,129.885s | 43 | 43 | 0 |
| OpenPI | 7 / 2 / 0 | 1,151.213s | 46 | 46 | 0 |
| OMP | 4 / 5 / 0 | 1,803.368s | 110 | 92 | 18 |

| Task | Bare Pi | OpenPI | OMP |
| --- | ---: | ---: | ---: |
| Git leak recovery | 3 / 0 / 0 | 3 / 0 / 0 | 3 / 0 / 0 |
| SQLite truncate | 3 / 0 / 0 | 3 / 0 / 0 | 1 / 2 / 0 |
| Cancel async tasks | 1 / 2 / 0 | 1 / 2 / 0 | 0 / 3 / 0 |

可支持的效率观察：OpenPI 与 Bare Pi 都是 7/9；OpenPI wall 比 Bare Pi 高 1.9%，没有提速证据。OpenPI 相对 OMP 多 3 pass，物理模型请求少 58.2%，总 wall 低 36.2%。OMP 的 110 个物理 POST 对应 92 个已完成 logical attempts，18 个 provider 重试没有从开销中隐藏。

## 完整性与安全收据

两组运行记录均满足：

- 27/27 个 Pi/OpenPI/OMP cell 落盘且身份唯一；
- 最终冻结源校验通过；
- retained artifact credential scan：0 missing roots、0 credential leak、0 scan failure；
- 真实 provider key 未注入 candidate；
- 全局并发为 1，所有 cell 按冻结 Latin-square 严格串行执行。

运行身份：

| 模型 | Lock fingerprint | Receipt |
| --- | --- | --- |
| GLM-5.3 | `sha256:037179456f3223457e428b9d5543911144b045bcea7ee7127728b27dd735780e` | `completed_with_indeterminate` |
| GPT-5.6 Luna | `sha256:00b9db64606832521df7f853d63d5e50d1e6754920e0ac51e1b32c2aacc4866c` | `completed_with_indeterminate` |

Evidence controller 还记录了 provider 物理重试：当 `physical POST < logical attempts` 时 fail closed；非负差值记录为 `unattributedProviderPostRequests`。

## 结论边界

这批结果支持以下窄结论：

1. 在两个完整模型批次中，OpenPI 与 Bare Pi 的通过数都是 7/9；Git 与 SQLite 两类任务合计都是 12/12。
2. 在这组普通 Terminal 任务中，OpenPI 保持了原生 Pi 的通过数；不同任务的耗时方向不一致，因此不作相对 Pi 的稳定速度结论。
3. 相对 OMP，GLM-5.3 批次观察到相同 pass 数下更低的 token 使用；Luna 批次观察到更多 pass、更少物理请求和更低 wall time。样本很小，不能外推为总体排名。
4. 这些任务没有专门要求 Subagent 或 Workflow，因此结果不能证明 OpenPI 编排能力的收益。

## 验证与复现边界

本报告对应的可检索、无凭据边界收据见 [receipts/openpi-issue-46-arm64-54-cell-v1.md](receipts/openpi-issue-46-arm64-54-cell-v1.md)。收据包含压缩后的任务结果账本、冻结身份、汇总指标和安全边界，可重算本报告的 pass/fail/indeterminate 汇总；原始 JSONL、Session、日志、candidate workspace 和凭据不随仓库发布。当前记录仍为 `draft`，因为原始证据包尚未提供独立复核入口。

Issue #46 记录的原始验证为：

- controller 定向 Node tests：23 pass，1 个环境用例 skip；
- 项目全量 Node tests：719/719；
- Vitest：29/29；
- `bun run check`：format、lint、typecheck 通过，typecheck 仅有既存 Effect advisory warnings。

本仓库当前提交落地的是报告和公开收据，不包含每个 cell 的原始 artifact；因此报告的可追溯锚点是 Issue #46、冻结版本、任务 commit、调度 hash、lock fingerprint 和安全收据。若要宣称可独立复算或官方成绩，仍需另行提供原始 artifact 包、运行脚本和相同环境。

下一轮实验应扩大任务集，并预注册会自然触发 Subagent/Workflow 的多文件任务，将能力采用率、质量与成本分开报告。

