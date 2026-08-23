# Claude Code Workflow 运行时合同访谈

> 日期：2026-08-23
>
> 环境：Claude Code `2.1.241`、`claude-opus-5-google`、high effort、`bypassPermissions`、默认完整工具集。
>
> 目的：让当前 Claude Code 实例依据它在自身环境中实际可见的工具合同、配置、官方资料和本地运行状态，解释 Workflow 的触发、提示词、DSL、调度、预算、恢复、权限与界面。此次任务是只读研究，没有要求它执行 Workflow 或修改代码。

## 证据边界

本文使用四类证据，不能混为一谈：

- **公开合同**：Anthropic 官方文档、Agent SDK 类型与 Cookbook；相对稳定，但仍可能随版本变化。
- **运行时合同**：Claude Code `2.1.241` 当前会话实际收到的 `Workflow` 工具描述和提示文字；能证明这一版、这一环境的行为，不能自动外推到未来版本。
- **本机实测**：版本、模型、权限模式、CPU、配置、工具可见性和调用统计。
- **模型判断**：Claude 对如何分解任务、何时扩大 fan-out 的解释；有参考价值，但不是 Runtime 强制算法。

一个重要发现是：公开工具参考对 `Workflow` 只有概览，完整 DSL 与大量行为规则主要存在于运行时注入的工具描述中。它们是产品实现的一部分，却不是稳定公开 API。因此 OpenPI 可以学习其原则，但不应逐字复制或依赖未公开细节。

## 访谈运行记录

- Session：复用同一正常 Claude Code 会话，而不是 `--bare` 或禁用工具的模型问答。
- 权限：`bypassPermissions`，默认工具集，初始化结果包含 `Workflow`。
- 本机 CPU：12；当前合同给出的并发公式得到峰值并发 10。
- 本地已保存 Workflow：0。
- `workflowSizeGuideline`：未显式配置，采用默认 `medium`。
- 用时：约 8 分 23 秒。
- 最终输出：约 33,401 tokens，其中 thinking 约 9,684 tokens。
- 费用：约 1.56 美元。
- 子代理或 Workflow 执行：0。
- 权限拒绝：0。
- 仓库代码修改：0。

没有实际启动 Workflow 是符合任务合同的：用户要求的是调查 Workflow 的设计，而不是用 Workflow 完成调查。工具可见不等于必须调用；是否调用仍由任务需求和用户授权共同决定。

## 一、何时允许使用 Workflow

### 1. 用户明确授权是前置条件

当前工具描述要求：只有用户明确选择多 Agent 编排时，Claude 才能调用 Workflow。不能因为模型认为任务“适合并行”就自行扩大到可能包含几十个 Agent 的执行。

当前版本认可的授权来源包括：

1. 用户在自己的输入中明确要求 workflow、fan-out、orchestrate 或使用子代理编排；
2. 用户输入 `ultracode`，或当前 Session 已启用 ultracode；
3. 用户调用的 Skill 或斜杠命令明确要求 Workflow；
4. 用户请求运行某个已命名或已保存的 Workflow。

仅仅“任务可能受益于 Workflow”不构成授权。没有授权时，应使用普通 Agent 能力，或者先说明大致规模与成本并征求同意。

### 2. `ultracode` 是持续授权，而不只是推理档位

在当前合同中，ultracode 同时表达两件事：使用更高推理强度；对实质任务持续允许 Claude 判断是否使用 Workflow，token 成本不再是首要约束。

但这个关键字只接受人类来源输入。来自 print prompt、未标记来源的 SDK 输入、cron、webhook 或转发文本中的 `ultracode`，不能被当作用户授权。这是在 Prompt 注入边界上的安全设计。

### 3. 触发门槛主要是 Prompt 合同

访谈没有发现一个独立的 Runtime 授权状态机来强制验证每次调用是否真的来自用户 opt-in。也就是说，当前限制主要通过系统提示和工具描述约束模型。OpenPI 不应照搬这一点；涉及权限、成本和工具边界的事实仍应尽量由 Runtime fail-closed 保证。

## 二、模型如何决定 Workflow 规模

### 1. Size guideline 是建议，不是硬上限

当前默认值是 `medium`，工具描述会在末尾告诉模型：以少于 15 个 Agent 为目标。公开配置还提供：

- `small`：少于 5 个；
- `medium`：少于 15 个；
- `large`：少于 50 个；
- `unrestricted`：不提供软规模目标。

这个值只是动态附加到模型可见工具说明的文本。用户明确要求的数量、覆盖范围或成本约束优先。它还会影响大规模预警阈值，但不会替代 Runtime 硬限制。

### 2. 规模来自自然工作项，而不是固定队伍大小

Claude Code 的建议拓扑是先发现工作项，再展开执行：

```text
少量 scout / inventory
  -> 返回结构化工作清单
  -> 按可独立验证的 item 动态 fan-out
  -> 只对高价值或失败项复核
  -> 单独汇总
```

因此“几十个 Agent”通常表示脚本计划了几十次短生命周期 `agent()` 调用，并不表示几十个同时运行。模型需要区分计划调用总量、单阶段 fan-out 宽度、Runtime 峰值并发和最终实际执行量。

### 3. 一个 Workflow 只承担一个清晰阶段

当前提示建议父 Agent 保持在环，不把理解、设计、实施、审查全部塞进一份超长脚本。更合适的方式是：

```text
Understand Workflow
  -> 父 Agent 读取证据并决定方向
Design Workflow
  -> 父 Agent 或用户确认关键方案
Implement Workflow
  -> 父 Agent 检查结果
Review Workflow
```

原因不是 UI 偏好，而是 Workflow 运行中没有自然的用户输入点。跨决策阶段拆开，才能让用户和父模型在证据变化时纠偏。

## 三、运行时工具描述如何组成

当前 `Workflow` 工具说明大致按以下顺序拼接：

1. 后台启动行为、task id 与完成通知；
2. Workflow 的适用价值；
3. 用户 opt-in 与成本警告；
4. hybrid strategy、推荐模式和 ultracode 语义；
5. DSL 规范、模式库和示例；
6. resume 与缓存说明；
7. 当前 size guideline 动态文本。

这说明 Claude Code 不是依靠一个隐藏分类器自动选择固定 Workflow。模型收到的是一份相当完整的编排语言和决策合同，然后依据当前任务生成脚本。

## 四、Workflow DSL

### 1. 脚本与元数据

调用可以直接传入脚本，也可以引用已保存脚本。内联脚本会被保存，以便后续查看和恢复。

脚本必须导出纯字面量 `meta`，至少包含 `name` 和 `description`；可以描述 `whenToUse` 与 UI phases。phase 名称需要和运行中使用的名称准确对应。Phase 主要服务可观测性，不自动构成调度屏障。

### 2. `agent()`

`agent(prompt, options?)` 启动一个短生命周期 Agent。重要选项包括 `label`、`phase`、`schema`、`model`、`effort`、`isolation: "worktree"` 与 `agentType`。模型和 effort 默认继承，只有显式需要时覆盖。

没有 schema 时返回文本；有 schema 时返回校验后的对象。失败通常投影为 `null`，脚本必须显式处理。

### 3. `pipeline()`

`pipeline(items, ...stages)` 是多阶段、逐 item 流水线的首选。item A 可以进入第二阶段，而 item B 仍在第一阶段，不需要每一层形成全局 barrier。

后续阶段能读取上一阶段结果、原始 item 和索引。某个阶段抛错时，该 item 后续结果变为 `null`，不必拖垮所有其他 item。

### 4. `parallel()`

`parallel(thunks)` 是真正的全局 barrier：所有分支完成后才能继续。当前合同明确提醒，连续的 parallel-map-parallel 往往应该改成 pipeline，除非下一阶段确实需要看到上一阶段所有结果。

### 5. 子 Workflow

脚本可以通过 `workflow(nameOrRef, args?)` 调用一个子 Workflow，但只允许一层嵌套。子 Workflow 与父 Workflow 共享并发槽、调用总量、取消和 token 预算，不获得额外资源池。

### 6. 其他原语

当前合同还提供 `phase()`、`log()`、`usage()`、`budget` 和 `args` 等能力，用于 UI、诊断和预算感知。脚本运行在受限 JavaScript 环境中，不能直接使用文件系统、shell、import，也不能依赖会破坏 deterministic replay 的随机数和当前时间。

## 五、并发、总量和预算

### 1. 并发限制

当前运行时描述的并发公式为：

```text
min(16, available CPUs - 2)
```

本机 12 CPU，因此当前峰值并发为 10。计划调用量可以大于并发数，多出的 Agent 排队等待槽位。单个 `parallel` 或 `pipeline` 最多接受 4096 个 item。

### 2. 总量限制

单个 Workflow run 最多调用 1,000 个 Agent。它是防失控循环的硬边界，不是推荐规模，也不是并发数。

### 3. Token budget

当前工具合同暴露了公开文档没有完整描述的 `budget`：如果用户给出 token target，它会成为硬天花板；脚本可以查询 total、spent 和 remaining，达到上限后新的 `agent()` 调用会失败。

这是 Claude Code 比当前 OpenPI 更成熟的一点：模型不仅知道并发和调用次数，还能在脚本里依据剩余 token 动态缩小验证宽度。OpenPI 可以研究同类能力，但必须先明确计量口径、父子共享方式、失败证据和恢复语义，不能只增加一个 Prompt 数字。

## 六、执行、恢复与缓存

### 1. 后台生命周期

Workflow 启动后立即得到 task id，父 Session 保持可用。运行完成后通过 task completion 进入原会话。这个默认生命周期与 OpenPI 当前同步默认形成鲜明对比，也是 OpenPI 已立项修正的主要方向。

### 2. Resume

当前版本支持同一 Session 内恢复。中途停止或脚本修改后，Runtime 会基于调用前缀复用已经完成的 Agent 结果；脚本 journal 和 Agent JSONL 作为恢复证据。

复用不是只看 label。模型、effort、agentType、工具、schema、cwd 等共同影响调用身份。编辑脚本后，只能复用最长未变化调用前缀。

### 3. Fan-out prompt cache

当同一 fan-out 中的 Agent 具有相同模型、effort、Agent 类型、工具、schema 和 cwd 时，Runtime 会先启动一个 Agent 建立可缓存前缀，再在短窗口内释放其余同构 Agent。缓存优化影响成本与延迟，不决定 fan-out 数量。

## 七、权限与隔离

- Workflow Agent 继承父会话的工具 allowlist。
- 公共文档描述其执行权限采用 `acceptEdits`，不完全等于父 Session 当前 permission mode。
- 并发修改时才建议使用 worktree；只读研究不应为每个 Agent 创建 worktree。
- Worktree 有可观测启动成本，当前说明估计约 200~500ms。

这部分值得 OpenPI 保持自己的优势：OpenPI 的 child tool whitelist、角色边界和 fail-closed 分类比“继承工具面后主要依赖 Prompt”更明确。学习 Claude 的规模与 DSL，不应削弱 OpenPI 的权限交集规则。

## 八、结果、UI 与持久化

- 中间结果保存在 Workflow 脚本变量中，不逐条灌入父会话。
- 结构化输出由 schema 约束，Agent 可在校验失败后修正。
- 最终可以用普通 JavaScript 聚合，也可以再用一个 Agent 做综合报告。
- `/workflows` UI 展示 phases、Agent 数量、tokens、时间与状态，并支持暂停、恢复、停止、重启、保存和下钻。
- 已保存 Workflow 位于项目或用户级 `.claude/workflows/`，并对符号链接和 monorepo 解析设有保护。

## 九、与 OpenPI 的差异

| 维度 | Claude Code 当前合同 | OpenPI 当前优势或问题 |
|---|---|---|
| 用户授权 | Prompt 层严格要求 opt-in | explicit/adaptive 能力门更清楚，可继续 Runtime fail-closed |
| 默认生命周期 | 后台，父 Session 可继续 | 当前仍存在默认同步阻塞，已确认需改 |
| 规模指导 | 动态 size guideline + 自然工作项 | 示例偏小，模型容易把并发误解为总量 |
| Token 预算 | 脚本可读硬预算 | 暂无同等一等公民预算合同 |
| DSL | agent/pipeline/parallel/child workflow | OpenPI 有 ref/inputs/untrusted/result graph 等更强数据边界 |
| 结果投影 | 中间结果留在脚本，最终汇总回父会话 | OpenPI 有单项与总量有界投影，几十 Agent 时需分层汇总 |
| 权限 | 继承 allowlist，Workflow Agent 使用 acceptEdits | OpenPI child 分类与角色白名单更严格 |
| 恢复 | 同 Session 调用前缀与 journal | OpenPI 有 content fingerprint、acceptance ledger 等审计优势 |

## 十、对 OpenPI 的直接启发

### 应当借鉴

1. **Workflow 启动默认不阻塞父 turn**，等待是显式同步点。
2. **先发现再动态展开**，不要让 Quick start 永远停留在两个手写 Agent。
3. **明确区分并发、计划总量和实际调用总量**，把解析后的 Runtime 边界告诉模型。
4. **一个 Workflow 聚焦一个可验证阶段**，关键决策回到父模型或用户。
5. **优先 pipeline，谨慎使用全局 barrier**。
6. **研究共享 token budget**，但在指标和恢复语义明确后再实现。
7. **几十个 Agent 必须分层汇总**，不能把所有完整结果一次性投进父上下文。

### 不应照搬

1. 不把 Prompt 当成权限边界；Runtime invariants 继续 fail-closed。
2. 不把 ultracode 或某个关键词做成僵硬路由器。
3. 不为了对齐 Claude Code 引入第二套 provider、Session 或 durable engine。
4. 不复制固定 `<5/<15/<50` 配置；OpenPI 首先应让模型看到真实任务工作项和用户约束。
5. 不把 Agent 数量当作性能或质量目标，最终仍用 benchmark、tokens、wall time、失败率和结果质量验收。

## 结论

Claude Code Workflow 的核心不是“能同时开很多 Agent”，而是把四个层次分开：

```text
用户授权
  -> 模型生成任务专属脚本
  -> Runtime 执行并强制资源边界
  -> 父 Session 在阶段之间做判断与综合
```

OpenPI 当前最需要补的不是更复杂的编排框架，而是三件高杠杆的小事：后台生命周期、模型可见的真实规模边界、以及“发现后动态 fan-out”的标准示例。Token budget 与分层汇总值得继续研究，但必须以可验证 Runtime 合同落地。
