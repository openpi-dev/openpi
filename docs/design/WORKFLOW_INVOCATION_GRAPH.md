# Workflow invocation and graph semantics

Status: implemented

This note records the durable semantics added to OpenPI Workflow after studying
Maka Agent Graph. Runtime behavior remains defined by the code and README.

## Decision

Keep JavaScript (`agent`, `pipeline`, `parallel`) as the orchestration language.
Add durable execution facts and a derived graph without introducing a second
runtime, daemon, scheduler database, automatic parent wake-up, or cross-restart
child-session promise.

The graph is a projection of explicit data dependencies. It is never admission
or scheduling authority.

## Invocation ledger

Every `agent()` call receives a stable identity within its run:

```text
{ runId, callIndex }
```

Its lifecycle has three independent planes:

```text
intent:     requested
admission:  pending -> claimed | replayed | rejected
execution:  pending -> running -> settled
                                  \-> uncertain (recovery only)
```

Terminal outcomes are `success`, `error`, or `uncertain`. Transitions are
monotonic and timestamp ordered. Illegal transitions fail closed.

A checkpoint is written after `requested` and immediately after `claimed`.
Persisted nonterminal records have no live owner after process restart, so they
are recovered as `uncertain`. OpenPI does not infer that they failed before
having effects and does not automatically retry them.

## Result-reference handoff

A successful call returns an opaque, high-entropy `ref`. A later call in the
same run may declare:

```js
agent("Verify the upstream result", { inputs: [previous.ref] });
```

The host resolves refs; workflow JavaScript cannot forge or inspect the
registry. Unknown, duplicate, failed, or cross-run-like refs are rejected.
Resolved content is appended under an explicit untrusted-data boundary.

Limits:

- at most 64 refs per call;
- at most 16 KiB UTF-8 per conclusion;
- at most 48 KiB UTF-8 across the rendered handoff;
- assistant text and structured output are both retained when both exist.

Refs are run-local capabilities. They are not restored across process restart.
A replay hit in a new run receives a new ref in that run.

## Operators

`operator: "name"` serializes activations of one reusable in-memory Pi
`SessionManager`:

```js
await agent("Inspect the module", { operator: "runtime" });
await agent("Now check its callers", { operator: "runtime" });
```

The first activation freezes the execution fingerprint and cwd. Later
activations with a different model, role/tool surface, effort, structured mode,
or cwd fail closed. Different operator keys may execute concurrently.

Operator calls cannot use per-call Worktree isolation and cannot use result
Replay. Replaying a string cannot reconstruct conversation state. Operator
queues observe Workflow cancellation; shutdown rejects new activations and
waits only within the Workflow's bounded cleanup path.

Operator reuse lasts for one Workflow run only. It is not durable Agent memory.

## Derived graph

Each invocation is a node. An `inputs` reference creates an edge from the
producer call to the consumer call. Projection is deterministic, bounded, and
retains diagnostics for missing inputs, duplicates, cycles, and omitted data.

The projection is persisted in `workflow.json`, summarized in `/workflows`, and
included in saved reports. It has no method that can claim, run, retry, cancel,
or complete a call.

## Replay and Worktrees

Existing Replay rules remain unchanged: only calls proven read-only against a
complete execution and workspace fingerprint can replay. Operator calls and
Worktree calls always run for real.

Current Worktree manifests are preservation artifacts, not replay receipts.
They are not cryptographically bound to a journal key, omit untracked/ignored
contents, and finalize after child execution. Treating them as replay evidence
would create an unsafe crash window and could hide write side effects.

The only sound future subset with current data would be clean, zero-delta,
read-only Worktrees. That duplicates ordinary read-only Replay with more
complexity, so Worktree Replay is deliberately deferred.

## Compatibility

Existing Workflow scripts need no changes. `operator`, `inputs`, and returned
`ref` are additive. Calls without them retain isolated child sessions, current
Replay behavior, Worktree preservation, Acceptance Ledger behavior, and the
same concurrency/call budgets.
