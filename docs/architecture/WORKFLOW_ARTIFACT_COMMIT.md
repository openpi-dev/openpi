# Workflow terminal artifact commit protocol

- Status: `validated`
- Created: 2026-09-04
- Verified: 2026-09-04
- Source boundary: implementation commit `68774e1`, based on `c1c60cd`
- Affected Pi primitive: the OpenPI Workflow extension's run-directory persistence; Pi Sessions, messages, providers, and child lifecycle remain unchanged
- Related Issue: [#110](https://github.com/openpi-dev/openpi/issues/110)
- Related PR: [#386](https://github.com/openpi-dev/openpi/pull/386)
- Related Decision: [0001 — documentation and evidence governance](../decisions/0001-documentation-and-evidence-governance.md)
- Supersedes: none

## Ownership

`workflow.json` remains the canonical persisted projection of a Workflow run. `result.json`, `transcripts.json`, and `journal.json` are dependent side artifacts. The hidden `.workflow-commit.json` file is a bounded recovery receipt, not another run manifest and not model-visible state.

The runtime still owns terminalization, delivery, cancellation, and cleanup. This protocol only makes the existing filesystem projection recoverable across a process crash between individually atomic file replacements.

## Commit sequence

For a terminal run, persistence follows this order:

1. Remove any receipt from an older attempt, failing closed if that cannot be done.
2. Atomically publish a terminal `workflow.json` without side-artifact references. A later write failure therefore cannot leave a known terminal run recorded as `running`.
3. Build the final compact manifest and every dependent artifact in memory.
4. Atomically write `.workflow-commit.json`. It contains version `1`, the terminal run identity, the terminal status, the artifact references, and a filename, byte count, and SHA-256 digest for each artifact.
5. Atomically replace each side artifact.
6. Atomically replace `workflow.json` with the exact manifest recorded by the receipt.
7. Best-effort remove the receipt. A crash or unlink failure after step 6 is harmless because recovery recognizes the already-committed manifest.

Running checkpoints retain the existing lightweight path and do not create commit receipts. Successful terminal persistence leaves no receipt behind.

## Recovery invariants

Persisted Workflow reads and delivery-receipt updates check for a pending commit before consuming `workflow.json`. Recovery promotes the recorded manifest only when all of these facts hold:

- the receipt is a regular, non-symlink file within its byte budget;
- the receipt version and run id match the containing generated run directory;
- the recorded manifest is bounded JSON for a known terminal state;
- artifact names are unique members of the fixed `result.json`, `transcripts.json`, and `journal.json` set;
- manifest references agree exactly with the receipt's artifact set;
- every artifact is a regular, non-symlink file whose byte count and SHA-256 digest match the receipt.

If the existing manifest has the same run id, terminal state, and artifact references, recovery only removes the stale receipt; delivery and resource-reference fields may have been updated since the receipt was written. The already-committed check deliberately ignores those mutable fields and never relies on whole-file byte equality. If every artifact validates and the manifest is still the earlier terminal projection, recovery atomically completes the manifest commit. Missing, truncated, substituted, oversized, malformed, or path-traversing evidence never gains an artifact reference.

An incomplete or invalid receipt stays available for inspection and for a concurrently finishing writer; the next terminal persistence attempt replaces the single fixed receipt. Legacy runs without a receipt keep their existing compatibility behavior. In particular, recovery does not infer completion merely from an orphan `result.json`, because that file alone does not carry a trustworthy terminal identity.

## Evidence and limits

At `fd2842f`, focused tests cover full preparation followed by recovery, incomplete preparation, same-size content substitution, an already-committed manifest, delivery mutation after recovery, normal receipt cleanup, and the dashboard/startup read path. `bun run check` passed; the full suite passed with 1247 Node tests, 0 failures, 1 skip, and 30 Vitest tests.

The guarantee is process-crash recovery at the repository's existing per-file atomic-replace boundary. It does not claim a filesystem-wide transaction or power-loss durability beyond `writeFileAtomic`, which does not currently fsync file and directory metadata.

## 2026-09-07 amendment: predecessor identity

- Verification boundary: PR #386 integrated with main `0bd0041`; this amendment describes the subsequent repair, not the historical validation above.
- Evidence: focused regressions reproduce the original recovery overwriting a newer failure publication and recreating a missing canonical manifest. The repaired path refuses both, and also preserves same-status cleanup changes.

The unshipped version-1 receipt now also requires `predecessorSha256`: the SHA-256 of the exact reference-free `workflow.json` bytes successfully published before preparing the receipt. `persistWorkflowTerminalState` returns that digest; ordinary terminal-recovery callers may ignore it.

Before promoting a pending receipt, recovery requires a bounded, regular, non-symlink canonical file with exactly that digest. Missing, unreadable, replaced, or newer canonical facts make the receipt invalid for promotion. A final-manifest failure may therefore publish a newer `failed` state without a stale completed receipt later erasing its error. Same-status cleanup and delivery changes are equally protected. Complete artifacts alone no longer authorize replacement.

The already-committed case still removes only the receipt and preserves current mutable delivery/resource fields. A delivery mutation before the artifact commit completes conservatively prevents later promotion; automatic recovery does not reset that delivery state. Receipts from the earlier unshipped implementation without a predecessor digest fail closed. This is a process-crash protocol under the existing single-writer assumption, not a filesystem compare-and-swap transaction against simultaneous external writers.
