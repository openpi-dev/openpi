# 任务：OpenPI 效率差距消融（deepseek-flash，TB10 四题 × 5）

## 要回答的问题
此前 OpenPI 与纯 Pi 通过率相同，但 OpenPI 输出 token 中位多约 16%（output-gap-k5：14/20 对，p=0.027），折算成本贵约 26%（threeway-v2）。
本轮回答两个问题：
1. 这个差距能否复现？
2. 如果能复现，它来自 OpenPI 的 8 个常驻工具，还是来自其余部分（skill 条目和扩展）？
不修改任何代码和提示词。

## 固定条件
- 模型：B.AI deepseek-v4.1-flash，openai-completions，thinking=xhigh，三组相同。
- Pi 1.4.0，三组相同。OpenPI 固定为 v1.1.0：git:github.com/openpi-dev/openpi@e799a9b802a2a0b640f7a8496c304e156fbfc6a9。agent 用 pi_openpi_frozen。
- 题目：log-summary-date-ranges、kv-store-grpc、nginx-request-logging、fix-git。用 threeway-v2 的预构建镜像（datasets-tb10-prebuilt）。Harbor 0.24.0，timeout 沿用 output-gap-k5 的设置。
- 每个 trial 记录 `pi list` 和 `pi --version`，证明 OpenPI 只有一个来源，版本正确。

## 三组
| 组 | 配置 |
|---|---|
| A 纯 Pi | Harbor pi，与 output-gap-k5 的纯 Pi 组相同 |
| B OpenPI | 默认配置，无追加参数 |
| C OpenPI 去工具 | 与 B 相同，另加 `--exclude-tools 'subagent_*,workflow,workflow_*'` |

## 冒烟门槛（三组各跑 1 次 fix-git，必须先过）
- A 组：工具数 4。
- B 组：工具数 12，系统提示里有子代理指引（"Delegate only substantial, independent work"）。
- C 组：工具数 4，系统提示里没有子代理指引，`<available_skills>` 里仍然列着 subagents 和 workflows。
- 三组都要满足：thinkingLevel=xhigh，usage 完整。
- 任何一条不符合就停下来报告，不要自己调整参数。

## 排程
- 按"题 × 轮"组成三元组，每个三元组的三组紧挨着跑。组内顺序按轮次循环：ABC、BCA、CAB……
- 全部 60 个 trial 在一个连续时间窗口内跑完，串行执行。
- infra 失败时，整个三元组作废，在同一窗口内一起重跑。正常判分的结果一律不重跑。

## 每个 trial 记录
reward、墙钟时间、父会话请求数、输出 token、fresh input、cacheRead、折算成本（fresh + 0.1×cacheRead + 4×output，与 threeway-v2 相同）、工具数、是否调用了子代理或 workflow。

## 判定（跑前定死，跑完不许改；只按逐对计数判定，不看总和）
比较对象是同一三元组内两组的输出 token。
1. 差距是否复现（B 对 A）：B 更多的对数 ≥15/20 判"复现"；≤10/20 判"未复现"，到此为止；11 到 14 判"不确定"，到此为止。
2. 只在复现时做归因：
   - C 对 A 更多的对数 ≤10/20，并且 B 对 C 更多的对数 ≥15/20：判"来自常驻工具"；
   - C 对 A 更多的对数 ≥15/20：判"来自工具以外的部分"；
   - 其余情况判"归因不确定"。

另外要报告，只报告不参与判定：
- 三组的通过数；
- 折算成本的逐对中位比，包括 B/A、C/A、B/C；
- 请求数的逐对中位比；
- B 组里调用了子代理或 workflow 的 trial 数，以及剔除这些 trial 后判定是否变化。

## 不要做的事
不改代码和提示词，不换模型、推理档位、题目或 Pi 版本，不加组。

## 交付
- 归档目录：runs/<日期>_deepseek-v4.1-flash_efficiency-ablation/，结构和 output-gap-k5 相同。
- 归档前做凭据扫描。
- summary 第一行写判定结果。
- 回报 archive commit 和 summary 路径。
