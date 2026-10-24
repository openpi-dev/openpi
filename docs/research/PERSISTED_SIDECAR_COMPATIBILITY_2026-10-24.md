---
status: validated
created: 2026-10-24
last-verified: 2026-10-24
applies-to: OpenPI main 31b2d045ec7147ac5fc3b2e350bbd55b0a2aa7cd
related-issues:
  - https://github.com/openpi-dev/openpi/issues/901
  - https://github.com/openpi-dev/openpi/issues/118
  - https://github.com/openpi-dev/openpi/issues/193
  - https://github.com/openpi-dev/openpi/issues/196
related-prs: []
supersedes: none
---

# OpenPI-owned persisted sidecar compatibility inventory

## Scope

This P0 record inventories the versioned, OpenPI-owned persisted sidecars that
are currently relevant to their decoders. It records present behavior; it does
not adopt a global migration policy, change a schema, or authorize automatic
data rewrites.

Pi owns Session identity, transcript files, resume, fork, and Session-file
migration. Pi Session JSONL, provider state, credentials, and user workspaces
are intentionally absent from this inventory.

## Source-verified inventory

| Record family | Owner and source seam | Current version | Legacy / malformed / future outcome | Why that outcome is safe |
| --- | --- | ---: | --- | --- |
| Setup configuration | `extensions/shared/setup-config.ts` | `configVersion: 1` | Unversioned config is readable and emits a legacy diagnostic; explicit setup save writes v1. Invalid or future `configVersion` blocks writes and preserves the original bytes. | Configuration is user-owned input. OpenPI must not silently rewrite unreadable or unknown input. |
| Workflow replay journal | `extensions/workflows/journal.ts` | `2` | v1 and unknown versions decode to no replay cache; malformed entries are discarded rather than reused. | Version 1 lacks side-effect/resource identity, so reuse could replay an unsafe result. |
| Plan Mode branch-local entry | `extensions/plan-mode/persisted-state.ts` | `1` | Only exact v1 shapes restore. A malformed or future newest entry leaves Plan Mode blocking writes until an explicit `/plan off`. | An untrusted sidecar must not silently re-open a write-capable mode. |
| Web turn-change evidence | `web/protocol/turn-changes.ts` | `1` or `2` | Only supported version-specific shapes and byte bounds are exposed; anything else is unavailable. | Reader-side evidence must not become trusted UI data when its identity or completeness is unknown. |
| Workflow artifact commit marker | `extensions/workflows/artifacts.ts` | `1` | Invalid or unsupported markers are unavailable for recovery. | Recovery must not accept a marker whose run, manifest, or artifact identity cannot be verified. |

## P0 executable evidence

- `tests/extensions/shared/setup-config.test.ts` covers missing, malformed,
  legacy, and unsupported configuration versions; it asserts that blocked input
  remains unchanged.
- `tests/extensions/workflows/journal.test.ts` covers legacy and future journal
  versions; neither produces replayable entries.
- `tests/extensions/plan-mode/persisted-state.test.ts` covers an exact current
  Plan Mode record plus future and malformed records; the latter remain blocked
  and provide no ready plan.

These tests use synthetic values only. They do not read or write Pi Session
files, user workspaces, provider credentials, or a real agent directory.

## P0 conclusion and remaining decision

The existing owners already choose different safe outcomes because their
semantics differ. The shared P0 invariant is deliberately narrow: unsupported
or malformed OpenPI-owned sidecars must not be mistaken for successful replay,
available evidence, or an open write gate.

Maintainers must decide whether these owner-local rules need a durable,
repository-level compatibility contract. If not, this inventory and its tests
remain evidence only; no general registry, migration engine, second Session
store, orchestration runtime, or user-data migration follows from it.
