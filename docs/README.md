# OpenPI documentation

This directory is the canonical home for durable project knowledge. GitHub Issues remain the public discussion and work-tracking surface; a repository record preserves a reusable conclusion without replacing the Issue history that produced it.

## Choose the record

| Need | Record | Boundary |
| --- | --- | --- |
| Discuss a question or track work | GitHub Issue | Context, alternatives, status, and decisions still needed |
| Explain contribution procedures | [`contributing/`](contributing/) | Current contributor workflow, not architecture or research |
| Track an engineering promise and its enforcement | [`disciplines.md`](disciplines.md) | Inventory of adopted or grandfathered constraints and their CI or manual checks; not an adoption path |
| Preserve sourced investigation | [`research/`](research/) | Facts, sources, inferences, recommendations, and unknowns |
| Preserve design exploration | [`design/`](design/) | Alternatives and trade-offs; not an adopted project constraint by itself |
| Adopt a durable project constraint | [`decisions/`](decisions/) | Accepted choice, rationale, alternatives, consequences, and replacement history |
| Describe stable runtime structure | [`architecture/`](architecture/) | Current ownership, seams, lifecycle, and authority at a named revision |
| Publish a formal measurement | [`benchmarks/`](benchmarks/) | Frozen protocol, identities, results, limitations, and evidence references |
| Describe shipped user behavior | Release notes | Version-specific, user-visible release facts |

Link a durable record to its source Issue and relevant PRs when available. Link the Issue back to the record. The record is a reviewed projection, not a rewrite of the discussion.

## Evidence and adoption are different axes

Research, design, architecture, and Benchmark records may be:

- `draft`: incomplete or not yet checked at the stated boundary;
- `validated`: checked against the named sources, revision, or evidence receipt;
- `superseded`: retained for history and linked to its replacement.

Decision records instead use `proposed`, `accepted`, `rejected`, or `superseded`. A validated observation can support a Decision, but it does not adopt the Decision automatically.

The engineering discipline ledger uses enforcement states (`enforced` or `manual`) and CI reachability (`yes` or `no`). Those fields describe how a promise is checked, not whether it is adopted or whether supporting evidence is validated. Adding an `OP-*` row does not adopt a new durable constraint; new constraints still require accepted Decision provenance. Rows that predate Decision 0001 are grandfathered as legacy constraints while their existing checks remain operational.

New or materially revised governed records should state their status, creation and verification dates, applicable source boundary, related Issues and PRs, and superseding relationship. Existing documents predate this contract and remain legacy records until a scoped review migrates them; their presence does not imply validation under the new policy.

## Evidence boundary

Separate verified facts from interpretation and recommendations. Repository validation proves that a record is well-formed and reachable; it does not prove a Benchmark conclusion, runtime behavior, release, deployment, or public acceptance.

A formal Benchmark publication needs independently reviewable source, model, task, verifier, isolation, accounting, failure, and limitation evidence. A hash alone identifies bytes only when the referenced bytes are retrievable. Keep large JSONL, logs, Sessions, candidate workspaces, caches, credentials, and private settings outside Git under a stable archive identity with bounded receipts.

Historical conclusions are append-only in meaning. Amend a record or mark it `superseded`; do not silently rewrite what an earlier revision claimed.

## Governance

[`Decision 0001`](decisions/0001-documentation-and-evidence-governance.md) adopts this information architecture. Category indexes and the discipline ledger describe local shape and enforcement without widening that Decision. Changes that add or remove a durable project constraint, or alter category ownership, evidence states, or publication gates, require a new or superseding Decision.
