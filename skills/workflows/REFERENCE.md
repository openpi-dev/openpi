# Workflow DSL reference

The `workflow` script is an async JavaScript function body executed in a restricted, killable sandbox. It has no imports, eval, timers, filesystem, network, or process APIs. Normal JavaScript control flow, array methods, `await`, and template strings are available. Return a JSON-serializable value.

## Metadata and narration

- `export const meta = { name?, description?, phases: [{ title, detail? }] }` declares progress metadata. Declare phases up front.
- `phase(title)` selects a declared phase.
- `log(message)` emits one terminal-safe progress line. The latest 100 lines are retained and dropped-line counts are reported.
- `usage()` returns cumulative `{ input, output, cacheRead, cacheWrite, total, cost, agents }`. It refreshes after agents settle. Compaction can make it a lower bound; it is a reading, not a limit.
- `args` is the parsed `args` tool parameter, or the original string when it is not valid JSON.

## Agent calls

`await agent(prompt, options)` runs one child and always resolves to `{ ok, output, structured?, ref?, acceptance?, error? }`. Check `ok` before reading output. Children receive normal trust-aware resources but cannot recursively orchestrate or ask the user.

Useful options include `agent_type`, `label`, `phase`, `schema`, `acceptance`, `model`, `provider`, `effort`, `isolation`, `operator`, and `inputs`.

- Prefer a matching `agent_type`. Model precedence is explicit model/provider, type file, configured built-in role, then parent. Effort precedence is explicit effort, type default, then parent.
- `schema` validates structured output. Use it whenever later workflow logic branches on fields.
- `acceptance: { criteria: [{ id, description, requiredEvidence? }] }` requires the same child to return an evidence ledger. Missing, malformed, or rejected criteria make `ok:false` while preserving output and evidence.
- `operator: "name"` reuses one in-memory child Session for serialized follow-ups inside the same run. Its model, role/tools, effort, structured mode, and cwd are frozen by the first activation. Operators cannot use per-call worktrees or replay, and do not survive restarts.
- `inputs: [ref, ...]` accepts successful opaque refs from the same workflow run only. Each conclusion is bounded to 16 KiB and total injected input to 48 KiB. Inputs are marked as untrusted data; the resulting graph is observability, not scheduling authority.
- `isolation: "worktree"` gives a writing child its own branch and checkout. Concurrent writers without isolation share one checkout and Git index and can overwrite each other. Tell isolated writers to commit. Empty worktrees are reclaimed; commits keep the branch; dirty work may keep the directory.

## Fan-out

`await pipeline(items, stage1, stage2, ...)` advances each item independently. A stage receives `(previousResult, originalItem, index)`. A throwing stage drops that item to null and skips its remaining stages. Results preserve input order.

`await parallel([() => agent(...), ...], { concurrency? })` is a barrier: later code starts after every thunk settles. A throwing thunk becomes null without discarding siblings. Use it when the next step needs the whole set for comparison, deduplication, merging, or an early aggregate decision.

Prefer `pipeline()` for ordinary multi-stage fan-out. Mapping, filtering, or flattening between stages is not by itself a reason for a barrier.

## Limits and failures

Workflow concurrency defaults to the configured package value and has a hard maximum of 64. Agent calls default to the configured package limit and have a hard maximum of 1024. There is no whole-run deadline. A child must produce its first assistant event within 45 seconds; individual child tool calls time out independently after 3 minutes and return an error result the child can recover from.

Each call persists intent, admission, and execution state. Interrupted nonterminal calls become `uncertain`, never guessed failed. Artifacts contain results, bounded transcripts, and a read-only graph projection for explicit result refs.

## Background and replay

`background: true` returns a run id immediately. The Session later receives a completion message; `workflow_status` inspects and `workflow_stop` cancels. Lifecycle tools become visible after a background run starts.

`resume_from_run_id` accepts a previous run id or unique suffix. Replay is content-based and order-independent. It requires an unchanged prompt, resolved role/schema/model/provider/effort, canonical cwd, repository state, resources, and trust context. Only provably read-only non-operator calls replay. Failed, unrestricted, unknown-tool, writable, worktree, operator, or un-fingerprintable calls run for real. Missing or old journals safely degrade to a full run.
