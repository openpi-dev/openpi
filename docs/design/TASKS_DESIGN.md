# Session Tasks — Research and Proposed Design

Status: implemented as `extensions/tasks/` after the multi-model revisions in [TASKS_EVALUATION.md](TASKS_EVALUATION.md). Historical alternatives below explain the design path; the implementation and evaluation document are authoritative for current behavior.

## Decision

My Pi Setup should add **session-scoped Tasks**, but it should not copy Maka wholesale and should not replace Subagents or Workflows.

Session Tasks answer: **what work remains, what is active or blocked, and what evidence supports completion?**

They do not execute work. Subagents execute one delegated task; Workflows execute staged fan-out; Session Tasks record user/model intent across turns, compaction, resume, and branch navigation.

## Primary-source findings

### Claude Code / Agent SDK

Anthropic migrated from replace-all `TodoWrite` to ID-addressed Task tools. The official Agent SDK docs describe:

- `TaskCreate` adds an item;
- `TaskUpdate` patches one item by `taskId`;
- `TaskList` and `TaskGet` read the task list;
- create input supports `subject`, `description`, `activeForm`, `metadata`;
- update additionally supports status, `addBlocks`, `addBlockedBy`, `owner`, and deletion;
- status is `pending`, `in_progress`, `completed`, with `deleted` as removal;
- the ID is returned by `TaskCreate`, not supplied by the model.

The TypeScript Agent SDK changelog records the switch at SDK 0.3.142 and says consumers should accumulate by task ID instead of replacing a snapshot list.

Sources:

- <https://code.claude.com/docs/en/agent-sdk/todo-tracking#migrate-to-task-tools>
- <https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md#03142>

The useful idea is stable identity plus incremental updates. Claude's dependency and owner fields are useful for Agent Teams, but are beyond our v1.

### OpenAI Codex

Codex's current `update_plan` remains a replace-all checklist, explicitly described as a TODO/checklist rather than Plan mode:

```text
PlanItemArg { step, status }
status = pending | in_progress | completed
UpdatePlanArgs { explanation?, plan[] }
```

The tool schema says at most one item may be `in_progress`. The handler emits a `PlanUpdate` event and returns `Plan updated`; it is rejected in Plan mode.

Sources:

- <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/plan_tool.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan.rs>
- <https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/plan_spec.rs>

Codex is the right model for **small ephemeral progress plans**, not durable cross-turn work identity.

### Maka Agent

Maka's implemented Session Tasks are deliberately separate from its Headless `TaskRun`, Goal, Workflow, AgentRun, and RuntimeEvent concepts.

Strong ideas worth preserving:

- state is advisory; filesystem, git, tests, tools, and verifier evidence remain truth;
- stable task identity and compact short keys;
- explicit `blocked`, `failed`, and `cancelled` states;
- completion/failure/blocking require evidence or a reason;
- parent verifies child success before marking a task complete;
- model-visible task context is bounded;
- task tools mutate local task state and do not dispatch work.

Sources in the companion Maka Agent repository:

- `maka-agent/docs/session-task-ledger-lifecycle.md`
- `maka-agent/packages/core/src/task-ledger.ts`
- `maka-agent/packages/runtime/src/task-ledger-tools.ts`
- `maka-agent/packages/storage/src/task-ledger-store.ts`

Maka's event-sourced JSONL store, UUID + hierarchical keys, resume-trust classifier, seven-day archive, expert-team claiming, and compatibility migration are not justified for My Pi Setup v1.

### Pi extension capabilities

Pi already provides the right persistence semantics for session tasks:

- `pi.appendEntry()` persists extension data but does not put it into model context;
- tool-result `details` can preserve state along the active session branch;
- `ctx.sessionManager.getBranch()` restores branch-correct state;
- `session_start` and `session_tree` cover resume/reload/branch navigation;
- `before_agent_start` can inject bounded current task state for a new user run;
- `registerEntryRenderer`, custom tool renderers, and `ctx.ui.custom()` support compact and full-screen UI.

Sources:

- Pi `docs/extensions.md`, `pi.appendEntry` and `before_agent_start`
- Pi `docs/session-format.md`, `CustomEntry` and SessionManager methods
- Pi `examples/extensions/todo.ts`

The upstream Todo example stores a complete snapshot in tool-result details and restores from the current branch. That is the best v1 persistence adapter because it naturally follows Pi forks and trees without an external locking protocol.

## Proposed v1

### Scope

Implement a session-owned task list for coordination.

Non-goals:

- no workflow/DAG engine;
- no automatic scheduling;
- no deadlines, priority, dependency graph, or project-management fields;
- no cross-session global task database;
- no automatic task completion from a successful Subagent;
- no event-sourced external files;
- no extra model calls or automatic continuation.

### State

```ts
type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

interface Task {
  id: number;                 // stable, monotonically allocated in this session branch
  subject: string;            // short imperative description
  description?: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  blockedReason?: string;
  failureReason?: string;
  completionEvidence?: string;
  owner?: { kind: "main" | "subagent" | "workflow"; id?: string };
}

interface TaskSnapshot {
  version: 1;
  nextId: number;
  tasks: Task[];
}
```

Use `T1`, `T2` as display references derived from numeric IDs. Do not add UUIDs or hierarchy until a real second writer or cross-session store exists.

### State transitions

```text
pending -> in_progress | cancelled
in_progress -> blocked | completed | failed | cancelled
blocked -> in_progress | failed | cancelled
failed -> pending | cancelled
completed/cancelled -> pending only with explicit reopen
```

Require:

- `blockedReason` for blocked;
- `failureReason` for failed;
- `completionEvidence` for completed.

Task completion remains advisory and must cite an observable check, artifact, commit, tool result, or user confirmation.

### Deep module

```ts
interface SessionTasks {
  execute(command: TaskCommand): TaskResult;
  snapshot(): TaskSnapshot;
  renderPrompt(maxChars?: number): string;
}

function restoreTaskSnapshot(branchEntries: readonly SessionEntry[]): TaskSnapshot;
```

One interface hides allocation, transition validation, limits, evidence rules, redaction, filtering, prompt budgeting, and persistence snapshots. Do not add a repository seam before a second persistence adapter exists.

### Model tool surface

Use four tools, matching the now-established Claude/Maka vocabulary:

```text
task_create({ tasks: [{ subject, description? }] })
task_update({ id, subject?, description?, status?, blocked_reason?, failure_reason?, completion_evidence?, explicit_reopen? })
task_list({ status?, include_terminal? })
task_get({ id })
```

Why four rather than one polymorphic `tasks` tool:

- matches current Claude Agent SDK conventions;
- stable, narrow schemas are easier for models to call correctly;
- read tools can remain compact while mutations return only changed tasks;
- no ambiguous action-dependent optional-field schema.

All mutations use sequential execution. Cap the task list (proposed 100 tasks), subjects (200 chars), descriptions/evidence (1,000 chars), and prompt projection (4,000 chars).

### Prompt policy

Do not inject an empty task list. When active tasks exist, add a bounded per-run message in `before_agent_start`:

```text
Current session tasks (advisory; real tool/filesystem/test evidence wins):
T2 [in_progress] Implement tasks
T3 [blocked] Verify branch restore — needs a fork test
Use task_list/task_get for full details.
```

Prioritize `in_progress`, `blocked`, then `pending`, and include at most two recent terminal items. Never inject all historical completed work.

Tool prompt guidance should say:

- use Tasks for non-trivial multi-step work or explicit user task lists;
- skip Tasks for one-step requests;
- keep status current;
- do not mark complete without evidence;
- Tasks track intent, not execution truth;
- Subagents and Workflows execute work; Task tools do not.

### Persistence and branch semantics

Store the complete `TaskSnapshot` in mutation tool-result `details`. Restore by scanning the active `ctx.sessionManager.getBranch()` and accepting the latest valid Task snapshot.

This gives:

- `/reload` and `/resume`: restored;
- `/tree`: branch-correct after `session_tree`;
- `/fork`: inherits state up to the branch point;
- `/new`: starts empty;
- Context Pivot: survives because the Pi session is unchanged.

No external `tasks.json` is needed.

### UI

- `/tasks`: read-only full-screen list initially;
- compact tool renderers for creates/updates/lists;
- Footer status is operational and always visible when custom Footer is enabled, e.g. `tasks 3 open · 1 blocked`;
- no persistent task card above the editor in v1.

### Subagent/Workflow integration

V1 should not delay integration of Session Tasks, but reserve optional owner fields.

A later v1.1 can add `task_id` to `subagent_spawn`:

- validate task exists;
- mark it in progress and record owner only after spawn succeeds;
- child success does **not** complete it;
- parent reviews output and calls `task_update(... completed, completion_evidence)`;
- child failure can mark failed with the actual error.

Do not give child Pi sessions Task tools initially; add all four names to the child denylist. The parent owns its session tasks.

Workflow linking should remain manual until there is a clear one-task-to-one-run ownership model.

## Recommended delivery sequence

1. Pure SessionTasks module and transition tests.
2. Four tools with branch-correct snapshot persistence.
3. Bounded `before_agent_start` projection and prompt tests.
4. Compact renderers, `/tasks`, Footer activity.
5. Add Task tools to Pi child/workflow deny lists.
6. Dogfood for several sessions.
7. Only then consider `subagent_spawn.task_id` ownership.

## Why this is the right size

Codex demonstrates that a replace-all checklist is sufficient for short runs but lacks stable identity. Claude demonstrates the ecosystem shift toward ID-addressed incremental Tasks. Maka demonstrates the value of evidence and explicit blocked/failed states, while also showing how quickly the subsystem can become a runtime of its own.

The proposed v1 takes the useful middle: **branch-correct, stable, evidence-aware session tasks behind a small interface, without creating a second Workflow or durable runtime.**
