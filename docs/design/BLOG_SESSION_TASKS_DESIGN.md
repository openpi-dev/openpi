# 稳定 ID 还不够：Agent Tasks 如何避免变成第二个 Workflow

把旧 `TodoWrite` 简化到最能说明问题的部分，接口大致长这样：

```json
{
  "todos": [
    { "content": "读代码", "status": "completed", "activeForm": "正在读代码" },
    { "content": "改实现", "status": "in_progress", "activeForm": "正在改实现" },
    { "content": "跑测试", "status": "pending", "activeForm": "正在跑测试" }
  ]
}
```

每次更新，模型都要重写整张表。

Claude Code 后来换成了另一套接口：

```text
TaskCreate
TaskUpdate(taskId, patch)
TaskList
TaskGet
```

变化看起来不大，无非是把一个工具拆成四个。`taskId` 才是关键：不同工作项可以增量更新，不必每次覆盖整张 Todo 表。多个 agent 同时改同一项，仍然需要串行写入或冲突规则；稳定 ID 不负责解决这个问题。

我们在给 Pi 扩展包设计 Task 时，最初也沿着这条路走。三份独立评审都跑完了：Fable 5 建议实现，Opus 5 和 GPT-5.6 Sol 要求先改设计。随后 Fable 与 Opus 完成交叉质询，Sol 的交叉质询超时，最后由 Opus 汇总。持久化顺序必须可靠，上下文不能留下旧快照，Task 也不能抢 Workflow 的活。漏掉任何一项，这套东西都会变成第二个 Workflow，或者一台不断往 Context 里倒垃圾的机器。

## Todo 一跨回合，身份就开始含糊

Todo 很适合短任务。

模型要读代码、改实现、跑测试，写一张清单，做完一项勾一项。OpenAI Codex 当前的 `update_plan` 基本就是这个模型：每个 step 只有文本和状态，状态也只有 `pending / in_progress / completed`。它甚至明确写着：这是 TODO/checklist 工具，不是 Plan Mode。

```rust
pub struct PlanItemArg {
    pub step: String,
    pub status: StepStatus,
}

pub struct UpdatePlanArgs {
    pub explanation: Option<String>,
    pub plan: Vec<PlanItemArg>,
}
```

源码在 Codex 的 [`plan_tool.rs`](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/plan_tool.rs)。这个设计很轻，代价也清楚：更新仍然是整表覆盖，没有稳定 ID、阻塞原因和单项增量修改。

短任务里，这些都不是问题。任务一旦跨过多个 turn、一次 compaction，或者中间派出两个 subagent，Todo 就开始含糊：

- 这条工作还是原来那条，还是模型重新写出来的同名条目？
- 一个 subagent 失败了，是任务失败，还是这次尝试失败？
- Context Pivot 以后，模型应该续做旧任务，还是重新建一张清单？
- 两个并行更新同时回来，谁覆盖谁？

Claude Agent SDK 把 `TodoWrite` 换成 `TaskCreate / TaskUpdate / TaskGet / TaskList`，就是在补这层身份。官方迁移文档要求调用方按 Task ID 累积状态，而不是每次替换整个列表。这个变化从 TypeScript Agent SDK `0.3.142` 起成为默认行为，见 [Todo tracking 文档](https://code.claude.com/docs/en/agent-sdk/todo-tracking#migrate-to-task-tools)。

所以我们要做一份 **Session Tasks**。Todo UI 漂不漂亮无关紧要；它要记住“还有什么工作”，但不能接管“工作怎么执行”。

## 先把 Task 放回正确的位置

我们的 Pi 扩展里已经有两套执行能力：

```text
Subagent   一次独立委派
Workflow   多阶段 fan-out、依赖和汇总
```

Task 再去派发工作，就会出现第三套执行协议。这个方向很诱人：给 `subagent_spawn` 加一个 `task_id`，子 agent 启动时自动把 Task 改成 `in_progress`，结束后自动勾成 `completed`。看起来很顺。

问题也从这里开始。

子 agent 返回成功，只说明它正常结束了。它可能漏读文件，可能只写了一半，也可能测试根本没跑。父 agent 还没看结果，Task 已经显示完成，这份任务记录就从“提醒”变成了“制造错误信心”。

Maka 的 [Session Tasks 文档](https://github.com/maka-agent/maka-agent/blob/f9e78d17e1ae42e3428390baf9d458cf4f30a00b/docs/session-task-ledger-lifecycle.md) 给了我们一个很重要的约束：**子 agent 可以认领 Task，但没有完成权。** 即使子 agent 成功返回，父 agent 也要审查结果，再写入完成证据。

我们把这条约束再收紧了一步：v1 连认领都不做。

```text
Tasks 记录意图
Subagent / Workflow 执行工作
文件、Git、测试、工具结果才是事实
```

Task 状态只能是提示。它不能推翻仓库里的真实状态，也不能因为某个进程退出码为 0 就宣布工作完成。

这条 seam 一旦守住，后面的设计反而简单了。

## 第一版先撞上了持久化

第一版 [`TASKS_DESIGN.md`](https://github.com/tt-a1i/my-pi-setup/blob/main/docs/design/TASKS_DESIGN.md) 写完后，我们让 Fable 5、Opus 5 和 GPT-5.6 Sol 分别评审。Fable 与 Opus 完成交叉质询，Sol 在这一轮超时，最后由 Opus 5 汇总。完整裁决保存在 [`TASKS_EVALUATION.md`](https://github.com/tt-a1i/my-pi-setup/blob/main/docs/design/TASKS_EVALUATION.md)。

| 模型 | 独立结论 | 置信度 |
| --- | --- | ---: |
| Claude Fable 5 | implement | 4/5 |
| Claude Opus 5 | revise | 4/5 |
| GPT-5.6 Sol | revise | 5/5 |

评审模型对需求本身没有太大分歧。争议都落在代码怎么写。Opus 5 找到的两个问题，直接推翻了第一版持久化方案。

### `before_agent_start.message` 不是临时上下文

我们原本计划在每轮开始时，把当前 Task 摘要注入模型：

```text
T2 [in_progress] 实现 Tasks
T3 [blocked] 验证分支恢复，需要 fork 测试
```

预算设成 4000 字符，看上去已经很克制。

但 Pi 的 [`before_agent_start`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#before_agent_start) 返回值里，`message` 的定义是：

> Inject a persistent message (stored in session, sent to LLM)

它会落进 Session。每轮注入一次，就会永久留下一个旧快照。十轮以后，模型同时看到十份互相矛盾的 Task 状态，Context 也白白变大。缓存仍能复用前面的共同前缀，但请求会带着越来越多已经过期的尾部内容。

正确的入口是 Pi 的 `context` hook。它在每次 LLM 请求前触发，可以临时改写这次请求的 messages，不落盘。下面是伪代码，省略了具体的 `AgentMessage` 构造：

```ts
pi.on("context", (event) => ({
  messages: [...event.messages, buildTasksContextMessage(snapshot)],
}));
```

投影放在消息尾部，不去改前面的共同前缀。它最大的好处是用完即弃，不会把旧状态留到下一轮。预算也从 4000 字符砍到 800。没有未完成 Task 时，一个字都不注入。

这一步不高级，但少了它，Tasks 会自己污染 Context。

### Pi 官方 Todo 示例也会遇到并发顺序问题

Pi 的 [`todo.ts` 扩展示例](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/todo.ts)把完整快照放进 tool result 的 `details`：

```ts
return {
  content: [...],
  details: { todos: [...todos], nextId },
};
```

恢复时扫描当前分支，取最后一份快照。这个办法天然支持 `/tree`、`/fork` 和 `/resume`，第一眼很适合复用。

麻烦在并行 Tool Call。

Pi 可以同时执行同一条 assistant message 里的多个工具。工具实际完成的顺序，和最终 tool result 写入 Session 的顺序不一定相同。假设两个更新并行执行：

```text
A 完成：snapshot revision 11
B 完成：snapshot revision 12
```

最终 Session 可能按 assistant 源顺序先写 B、后写 A。重启后“最后一份快照”变成 revision 11，B 的修改消失。

这不是理论边角。Task 工具恰好很容易被模型并行调用。

最终方案改成：变更真正生效时，立即写一个 Pi Custom Entry。

```ts
pi.appendEntry("session-tasks", snapshot);
```

[`appendEntry`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md#piappendentrycustomtype-data) 写入的 Custom Entry 会持久化，但不进入 LLM Context。写入顺序就是变更应用顺序。快照再带一个单调递增的 `revision`。恢复时先定位当前分支上 revision 最大的候选；同 revision 取位置靠后的一个。这个候选如果损坏或版本未知，直接恢复失败，不能跳回更旧快照。

Tool result 只返回本次变更，供模型和用户确认，不再承担持久化。

### 状态机差点长成第二个 Workflow

第一版 Task 有六种状态、严格转移图、Owner、三种证据字段、显式 reopen，后面还打算接 Subagent。

```text
pending -> in_progress
in_progress -> blocked/completed/failed/cancelled
blocked -> in_progress/failed/cancelled
...
```

这套状态机单独看没问题，放进模型工具就太重了。评审认为模型会频繁把刚创建的 Task 直接标记完成。严格禁止 `pending -> completed`，只会制造一次失败 Tool Call，再逼模型补一个没有业务价值的 `in_progress`。

GPT-5.6 Sol 还指出，advisory tasks 里的 `failed` 很含糊：失败的是任务，还是某次尝试？如果工作仍然要做，它应该回到 `pending`；如果缺条件，它应该是 `blocked`；如果决定不做，叫 `dropped` 更准确。

最后留下五个状态：

```ts
type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "done"
  | "dropped";
```

允许任意状态互转。`blocked / done / dropped` 必须带 `note`：

- blocked：缺什么条件；
- done：看过什么证据；
- dropped：为什么不再做。

系统不会假装自己验证了 Note。它只是把这句话展示给用户审计。证据如果没人看，就是仪式感。

## 最后留下来的接口

我们没有沿用 `task_*`，而是选了 `tasks_*`：

```text
tasks_add
tasks_update
tasks_list
```

原因很实际。Claude Code 曾长期用 `Task` 指子 agent；这个扩展包里又已经有真正执行工作的 `subagent_spawn`。工具说明写十遍“不执行任务”，也不如先把名字选对。

每个工具的第一句话固定为：

> 记录当前 Session 的工作意图；不执行、不调度、也不委派任何工作。

数据模型也压到了很小：

```ts
interface TaskItem {
  id: number;
  subject: string;
  detail?: string;
  status: "pending" | "in_progress" | "blocked" | "done" | "dropped";
  note?: string;
}

interface TaskSnapshot {
  version: 1;
  revision: number;
  nextId: number;
  items: TaskItem[];
}
```

没有 Owner，没有 Deadline，没有 Priority，没有依赖图。那些字段以后可能有用。v1 每加一个，Tasks 都更像调度器。

字段还有几条硬限制：`subject` 最多 120 字符，`detail` 和 `note` 各 500；离开 `blocked / done / dropped` 时清掉旧 note，除非这次更新同时写入新 note。三个 `tasks_*` 工具只能由父 Session 使用，Pi Subagent 和 Workflow 子会话统一从共享 denylist 排除。

我们也没有只设 Task 数量上限。100 条 Task，每条带 1000 字描述和 1000 字证据，一份快照就可能超过 200 KB；每次更新再写一遍，Session 文件会按变更次数快速膨胀。

v1 直接限制序列化快照：16 KB。一次 Mutation 如果让快照超限，在修改内存前就拒绝。不能截断，因为被截掉的可能正是未完成工作。

## 分支里的 T3，不保证全局唯一

Pi Session 是一棵树。

```text
           T1, T2
          /      \
branch A: T3     branch B: T3
```

两个分支都可能创建自己的 T3。这符合分支语义。T3 在祖先链上稳定，在整个 Session 文件里不全局唯一。

为了让这个边界不骗人，我们不会给显示 ID 套一层“全局身份”的想象。恢复快照时还要做两件事：

```text
nextId = max(snapshot.nextId, maxItemId + 1)
newest revision malformed -> fail closed
```

不能遇到坏快照就悄悄退回上一版。上一版的 `nextId` 可能更小，后续重新分配 T3，同一条分支里就出现两个意思不同的 T3。宁可显示 Tasks 恢复失败，也不要把旧状态装成新状态。

## 为什么 v1 不接 Footer，也不接 Subagent

我们刚给 Pi Footer 做完一轮配置，里面有一条原则：Subagent、Workflow、后台终端属于运行状态，必须始终可见。

未完成的 Task Item 只是一份意图记录。它可能放在那里几小时，也可能只是用户暂时不做的提醒。把 `tasks 7 open` 常驻 Footer，会把意图伪装成正在运行的工作，还会一直占一行。

所以 v1 只提供：

- 紧凑 Tool Renderer；
- 一个只读 `/tasks`；
- 每次请求前最多 800 字符的临时投影。

Subagent 联动也不做。后面真要加 `task_id`，边界仍然是：Spawn 成功可以记录关联，子 agent 成功不能自动写 `done`。父 agent 看完结果，才能把证据写进去。

我们还发现一个更眼前的问题：本机已经安装了 `~/.pi/agent/extensions/todo.ts`。Todo 和 Tasks 同时暴露给模型，工具选择一定会乱。Tasks 上线前，这个旧工具必须停用；否则宁可不注册新工具。

## 先设删除条件，再写代码

Tasks 很容易越做越像项目管理软件。我们给 v1 留了一个不太体面的出口：用十个长 Session 做 dogfood，如果没有证明价值，就删掉。

检查四个数字：

```text
每个完成项的 Mutation 次数       <= 3
Context Pivot 后重复建单率       = 0
Task Entry 占 Session JSONL    < 5%
done note 可核查证据比例         >= 70%
```

至少要包含一次 Context Pivot 和一次 Fork。

如果稳定 ID 和 `blocked` 状态比 Codex 那种整表 Checklist 好不到哪里去，就别继续堆 Owner、依赖和 Agent Team。模型要是只会频繁改状态，`done note` 又全是“已完成”这种空话，这个实验已经失败了。

删掉它。

一套 Task 设计有没有用，不看它能表示多少状态。先看第三轮失败以后，它还记不记得什么没做；再看恢复以后，它有没有骗你。
