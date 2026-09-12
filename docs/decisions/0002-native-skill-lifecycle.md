---
decision-status: accepted
created: 2026-08-31
last-reviewed: 2026-08-31
applies-to: Pi 0.84.1; OpenPI PR 322 revision e4731fcc90af172b0dbed3325220d42f13cfb81c and its native-only replacement
owner: OpenPI maintainers
related-issues: "#282, #316, #317"
related-prs: "#321, #322"
supersedes: none
---

# Decision 0002: Keep Skill loading and lifecycle native to Pi

## Context

[Issue #316](https://github.com/openpi-dev/openpi/issues/316) originally required inline `$skill` references with unchanged visible text and hidden model-visible bodies. [PR #322](https://github.com/openpi-dev/openpi/pull/322) implemented run-scoped snapshots and provider-context projections; the integrated candidate also added completion from [PR #321](https://github.com/openpi-dev/openpi/pull/321) and reattached snapshots after compaction. These features implemented the earlier requirement, not a contributor failure.

After source research, the maintainer chose to use native Pi without an additional body lifecycle. The accepted direction is published in [Discussion #324](https://github.com/openpi-dev/openpi/discussions/324#discussioncomment-18217814). Earlier candidate recommendations and their evidence remain in that Discussion; they are not accepted Decisions superseded by this record.

## Decision

- Pi owns Skill discovery, source identity, trust, metadata, and loading.
- Model-selected Skills use the native metadata catalogue and `read` tool. Explicit invocation uses `/skill:name` and Pi's existing expansion, including native queued input paths.
- Pi owns completion, normal message persistence, compaction and Session reconstruction. OpenPI adds no Skill-specific body cache, provider-only projection, compaction reattachment, or guaranteed reload-marker retention.
- Do not retain a separate `$skill` parser or autocomplete adapter. It would advertise a second invocation contract after its hidden-body execution path was removed. `$skill` remains ordinary text; a model may interpret it naturally, but OpenPI makes no automatic loading guarantee.
- Do not replace the deleted extension with an alias, prompt router, configuration switch, or a new loading module.

## Evidence boundary

The source baseline is Pi 0.84.1 at [`53fa77cc`](https://github.com/earendil-works/pi/commit/53fa77ccd8a279eb87e92294ef3687b03ff80112): [metadata and native read instructions](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/skills.ts#L306-L337), [explicit and queued expansion](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/agent-session.ts#L1219-L1300), and [compaction-aware context reconstruction](https://github.com/earendil-works/pi/blob/53fa77ccd8a279eb87e92294ef3687b03ff80112/packages/coding-agent/src/core/session-manager.ts#L383-L439).

The implementation regression suite is [native-skills.test.ts](../../tests/extensions/shared/native-skills.test.ts). It loads the package through Pi in an isolated fixture and exercises actual Session, read-tool, persistence and compaction paths with a deterministic faux provider. It does not prove model compliance, paid-provider behavior, terminal UI acceptance or released behavior. Command results belong in the implementation receipt, not in claims of model effectiveness.

## Alternatives considered

- Reference-only adaptation and native hidden-body injection were credible earlier candidates, but both would add an OpenPI invocation contract rather than reuse the native command as-is.
- The candidate's immutable snapshots and compaction reattachment enforce a stronger body-visibility contract. That additional contract is intentionally retired, not replaced by weaker synchronization code.
- Other agents' bounded body recovery and reload markers remain useful research. Their existence does not establish a requirement to implement them in OpenPI.

## Consequences

The candidate loses inline multi-Skill expansion and the promise of unchanged raw text plus hidden bodies. Native slash invocation instead expands a user message, which participates in normal persisted history. Native read results also participate in history. No OpenPI-owned stored body format needs migration: the retired snapshots were in-memory provider projections. Existing Session records must not be deleted or rewritten.

Compaction may remove full instructions from the active context while preserving the underlying Session history. Neither automatic rereading nor exact instruction retention is guaranteed. Long reads remain bounded by Pi's read-tool output limits; explicit expansion remains bounded by model context capacity. These are accepted native limitations, not claims of zero risk.

The original Issue acceptance criteria and PR description need alignment before the replacement is merged; this record does not silently change them or close the related Issues. No compatibility alias is promised for an unmerged candidate. A future recovery mechanism requires concrete failure evidence and a separately accepted scope.

## Amendments

None. Adoption records the maintainer's scope decision, not a merge, release or runtime-acceptance receipt.
