---
decision-status: proposed
created: 2026-09-01
last-reviewed: 2026-09-01
applies-to: Pi 0.84.3+; OpenPI 0.1.0+
owner: OpenPI maintainers
related-issues: "#328"
related-prs: "#269"
supersedes: none
---

# Decision 0003: Define and enforce the supported Pi baseline (0.84.3+)

## Context

OpenPI previously expressed three conflicting compatibility boundaries:
- `README.md` documented support for Pi 0.84.1+;
- `package.json` specified `^0.84.1` for Pi devDependencies;
- `bun.lock` locked dependencies to `0.84.1`, while `peerDependencies` permitted any compatible version via `*`.

This baseline drift created behavioral divergence between fresh installations and frozen-lock environments. Specifically, upstream Pi introduced critical lifecycle fixes in `v0.84.3`:
1. `4495469a5 fix(coding-agent): compact without provider usage` enables native message-history token estimation and automatic compaction for sessions where provider token usage is missing or zero (e.g. Cursor or output-only providers). In Pi 0.84.1, `AgentSession.prototype._checkCompaction` returned false on zero usage, preventing threshold compaction.
2. `e5dde9a76 feat(ai): add simple tool choice option` added tool choice options to `@earendil-works/pi-ai`.

To keep OpenPI aligned with upstream Pi primitives without forcing downstream provider extensions to implement ad-hoc compaction workarounds or fake token metrics, a unified project-level baseline must be established.

## Decision

- Elevate the official supported baseline to **Pi 0.84.3+**.
- Align all manifest and documentation boundaries to this baseline:
  - `package.json` devDependencies floor updated from `^0.84.1` to `^0.84.3`.
  - `bun.lock` refreshed to the latest compatible release (0.84.4).
  - `README.md` badge and requirements updated to `Pi 0.84.3+`.
- Downstream provider PRs (such as PR #269) must rely on Pi 0.84.3+ native compaction and token estimation rather than inventing custom provider-local compaction lifecycles or falsifying token usage.

## Evidence boundary

- Pi upstream commit `4495469a5` was first packaged in `@earendil-works/pi-coding-agent@0.84.3`.
- Tested on `AgentSession.prototype._checkCompaction` with empty/zero usage:
  - Pi 0.84.1: `compactCalls=0`;
  - Pi 0.84.4: `compactCalls=1` (estimated from message history).
- Full OpenPI test suite passes under Pi 0.84.4 across Node 22 and Node 24 (1138+ passed tests, 0 failures).

## Alternatives considered

- **Maintain 0.84.1 as the baseline**: Rejected because providers lacking full token metrics (e.g. Cursor) would remain unable to trigger native compaction without fragile custom hacks.
- **Refresh lockfile without changing package.json caret floor**: Rejected because `README.md` and `package.json` would continue to promise a floor version (0.84.1) that does not support full lifecycle behavior.
- **Upgrade dependencies directly inside provider PRs (e.g. #269)**: Rejected to preserve separation of concerns between project-wide infrastructure governance and individual provider features.

## Consequences

- All developers, CI jobs, and published packages share a coherent dependency baseline.
- Future providers can safely rely on Pi 0.84.3+ context estimation without polyfilling compaction.
- Existing sessions and runtime configurations remain unaffected as Pi 0.84.3+ is backwards-compatible with 0.84.1 session formats.

## Amendments

None.
