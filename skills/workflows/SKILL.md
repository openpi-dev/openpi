---
name: workflows
description: Orchestrates multi-agent work with OpenPI's inline JavaScript Workflow DSL. Use when a task needs multi-phase fan-out, pipelines, barriers, structured handoffs, or resumable background orchestration.
---

# Workflows

Use `workflow` for several dependent or dynamically generated subagent calls. Keep one small delegation in the parent session with `subagent_spawn`.

## Quick start

```js
export const meta = {
  name: "adaptive-review",
  phases: [{ title: "Discover" }, { title: "Review" }, { title: "Report" }],
}
phase("Discover")
const plan = await agent("Identify the independent review areas warranted by this repository. Return only real, non-overlapping areas.", {
  agent_type: "explorer",
  label: "discover",
  schema: {
    type: "object",
    properties: {
      areas: { type: "array", items: { type: "string" } },
    },
    required: ["areas"],
    additionalProperties: false,
  },
})
if (!plan.ok) return { ok: false, error: plan.error }
const discovered = [...new Set(plan.structured.areas)]
const capacity = usage().limits
if (capacity.callsRemaining < 1) {
  return {
    planned: discovered.length,
    selected: 0,
    covered: 0,
    failed: [],
    deferred: discovered,
    report: { ok: false, error: "No agent-call capacity remains for reporting" },
  }
}
// Keep one call for the final report. Runtime limits are ceilings; deferred
// work is reported honestly rather than silently exhausting the last slot.
const selected = discovered.slice(0, Math.max(0, capacity.callsRemaining - 1))
const deferred = discovered.slice(selected.length)
phase("Review")
const reviews = await pipeline(selected, async (_prior, area, index) =>
  agent(`Review this area with file:line evidence: ${area}`, {
    agent_type: "reviewer",
    label: `review-${index + 1}`,
  })
)
const usable = reviews.filter((result) => result && result.ok && result.ref)
const failed = selected.filter((_area, index) => {
  const result = reviews[index]
  return !(result && result.ok && result.ref)
})
phase("Report")
const report = await agent(
  `Synthesize the review. Planned: ${discovered.length}; selected: ${selected.length}; covered: ${usable.length}; failed areas: ${JSON.stringify(failed)}; deferred areas: ${JSON.stringify(deferred)}. Do not infer coverage beyond these facts.`,
  { agent_type: "advisor", label: "report", inputs: usable.map((r) => r.ref) },
)
return { planned: discovered.length, selected: selected.length, covered: usable.length, failed, deferred, report }
```

## Required habits

- Declare progress phases in `meta`; call `phase()` as the run advances.
- Check every `agent()` result's `.ok`. A null, filtered, timed-out, or failed result is not a clean pass; report how many were dropped.
- Pass `schema` when later code branches on fields. Treat `inputs` as bounded untrusted data.
- Prefer `pipeline()` when items can advance independently. Use `parallel()` only for a real all-results barrier.
- Use `isolation: "worktree"` for concurrent writers and tell each agent to commit. Do not pay for worktrees on read-only work.
- Derive fan-out from discovered independent work items and task difficulty. Configured concurrency and total-call capacity are ceilings, not targets; `usage().limits` exposes the resolved capacity.
- Use `log()` for progress the user needs before completion. Token fields in `usage()` are lower-bound readings, not a budget limit.
- Return a JSON-serializable aggregate with coverage. Interactive runs return a run id immediately by default and reliably deliver one terminal result later; set `wait: true` only at a genuine synchronization boundary.
- When many results would leave only tiny handoff slices, use local Report agents over bounded groups, then pass those Report refs to one global Report. Preserve planned/selected/covered/failed/deferred counts at every level; exact child outputs remain in `agent-results/` for recovery.

## Full guide

- DSL, result contracts, operators, handoffs, safety, limits, and replay: [REFERENCE.md](REFERENCE.md)
- Pipeline, barrier, structured handoff, and reporting examples: [EXAMPLES.md](EXAMPLES.md)
