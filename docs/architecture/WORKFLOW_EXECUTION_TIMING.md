# Bounded workflow execution timing

- Status: validated at source and synthetic-test boundaries; installed runtime acceptance pending
- Created / verified: 2026-10-04
- Source boundary: `71d12eed69827dfea9b5d85236d1cbb5b94a6a11`; #662 implementation based on main `b0096cce99f721c1c2bcfb6bea617e3d3d63ff3d`
- Issue: [#662](https://github.com/openpi-dev/openpi/issues/662)
- Pi seam: existing workflow invocation ledger, child `AgentSession` event listener, child tool timeout guard, and run-directory artifact writer
- Supersedes: none

## Owners and evidence

Admission and child lifecycle remain facts of `InvocationRecord`: admission is
`claimedAt - requestedAt`; child lifecycle is `terminalAt - runningAt`. The
runner adds a monotonic observation window covering session startup, prompting,
and cleanup. Epoch timestamps are the initial wall-clock anchor plus monotonic
elapsed time, rather than independent wall-clock readings. These windows are
not provider latency measurements.

The existing Pi listener observes tool start/end events directly; transcripts
and compaction cannot erase its aggregate timing. It counts starts, ends,
matched pairs, errors, observed retry starts/ends, explicit runtime timeout and
cancellation boundaries, incomplete starts, unmatched ends, and tracking drops.
The timeout guard reports its own actual timeout/cancellation signal outcome;
error text and tool payloads are not inspected to infer those outcomes. The
observer cannot change tool success or failure if it throws.

`toolDurationMs` sums only matched start/end pairs. `toolWallMs` is the union
of tracked lifecycle intervals, so overlapping tools do not double-count wall
time. An unfinished interval ends at the listener observation cutoff, not an
invented tool completion; `unclosedStarts` and `partial-tool-events` explicitly
mark that uncertainty. After tracking overflow, wall coverage is a lower bound
on observed lifecycle occupancy. `unattributedMs` is the remainder of the runner
window and is never named thinking, model time, or provider latency. Retry
counts do not claim to recover complete retry latency or private reasoning.

## Persistence, privacy and bounds

Each settled execution keeps a small allowlisted numeric `AgentRecord.timing`
summary in `workflow.json`, separate from the bounded `transcripts.json`.
`agent-timing/agent-NNNN.json` adds invocation identity and at most 32 retained
tool entries: bounded tool name/ID, observed start/end, matched duration, and
observed outcome. Detail entries have a shared 16 KiB encoded budget; the whole
artifact has a hard 32 KiB complete-JSON budget. Active pairing is capped at
128 calls, IDs at 256 UTF-8 bytes and tool names at 128 bytes. Oversized IDs
are not tracked; truncated names/IDs and all dropped detail entries are counted.
The existing transcript timing map is also capped at 128 records.

Counts and paired duration continue accumulating after detail retention fills.
Missing start/end events or active overflow mark partial coverage; detailed
entry omission alone does not erase aggregate coverage. No tool arguments,
outputs, message text, provider reasoning, or extra model calls are captured.
The feature adds no tools, runtime permissions or setup preferences, and does
not add timing text to ordinary model-facing completion content. The explicit
saved workflow report includes summary coverage and the artifact reference.

Artifacts reuse the existing run directory and atomic file writer. They are
additional bounded per-call files, not a new Session store or unlimited trace.
Persistence failure is marked `timingArtifactState: failed` without rewriting
the execution outcome; the numeric summary remains available when the workflow
manifest persists. The 32 KiB artifact budget is per call; the existing agent-call
limit bounds the number of such files within a run when configured.

Canonical run files have the existing indefinite disk lifetime and require
manual deletion. Session-memory retention and dashboard projections do not delete
these files. There is no aggregate disk quota or automatic retention across runs,
so timing artifacts can accumulate with the canonical run directories. This
change does not introduce a new storage or retention subsystem.

Reload only retains validated numeric fields and fixed relative artifact paths.
It never replays events or makes model calls. A journal replay writes invocation
provenance `replay`, its origin when available, and no new execution summary or
tool entries. Original timing is not claimed to have been transferred through
the result journal. Legacy records have timing coverage unknown (field absent),
not zero duration. Startup failures before listener installation explicitly use
coverage `unobserved`. Process death before settlement does not promise recoverable
live timing; the mechanism is not a durable event log.

## Candidate validation and measurement boundary

The focused runner, timing, artifacts, retention, timeout, and dashboard suites
passed 114 tests; source typechecking passed. Fixtures cover parallel interval
union, timeout/cancel distinctions, unfinished tools, missing events, compaction-
independent event capture, transcript truncation, reload, replay provenance,
identifier escaping, 10,000 sequential calls and active-limit overflow.

The reproducible synthetic seam check is:

```sh
node --experimental-strip-types scripts/measure-workflow-timing.ts
```

On Node `v26.8.1`, `darwin/arm64`, 20,000 synthetic calls / 40,000 lifecycle
events, nine alternating warmed rounds had median 5.321 ms for the existing
bounded transcript timing map and 7.590 ms with the added diagnostic ledger:
2.268 ms added, or 0.0567 microseconds per event. The final capture retained
128 transcript timing records, 32 diagnostic entries and 5,856 JSON bytes;
all 20,000 pairs were counted and 19,968 detail omissions were explicit.

This is a local synthetic engineering check, not a formal model Benchmark.
It measures event processing only; the timer stops before the diagnostic
snapshot. Snapshot construction, session creation, provider/model behavior,
renderer cost and artifact disk latency are excluded. The measurement
is sensitive to JIT and host scheduling. Full repository gates and independent
review remain the integrating delivery receipt's responsibility. No installed
Pi package or user configuration was changed, and no installed/UI smoke result
is claimed.
