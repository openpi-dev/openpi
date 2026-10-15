# Cursor context and transport follow-up

- Status: validated source investigation and deterministic reproductions; PR validation is recorded in the linked Issue
- Created / verified: 2026-09-07
- Source boundary: `69a7e5f19b4db3e32b7ad6abc81884edf767b2e3` (v0.6.1)
- Issue: [#431](https://github.com/openpi-dev/openpi/issues/431)
- Repair PR: [#432](https://github.com/openpi-dev/openpi/pull/432)
- Supersedes: none

## Scope and runtime identity

The isolated repair checkout is `openpi-context-transport-performance`. The user's `pi list` still reports one OpenPI source, `openpi-main-runtime`, at `c8f2c13d49f2e6cd3b389dfff72ccc2eaca970c1`. Source tests do not imply that the running Pi has loaded these fixes. No role, auth, settings or user runtime files were changed.

## Context: preserve the two protocol projections

A local request probe with a 115,000-byte historical user message found that payload in two blobs, totaling approximately 230,565 stored bytes with surrounding metadata. This is a local representation cost, not proof of doubled model context or billed input.

The primary upstream [history repair #737](https://github.com/can1357/oh-my-pi/pull/737) identifies the JSON root history as model input and the protobuf turns as Cursor UI state. It records actual history loss when only turns were populated. OpenPI builds both from current Pi messages. Removing either without a protocol acceptance test would be a semantic change, not a safe allocation optimization. Request-context rules similarly remain unchanged; server-side deduplication and exact tokenization have not been measured here.

Cursor's generated-token deltas do not contain complete input/cache usage. Keep usage unknown rather than reporting generated tokens as total context. Current Pi skips all-zero usage when selecting a context anchor and estimates message history for compaction; the existing real AgentSession regression exercises an 800,000-character prompt with generated-only token updates. This is a heuristic, not an exact tokenizer or provider billing receipt. The repair adds request-history regressions, including rebuilding from a compacted context without reviving omitted history. It does not replace Pi compaction or introduce a second usage ledger.

## Transport: repeated frame copying

The previous receive loop concatenated the entire incomplete frame for each network chunk. A deterministic 1 MiB payload split into 1 KiB chunks copied 538,442,757 bytes for 1,048,581 wire bytes. The regression counts byte-copy operations rather than enforcing a machine-dependent timing threshold.

The repair accumulates the five-byte header, rejects oversized frames before body allocation, and copies a fragmented payload into one bounded buffer. Contiguous payloads use a synchronous borrowed slice. Each body byte is copied at most once; header copying is constant per frame. The existing 16 MiB frame limit is unchanged. A fragmented frame now reserves its declared bounded body size once the complete header arrives, even before its whole body arrives; this trades repeated incremental allocations for one bounded reservation.

Tests cover all split positions, empty/coalesced frames, retained-buffer stability, exact-limit acceptance, oversized headers, linear copy bounds and production EOF errors. Existing production transport tests cover text/thinking, tool pairing, trailers, permission denial, timeout and cancellation. A complete header awaiting its body still delays tool handoff; a partial header retains the existing behavior. This is an allocation repair, not a throughput claim for live Cursor or eight concurrent model calls.

## Transcript: confirmed cache error, viewport priority narrowed

On the fixed base, reusing the same transcript items after changing cwd could retain a path formatted relative to the old directory. A warm renderer showed `Read file.ts` where a fresh renderer showed the original absolute path. Adding cwd to the bounded per-item cache key fixes that operator-visible error. It does not change model context or native tool execution.

The separate [viewport PR #327](https://github.com/openpi-dev/openpi/pull/327), inspected at `9691b006a9a96c786a9ed4cd6d5fd00ae8499e9f`, reports approximately 0.1 ms warm repaint at the 512-item ceiling and explicitly excludes cold-open improvement. That evidence does not establish severe present-day lag. Its larger layout/revision rewrite needs separate validation of renderer identity and invalidation before adoption. This batch therefore repairs the reproduced stale path, rather than importing an overlapping renderer rewrite. Full-history iteration remains a scaling opportunity, not a newly validated severe defect.

## Acceptance limits

No paid provider calls were needed or made for these deterministic tests. Local SDK/transport tests establish the client behavior; upstream protocol evidence is separately attributed. Local `bun run check` passed. The default full test attempt was interrupted during host scheduling delay; the complete discovered suite then passed at Node file concurrency 2 (1455 passed, one platform skip; Vitest 30/30). Two independent reviews found no actionable defects. Remote CI receipts are recorded in the PR. This investigation is not a formal end-to-end performance Benchmark.
