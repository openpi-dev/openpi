---
status: draft
created: 2026-09-09
last-verified: 2026-09-09
applies-to: isolated E high-fast receipts; exploratory, not a Benchmark
related-issues: "#512"
related-prs: "#515"
---

Canonical machine+human index lives outside git:

- `/tmp/openpi-reliability-20260908/results/e-high-fast-512-version-split.md`
- `/tmp/openpi-reliability-20260908/results/e-high-fast-512-version-split.json`
- `/tmp/openpi-reliability-20260908/results/source-overlay.json`

**E-01..10** = pre-fix stock spawn / `a3edee28` behavior (7/10). E-06..10 are in this window.

**E-11..20** = post-fix spawn text from commit `7950570` (10/10). Receipt `source` fields on those rows are still the hardcoded stock SHA; do not treat that field as product HEAD.
