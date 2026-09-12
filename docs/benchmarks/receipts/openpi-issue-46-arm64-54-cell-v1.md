---
receipt-id: openpi-issue-46-arm64-54-cell-v1
status: draft
created: 2026-08-29
source-issue: "https://github.com/openpi-dev/openpi/issues/46"
source-report: "../OPENPI_PI_OMP_54_CELL_DIAGNOSTIC.md"
source-task-revision: d1f1920f2d817a831f466d0ff363ef795a9a3b00
schedule-sha256: 974fdc67aad36c4c890a83d6705e7a687610a0ecbef00a0c0ca4e7efac369a62
evidence-kind: bounded-credential-free-receipt
raw-evidence: not-included
---

# Bounded evidence receipt: Issue #46

This receipt is the small, credential-free evidence boundary for the 54-cell
ARM64 diagnostic reported in Issue [#46](https://github.com/openpi-dev/openpi/issues/46).
It is versioned with the report and identified by `receipt-id` above.

The ledger below records the three-repeat outcome for each model, harness, and
task. Summing `pass`, `fail`, and `indeterminate` by model and harness
reproduces the report's 7/9, 4/9, and related result totals. Aggregate wall,
usage, and request counts are retained separately because the public source
only exposed those metrics at harness level.

## Frozen identities

| Field | Value |
| --- | --- |
| Pi | `@earendil-works/pi-coding-agent 0.84.2` |
| OpenPI | `@tt-a1i/openpi 0.3.0` |
| OMP | `@oh-my-pi/pi-coding-agent 17.2.12` |
| Bun | `1.3.14` |
| Harbor | `0.20.0` |
| Runtime | Podman server `6.0.2`, Linux ARM64 VM |
| Repeats | 3 per model, task, and harness |
| Deadline | 1,800 seconds per cell |
| Lock fingerprints | GLM `sha256:037179456f3223457e428b9d5543911144b045bcea7ee7127728b27dd735780e`; Luna `sha256:00b9db64606832521df7f853d63d5e50d1e6754920e0ac51e1b32c2aacc4866c` |

## Outcome ledger

Each outcome is `pass / fail / indeterminate` across three repeats.

| Model | Harness | Task | Repeats | Pass | Fail | Indeterminate |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GLM-5.3 | Bare Pi | `git-leak-recovery` | 3 | 3 | 0 | 0 |
| GLM-5.3 | Bare Pi | `sqlite-db-truncate` | 3 | 3 | 0 | 0 |
| GLM-5.3 | Bare Pi | `cancel-async-tasks` | 3 | 1 | 1 | 1 |
| GLM-5.3 | OpenPI | `git-leak-recovery` | 3 | 3 | 0 | 0 |
| GLM-5.3 | OpenPI | `sqlite-db-truncate` | 3 | 3 | 0 | 0 |
| GLM-5.3 | OpenPI | `cancel-async-tasks` | 3 | 1 | 2 | 0 |
| GLM-5.3 | OMP | `git-leak-recovery` | 3 | 3 | 0 | 0 |
| GLM-5.3 | OMP | `sqlite-db-truncate` | 3 | 3 | 0 | 0 |
| GLM-5.3 | OMP | `cancel-async-tasks` | 3 | 1 | 2 | 0 |
| GPT-5.6 Luna | Bare Pi | `git-leak-recovery` | 3 | 3 | 0 | 0 |
| GPT-5.6 Luna | Bare Pi | `sqlite-db-truncate` | 3 | 3 | 0 | 0 |
| GPT-5.6 Luna | Bare Pi | `cancel-async-tasks` | 3 | 1 | 2 | 0 |
| GPT-5.6 Luna | OpenPI | `git-leak-recovery` | 3 | 3 | 0 | 0 |
| GPT-5.6 Luna | OpenPI | `sqlite-db-truncate` | 3 | 3 | 0 | 0 |
| GPT-5.6 Luna | OpenPI | `cancel-async-tasks` | 3 | 1 | 2 | 0 |
| GPT-5.6 Luna | OMP | `git-leak-recovery` | 3 | 3 | 0 | 0 |
| GPT-5.6 Luna | OMP | `sqlite-db-truncate` | 3 | 1 | 2 | 0 |
| GPT-5.6 Luna | OMP | `cancel-async-tasks` | 3 | 0 | 3 | 0 |

## Harness-level accounting

| Model | Harness | Wall seconds | Provider tokens | Physical POST | Logical attempts | Extra physical POST |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| GLM-5.3 | Bare Pi | 2647.724 | 249625 | 94 | not reported | not reported |
| GLM-5.3 | OpenPI | 1107.098 | 331851 | 87 | not reported | not reported |
| GLM-5.3 | OMP | 1081.746 | 2176017 | 106 | not reported | not reported |
| GPT-5.6 Luna | Bare Pi | 1129.885 | not returned | 43 | 43 | 0 |
| GPT-5.6 Luna | OpenPI | 1151.213 | not returned | 46 | 46 | 0 |
| GPT-5.6 Luna | OMP | 1803.368 | not returned | 110 | 92 | 18 |

## Integrity boundary

- The source report states 27/27 cells persisted for each model and 54 cells total.
- The source report states the frozen source, schedule, and lock checks passed.
- The source report states 0 missing roots, 0 credential leaks, and 0 scan failures.
- Raw JSONL, Sessions, logs, candidate workspaces, caches, and provider credentials are not included.
- This receipt is a bounded transcription of the public source material, not an independent rerun or an official Terminal-Bench result.

Independent validation remains pending until a reviewer can retrieve the
underlying credential-free archive or an equivalent bounded source receipt.
