---
status: draft
created: 2026-09-08
last-verified: 2026-09-09
applies-to: isolated v0.8.1 worktree a3edee28 plus print-host wiring and unused-unless-set OPENPI_CURSOR_WIRE_LOG; exploratory, not a Benchmark
related-issues: "#234, #512, #513, #514, #516"
related-prs: "#484, #515"
supersedes: none
---

# OpenPI Cursor reliability — session progress

Companion to [`CURSOR_RELIABILITY_BASELINE_2026-09-08.md`](CURSOR_RELIABILITY_BASELINE_2026-09-08.md). Ledger: `/tmp/openpi-reliability-20260908/results/ledger.jsonl`. Not a formal Benchmark.

## Matrix (first 5 attempts per cell; all attempts kept)

| Config | A | B | C | D | E | F |
| --- | --- | --- | --- | --- | --- | --- |
| cursor-grok-4.6-high-fast | 5 (3 correct, 2 identity-loop timeout) | 5/5 | 5/5 native≥1 | 5 (4 correct, 1 error-retry timeout) | first 5: 2 correct, 3 print-settle. E-06..10 still stock spawn (5/5 correct). E-11..20 print-host after-fix (10/10) | 5/5 |
| cursor-grok-4.6-high | 5/5 | 5/5 | first 5: 4 native-occurring (3 correct, 1 wrong); C-03 no-native. Extra C-06 native+correct → 5 counting | 5 (4 correct, 1 timeout) | 5/5 | 5/5 (+5 extra correct) |
| cursor-grok-4.6-medium-fast | 5 (4 correct, 1 hang-after-success timeout; acceptor still green) | 5 (4 correct, 1 hang-after-success timeout; acceptor still green) | first 5: 4 native-occurring (C-01 timeout, no native). Extra C-06 native+correct → 5 counting | 5 (2 correct, 3 timeout) | 5/5 | 5/5 |

Class C counts only when a native request occurred (`native_rejection` on the wire). high-fast C is 5/5. high and medium-fast each now have ≥5 native-occurring runs after extras (old no-native rows kept).

## Long tasks (≥10 min wall + independent external acceptor)

| Run | Duration | Acceptor | Class |
| --- | --- | --- | --- |
| LP-high-fast-01 | 789s | pass (4 shard path hashes) | correct completion |
| LH-medium-fast-01 | 633s | fail (count/hash mismatch) | wrong result |
| LH-high-01 | 819s | fail | wrong result |
| LD-medium-fast-01 | 791s | fail (15–16 line / hash drift) | wrong result |
| LD-high-fast-01 | 1165s | fail | wrong result |
| LD-high-01 | 1710s | fail (15/16 lines, hash drift) | wrong result |

Shorter audits (L 210s, other LPs 217–487s) have acceptors but do **not** count toward the six 10-minute tasks.

Content-hash long tasks often mismatch because models include an extra `.ts` file or hash a different canonicalization. That is model-strategy / wrong-result, not infrastructure. One path-list pipeline passed.

## Criterion 3 — cancel / disconnect / timeout / cleanup

- Unit (re-run 2026-09-09, logs captured): `results/fault/pi-backend-lifecycle.unit.log` 20 pass / exit 0; `results/fault/cursor-provider.unit.log` 30 pass / exit 0.
- Live cancel `cancel-live-1788887430222`: `sawTool=true`, SIGTERM after first `tool_execution_start`, leftover `[]`, user Sessions 939, class `cancel`.
- Live disconnect `disconnect-live-1788887477808`: isolated CONNECT proxy dropped after first tool; next stream `stopReason: error` / `Client network socket disconnected before secure TLS connection was established`; then `agent_settled`; leftover `[]`; Sessions 939. Class `infrastructure failure`.
- After harness SIGTERM loops: no leftover `run-cell` processes. Isolation leak from an earlier un-prefixed lifecycle test was removed; Sessions restored to 939.

## Failure classes (all attempts kept)

1. **Tool-identity loop** (A high-fast 01, 04) — [#513](https://github.com/openpi-dev/openpi/issues/513). Many successful Pi `read`/`rg`; model claims native / `mcp_openpi_*` names; never writes ACCEPT_A. Under investigation. Not connection timeout.
2. **Hang after acceptor success** (A-04, B-02 medium-fast) — [#516](https://github.com/openpi-dev/openpi/issues/516). Work written, session does not exit; harness timeout. Under investigation.
3. **Error-recovery loop** (D timeouts) — repeated failed missing-path reads; never ACCEPT_D. Model strategy.
4. **Print-mode parent settle** (E high-fast 01–03) — [#512](https://github.com/openpi-dev/openpi/issues/512). Spawn then `stop` without wait; `--print` emits `agent_settled`. Wiring on research branch / [PR #515](https://github.com/openpi-dev/openpi/pull/515) (not merged). Version-split index: `/tmp/openpi-reliability-20260908/results/e-high-fast-512-version-split.md`.
5. **Native reject without task recovery** (C high 02) — rejection recorded, zero Pi tools, wrong result.
6. **Insufficient evidence** (C high 03; first live cancel) — no tools / no native frames.
7. **Long-task hash canonicalization** — systematic extra-file or digest drift on content-hash shards.
8. **Explorer inherits write** — [#514](https://github.com/openpi-dev/openpi/issues/514). Advertised `write`/`bash` on a “read-only” role. No `CHILD_ESCAPED.txt` in E samples.

## Print-host fix (#512)

Before (stock v0.8.1 spawn text), same E task+acceptor, `cursor-grok-4.6-high-fast`, **E-01..10** (not E-06..20): **7/10** correct. E-06..10 are still pre-fix.

After (print-host spawn text + bounded `followUp` barrier), **E-11..20**: **10/10** correct. E-11 spawn result: `This host cannot re-invoke you after you end the turn. You MUST call subagent_wait...`

Receipt `source` fields remain `a3edee28` on those 20 rows (harness hardcoded). Overlay: `results/source-overlay.json`. New C extras record HEAD `7950570`.

Isolated `bun run check` exit 0 (`results/isolated-bun-check.log`) and `bun run test` exit 0, 1470 pass (`results/isolated-bun-test.log`).

No tools disabled, permissions unchanged, no timeout lengthening, no swallowed errors.

## Issues

- [#512](https://github.com/openpi-dev/openpi/issues/512) print-mode settle — evidenced; wiring on [PR #515](https://github.com/openpi-dev/openpi/pull/515), not merged.
- [#513](https://github.com/openpi-dev/openpi/issues/513) Cursor prompt vs advertised names — under investigation; no 10/10 A-loop before-after yet (only 2 failing / 5 on high-fast A).
- [#514](https://github.com/openpi-dev/openpi/issues/514) explorer inherit write — under investigation; no proven write escape.
- [#516](https://github.com/openpi-dev/openpi/issues/516) hang-after-success on print after green acceptor — under investigation.

## Sample limits

- Baseline cells n=5. E high-fast n=20 for the #512 before/after only.
- Cursor usage fields are typically zeros / unknown.
- GetUsableModels probe without `ALL_PROXY` failed; live `pi --print` with the user proxy inherited streamed all three Grok IDs.
- Concurrent parents: 3 long heavies in parallel produced hash errors, not connection storms.

## Isolation

Always `PI_CODING_AGENT_DIR=/tmp/openpi-reliability-20260908/pi-agent`. Unique isolated OpenPI: `/tmp/openpi-reliability-20260908/src`. User packages (`pi-web-access` + `openpi-main-runtime`) and 939 Sessions unchanged.
