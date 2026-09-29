# Session child-execution admission

Issue: [#159](https://github.com/openpi-dev/openpi/issues/159)

## Scope and decision

The first implementation phase provides an opt-in, session-local admission
limit for *active child executions*. It applies to Workflow runs, Direct
Subagent executions, and BTW executions that share one top-level Pi
`SessionManager`. The parent Session does not consume a slot.

This is deliberately not a process-wide scheduler and does not account for
Background Terminal processes, worktrees, artifacts, provider quotas, tokens,
cost, memory, or HTTP 429 responses. It also does not alter model selection,
thinking level, tools, Trust, or child permission intersection.

## Contract

`childExecutions.maxActive` is disabled by default. When explicitly configured
to an integer from 1 through 64, it limits only concurrently active child
executions for that top-level Session. Workflow's run-local concurrency and
call limits, Direct Subagent's local pool of four, and BTW's local pool of two
remain in force.

Each entry first reserves its pre-existing local allowance and then acquires
the shared FIFO admission lease before constructing or restarting an expensive
child execution. The reverse order is never used, avoiding a local/shared
lock cycle. Queuing is bounded, abortable, and reports aggregate origin counts
without exposing task content.

An active child releases its lease only after terminal evidence. A cancel or
shutdown request alone is not terminal evidence: if the underlying stop times
out, the lease is retained fail-closed rather than allowing an unproven extra
execution. Leases are idempotent and attempt-scoped, so a stale completion
cannot release a later restart. Dormant children hold no lease and acquire one
again when sent new work.

## Projections

The same admission snapshot is the runtime fact used by the subagent TUI and
the Web capability projection. It contains the configured limit, held and
queued totals, aggregate origin counts, and a generic blocking reason; it
never includes queued task prompts or result text.

## Validation boundary

The implementation is tested with controllable child runtimes, promises, and
abort signals rather than provider calls. Its tests prove admission and
lifecycle behavior; they do not claim performance, cost, token, memory, or
429 improvements.
