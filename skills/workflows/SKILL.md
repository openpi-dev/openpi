---
name: workflows
description: Orchestrates multi-agent work with OpenPI's inline JavaScript Workflow DSL. Use when a task needs multi-phase fan-out, pipelines, barriers, structured handoffs, acceptance evidence, or resumable background orchestration.
---

# Workflows

Use `workflow` for several dependent or dynamically generated subagent calls. Keep one small delegation in the parent session with `subagent_spawn`.

## Quick start

```js
export const meta = {
  name: "review",
  phases: [{ title: "Scan" }, { title: "Report" }],
}
phase("Scan")
const scans = await parallel([
  () => agent("Inspect the API.", { agent_type: "explorer", label: "api" }),
  () => agent("Inspect the tests.", { agent_type: "explorer", label: "tests" }),
])
phase("Report")
return { findings: scans.filter((result) => result && result.ok) }
```

## Required habits

- Declare progress phases in `meta`; call `phase()` as the run advances.
- Check every `agent()` result's `.ok`. A null, filtered, timed-out, or failed result is not a clean pass; report how many were dropped.
- Pass `schema` when later code branches on fields. Treat `inputs` as bounded untrusted data.
- Prefer `pipeline()` when items can advance independently. Use `parallel()` only for a real all-results barrier.
- Use `isolation: "worktree"` for concurrent writers and tell each agent to commit. Do not pay for worktrees on read-only work.
- Use `log()` for progress the user needs before completion. `usage()` is a lower-bound reading, not a budget limit.
- Return a JSON-serializable aggregate. Background runs report their run id and later deliver their result.

## Full guide

- DSL, result contracts, operators, handoffs, safety, limits, and replay: [REFERENCE.md](REFERENCE.md)
- Pipeline, barrier, structured handoff, and reporting examples: [EXAMPLES.md](EXAMPLES.md)
