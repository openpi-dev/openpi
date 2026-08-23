# Claude Code Dynamic Workflow 的编排规模与 OpenPI 借鉴原则

> 日期：2026-08-23
>
> 范围：仅使用 Anthropic 官方 Claude Code 文档、官方 Agent SDK Cookbook 和官方示例；不推断未公开的 Runtime 内部算法。本文补充已有的 [Claude Code Workflow 生命周期研究](./CLAUDE_CODE_WORKFLOW_DESIGN_2026-08-23.md)，只回答“Claude 一次启动多少 Agent、为什么、谁决定、有哪些边界”。

## 结论先行

Claude Code 并没有一个“普通任务固定启动 3 个、复杂任务固定启动 20 个”的公开调度公式。它分成四层：

```text
用户描述任务、结构、成本或规模要求
  ↓
Claude 根据任务生成完整 JavaScript 编排脚本
  ↓
脚本中的数据规模和控制流决定计划调用总量
  ↓
Runtime 在硬边界内排队执行
```

四层分别由不同主体拥有：

| 层 | 谁负责 | Claude Code 的合同 |
|---|---|---|
| 工作如何分解 | 模型 | Claude 根据任务写 Workflow 脚本，决定阶段、分片、验证和汇总方式 |
| 用户偏好 | 用户 | 自然语言可以明确要求覆盖范围、每项独立验证、成本约束或规模；`workflowSizeGuideline` 提供全局软建议 |
| 计划调用量 | 脚本 | `agent()` 调一次产生一次 Agent；数组长度、循环、分支和验证条件共同决定总调用量 |
| 执行并发和失控保护 | Runtime | 同时最多 16 个 Agent（CPU 较少时更低），每个 Run 最多 1,000 个 Agent |

当前 Claude Code `v2.1.219+` 默认的 size guideline 是 `medium`，含义是 Claude 写脚本时**以少于 15 个 Agent 为目标**。它是建议，不是 cap；任务 Prompt 可以覆盖。真正的硬边界仍是同时最多 16 个、单 Run 总共最多 1,000 个。计划超过 25 个 Agent 或预计超过 150 万 tokens 时，Claude Code 默认只显示 `Large workflow` 警告，不暂停、不截断。[官方规模设置](https://code.claude.com/docs/en/workflows#set-a-size-guideline) [官方行为与限制](https://code.claude.com/docs/en/workflows#behavior-and-limits) [官方成本说明](https://code.claude.com/docs/en/workflows#cost)

因此，Claude Code 看起来会启动几十个 Agent，不是因为 Runtime 鼓励“越多越好”，而是因为 Workflow 把任务先展开成**可数的独立工作项**，再由 Runtime 限流执行。例如发现 80 个待审文件后，脚本可以计划 80 次文件审查；同一时刻仍只有最多 16 个在跑，其余排队。

## 1. “一次启动多少个”其实有三个不同数字

讨论 fan-out 时必须区分：

1. **计划总量**：这个 Workflow 完整执行可能调用多少次 `agent()`。
2. **某个阶段的 fan-out 宽度**：同一批有多少独立工作项可并行。
3. **真实瞬时并发**：Runtime 此刻实际运行多少 Agent。

例如：

```text
阶段 1：1 个 Agent 发现 80 个文件
阶段 2：每文件 1 个审查 Agent，共计划 80 次
阶段 3：1 个 Report Agent 汇总

计划总量 = 82
阶段 2 fan-out 宽度 = 80
真实瞬时并发 <= 16
```

如果把三者都叫“启动 80 个”，就会误以为 Claude 同时把本机压上了 80 个进程。官方 Cookbook 明确说：脚本可以计划超过并发限制的工作，Runtime 会把超出的 Agent 排队，等待槽位释放。[官方 Dynamic Workflow Cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

## 2. 谁决定 Agent 数量

### 2.1 模型决定编排计划

用户请求 Workflow 后，Claude 会为当前任务写一份完整 JavaScript 脚本，再把它交给 `Workflow` 工具。脚本而不是父模型逐 Turn 决定接下来执行什么；中间结果保存在脚本变量中。[官方 Workflow 概览](https://code.claude.com/docs/en/workflows#when-to-use-a-workflow)

因此 Agent 数量来自 Claude 写出的代码：

```js
const files = await agent("找出所有待审文件", { schema: fileSchema })

const reviews = await pipeline(files.structured.files, file =>
  agent(`审查 ${file}`, { label: file })
)

return reviews.filter(Boolean)
```

假如发现 7 个文件，第二阶段调用 7 个 Agent；发现 500 个文件，就计划 500 个。Runtime 不会为了保持“medium”自动把 500 个文件变成 14 个，也不会自动把 7 个文件膨胀成 14 个。

### 2.2 自然工作项决定最有意义的 fan-out

Anthropic 官方例子反复使用“一个独立 item 对应一个 Agent”：

- 每个路由文件一个安全审查 Agent；
- 每个变更文件一个 reviewer；
- 每个待迁移组件一个独立转换任务；
- 每个事实 claim 一个 verifier；
- 只为通过初审的 claim 再创建 skeptic；
- 多个独立研究角度分别搜索，再统一综合。

这不是必须遵守的 Runtime 规则，而是很有价值的模型策略：分片单位必须能独立完成、独立验证、产生明确结果。官方文档给出的文件审查、迁移、研究和收敛搜索示例都体现了这一点。[官方 Workflow Prompt 示例](https://code.claude.com/docs/en/workflows#example-workflow-prompts)

### 2.3 用户可以直接约束结构和规模

用户 Prompt 可以指定：

- “每个文件必须独立审查”；
- “每个发现再由另一个 Agent 反证”；
- “最多使用 6 个 Agent”；
- “先在一个目录做小样，再决定是否全量”；
- “机械提取用较便宜模型，最终判断用强模型”。

官方 Cookbook 明确指出：用户描述的 harness 结构决定实际 harness，也决定验证成本；应先在小切片上运行并观察费用。[官方 Cookbook 的使用与成本建议](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows#when-to-reach-for-a-workflow)

### 2.4 `workflowSizeGuideline` 只是给模型的建议

当前官方取值为：

| 设置 | Claude 写脚本时的目标 |
|---|---:|
| `unrestricted` | 不给数量建议，按任务决定 |
| `small` | 少于 5 个 Agent |
| `medium` | 少于 15 个 Agent |
| `large` | 少于 50 个 Agent |

`v2.1.219+` 默认 `medium`；更早版本默认 `unrestricted`。官方明确写明 guideline 是 advice，不是 cap，任务 Prompt 要求不同规模时可以覆盖。配置变化从下一条 Prompt 开始生效。[官方规模设置](https://code.claude.com/docs/en/workflows#set-a-size-guideline)

这意味着：

```text
medium
!= 每次创建 14 个
!= 最多只能创建 14 个
!= Runtime 并发上限为 14

medium
= 在没有更强任务依据时，提醒 Claude 把计划控制在 15 个以内
```

## 3. Runtime 的硬限制

### 3.1 并发最多 16

Claude Code 同时最多运行 16 个 Workflow Agent；CPU 核数不足或容器 CPU 受限时会更低。计划数量更大时进入队列。[官方行为与限制](https://code.claude.com/docs/en/workflows#behavior-and-limits)

这是资源安全边界，不是模型的分解建议。

### 3.2 每个 Run 最多 1,000 次 Agent

单个 Workflow Run 的 Agent 总量硬上限为 1,000，用于阻止失控循环。这是计划总量边界，不等于允许 1,000 个同时运行。[官方行为与限制](https://code.claude.com/docs/en/workflows#behavior-and-limits)

### 3.3 大规模告警是 advisory

默认满足任一条件就显示 `Large workflow`：

- 计划超过 25 个 Agent；
- 预计总 tokens 超过 150 万。

告警只提醒用户去 `/workflows` 观察或停止，不自动暂停、不降低规模。用户选定 size guideline 后，其 Agent 数量取代默认的 25-Agent 告警阈值；启用 ultracode 的 Session 不显示该告警，因为用户已经选择了大规模运行。[官方成本说明](https://code.claude.com/docs/en/workflows#cost)

### 3.4 Prompt cache stagger 是启动优化，不是数量策略

同一 fan-out 中，模型、effort、agent type、工具、schema 和工作目录一致的 Agent 可以共享系统提示前缀缓存。Claude Code 会先放行第一个匹配 Agent，等它开始响应后再一起放行其余 Agent；默认最多等待 5 秒。这个机制减少重复处理前缀的成本，但不会决定要创建几个 Agent。[官方 Prompt caching in a fan-out](https://code.claude.com/docs/en/workflows#prompt-caching-in-a-fan-out)

## 4. Phase 和拓扑是怎么决定的

### 4.1 `phase()` 负责观察归类，JavaScript 控制流才负责依赖

`meta.phases` 和 `phase(name)` 让进度 UI 按阶段展示 Agent 数量、tokens 和时间。真正保证依赖顺序的，是 JavaScript 的 `await`、循环、分支、`parallel()` 和 `pipeline()`；不能把 UI phase 标签当成调度屏障。[官方 Workflow 脚本示例](https://code.claude.com/docs/en/workflows#what-the-saved-script-looks-like)

### 4.2 常见拓扑

#### A. Discover -> fan-out -> report

适用：审查未知数量文件、API、测试、数据项。

```text
1 个发现 Agent
  → N 个独立执行/审查 Agent
  → 1 个汇总 Agent
```

Agent 数量约为 `N + 2`。如果聚合可以由确定性 JavaScript 完成，最后的 Report Agent 也可以省掉。

#### B. Fan-out -> adversarial verify -> report

适用：安全审计、事实核查、高风险结论。

```text
N 个初审 Agent
  → 只对候选发现启动 M 个反证 Agent（M <= N）
  → 1 个汇总 Agent
```

Agent 数量约为 `N + M + 1`，但 M 是运行时数据决定的，不应该预先等于 N。官方 Cookbook 的 fact-check 就是先验证每个 claim，再只对 `confirmed` 结果做 skeptic 检查，然后产出最终报告。[官方 Dynamic Workflow Cookbook](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

#### C. Pipeline per item

适用：每个 item 都要经过提取、变换、检查等多步，而且快 item 不应等待慢 item。

```text
N 个 item × K 个 stage
```

最坏计划调用量约为 `N × K`；失败 item 可以提前退出，从而减少实际调用量。`pipeline()` 允许 item A 已进入第二阶段时，item B 仍在第一阶段，而不是在每一阶段形成全局 barrier。[官方 Cookbook：Workflow primitives](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows#how-to-read-a-workflow-script)

#### D. Round-based convergence

适用：直到没有新增问题、测试通过或连续几轮没有进展。

```text
每轮发现/修复/验证
  → 判断是否收敛
  → 未收敛才进入下一轮
```

调用总量由运行证据决定，因此必须有确定性的停止条件，例如“连续两轮没有新发现”或“测试通过”。官方示例明确采用这种停止条件，而不是无界“继续找”。[官方迭代示例](https://code.claude.com/docs/en/workflows#find-issues-until-the-list-stops-growing)

#### E. Multiple perspectives -> judge/report

适用：架构方案、研究问题、难以一次定论的计划。

```text
3~N 个相互独立视角
  → 1 个比较/裁决 Agent
```

这里的 N 不是数据 item 数，而是有实质差异的视角数。重复同一种角度只会增加 token 成本，不会线性提高质量。

## 5. 不同任务如何估算 Agent 数量

下表是依据官方原语推导的设计示例，不是 Anthropic 的隐藏算法：

| 任务 | 合理结构 | 计划调用量 | 为什么 |
|---|---|---:|---|
| 阅读一个小模块并总结 | 单 Agent，不上 Workflow | 1 | 没有值得脚本化的 fan-out 或强制验证 |
| 评审一个 PR 的 4 个独立模块 | 4 reviewers + 1 report | 5 | 文件/模块边界清楚，最终需要去重排序 |
| 核查 10 条事实 | 1 extract + 10 verify + M skeptic + 1 report | 12~22 | 每条 claim 独立；只反证通过初审的候选 |
| 迁移 80 个独立组件 | 1 discover + 80 migrate + 80 verify + 1 report | 最多 162 | 每项两阶段；Runtime 分批跑，不是 162 并发 |
| 调查一个难复现 bug | 3~5 个独立假设 + 1 judge | 4~6 | 多视角抗锚定，但不是按文件数盲目扩大 |
| 一直修到 typecheck 通过 | 每轮 1~N fix + 1 verify | 动态 | 数量由错误数与收敛轮数决定，必须设置停滞条件 |

一个实用判断式是：

```text
计划调用量
= 发现/规划调用
+ 独立工作项 × 每项必经阶段
+ 条件性复核项
+ 最终综合调用（如果确定性代码不足以综合）
```

但不要把这个公式放进 Runtime。它是模型在写脚本前进行规模估算的思考工具。

## 6. 与 Agent Teams 的数量建议不要混用

Claude Code 的 Agent Teams 官方建议通常从 3~5 个 teammate 起步，并建议每个 teammate 保持 5~6 个任务，以平衡沟通成本和利用率。但 Agent Teams 是少量、长期、可以互相沟通的 peer session；Dynamic Workflow 是由脚本调度的短生命周期 Agent，可以达到几十至几百个。[官方 Agent Teams 最佳实践](https://code.claude.com/docs/en/agent-teams#choose-an-appropriate-team-size)

因此：

```text
Agent Teams 的 3~5 人建议
不能推导出
Workflow 也应该只用 3~5 个 Agent
```

这也解释了用户体验中的明显差异：Claude Code Workflow 常常显示几十个调用，而一般手动 Subagent/Team 会少得多。两者的协调拓扑、结果落点和开销结构完全不同。

## 7. 对 OpenPI 的直接启示

### 7.1 保留模型对分解和规模的判断权

OpenPI 不应增加固定的“默认创建 3 个 Agent”规则，也不应根据“任务很大”这个模糊标签在 Runtime 自动膨胀 fan-out。模型最接近任务语义，应该决定：

- item 怎么切；
- 是否需要验证；
- 哪些验证是条件性的；
- 是否需要 Report Agent；
- 哪个阶段适合更强或更经济的模型。

Runtime 只执行硬约束并返回高保真反馈。

### 7.2 当前 OpenPI 的硬限制已经足够，不必照抄 16/1,000

OpenPI 当前配置为：

- 默认同时 8 个 Agent；
- 默认每个 Workflow 最多 128 次 `agent()`；
- 可配置并发硬上限 64；
- 调用总量硬上限 1,024。

这些数字符合本地 Pi Runtime 的资源边界。Claude 的 `16/1,000` 是它的产品实现选择，不是行业真理。OpenPI 应保留可配置上限，不为了表面对齐修改数字。

### 7.3 不建议马上复制 `small/medium/large`

OpenPI 已经允许用户通过 `/openpi-setup` 配置真实的并发和调用上限。再增加一组 `small/medium/large` 容易把“模型建议规模”和“Runtime 强制边界”混在一起，也增加配置面。

更小的改进是强化 Workflow Skill 的一句原则：

> 根据可独立验证的自然工作项和任务难度决定 fan-out；用户明确成本或规模要求时优先遵守。并发与最大调用数只是 Runtime 上限，不是应当用满的目标。

如果真实使用仍稳定只生成 3 个、明显覆盖不足，再通过 Benchmark 证明问题后考虑一个单独的 advisory size preference；不要先加配置。

### 7.4 支持“规模预估”，不要让 Runtime 接管规划

模型写非平凡 Workflow 前，可以在 narration 或 launch receipt 中简短说明：

```text
计划：1 个发现 + 24 个文件审查 + 最多 24 个反证 + 1 个汇总
预计 Agent 调用：26~50
并发上限：8
```

这让用户在启动前理解成本，也便于发现意外膨胀；但最终代码仍由模型生成，Runtime 只校验不超过 `maxAgentCalls`。

### 7.5 对大 fan-out，公平汇总比盲目扩容更重要

允许 50 个 Agent 没有意义，如果最终只把前几个结果塞进父上下文。OpenPI 应继续推进已有的结果 artifact、bounded handoff 和 Report 阶段设计：

- 中间结果保留在 Workflow 内部；
- 汇总输入必须覆盖所有 item，明确 dropped/failed；
- 父会话只接收最终 bounded report 和 artifact 索引；
- UI 展示计划量、已完成、失败、tokens 和阶段，而不是把所有结果逐条注入父上下文。

这与 Claude Code“脚本变量保存中间结果，父上下文只拿最终答案”的核心优势一致。

### 7.6 大规模应先做小样，而不是自动压低完整任务

官方建议大任务先在一个目录或窄问题上运行，观察效果和 token 使用，再全量展开。OpenPI 可把它写进 Skill 作为模型策略：

```text
任务规模大且分片质量未知
  → 先用 2~5 个代表性 item 校准 prompt/schema/验证标准
  → 校准通过后再运行完整 fan-out
```

这比 Runtime 永久限制为 3 个 Agent 更能兼顾质量、成本和覆盖率。

## 8. 建议的 OpenPI 最小改进

在不增加新工具、不增加新设置、不改变 Runtime 权限边界的前提下：

1. 在 Workflow Skill 中明确“Agent 数量由自然工作项、验证需求和任务难度决定”。
2. 明确“用户的成本、数量、模型和 effort 要求优先”。
3. 区分计划调用量、fan-out 宽度和真实并发，避免模型把 `concurrency=8` 误当成“整个 Run 只能调用 8 次”。
4. 对大任务鼓励先做代表性小样，再全量运行。
5. 对动态 fan-out 要求脚本报告 planned/completed/failed/dropped 数量。
6. 汇总必须验证覆盖率，不能只综合最先完成或输出最大的几个结果。
7. 保持 Runtime 的 `8/128` 默认与 `64/1024` 硬上限，不新增 Claude 风格的第二套 size 配置，除非真实 Benchmark 证明需要。

这套改进的核心不是让 OpenPI “一次开更多 Agent”，而是：

> 让模型按任务结构创建恰好足够的 Agent，让 Runtime 有界执行，让汇总阶段完整覆盖，并让用户在成本与规模上拥有最终决定权。

## 9. 本机 Claude Code 实验应记录什么

官方合同只能告诉我们边界，不能证明当前本机所配模型会为某个具体 Prompt 生成多少 Agent。要回答“这个模型实际上怎么调用”，应在同一 checkout 做三类只读实验，并保存生成脚本：

1. **不指定数量**：`use a workflow to review every changed file and produce one ranked report`。
2. **给自然覆盖要求**：`每个变更文件独立审查，每条候选问题再由另一个 Agent 反证`。
3. **给明确成本约束**：同一任务加上 `最多使用 6 个 Agent`。

每轮记录：

- Claude Code 版本、模型、effort、`workflowSizeGuideline`；
- 输入 Prompt；
- 生成的 Workflow 脚本；
- 计划 `agent()` 调用的上/下界；
- 实际 Agent 总数和峰值并发；
- phases、最终覆盖率、失败/丢弃数；
- tokens、wall time、最终结果质量。

必须把实验结果描述为“这个版本、这个模型、这个任务下的观测”，不能升级成 Claude Code 的稳定算法。真正稳定的产品合同仍以官方限制和 interface 为准。

### 9.1 本机模型访谈（不是 Runtime 合同）

本机在 2026-08-23 使用 Claude Code `2.1.241`、`claude-opus-5-google`、high effort 做了一次关闭工具的模型访谈。模型给出的有价值启发式包括：

- 必须区分计划总量、阶段 fan-out 宽度、真实瞬时并发和 run 结束后的实际调用总量；
- 高不确定性任务先用 1~3 个探针确定分片形状，再扩展第二批；
- 宽度通常应沿 `宽扫 -> 窄证 -> 单写` 收敛；
- fan-out 的首要价值是上下文隔离与召回率，不自动带来正确性或一致性；
- 普通 bug 修复通常不需要 Workflow；安全审计和跨来源研究更适合宽 fan-out；
- “500 个文件”不应机械等于“500 个 Agent”：可判定的批量变换优先交给 codemod/普通 JavaScript，Agent 处理发现、规则归纳和失败长尾；
- 成本由总调用量决定，并发限制主要控制资源占用和延迟，不能替代总量预算。

这些是该模型在该 Prompt 下的实践建议，不是 Anthropic 的隐藏调度算法。访谈也暴露了一个重要反例：第一次关闭全部工具后，模型声称产品没有数值化 size guideline；这与当前官方文档明确的 `<5/<15/<50/unrestricted` 冲突。第二次要求它只依据当前可见工具时，它如实确认 bare/print 会话中没有看到 Workflow 工具或相关数字。

因此本机模型访谈的证据等级应保持为：

```text
官方文档 / SDK 类型
  > 实际生成脚本与 run telemetry
  > 模型对自身启发式的解释
```

当前普通模式调用还暴露了一个本机环境问题：全局 npm wrapper 缺少 native optional binary；临时同版本 wrapper 可运行，但加载普通定制链路时在请求发出前停滞，`--bare` 才正常进入模型。这个问题与 Workflow fan-out 策略无关，后续如要做真实 Workflow 观测，应先修复 CLI 安装并单独定位普通启动链路，再运行第 9 节的三组实验。

### 9.2 正常模式、全权限模型访谈

随后使用临时完整安装的 Claude Code `2.1.241` 重新运行正常模式，而不是 `--bare`：

- 模型：`claude-opus-5-google`；
- effort：`high`；
- 权限模式：`bypassPermissions`；
- 工具面：默认完整工具集，初始化结果明确包含 `Workflow`；
- 任务：读取 OpenPI 当前实现与官方资料，解释 Workflow 的规模决策，并为本仓库设计一次全仓只读审计；
- 用时：约 `6m25s`；
- 最终回复：约 `9,694` output tokens；
- 仓库代码变更：`0`；
- 实际 `Workflow` 调用：`0`。

最后一点不是失败。模型没有为了证明自己拥有 Workflow 而启动一轮昂贵执行；它判断当前任务是“调研、解释和设计”，通过读取源码、官方文档和自身实际工具合同就能回答。这证明“工具可见”不等于“模型应当调用”，也支持 OpenPI 的设计原则：能力开放后仍由模型按任务判断是否使用。

这次正常模式访谈给出了四个比关闭工具访谈更强的发现：

1. Claude Code 当前确实把 size guideline 作为工具描述末尾的模型建议传入：默认 `medium`，目标少于 15 个 Agent；用户 Prompt 可以要求不同规模。它不是 Runtime cap。
2. 当前 Claude Workflow 工具合同还暴露了一个官方公开 Workflow 文档未写明的 `budget` 全局：用户提供 token target 后，它是硬上限；达到上限后，新的 `agent()` 调用会抛错。脚本还能读取剩余额度，按预算动态收缩。这是运行时合同观测，不应泛化到其他版本。
3. OpenPI 只开 3 个左右的首要原因不是 `8/128` Runtime 上限，而是模型可见示例：Quick start 只展示两个手写 Agent，全部示例都缺少“发现 Agent 返回结构化列表，再由该列表决定下一阶段宽度”的 canonical 拓扑。
4. OpenPI 的工具描述没有在模型写脚本前展示解析后的真实 `concurrency` 与 `maxAgentCalls`，也没有明确说明“计划总量可以大于并发上限，多出的调用会排队”。模型容易把并发边界误读成整轮规模建议。

针对当前仓库的“架构、安全、测试、文档全仓只读审计”，该模型没有建议机械地做 `24 extensions x 4 lenses = 96 Agents`。它先按源码规模与风险边界发现审计单元，再给出以下动态区间：

```text
Inventory        1~2
Lens fan-out    16~24
Adversarial      8~16（只复核候选发现）
Completeness         1
Synthesis            1
----------------------
计划总量         27~44
峰值并发             8（由 OpenPI Runtime 排队）
```

宽度来自第一阶段的结构化输出，而不是写死 `27` 或 `44`。反证阶段只为产生中高风险候选的工作项启动，因此实际调用数由证据决定。停止条件是一次 completeness critic 加最多一轮有界补审，不做无限 `loop-until-dry`。

模型最终给出的改进优先级是：

1. 必做：把 Workflow Skill 的 Quick start 换成“发现 -> 结构化列表 -> 动态展开”示例。
2. 把本次解析后的并发上限和调用总量上限注入模型可见工具描述，并解释二者区别。
3. 补一个有确定停止条件的动态收敛示例。
4. 只增加一句规模原则，不新增 `small/medium/large` 配置：宽度由可独立验证的自然工作项决定，用户明确的成本、数量或覆盖要求优先。
5. `budget` 硬天花板先作为候选设计研究；它会新增 Runtime 表面，应在前四项和 benchmark 之后再决定。

这次观测仍然不是 Claude Code 的隐藏调度算法。它证明的是：在同一版本、同一模型、同一仓库和同一 Prompt 下，完整工具可见时模型会区分“是否需要执行 Workflow”和“如果执行应规划多大规模”，并能为当前仓库提出远大于 3、但不是盲目放大的动态调用区间。真正的执行行为仍需按第 9 节三组 Prompt 跑真实 Workflow 才能验证。

### 9.3 当前 Claude Code 环境的完整 Workflow 合同访谈

在用户进一步明确需求后，又复用同一个正常 Claude Code 会话，要求它不执行 Workflow，而是从自身环境中系统梳理当前实际注入的 Workflow 工具合同、提示词结构、DSL、并发与 token 预算、恢复、缓存、权限、UI 和持久化，并明确区分公开文档、运行时合同、本机实测和模型判断。

这次访谈约耗时 8 分 23 秒，输出约 33,401 tokens，费用约 1.56 美元，未启动子代理、未执行 Workflow、未修改仓库。完整整理见 [Claude Code Workflow 运行时合同访谈](./CLAUDE_CODE_WORKFLOW_RUNTIME_CONTRACT_2026-08-23.md)。

最重要的新增结论是：当前版本的大量详细规则并不属于公开 SDK 稳定接口，而是动态注入到 `Workflow` 工具描述中的模型合同。OpenPI 可以学习其“明确授权、任务专属脚本、Runtime 强制边界、父模型阶段判断”的分层原则，但不能把某一版内部工具描述误当成永久产品规范。

## 参考资料

- [Claude Code: Orchestrate subagents at scale with dynamic workflows](https://code.claude.com/docs/en/workflows)
- [Claude Cookbook: Orchestrate subagents at scale with dynamic workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)
- [Anthropic 官方 Cookbook 源文件](https://github.com/anthropics/claude-cookbooks/blob/main/claude_agent_sdk/08_Dynamic_workflows.ipynb)
- [Claude Code: Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams)
