# OpenPI Workflow V2：Pi-native 动态编排改进方案

> 日期：2026-08-23
>
> 状态：已在 `codex/workflow-v2` 实施；最终验证与真实模型 smoke 见文末实施记录。
>
> 依据：当前 OpenPI 源码、Issues #71/#74/#75/#90、Claude Code `2.1.241` 运行时合同访谈，以及三份相互独立的 interface 设计评审。
>
> 后续决定（2026-08-30）：Issue #132 / PR #139 将新调用策略收敛为 `wait`，同时为已发布的 `background` alias 保留迁移窗口。本文件保留 Workflow V2 落地时的历史合同与验证证据；当前行为以代码和当前用户文档为准，后续结果见文末 addendum。

## 结论

OpenPI 不需要重写 Workflow DSL，也不需要复制 Claude Code 的第二套 Runtime。当前 execution implementation 已经具备 sandbox、pipeline、parallel、结构化结果、refs、journal、replay、worktree、acceptance 和 dashboard。真正的问题集中在它的外部 interface 与生命周期默认值：

```text
现在：workflow 同时承担 start + wait，并默认 wait

目标：start 默认释放交互父 turn
      wait 只是显式调用策略
      stop 是唯一取消动作
      completion 可靠、可恢复地进入父会话
```

推荐建立一个更深的 `WorkflowRunCoordinator` module，模型侧只保留三个稳定工具：

```text
workflow
workflow_status
workflow_stop
```

模型决定任务拆分、fan-out、阶段和汇总；Runtime 强制授权、容量、权限、生命周期、取消、持久化、恢复和终态证据。

## 实施摘要

本轮没有把整个 2200 行 Workflow extension 塞进一个新的大类，而是按不变量拆成三个深 seam：

- `coordinator.ts`：宿主默认值、`wait/background` 兼容解析，以及 wait/terminal 仲裁；
- `result-delivery.ts`：逐 run delivery identity、pending/receipt/retry/restore；
- `shared/result-budget.ts` 与 `shared/text-projection.ts`：Subagent/Workflow 共用的公平预算与 head/tail 投影。

已经落地：

- TUI 默认 detached，print/无可靠投递宿主默认 wait；
- `wait:true` 是唯一正向同步选择，`background` 仅为 deprecated inverse alias；
- 中断 wait 不取消 run，stop/shutdown 才拥有取消权；
- terminal execution state 与 delivery state 正交持久化；
- send failure 以同一 per-run id 重试，成功 sibling 不重发；
- capability load 后三个工具一次稳定出现，spawn/settle 不改变 Schema；
- `workflow_status` 只给 bounded state/coverage，不重复完整结果；
- `usage().limits` 暴露实际并发和调用余量；
- Quick start 从固定两个 Agent 改为 discovery -> dynamic pipeline -> coverage report；
- handoff 对 64 个结果公平 water-filling，完整成功结果逐 Agent 落盘；
- 最终父投影根据 Pi 当前 context headroom 动态收窄，同时保留 head/tail 与 artifact 恢复路径。

明确没有增加：`workflow_wait`、size planner、budget planner、通用 Execution Fabric、daemon、全局 scheduler、递归 Workflow 或第二 provider stack。

## 1. 当前问题

### 1.1 默认阻塞

当前 `workflow` 使用：

```ts
const background = (params.background ?? false) && ctx.hasUI
```

省略参数时，工具会一直 `await completion`。Workflow 越长、Agent 越多，父会话越久不可用。

### 1.2 终态与完成投递不可靠

后台运行完成后只有一次 `pi.sendMessage()` 机会；失败会被吞掉。最终 artifact 写入失败时，磁盘也可能永久保留无解释的 `running`。运行终态和消息投递状态没有分开。

### 1.3 Tool schema 随实例状态变化

加载 Workflow capability 后最初只显示 `workflow`，第一次后台启动后才加入 `workflow_status` 和 `workflow_stop`。这会再次改变工具 schema，也把短暂的资源实例状态泄漏到能力 interface。

### 1.4 示例把模型锚定在少量 Agent

当前 Quick start 手写两个 scan Agent。虽然 Runtime 默认允许 8 并发、128 次总调用，模型仍容易把 Workflow 理解为“两个专家加一个汇总”，而不是先发现自然工作项再动态展开。

### 1.5 大 fan-out 汇总存在顺序偏置

Workflow handoff 目前按 ref 顺序拼接，然后受 16 KiB/项、48 KiB 总量限制。后面的结果可能被整体截掉。最终父会话投影也没有把 wrapper、Agent 清单和日志统一纳入动态预算。

## 2. 设计原则

### 模型拥有判断

- 是否需要 Workflow；
- 如何发现自然工作项；
- Agent 数量、角色与阶段；
- pipeline 与 barrier 的选择；
- 是否进行局部或全局 Report；
- 如何根据用户的成本、时间、数量和覆盖要求收缩或扩大。

### Runtime 拥有事实

- explicit/adaptive 能力授权；
- child authority 交集；
- 并发、调用总量和 admission；
- run id、持久化、取消、shutdown 和 cleanup；
- completed/failed/aborted/uncertain；
- completion pending/delivered；
- replay、artifact 和精确终态证据；
- 有界、公平的模型上下文投影。

### 不创建第二控制面

Pi 继续拥有 Session、Provider、模型、Trust 和普通工具。OpenPI 不增加 daemon、全局 scheduler、第二 provider stack 或跨进程 durable execution 承诺。

## 3. 模型 interface

### 3.1 `workflow`

```ts
workflow({
  script: string,
  args?: string,
  resume_from_run_id?: string,

  // 新的正向语义
  wait?: boolean,

  // 旧兼容参数，逐步 deprecated
  background?: boolean,
})
```

解析规则：

```text
显式 wait
  -> 严格服从

只有 background
  -> wait = !background

两者同时出现且语义冲突
  -> fail closed

两者都省略
  -> adapter.canDeliverLater = true：wait = false
  -> adapter.canDeliverLater = false：wait = true
```

为什么推荐 `wait`：

- 它描述调用者行为，而不是把“是否后台”误当成执行所有权；
- `wait: true` 是显式 barrier；
- `wait` 被中断只结束等待，不能隐式取消 run；
- 只有 `workflow_stop` 取消运行。

兼容期保留 `background`，避免旧模型调用和历史脚本立即失效。

### 3.2 `workflow_status`

```ts
workflow_status({ runId?: string })
```

它只负责非阻塞 observation：

- 无 ID：列出本 Session 当前和最近 runs；
- 有 ID：返回状态、phase、Agent、coverage 摘要和 artifact 位置；
- 不等待；
- 不消费结果；
- 不改变执行状态。

`workflow_status` 不重复返回完整 final projection。Pending 或 delivered 状态都只提供 bounded summary 与 artifact 位置；automatic completion 或 `wait:true` inline receipt 才是完整主动交付通道。这样 observation 不会和 completion turn 竞争，也不会让一次完成结果进入模型两遍。

不增加 `workflow_wait`，也不把 `wait` 塞入 status。同步已经能由 `workflow({ wait: true })` 表达；普通后台 completion 由 Runtime 自动重新唤醒父模型。

### 3.3 `workflow_stop`

```ts
workflow_stop({ runId: string })
```

它是唯一取消入口，并且幂等：

- running -> 请求 abort，返回 aborting；
- terminal -> 返回已有终态；
- 未知或后缀冲突 -> 确定性错误。

## 4. 深 module：`WorkflowRunCoordinator`

外部 interface：

```ts
start(
  spec,
  { wait, signal, completionAdapter },
): Promise<
  | { mode: "detached"; receipt: LaunchReceipt }
  | { mode: "inline"; receipt: CompletionReceipt }
>
inspect(query): WorkflowSnapshot
stop(runId): StopReceipt
```

Implementation 内部可以由 `startRun()` 产生 `{ launch, completion }`，但 completion Promise 不泄漏到 tool handler。Coordinator 自己负责注册 inline wait interest、处理中断、消费对应 automatic delivery，并返回正确的 discriminated receipt。

Implementation 隐藏：

- run id 和目录生成；
- initial intent 原子写入；
- active registry 与 controller；
- sandbox 与 child Pi Session；
- agent ledger、phase、usage 和 graph；
- replay、journal、acceptance 和 handoff；
- inline wait interest；
- terminal persistence；
- completion pending/outbox/delivery；
- parent busy/idle race；
- session shutdown 与 stale-run reconciliation；
- UI、模型 context 和 artifact 三种投影；
- #90 的公平 handoff 与父上下文预算。

这个 module 的 depth 来自：调用方只学习 start/inspect/stop，却获得完整生命周期 leverage；错误和修改集中在一个 seam，避免继续散落在 tool handler、`finally()`、session hooks 和 renderer 中。

## 5. Adapter 与依赖

### 5.1 `WorkflowCompletionAdapter`

这是一个真实 seam，因为至少有两个 production adapter：

```ts
interface WorkflowCompletionAdapter {
  canDeliverLater: boolean
  isParentIdle(): boolean
  deliver(
    envelopes: readonly {
      deliveryId: string // workflow:<runId>:terminal
      runId: string
      content: string
    }[],
  ): Promise<DeliveryReceipt[]>
}
```

- Pi interactive adapter：自动 completion turn；
- print/automation adapter：默认 inline wait；
- 未来 Web/RPC adapter：只有拥有可靠事件通道时才允许 later delivery。

不能继续用 `ctx.hasUI` 代替这个 interface。UI 存在不等于能可靠异步交付结果。

幂等 identity 属于每一个 terminal result，而不是 transport batch。Batching 只能优化发送；某一批部分成功时，各 envelope 的 receipt 必须能独立提交和重试，不能用一个 batch id 猜哪些 run 已送达。

### 5.2 Artifact store

属于 local-substitutable 依赖：生产使用 run-directory filesystem adapter，测试使用临时目录或内存 adapter。它是 coordinator 的内部 seam，不暴露给模型。

### 5.3 Agent execution

Pi child Session 仍是唯一 implementation。保留现有测试注入 seam，不建立新的 provider adapter。

### 5.4 Shared delivery

Subagent、Background Terminal 和 Workflow 都需要 pending、drain、restore 和 parent-settled batching。应收敛成 shared module，但 Workflow 的持久 outbox 可以先由 coordinator 私有拥有，等第二个消费者出现跨 Session 恢复需求后再深化。

## 6. 生命周期不变量

### 6.1 启动

1. 先完成 preflight 和 launch record 原子持久化，再启动 sandbox。
2. 初始持久化失败不得产生真实 run。
3. handle 返回后，父 tool signal 不再拥有 run。
4. 显式 `wait: false` 但 adapter 无 later-delivery 能力时必须报错，不能静默退化成 blocking。

### 6.2 执行与等待

```text
execution:
running -> completed | failed | aborted | uncertain

delivery:
none -> held-for-inline -> consumed-inline
                        -> pending -> delivered
none -----------------> pending -> delivered
```

`wait` 只控制当前调用是否等待。中断 wait 不取消执行；stop 或 session shutdown 才取消。

Wait cancellation 与 terminal inline consumption 必须经过同一个原子仲裁门：

```text
abort 先赢
  -> release held-for-inline
  -> terminal delivery=pending
  -> 后续 automatic completion

terminal 先赢
  -> coordinator 确定会返回 CompletionReceipt
  -> terminal delivery=consumed-inline
  -> 同时到达的 wait abort 不再覆盖已完成结果
```

`consumed-inline` 不能仅凭“曾登记 wait interest”写入；只有 coordinator 已原子赢得 terminal 分支并承诺返回 CompletionReceipt 后才可提交。否则结果必须进入 pending，确保后续自动交付。

### 6.3 终态与投递顺序

```text
terminalize execution
  -> 原子提交 terminal evidence
     + delivery=pending 或 consumed-inline
  -> pending 才尝试投递
  -> 成功后逐 run 标记 delivered
```

如果底层存储无法一次原子提交两个字段，恢复规则必须等价：任何 terminal 且没有 `delivered` 或 `consumed-inline` receipt 的 run，在 Session 恢复时确定性重建为 pending。`wait:true` 的 interest 必须在 run 启动前登记为 `held-for-inline`，再由上述原子仲裁决定 `consumed-inline` 或 `pending`，避免 automatic delivery 抢先或 wait 中断丢失结果。

投递采用 at-least-once + 每 run stable delivery id。正常运行时按该 id 防止重复排队；若进程恰好在 Pi 接受消息之后、receipt 落盘之前消失，恢复时可能重投同一 id。没有接收侧原子去重就不宣称 exactly-once。

### 6.4 Busy/idle race

当前 busy 时降级为 `nextTurn` 会要求用户再发消息才能唤醒，应改成与 Subagent 一致的双边闭合：

```text
run 在 parent idle 后完成
  -> 立即 followUp + triggerTurn

run 先完成、parent 后 settle
  -> defer
  -> agent_settled
  -> 批量 followUp + triggerTurn
```

快速 Workflow 在 launch tool 尚未返回时完成，也必须恰好产生一次 completion turn。

### 6.5 Tool schema 稳定

Workflow capability 一旦加载，立即一次性显示：

```text
workflow
workflow_status
workflow_stop
```

start、settle、stop 和 dashboard 都不得改变工具 schema。

## 7. 模型提示合同

常驻工具描述保持紧凑，完整 recipe 放在 Skill。核心信息应包括：

```text
- 用户明确请求 Workflow 或任务确实需要多阶段动态 fan-out 时使用。
- 交互 Session 默认立即返回 run id，完成后自动交付；只有当前 turn 必须同步消费结果时才 wait。
- 根据可独立验证的自然工作项和任务难度决定 fan-out；用户明确的成本、数量、模型和 effort 要求优先。
- 并发是 Runtime ceiling，不是 Agent 目标数，也不是总调用量。
- 当前 Session 的有效并发为 {resolvedConcurrency}，每 Run 最大调用为 {resolvedMaxCalls}。
- 未知工作集合先结构化 discovery，再 pipeline；检查每个结果并报告 planned/completed/failed/dropped。
- pipeline 是默认；parallel 只用于真实 all-results barrier。
- 非平凡脚本先读 Workflow Skill。
```

### 7.1 Quick start

当前固定两个 scan Agent 的例子应替换为：

```text
Discover structured items
  -> validate and deduplicate
  -> dynamic pipeline over items
  -> conditional verification
  -> Report with explicit coverage counts
```

Agent 数量来自 inventory 输出，不来自固定 3、8 或 15。

### 7.2 一个 Workflow 一个可验证阶段

把这条写进 Skill guidance，但不做 Runtime 状态机：

```text
Understand Workflow -> parent judgment
Design Workflow     -> user/parent judgment
Implement Workflow  -> parent judgment
Review Workflow
```

Workflow 运行中没有自然用户输入点，关键决策应回到父 Session。

## 8. 预算与汇总

### 8.1 现在提供精确 call capacity

扩展现有 `usage()`：

```ts
usage() => {
  input,
  output,
  cacheRead,
  cacheWrite,
  total, // 继续标明是 lower bound
  cost,
  agents,
  limits: {
    concurrency,
    maxAgentCalls,
    remainingAgentCalls,
  },
}
```

调用次数与剩余 admission 是精确 Runtime facts，可以帮助模型动态收缩。

### 8.2 暂不实现硬 token budget

Claude 当前有可读取的硬 token budget，但 OpenPI 的 provider usage、cache、compaction、重试和 replay 口径尚不能构成可证明的统一天花板。现在照搬会产生虚假精确性。

应等以下问题明确后再单独设计：

- input/output/cache 是否都计入；
- 父会话和 Workflow 是否共享；
- replay 是否再次扣减；
- provider 未返回 usage 时如何 fail closed；
- 超限是拒绝新 Agent、取消运行还是只告警。

### 8.3 分层 Report

小 fan-out 可以使用现有 refs/inputs。大 fan-out 应：

```text
leaf Agents
  -> 若干 local Report Agents
  -> 一个 global Report Agent
  -> bounded parent projection
```

Runtime 不自动插入 Report Agent。当前已提供：

- 按 ref 公平 water-filling；
- partial 文本标签与 head/tail 投影；
- 每个成功 Agent 的 run-relative audit artifact（不是 child 可直接读取的 handle）；
- 父 context 动态 headroom 与统一 message budget。

模型决定分组大小和层数；Workflow 脚本负责维护 planned/selected/covered/failed/deferred 计数。当前没有机器可读的 Runtime coverage manifest，不应把公平出现误称为完整证据覆盖。

## 9. 为什么现在不做通用 Execution Fabric

灵活性评审提出了统一 handle/event/barrier：让 Workflow、Subagent 和 Background Terminal 可以一起 `await all/any/quorum`。它在未来有 leverage，但目前没有足够真实 trace 证明需要公开给模型。

现在可以保留内部兼容方向：

- 启动结果逐步采用一致的 `{ kind, id, sessionId, generation }` identity；
- 完成事件使用共享 envelope；
- result projection 使用共享预算 module；
- 每个 owner 仍保存自己的 authoritative state。

暂不新增 `await_executions`。只有真实 trace 经常出现跨 family barrier，并且 benchmark 证明它减少轮询或模型轮次时再开放。

直接否决条件：

- 需要 daemon、global scheduler 或第二份 authoritative registry；
- Fabric 开始创建、取消或恢复 execution；
- 必须新增两个以上公共模型工具；
- reload/exit 后无法解释 handle 状态；
- 相比最小 async Workflow，中位额外模型轮次增加 1 次以上；
- 找不到真实跨 family barrier 用例。

## 10. 实施顺序

### Phase 0：固定基线

- 当前 blocking/background 行为；
- tool schema hash；
- sendMessage、final write、busy/idle、quick-completion 故障注入；
- 3/16/40 ref handoff 覆盖基线。

### Phase 1：#71 可靠事实

- terminal persistence；
- pending delivery receipt；
- stable delivery id；
- retry、正常运行时去重，以及 receipt 持久化失败时保留同一 delivery id；
- stale `running` 归并为明确 `uncertain`。

### Phase 2：抽取 coordinator，不改行为

- 把 active registry、controller、settlement、delivery 和 shutdown 收进深 module；
- 旧 e2e 继续全绿；
- tool handler 变成薄 adapter。

### Phase 3：稳定工具组

- capability load 时一次显示三个工具；
- 删除第一次 background run 后的 `showLifecycleTools()`；
- launch/settle 前后 schema hash 不变。

### Phase 4：`wait` 与宿主默认值

- 新增 `wait`；
- `background` 兼容映射并 deprecated；
- interactive/Web/RPC adapter 有可靠 completion channel 时默认 `wait=false`；
- print/automation 默认 `wait=true`；
- wait interrupt 不取消 run；
- stop 幂等；
- completion race 对齐 Subagent。

### Phase 5：模型 leverage

- 注入 resolved concurrency/max calls；
- 扩展 `usage().limits`；
- Quick start 改成 discovery -> dynamic pipeline；
- 增加“一次 Workflow 一个可验证阶段”与显式 coverage 计数 guidance。

### Phase 6：#90 大规模汇总

- 公平 handoff；
- run-relative result audit artifact；
- hierarchical Report guidance；
- dynamic parent context projection；
- 16+ Agent 结果顺序不影响覆盖。

### Phase 7：真实 Benchmark 决策

- 先跑 deterministic lifecycle gates；
- 再做 provider/request-shape/cache probe；
- 最后跑自然需要 Workflow 的 paired model benchmark；
- 每一 Phase 独立留 ledger，避免把收益归到错误改动。

## 11. 验证矩阵

### 11.1 确定性 Gate

| 项目 | 验收 |
|---|---|
| TUI 默认启动 | 注册 run 后立即返回，不等首个 Agent |
| Parent unavailable time | 相比 blocking 基线下降至少 90% |
| Quick completion | 无故障窗口内 100/100 单次 completion；故障重投保持同一 delivery id |
| Busy parent | 不打断当前 turn；settle 后自动唤醒 |
| Delivery failure | 首次失败可重试，无永久丢失和双重展示 |
| Terminal write failure | 无无解释 `running` |
| Wait interrupt | run 继续，status 可查 |
| Repeated stop | 幂等 |
| Schema stability | capability load 后 start/settle hash 不变 |
| Noninteractive | 省略参数仍在本 invocation 获得 final result |
| Reload/shutdown | 明确 aborted/uncertain，不宣称 durable resume |
| Handoff fairness | 改变 ref 顺序不改变覆盖数量 |

### 11.2 模型 Feature Probe

固定同一模型、effort、仓库 snapshot、任务、授权方式、并发、总调用上限和 tool surface，采用最小 2×2：

```text
             当前 Prompt       Dynamic Prompt
Blocking          A                  C
Async             B                  D
```

- A/B 只验证 lifecycle 对 parent availability、turns、tokens 和完成投递的影响；
- A/C 只验证 dynamic discovery 对 fan-out、coverage 和质量的影响；
- A/D 是最终产品组合效果，不用来归因单个机制。

任务应分别产生约 3、12、40 个自然工作项，再增加一个依赖 DAG。

记录：

- 是否只调用一次 workflow；
- planned/admitted/actual/covered/failed/dropped；
- peak concurrency；
- invalid script；
- launch-to-parent-idle；
- completion loss/duplicate；
- parent 与 nested tokens；
- cache read/write 和 tool schema hash；
- wall time、成本和最终 coverage。

### 11.3 中性价值 Benchmark

历史短 coding benchmark 中高级能力采用率经常为 0，不能验证 Workflow 价值。应预注册自然需要动态 fan-out 的任务：

- 多模块安全或架构审计；
- 大规模迁移与失败长尾；
- 多来源事实核验；
- discovery 后工作项数量才知道的任务；
- 16+ Agent 分层汇总。

对比：

```text
Bare Pi
Direct Subagents
OpenPI Workflow
```

主要指标是 verifier/coverage/遗漏率；Agent 数量不是成功指标。次要指标包括 parent turns、tool calls、tokens、cache、wall time、恢复率和用户干预。

否决标准：

- task pass@1 低于 blocking 基线；
- 产生仅用于 polling/status 的额外模型轮次；
- completion 丢失、重复或假终态非零；
- fan-out 固定在 3、8、15，而不随工作项变化；
- 16+ Agent 报告因 refs 顺序变化而漏掉不同证据；
- 相比 Direct Subagents 没有质量、覆盖或恢复收益，却显著增加 tokens/wall time。

## 12. 明确不做

- 不增加 `workflow_wait`、size planner 或 budget planner 工具；
- 不采用 Claude `<5/<15/<50` size buckets；
- 不使用 CPU 核数公式决定并发；
- 不绑定 ultracode 与 Workflow 授权；
- 不采用 Prompt-only 权限；
- 不允许 child Workflow 或递归 team；
- 不自动插入固定 Report Agent；
- 不建立 `.claude/workflows/` 对等模板体系；
- 不宣称跨 reload/exit durable execution；
- 不引入第二 provider、Session、daemon 或 scheduler；
- 不以 Agent 数量替代质量证据。

## 13. 最终推荐路径

```text
#71 可靠终态与投递
  -> 深化 WorkflowRunCoordinator
  -> 稳定三工具 interface
  -> #74 默认释放父 turn
  -> #75 动态 discovery/fan-out 提示合同
  -> #90 公平 handoff 与分层 Report
  -> paired Benchmark 决定是否继续扩面
```

一句话产品合同：

> 用户只需明确要求 Workflow；模型根据自然工作项和任务难度生成一次任务专属脚本；OpenPI 立即释放交互父 turn，在 Pi lifecycle seam 后有界执行、可靠投递，并以 coverage 与 artifact 证明没有把失败或遗漏伪装成成功。

## 14. 实施与验证记录

### 14.1 确定性验证

实施分支：`codex/workflow-v2`，基线 `origin/main@494f74f`。

```text
bun run check
  format: pass
  lint --error-on-warnings: pass
  typecheck: pass

bun run test
  Node: 859/859 pass
  Vitest: 30/30 pass
```

专项覆盖包括：interactive/print 默认值、legacy alias 冲突、wait 中断、terminal/abort 仲裁、busy/idle delivery、首次 transport failure、逐 run receipt、legacy restore、`uncertain` 独立统计、稳定工具组、64-ref 公平 head/tail handoff、64-run completion 批次预算、动态父上下文投影和逐 Agent artifact。

### 14.2 真实模型 smoke

运行资产与 npm 安装隔离，直接从本 checkout 显式加载 `extensions/workflows/index.ts`、`extensions/capabilities/index.ts` 和 Workflow Skill。父模型为 `seal/deepseek-v4-flash-0731-baidu`；三个 Workflow children 按本地角色配置使用 `gpt-5.6-luna`。print 宿主省略 `wait/background`，因此按合同 inline 等待。

真实 run `wf_6664b8e3427d`：

- 3/3 child sessions 实际启动并完成；
- 逐 Agent artifact：`agent-results/agent-0001.json` 至 `agent-0003.json`；
- run `completed`，delivery `consumed-inline`，result 在 `result.json`；
- 父 DeepSeek 最终报告 coverage `2/3`：delivery 与 fan-out PASS，lifecycle FAIL；
- FAIL 找到真实缺口：硬进程丢失后的 stale `running` 只做读取时内存归并，没有持久化 terminal/delivery；
- 随后修复为 Session restore 时回写 `uncertain + pending`，明确提示 owner-loss 后外部副作用未知，保留同一 delivery id，再进入 outbox；对应恢复测试已补并通过。升级前已经终结且没有 delivery 字段的旧 run 不会被意外重放。

模型侧也暴露一次可观察的修正成本：第一次脚本把宿主常量名写错，产生一个 0-Agent failed run；DeepSeek 读取错误后用 `args` 修正并重新发起正确 run。Runtime 没有掩盖失败，artifact 保留了两次事实。该现象属于模型生成脚本质量，不应通过新增 rigid planner 或隐藏重试状态来“修平”。

### 14.3 当前结论

Lifecycle、delivery、Schema stability、dynamic capacity、fair projection 和 artifact 证据链已经实现并有确定性或真实模型证据。尚未把通用 Execution Fabric 暴露给模型，也没有自动插入 Report Agent；这两项是刻意不做，而非未完成缺口。真正的大规模质量仍应通过后续冻结配置的 2×2 benchmark 决定，不用单次 smoke 冒充跑分提升。

## 15. 后续合同变更（2026-08-30）

Issue #132 / PR #139 将 `wait` 作为唯一推荐的新调用策略。由于 `background` 从 OpenPI v0.2.0 起就是已发布输入，本次继续把它作为 deprecated inverse alias 接受：`background: true` 对应 `wait: false`，`background: false` 对应 `wait: true`；真正删除只在另行公告的 breaking release 进行。除这一已发布兼容字段外，未知输入继续 fail closed。

Coordinator 在单一输入边界完成 legacy 映射，内部仍只产生 `inline | detached` 运行模式。`WorkflowDetails.background` 与 persisted artifact 中的同名字段继续记录实际 detached 状态，不记录调用时使用的是 `wait` 还是兼容 alias，也不改写历史 artifact。

该后续变更的最终验证以 PR #139 exact-head review 为准，至少包括：

- `wait`、legacy `background`、冲突输入、host delivery 能力和 wait interruption 的专项测试；
- `bun run check`；
- `bun run test`；
- GitHub CI：Node 22.19.0、Node 24 与 Windows background-terminal suite。
