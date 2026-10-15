# Architecture records

Architecture records describe OpenPI ownership boundaries, lifecycle seams, and runtime contracts at a named source revision and declare their evidence status. Only a `validated` record represents structure checked at its stated boundary. Runtime behavior remains defined by code and current user documentation.

Keep unresolved alternatives and implementation proposals in [`../design/`](../design/). Promote a constraint through an accepted [`Decision`](../decisions/) before treating it as architecture policy.

Each new or materially revised architecture record should identify its evidence status, source revision, affected Pi primitive, current invariants, related Issues and Decisions, and any record it supersedes.

- [`WORKTREE_HANDOFF_INVENTORY.md`](WORKTREE_HANDOFF_INVENTORY.md) - #661 bounded Git inventory coverage and preservation semantics (draft candidate)
- [`WEB_MODEL_DISCOVERY.md`](WEB_MODEL_DISCOVERY.md) - bounded Web model snapshots and full-catalog discovery through Pi's model runtime
- [`RUNTIME_SNAPSHOT.md`](RUNTIME_SNAPSHOT.md) - parent-only, bounded runtime observation through the existing capability gateway

- [`WORKFLOW_EXECUTION_TIMING.md`](WORKFLOW_EXECUTION_TIMING.md) - privacy-safe bounded timing observation, explicit coverage and replay provenance (#662)
