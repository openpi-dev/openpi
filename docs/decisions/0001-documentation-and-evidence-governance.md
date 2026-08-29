---
decision-status: accepted
created: 2026-08-29
last-reviewed: 2026-08-29
applies-to: OpenPI repository documentation from this Decision forward
owner: OpenPI maintainers
related-issues: "#198, #277"
related-prs: "#278, #290"
supersedes: none
---

# Decision: Documentation and evidence governance

## Context

GitHub Issues currently carry discussion, implementation tracking, research, design proposals, and Benchmark summaries in the same timeline. Reusable conclusions become hard to find, and readers can mistake a recommendation, a successful repository check, or an unavailable local artifact for an adopted or independently verified result.

## Decision

Issues remain the canonical discussion and work-tracking surface. The repository `docs/` tree is the canonical home for reusable research, design history, accepted Decisions, architecture descriptions, contribution procedures, and formal Benchmark records.

Evidence validation and project adoption are separate. Research, design, architecture, and Benchmark records use evidence states; Decision records use adoption states. A recommendation becomes a project constraint only through an accepted Decision.

The engineering discipline ledger is an enforcement projection of constraints adopted by a Decision or explicitly retained as grandfathered legacy constraints. Its `enforced` or `manual` status and CI reachability describe how a promise is checked; they do not adopt the promise or validate its evidence. Adding a ledger row alone cannot create a new durable project constraint.

This policy is forward-only. Existing documents remain legacy records until a scoped review migrates them. No automated rewrite or bulk metadata migration is implied.

## Evidence boundary

This Decision adopts information architecture and publication boundaries. It does not validate any existing Benchmark result, adopt any candidate runtime design, add a documentation validator, or change runtime behavior.

Repository checks may later verify structure and reachability, but they cannot prove the truth of a Benchmark conclusion. Formal results require independently reviewable identities, accounting, failure classification, limitations, and retrievable evidence.

## Alternatives considered

- **Keep reusable conclusions only in Issues:** rejected because conclusions remain difficult to discover and version with code.
- **Treat every complete design document as authoritative:** rejected because document completeness is not project adoption.
- **Retrofit every historical document immediately:** rejected because it creates a broad rewrite with weak review provenance.
- **Publish complete raw evidence in Git:** rejected because logs, Sessions, credentials, caches, and workspaces may be large or sensitive.

## Consequences

- Contributors have one entry point for choosing a durable record.
- Accepted constraints require explicit Decision provenance.
- The discipline ledger reports enforcement separately from adoption; rows that predate this Decision remain operational as grandfathered legacy constraints without gaining retroactive Decision provenance.
- Existing records do not become validated merely because they are indexed.
- Benchmark protocol, automated validation, and individual result publication can proceed as separate changes with their own evidence gates.
- Large or sensitive raw artifacts remain outside Git under stable, reviewable identities.

## Amendments

None.
