---
decision-status: accepted
created: 2026-09-01
last-reviewed: 2026-09-01
applies-to: OpenPI development and CI baseline from this Decision forward
owner: OpenPI maintainers
related-issues: "#328"
related-prs: "#269, #330"
supersedes: none
---

# Decision 0003: Update and align the supported Pi development baseline (0.84.4+)

## Context

OpenPI previously expressed conflicting compatibility boundaries across repository assets:
- `README.md` documented support for Pi 0.84.1+;
- `package.json` specified `^0.84.1` for Pi devDependencies;
- `bun.lock` locked development and CI test environments to `0.84.1`, while `peerDependencies` permitted any compatible version via `*`.

This baseline drift created behavioral divergence between fresh installations and frozen-lock CI environments. Specifically, upstream Pi introduced critical lifecycle fixes in `v0.84.3` and enhancements in `v0.84.4`:
1. `4495469a5 fix(coding-agent): compact without provider usage` enables native message-history token estimation and automatic compaction for sessions where provider token usage is missing or zero (e.g. Cursor or output-only providers). In Pi 0.84.1, `AgentSession.prototype._checkCompaction` returned false on zero usage, preventing threshold compaction.
2. `e5dde9a76 feat(ai): add simple tool choice option` added tool choice options to `@earendil-works/pi-ai`.

To keep OpenPI aligned with upstream Pi primitives without forcing downstream provider extensions to implement ad-hoc compaction workarounds or fake token metrics, the declared development baseline and frozen lockfile must be unified.

## Decision

- Update and align the declared and verified development baseline to **Pi 0.84.4+**.
- Align manifest and documentation boundaries to this baseline:
  - `package.json` devDependencies floor updated from `^0.84.1` to `^0.84.4`.
  - `bun.lock` locked to the verified release `@earendil-works/pi-coding-agent@0.84.4`.
  - `README.md` badge and installation requirements updated to `Pi 0.84.4+`.
- In accordance with Pi extension package conventions, published packages continue to express `peerDependencies: { "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": "*", "@earendil-works/pi-tui": "*" }` and do not introduce an artificial runtime host-rejection layer.
- Downstream provider PRs (such as PR #269) must rely on native Pi message-history compaction rather than inventing custom provider-local compaction lifecycles or falsifying token usage.

## Evidence boundary

- Pi upstream commit `4495469a5` was first packaged in `@earendil-works/pi-coding-agent@0.84.3`.
- Tested on `AgentSession.prototype._checkCompaction` with empty/zero usage:
  - Pi 0.84.1: `compactCalls=0`;
  - Pi 0.84.4: `compactCalls=1` (estimated from message history).
- Full OpenPI test suite passes under Pi 0.84.4 across Node 22 and Node 24 (1108 Node tests passed, 1 platform skip; Vitest 30/30 passed; total 1138 passed tests, 0 failures).

## Alternatives considered

- **Maintain 0.84.1 as the baseline**: Rejected because providers lacking full token metrics (e.g. Cursor) would remain unable to trigger native compaction without fragile custom hacks.
- **Declare 0.84.3 while locking 0.84.4 without dedicated sub-version CI**: Rejected to avoid expressing an unverified sub-version floor that drifts from the locked CI evidence.
- **Introduce an install-time version rejection gate**: Rejected because Pi package installation manages peer resolution natively, and OpenPI avoids non-native runtime barriers.

## Consequences

- Developers, CI jobs, and documentation share an exact, verified dependency baseline.
- Future providers can safely rely on Pi 0.84.4+ context estimation without polyfilling compaction.
- Existing sessions and runtime configurations remain unaffected as Pi 0.84.4 is backwards-compatible with 0.84.1 session formats.

## Amendments

None.
