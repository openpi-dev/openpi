# Workflow DSL reference

The `workflow` script is an async JavaScript function body executed in a restricted, killable sandbox. It has no imports, eval, timers, filesystem, network, or process APIs. Normal JavaScript control flow, array methods, `await`, and template strings are available. Return a JSON-serializable value.

## Metadata and narration

- `export const meta = { name?, description?, phases: [{ title, detail? }] }` declares progress metadata. Declare phases up front.
- `phase(title)` selects a declared phase.
- `log(message)` emits one terminal-safe progress line. The latest 100 lines are retained and dropped-line counts are reported.
- `usage()` returns cumulative `{ input, output, cacheRead, cacheWrite, total, cost, agents, limits }`. `limits` contains `{ concurrency, maxAgentCalls, callsUsed, callsRemaining }` resolved for this run. Token fields refresh after agents settle and compaction can make them a lower bound; capacity fields are runtime facts, not target fan-out.
- `args` is the parsed `args` tool parameter, or the original string when it is not valid JSON.

## Agent calls

`await agent(prompt, options)` runs one child and always resolves to `{ ok, output, structured?, ref?, acceptance?, acceptanceWarning?, error? }`. Check `ok` before reading output. Children receive normal trust-aware resources but cannot recursively orchestrate or ask the user.

Useful options include `agent_type`, `label`, `phase`, `schema`, `model`, `provider`, `effort`, `isolation`, `operator`, and `inputs`. The legacy `acceptance` option remains readable only during the 0.x migration window described below.

- Prefer a matching `agent_type`. Model precedence is explicit model/provider, type file, configured built-in role, then parent. Effort precedence is explicit effort, type default, then parent.
- `schema` validates structured output. Use it whenever later workflow logic branches on fields.
- `acceptance` is deprecated since OpenPI 0.5 and scheduled for removal in 1.0. Compatibility calls still return the child-authored ledger with `authority: "model-self-attestation"` and a migration warning, but it never determines `ok`. Use ordinary `schema` for findings, then let the parent evaluate them alongside runtime-observed exit codes, test receipts, file fingerprints, and tool results. Old DSL, journals, and artifacts remain readable during 0.x.
- `operator: "name"` reuses one in-memory child Session for serialized follow-ups inside the same run. Its model, role/tools, effort, structured mode, and cwd are frozen by the first activation. Operators cannot use per-call worktrees or replay, and do not survive restarts.
- `inputs: [ref, ...]` accepts successful opaque refs from the same workflow run only. Each conclusion is bounded to 16 KiB and total injected input to 48 KiB. The total budget is fairly distributed, so a large fan-out cannot starve later results merely because of order; partial projections are labeled. Full successful child results remain in the run's `agent-results/` artifacts. Inputs are marked as untrusted data; the resulting graph is observability, not scheduling authority.
- Fair projection preserves the head and tail of every partial result and names its run-relative `agent-results/agent-N.json` audit artifact. That path is provenance for the parent/operator, not a child-readable handle. Fair presence is not proof of full evidence coverage: for large fan-out, group source refs into local Report agents, then pass only their refs to a global Report. The workflow script—not Runtime—must state planned, selected, covered, failed, and deferred counts.
- `isolation: "worktree"` gives a writing child its own branch and checkout. Concurrent writers without isolation share one checkout and Git index and can overwrite each other. Tell isolated writers to commit. Empty worktrees are reclaimed; commits keep the branch; dirty work may keep the directory.

## Fan-out

`await pipeline(items, stage1, stage2, ...)` advances each item independently. A stage receives `(previousResult, originalItem, index)`. A throwing stage drops that item to null and skips its remaining stages. Results preserve input order.

`await parallel([() => agent(...), ...], { concurrency? })` is a barrier: later code starts after every thunk settles. A throwing thunk becomes null without discarding siblings. Use it when the next step needs the whole set for comparison, deduplication, merging, or an early aggregate decision.

Prefer `pipeline()` for ordinary multi-stage fan-out. Mapping, filtering, or flattening between stages is not by itself a reason for a barrier.

## Limits and failures

Workflow concurrency defaults to the configured package value and has a hard maximum of 64. Agent calls default to the configured package limit and have a hard maximum of 1024. There is no whole-run deadline. A child must produce its first assistant event within 45 seconds; individual child tool calls time out independently after 3 minutes and return an error result the child can recover from.

Each call persists intent, admission, and execution state. Interrupted nonterminal calls become `uncertain`, never guessed failed. Artifacts contain results, bounded transcripts, and a read-only graph projection for explicit result refs.

## Lifecycle and replay

Interactive TUI runs return an accepted run id immediately by default, release the parent turn, and later deliver a terminal completion with a stable delivery id. Delivery is at least once: normal retries do not duplicate a run, but a process loss after Pi accepts the message and before the receipt is persisted can replay the same id. `wait: true` explicitly waits inline; interrupting that wait releases only the waiter and the run continues. Print/automation defaults to waiting because it has no later delivery channel.

New calls must use `wait`. For compatibility with released OpenPI versions, the deprecated `background` alias remains accepted during the current migration window: replace `background: true` with `wait: false`, or `background: false` with `wait: true`, and do not provide both fields. The alias will be removed only in an announced breaking release. Persisted artifact/details fields named `background` remain actual detached-state facts and are not part of that removal.

Loading the Workflow capability exposes `workflow`, `workflow_status`, and `workflow_stop` as one stable group; starting or settling a run does not mutate the model tool Schema. `workflow_status` returns a bounded state/coverage summary and artifact path without consuming or repeating the full completion. `workflow_stop` is idempotent and preserves partial artifacts. A failed completion send remains pending with the same per-run delivery identity and is retried when the parent settles or the Session is restored.

`resume_from_run_id` accepts a previous run id or unique suffix. Replay is content-based and order-independent. It requires an unchanged prompt, resolved role/schema/model/provider/effort, canonical cwd, repository state, resources, and trust context. Only provably read-only non-operator calls replay. Failed, unrestricted, unknown-tool, writable, worktree, operator, or un-fingerprintable calls run for real. Missing or old journals safely degrade to a full run.
