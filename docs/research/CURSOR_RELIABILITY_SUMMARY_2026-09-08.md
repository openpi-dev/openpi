---
status: draft
created: 2026-09-08
last-verified: 2026-09-08
applies-to: isolated OpenPI v0.8.1 experiments; exploratory, not a Benchmark
related-issues: "#512, #513, #514"
related-prs: "#484"
supersedes: none
---

# OpenPI Cursor reliability — summary

Exploratory. Not a formal Benchmark. Full matrix and classifications: [`CURSOR_RELIABILITY_PROGRESS_2026-09-08.md`](CURSOR_RELIABILITY_PROGRESS_2026-09-08.md).

## What was verified

- **Runtime:** Pi 0.85.1; experiment source v0.8.1 `a3edee28`; unique isolated package `/tmp/openpi-reliability-20260908/src`. Daily OpenPI remains `openpi-main-runtime` @ `ed9dbc10` (0.7.0) — unused.
- **Configs:** `cursor-grok-4.6-high`, `cursor-grok-4.6-high-fast`, `cursor-grok-4.6-medium-fast` all listed and all streamed live. No silent substitution.
- **18 baseline cells × 5** on the three configs (A–F). high-fast C is 5/5 native-reject → Pi recover (PR #484).
- **Six 10+ minute tasks** with external acceptors (LP-high-fast-01 path-hash pass at 789s; five content-hash runs 633–1710s with evaluated wrong-result acceptors).
- **Cancel / disconnect / timeout / cleanup:** unit 20+30; live cancel with tool-seen; live proxy-drop TLS disconnect; leftover processes empty; user Sessions 939.
- **#512 fix:** E high-fast 7/10 → 10/10 on the same acceptor. Isolated `bun run check` + `bun run test` green.

## What remains unreliable

- high-fast class A identity loop (~2/5). [#513](https://github.com/openpi-dev/openpi/issues/513). No 10/10 before-after yet.
- medium-fast hang-after-success (acceptor green, process does not exit).
- D error-retry loops (especially medium-fast 3/5 timeout).
- C on high: 3/5 valid native recoveries.
- Long content-hash acceptors (model canonicalization).
- Explorer/reviewer inherit write/bash. [#514](https://github.com/openpi-dev/openpi/issues/514).

## Before / after (#512 only)

| Source | Task | n | Correct |
| --- | --- | --- | --- |
| v0.8.1 stock spawn text | E / high-fast | 10 | 7 |
| v0.8.1 + print-host wiring | E / high-fast | 10 | 10 |

Other cells were not re-run after the fix except in-flight longs.

## Sample limits

n=5 per baseline cell. Usage unknown. Live discovery without proxy failed. Do not treat this file as a Benchmark.
