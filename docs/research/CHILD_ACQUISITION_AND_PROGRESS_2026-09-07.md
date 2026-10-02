---
status: validated
created: 2026-09-07
last-verified: 2026-09-07
applies-to: OpenPI child acquisition and progress projection
related-issues: #428
related-prs: #429
supersedes: none
---

# Child acquisition and progress reliability audit

- Status: validated for deterministic defect reproduction; repair acceptance is recorded in the linked PR
- Created / verified: 2026-09-07
- Source boundary: `eaf470bab4ac2dda607d16c6ddee66dc35367527` (main after PR #426)
- Issue: [#428](https://github.com/openpi-dev/openpi/issues/428)
- Repair PR: [#429](https://github.com/openpi-dev/openpi/pull/429)
- Supersedes: none

## Scope and provenance

This audit checks child startup ownership and progress projection. The repair uses an isolated source worktree; `pi list` still identifies the user's separate `openpi-main-runtime` checkout at `c8f2c13`. Source validation does not imply that the user's already-running Pi loaded the fixes. No user role files, settings, private Sessions, or ignored evidence were changed.

Existing viewport, retained-history, headless-shell and terminal-artifact PRs (#327, #319, #423 and #386) remain separate. The previous Cursor/tool/cwd repair was merged as [#426](https://github.com/openpi-dev/openpi/pull/426).

## Confirmed mechanisms

### Cancelled ordinary child acquisition loses its owner

The production Pi backend used an interruptible `Effect.tryPromise` acquisition but ignored its abort signal. Its cleanup finalizer was registered only after resource loading, session creation and extension binding. A deterministic probe paused the session factory, interrupted the scoped spawn, then released the factory. The late child bound extensions despite cancellation and received zero abort, shutdown or dispose calls.

The repair gives startup provisional cleanup ownership before the first asynchronous acquisition, observes cancellation at acquisition boundaries and reuses the bounded child shutdown helper. A child arriving after cancellation is disposed without beginning extension binding. Ownership transfers to the existing backend finalizer after registration. The tool boundary preserves interruption as a typed error, including combined interruption and cleanup failure, instead of treating it as a known quiescent startup failure. For isolated startup, it retains the checkout and reports its path/branch while quiescence is unknown; a paused binding hook can therefore finish writing without its cwd disappearing. Known non-interrupted startup failures retain the existing empty-worktree cleanup.

Already-running extension hooks cannot be forcibly stopped by an SDK API that offers no cancellation; bounded cleanup is not a claim that arbitrary extension code becomes cancellable.

### Cancelled Workflow worktree acquisition skips cleanup

A disposable Git repository's post-checkout hook held `git worktree add` in progress. Cancelling the Workflow, releasing the hook and awaiting run completion left two worktrees instead of one. The abort check threw after successful creation but before the owning `try/finally`.

The repair moves that check inside the existing cleanup region. Existing policies remain authoritative: an empty worktree may be reclaimed, while user-produced dirty work and uncertain cleanup retain their evidence.

### Byte pressure hides the newest failure

With an initial task, twenty 16-KiB tool results and a final error, the production progress projection omitted the final error and last showed `call-15`. Its entry-count policy retained the first and newest entries, but its byte-budget pass consumed the budget from oldest to newest.

The repair reserves the initial entry and allocates the remaining text budget from newest to oldest, then restores chronological display. Tool identity, error state and timing travel with retained entries. Existing per-entry truncation and omission markers remain explicit. The 256-KiB limit is the source-text budget; markers and metadata are not a claim of a strict serialized-object byte limit. Pi's canonical messages and tool results are unchanged.

### Tool preview scans content it never displays

`toolPreview` split the entire tool output into lines for every update even though the UI needed only its first nonempty line. An exact-source synthetic probe returned the same five characters (`ready`) while ten updates over an 8-MiB dense-line payload took approximately 442 ms. This is a stress case, not a claim that ordinary Pi Bash updates routinely contain 8 MiB; native tools may already truncate their partial results.

The repair finds the first meaningful text and examines only the first-line preview window, using the existing consumer's 64-KiB character limit. Necessary leading-whitespace search remains linear; trailing multiline output no longer creates a whole-output array. Full tool results remain canonical and available independently of the preview.

One local Node 26.3.0 diagnostic comparison reused identical text payloads, extracted the before function from the frozen source and imported the repaired helper. Both returned `ready`; timing excluded construction of the payload. This isolates preview work rather than end-to-end latency:

| Payload and repeated calls | Before | After |
| --- | --- | --- |
| 50 KiB, 80-character lines, 1000 calls | 8.882 ms | 0.310 ms |
| Synthetic 8 MiB, 80-character lines, 100 calls | 165.259 ms | 0.013 ms |
| Synthetic 8 MiB, short lines, 10 calls | 440.523 ms | 0.003 ms |

Small after-values approach timer/JIT noise. The useful result is removal of whole-tail splitting, enforced by a deterministic regression, not a precise whole-application speedup multiplier.

## Evidence and limits

Regression tests exercise production Effect cancellation and the real Git worktree lifecycle, plus byte-pressure error retention and first-line preview behavior. `bun run check` passed. Standard `bun run test` passed 1446 Node tests with one platform skip and 30 Vitest tests. Two independent reviews are clean after closing the interrupted-startup worktree classification gap. Remote CI status is recorded in the PR. No paid model calls are needed to reproduce these deterministic runtime defects.

A separate synthetic Cursor transport probe identified repeated copying while accumulating a large fragmented Connect frame. It is outside this bounded child acquisition/progress repair, as are speculative Graph recomputation and renderer-retention concerns without a completed failure proof. This record is a diagnostic investigation, not a formal throughput Benchmark or an assertion that every possible performance issue was resolved.

## Verified facts

The deterministic tests and bounded probes described above establish the recorded lifecycle and projection observations at the source boundary.

## Inferences

The repair interpretation is limited to the mechanisms reproduced by those tests; timing measurements are not generalized performance claims.

## Recommendations

Keep child ownership, cancellation, and progress projection within their existing Pi lifecycle seams and rerun the linked PR validation when those seams change.

## Unknowns

Provider-specific behavior, installed-runtime acceptance, and unmeasured workload limits remain outside this record.
