# 任务：Fusion 零代码原型对照（第一阶段）

## 要回答的问题

在 OpenPI 上，让前沿模型当 lead、便宜模型当常驻副手（sidekick），能否在通过率不下降的情况下，降低每个任务的实际花费？前提是 lead 自己的花费真的下降，否则这个模式就不成立。

不修改 OpenPI 和 Pi 的任何代码。原型只由两份文件组成，都在本目录，**内容不许改动**：
- `lead-guidance.md`：lead 的分工规则，通过 `--append-system-prompt` 注入。
- `sidekick.md`：副手的角色文件，放到 `$PI_CODING_AGENT_DIR/agents/sidekick.md`。
  `model:` 这一行是唯一允许修改的地方：如果在 harness 里 `deepseek/deepseek-flash` 解析不到，就改成能解析到 DeepSeek 官方 `deepseek-flash` 的 provider/model id，并在 summary 里注明。

## 固定条件

- OpenPI：`git:github.com/openpi-dev/openpi@e799a9b802a2a0b640f7a8496c304e156fbfc6a9`（v1.1.0）。Pi 固定为 1.3.0，Harbor 用上一轮的版本。Agent 类沿用 delegation-value 那一轮的 `PiOpenPIFrozen`，包括 `_collect_pi_extra`。
- Lead 模型：`gpt-6.1-sol`，thinking=high。副手模型：DeepSeek 官方 `deepseek-flash`，reasoning_effort=high（由角色文件指定）。
- 两个模型都必须能在同一个 trial 里调通。如果环境里没有 gpt-6.1-sol 的可用凭据，**停下来报告**，不要换模型。
- 题目：TB10 预构建镜像里实现类最多的 5 道：`cancel-async-tasks`、`kv-store-grpc`、`multi-source-data-merger`、`openssl-selfsigned-cert`、`sqlite-db-truncate`。

## 三组

| 组 | lead-guidance | sidekick.md | k | 作用 |
|---|---|---|---|---|
| solo | 无 | 无 | 3 | 对照：前沿模型单干 |
| fusion | 有 | 有 | 3 | 被测：带分工规则 |
| noguide | 无 | 有 | 1 | 只报告：不给规则时，模型会不会自己用副手 |

- solo 和 fusion 按"题 × 轮"配对，每对两组前后紧挨着跑，先后顺序按轮次轮换。noguide 的 5 个 trial 穿插在同一窗口里。所有 trial 在一个连续时间窗口内跑完。
- 出 infra 失败（包括 provider 返回 4xx 或 5xx 导致运行中断）：这一对的两组都作废，在同一窗口内一起重跑。不允许只重跑其中一组。

## 冒烟门槛（必须先过）

先跑 1 个 fusion trial（`kv-store-grpc`），逐条确认：
1. 主会话的系统提示里包含 `# Working with a sidekick`。
2. 主会话 assistant 消息的 `model` 全部是 gpt-6.1-sol；子会话的 `model` 全部是 deepseek-flash（看 `score_fusion.py` 输出的 `lead_models` 和 `child_models` 两列）。
3. `cost_complete=True`，并且 `child_sessions >= spawn`。
4. 这个 trial 的 `total_usd` 不超过 2 美元。

关于是否真的委派了：
- 冒烟 trial 里 `spawn_sidekick=0` 不算失败，可以再跑 1 个冒烟。
- 两次都是 0，就停下来报告"规则未生效"，并附上 lead 的最终回复。不要修改规则文本。

冒烟通过后，用冒烟花费估算全部 35 个 trial 的总花费。超过 40 美元就先停下来报告，等确认后再跑。

## 指标

用本目录的 `score_fusion.py` 打分，不要修改它。每个 trial 记录：reward、wall_s、lead_usd、child_usd、total_usd、lead_turns、child_turns、spawn_sidekick、send、wait、两组模型、cost_complete。

`cost_complete=False` 的 trial 作废并记录原因。另外检查：如果 lead 用了 workflow，或者 spawn 时没有用 sidekick 类型，这个 trial 照常计入，但要在 summary 里单独列出。

## 判定（预先定好，跑完不许改）

只比较 fusion 和 solo 的 15 个配对：

- **有效性**：fusion 组 15 个 trial 里，至少 8 个满足 `spawn_sidekick >= 1`。达不到就判"规则未生效"，不做后面的判定。
- **有价值**：同时满足以下三条：
  - fusion 的通过数 ≥ solo 的通过数 − 1；
  - 逐对 total_usd 比值（fusion / solo）的中位数 ≤ 0.85；
  - 逐对 lead_usd 比值（fusion 的 lead_usd / solo 的 total_usd）的中位数 ≤ 0.7。
- **无价值**：满足任意一条即可：
  - 逐对 total_usd 比值的中位数 ≥ 1.0；
  - fusion 的通过数 ≤ solo 的通过数 − 2。
- 其余情况都判**不确定**。

另外报告以下内容，只报告，不参与判定：
- 逐对墙钟时间比值的中位数；
- 每道题各自的配对结果；
- noguide 组里有几个 trial 用了副手，以及它的通过数和花费；
- fusion 组的 send 次数分布，用来看副手有没有被反复复用；
- lead 是否出现过重做副手工作的情况，抽 2 个 trial 看轨迹，定性描述即可。

## 不要做的事

- 不要修改 `lead-guidance.md`、`sidekick.md`（`model:` 那一行除外）或 `score_fusion.py`。
- 不要换模型、改推理档位、换题或加题。
- 不要修改 OpenPI 或 Pi 的代码。
- 第一阶段跑完就停。是否进入第二阶段（用更难的题）由我决定。

## 交付

- 归档目录：`runs/2026-10-xx_fusion-proto-phase1/`，结构和 delegation-value 那一轮相同。要包含：各 trial 的 CSV、配对表、判定结果、作废记录，以及固定的版本和模型标识。
- 不要归档任何凭据。提交前做 secret 扫描。
- summary 第一行直接写判定结果：有价值 / 无价值 / 不确定 / 规则未生效。之后再写数据。
- 回报时给出 archive commit 和 summary 路径。
