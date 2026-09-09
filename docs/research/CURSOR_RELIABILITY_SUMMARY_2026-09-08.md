---
status: draft
created: 2026-09-08
last-verified: 2026-09-09
applies-to: isolated OpenPI v0.8.1 experiments; exploratory, not a Benchmark
related-issues: "#512, #513, #514, #516"
related-prs: "#484, #515"
supersedes: none
---

# OpenPI Cursor reliability — summary

Exploratory. Not a formal Benchmark. Full matrix and classifications: [`CURSOR_RELIABILITY_PROGRESS_2026-09-08.md`](CURSOR_RELIABILITY_PROGRESS_2026-09-08.md).

## What was verified

- **Runtime:** Pi 0.85.1; experiment source v0.8.1 `a3edee28`; unique isolated package `/tmp/openpi-reliability-20260908/src`. Daily OpenPI remains `openpi-main-runtime` @ `ed9dbc10` (0.7.0) — unused.
- **Configs:** `cursor-grok-4.6-high`, `cursor-grok-4.6-high-fast`, `cursor-grok-4.6-medium-fast` all listed and all streamed live. No silent substitution.
- **18 baseline cells × 5** on the three configs (A–F). Class C native-occurring counts: high-fast **5/5**; high **4/5 then +C-06 → 5**; medium-fast **4/5 then +C-06 → 5**. Old no-native rows kept.
- **Six 10+ minute tasks** with external acceptors (LP-high-fast-01 path-hash pass at 789s; five content-hash runs 633–1710s with evaluated wrong-result acceptors).
- **Cancel / disconnect / timeout / cleanup:** unit logs recaptured (`results/fault/*.unit.log`, 20/20 and 30/30, exit 0); live cancel/disconnect unchanged; leftover processes empty; user Sessions 939.
- **#512:** E-01..10 stock spawn 7/10; E-11..20 print-host 10/10. Version-split index in `results/e-high-fast-512-version-split.md`. Isolated bun logs: `results/isolated-bun-check.log` / `isolated-bun-test.log` (both exit 0). PR #515 not merged.

## What remains unreliable

- high-fast class A identity loop (~2/5). [#513](https://github.com/openpi-dev/openpi/issues/513). No 10/10 before-after yet.
- medium-fast hang-after-success (acceptor green, process does not exit). [#516](https://github.com/openpi-dev/openpi/issues/516).
- D error-retry loops (especially medium-fast 3/5 timeout).
- C on high: 3 correct + 1 wrong among 5 native-occurring (plus earlier no-native C-03).
- Long content-hash acceptors (model canonicalization).
- Explorer/reviewer inherit write/bash. [#514](https://github.com/openpi-dev/openpi/issues/514).

## Before / after (#512 only)

| Source | Attempts | n | Correct |
| --- | --- | --- | --- |
| v0.8.1 stock spawn (E-01..10; E-06..10 still this window) | E / high-fast | 10 | 7 |
| print-host `7950570` spawn text (E-11..20) | E / high-fast | 10 | 10 |

Other cells were not re-run after the fix except in-flight longs.

## Sample limits

n=5 per baseline cell. Usage unknown. Live discovery without proxy failed. Do not treat this file as a Benchmark.
