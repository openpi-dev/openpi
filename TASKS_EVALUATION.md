# Session Tasks — Multi-model Evaluation

Date: 2026-07-27

Models:

- `codewiz-anthropic/claude-fable-5-google` · high
- `codewiz-anthropic/claude-opus-5-google` · high
- `seal/gpt-5.6-sol` · high

Method: three independent structured reviews, three cross-examinations, then an Opus 5 synthesis. The GPT-5.6 Sol cross-examination timed out before its first response; its independent review completed successfully with confidence 5/5 and is included. Workflow artifacts are under `~/.pi/agent/workflows/wf_4c62ecc198cd/`.

## Verdict

**Implemented after revision as `extensions/tasks/`.**

Implementation correction: model-visible projection is not injected on every request. It is frozen only for cold runs after session start, tree navigation, or compaction/Context Pivot, then reused byte-identically within that run and removed after settlement. This avoids accumulating persistent messages and reduces repeated cache-prefix divergence. Persistence uses synchronous `pi.appendEntry("session-tasks", snapshot)` before the in-memory commit.

The need is real: My Pi Setup has Subagents and Workflows for execution and Context Pivot for context hygiene, but no durable, branch-correct record of work intent across turns and compaction. Session Tasks fill that seam if they remain advisory and do not execute or schedule work.

The original `TASKS_DESIGN.md` gets the responsibility boundary right, but three implementation mechanisms need correction:

1. Do not inject a persistent `before_agent_start.message` on every turn.
2. Do not copy Pi's Todo example's tool-result snapshot ordering without addressing concurrent tool calls.
3. Do not start with a workflow-like lifecycle, owner linkage, and strict transition graph.

## Independent reviews

### Fable 5 — implement, confidence 4/5

Fable judged the product/agent behavior valuable, especially across Context Pivot and long sessions. Its main concerns:

- an existing `todo` tool would create split-brain planning state;
- models may confuse Task vocabulary with work-spawning tools;
- strict transitions produce retry loops on common model behavior;
- vague triggers cause status churn;
- injected task context may cause an agent to resume unrelated work;
- evidence only helps if users can see and audit it.

Fable recommended three tools (`create`, `update`, `list`), explicit “does not execute work” descriptions, visible reasons/evidence, and a sharper trigger: use Tasks only across multiple agent runs/user turns or for explicit user lists.

### Opus 5 — revise, confidence 4/5

Opus identified the deepest correctness risks:

- Pi can execute sibling tool calls concurrently; a full snapshot returned in tool-result details can be persisted in source order rather than mutation completion order, losing the latest state after reload/fork.
- `before_agent_start.message` is persistent session context, so repeated snapshots accumulate and contradict each other.
- a 100-task count cap does not bound snapshot bytes; repeated full snapshots can make session growth quadratic.
- an invalid newest snapshot must not silently revive an older state and reuse IDs.
- field lifecycle (terminal notes, reopen, stale evidence, timestamps) was under-specified.

Opus recommended monotonic snapshot revisions, a serialized byte cap, transient context projection, no owner field, and much looser non-terminal state transitions.

### GPT-5.6 Sol — revise, confidence 5/5

Sol pushed for the smallest useful model:

- `{ id, subject, status, note? }` with `pending | in_progress | blocked | completed`;
- no owner, executor linkage, timestamps, strict transition graph, `failed`, or rich UI in the first slice;
- no `task_get`; filter `list` by ID if needed;
- a 16–32 KB serialized snapshot cap and immutable candidate mutation;
- explicit active-branch semantics: IDs are stable along ancestry, but divergent branches may reuse display IDs;
- a tiny transient reminder, if dogfooding proves one is needed;
- concrete kill criteria if stable IDs and blocked state do not outperform a replace-all checklist.

## Final rulings

### 1. Vocabulary and tools

Use **tasks** vocabulary to avoid collision with Claude's historic Task-as-agent meaning and with the existing `subagent_spawn` surface:

```text
tasks_add
tasks_update
tasks_list
```

Each description starts with:

> Records session work intent. It does not execute, schedule, or delegate work.

No `tasks_get` in v1. `tasks_list` can accept an optional ID/status filter.

### 2. State model

```ts
type TaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "done"
  | "dropped";

interface TaskItem {
  id: number;
  subject: string;
  detail?: string;
  status: TaskStatus;
  note?: string;
}

interface TaskSnapshot {
  version: 1;
  revision: number;
  nextId: number;
  items: TaskItem[];
}
```

Rulings:

- multiple `in_progress` items are legal;
- any status may transition to any other status;
- `blocked`, `done`, and `dropped` require a note;
- `done` notes should cite observable evidence, but Session Tasks must not claim the evidence was verified;
- leaving a terminal/blocked state clears its old note unless a new note is supplied;
- `nextId = max(persistedNextId, maxItemId + 1)` during restore;
- IDs are branch-local references (`T1`, `T2`), not global identities.

### 3. Persistence

Use Pi session custom entries:

```ts
pi.appendEntry("session-tasks", snapshot)
```

Why:

- Custom entries persist but never enter LLM context.
- Appending at mutation application time preserves the actual mutation order instead of depending on sibling tool-result persistence order.
- Scanning `ctx.sessionManager.getBranch()` gives branch-correct `/reload`, `/resume`, `/tree`, `/fork`, and Context Pivot behavior.
- No external file, lock, or repository seam is required.

Restore the highest valid revision on the current branch; tie-break by later branch position. If the newest revision is malformed or has an unknown version, fail closed and notify rather than silently reverting to an older snapshot.

Enforce a 16 KB serialized-snapshot ceiling before committing a candidate mutation. Proposed field limits: subject 120 chars, detail 500, note 500.

### 4. Model visibility

Do not use `before_agent_start.message`: Pi persists it.

Use the non-persistent `context` hook before each LLM request. Append at most 800 characters to the current request's message tail, only when actionable items exist. Prioritize:

```text
in_progress > blocked > pending
```

The projection must say:

- task state is advisory context, not an instruction to resume unrelated work;
- real files, git, tests, tools, artifacts, and user confirmation are truth;
- use `tasks_list` for details;
- after compaction/pivot, coordinate with the existing task list instead of recreating items.

This keeps dynamic state at the tail and preserves the stable prompt prefix for caching.

### 5. Subagent and Workflow policy

No v1 business coupling:

- no `task_id`/task ID on `subagent_spawn`;
- no owner field;
- no automatic status change from Subagent/Workflow outcomes;
- only the parent session updates task state after reviewing results.

All three task tools must be denied to Pi children and Workflow children. Before adding them, remove the duplicate private denylist in `extensions/subagents/src/backends/pi.ts` and reuse `extensions/shared/child-session.ts` as the single source.

### 6. UI

V1 includes:

- compact tool rendering;
- read-only `/tasks` command showing notes/evidence;
- no permanent panel and no Footer count initially.

Open task count is advisory intent, not running operational work. It should not be mixed with the Footer's always-visible Subagent/Workflow/background-process status until dogfooding proves value.

### 7. Existing Todo conflict

This machine currently has:

```text
~/.pi/agent/extensions/todo.ts
```

It registers `todo` and `/todos`. Shipping both creates overlapping planning surfaces. Before enabling task tools, either remove/disable the old Todo extension or implement a startup conflict gate that withholds the task tools and explains the conflict.

## Required tests

1. Add/update/list and stable allocation.
2. Any transition allowed; required note for `blocked/done/dropped`; stale note clearing.
3. Multiple `in_progress` items.
4. 16 KB cap rejects mutation before changing memory or appending an entry.
5. Malformed/unknown snapshot fails closed; IDs never rewind.
6. Out-of-order entry position with monotonic revision restores correctly.
7. Concurrent sibling mutations survive reload.
8. `/tree`, `/fork`, `/new`, `/resume`, and Context Pivot branch semantics.
9. An empty task list produces no context mutation; active projection is tail-appended and ≤800 chars.
10. Task tools are denied to both Pi Subagents and Workflow children through one shared policy.

## Dogfood gate and kill criteria

Evaluate at least ten long sessions, including one Context Pivot and one fork.

Track:

- mutation calls per completed item (target ≤3);
- duplicate items after pivot (target 0);
- tasks-entry bytes as a share of session JSONL (target <5%);
- proportion of `done` notes with checkable evidence (target ≥70%).

Delete or collapse the extension back to a Codex-style replace-all checklist if stable IDs and `blocked` state show no observable benefit, or if status churn/evidence theater dominates usage.

## Recommended sequence

1. Deduplicate child tool policy.
2. Resolve the installed Todo conflict.
3. Implement and test the pure tasks module.
4. Add custom-entry persistence and branch restoration.
5. Add three tools and transient context projection.
6. Add child denylist entries.
7. Add compact renderers and `/tasks`.
8. Dogfood, measure, then decide whether to keep or delete it.
