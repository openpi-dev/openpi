# Performance audit continuation

- Status: validated at the local source boundary; native TUI visual acceptance confirmed by the user on 2026-10-23
- Created / verified: 2026-10-23
- Source boundary: baseline `ea4dfb993793ccdb093229588b6ccd3467afd90a`, local changes on `codex/performance-audit`
- Related Issue: [#841](https://github.com/openpi-dev/openpi/issues/841), including checkpoint follow-up [#839](https://github.com/openpi-dev/openpi/issues/839)
- PR: [#895](https://github.com/openpi-dev/openpi/pull/895); opened after the local audit below
- Supersedes: none; this continues rather than rewrites the earlier audit

## Confirmed mechanisms and repairs

1. Direct subagent waits resumed on every progress notification and emitted the same pending IDs repeatedly. Wait subscriptions now retain their registration until one of their pending children stops being busy. Live view subscribers still receive every notification. Existing cancellation and restart tests remain authoritative; the completion test additionally checks one pending-list emission while multiple live updates arrive.
2. Workflow session recovery hydrated foreign runs' result and transcript artifacts before checking session identity. The persisted-read helper now checks the requested session before hydration. Matching-session recovery remains unchanged. This does not eliminate manifest scanning or commit-marker recovery and validation.
3. Workflow preview, usage and transcript updates rebuilt an unchanged dependency graph before throttling. Those progress updates now skip graph refresh; lifecycle emissions and persistence still reconstruct the graph. Execute-level and graph tests cover final state, replay, failures and cancellation.
4. Session catalog shared scans left abort listeners attached to their callers after completion. Success and failure completion now release those listeners and retained signal references.
5. Session catalog parsing repeatedly searched an ever-growing partial JSONL record. It now scans each decoded chunk and joins fragments only when a record ends. First-user-message extraction also avoids materializing irrelevant later message text. Regression coverage includes UTF-8 across read boundaries and a final record without a newline.
6. Footer rendering resolved and fitted the same layout twice. It now renders the already fitted segments, retaining the status-inline width check. Existing footer tests cover styles, narrow widths, Unicode and alignment.
7. Live workflow checkpoints rewrote unchanged side artifacts. The session-owned persistence writer now retains only content digests and file identities for its fixed artifact set. Matching content is reused only while inode, device, size, nanosecond modification/change times and regular-file type still match. Missing or externally changed files are repaired; failed replacements discard their cached identity. Terminal commits bypass reuse and retain complete artifact publication. The journal accumulator also reuses its bounded JSON string until the next append; transcript serialization itself still runs at each checkpoint.
8. The native child tool-rendering ledger retained completed results after their transcript entries were evicted. Direct children now release only IDs observed leaving their retained transcript; workflow snapshots retain the IDs in their bounded transcript. Pending executions remain available until they complete. A direct integration test exposed an important ordering constraint: producers may queue events ahead of the manager, so pruning every unknown ID would delete future results. Explicit observed-eviction IDs preserve those future results. Neither path changes Pi's canonical messages or persisted evidence. Existing external snapshot arrays may retain compact history, but evicted native cards fall back to that compact representation.
9. Accumulated Markdown previews could build tens of thousands of DOM nodes after continuing through file pages. Above 100,000 loaded characters, file previews now display all loaded source text with an explanatory notice. This matches the existing source-highlighter work budget; smaller Markdown still renders normally, and an explicitly selected source view needs no extra notice. Download, editing and pagination limits are unchanged. The trade-off is loss of rich Markdown formatting for large previews, not loss of content.

## Evidence

`pi list` reported exactly one OpenPI source, `/Users/tsk/code/openpi`; `node scripts/provenance.mjs` matched the baseline checkout. A new process loads the edited source; this does not prove that pre-existing interactive sessions were reloaded.

An isolated real-module catalog probe used synthetic files and no model calls:

| Observation | Baseline | Repaired |
| --- | ---: | ---: |
| Abort listeners retained after 25 scans | 25 | 0 |
| Characters searched for newlines, 1 MiB record | 9,959,844 | 1,048,756 |
| Characters searched for newlines, 4 MiB record | 140,502,132 | 4,194,484 |
| Characters searched for newlines, 16 MiB record | 2,172,620,724 | 16,777,396 |

These operation counts explain the removed quadratic work; they are not a whole-application throughput claim. Local elapsed samples were not sufficiently controlled to publish a general speedup. The probe and raw output are currently local under `/tmp/openpi-performance-2026-10-23/web/`; this temporary location is not a durable public Benchmark archive.

A second Node 22.23.3 diagnostic created 64 synthetic agents, each with 8,000 transcript characters and 16,000 journal-output characters. After the initial checkpoint, ten preview-only updates wrote 30 files / 15,630,840 bytes on baseline and 10 files / 195,770 bytes with the checkpoint repair. Each new manifest was still written; only the unchanged transcript and journal files were reused. The probe invoked both real persistence implementations with the same journal implementation and data, measuring file-write bytes rather than elapsed latency. Source copies, probe and output are under `/tmp/openpi-performance-2026-10-23/checkpoint/`. Its initial import-path setup error was fixed before either measured run. Artifact/journal focused tests passed 36 cases, including external corruption, deletion, append invalidation and final publication.

Retention integration checks send 600 completed tools through the real direct manager and verify only the 512 retained transcript records remain in its renderer. A 100-cycle workflow test verifies that renderer IDs exactly match the retained transcript after terminal reconciliation. Native-renderer tests separately preserve pending tools and retained expanded results. The combined focused run passed 53 tests after fixing the queued-event ordering issue. These are reachability/state checks, not RSS measurements.

The existing real-SDK child-startup diagnostic also passed all nine combinations of 1/4/8 children and 0/100/1000 foreign workflow runs: zero foreign artifact reads, bytes and parses in every case. It loads the current source into isolated child sessions and disposes them, without model calls or changing user settings. Timings overlapped other tests and are not comparative latency evidence. Raw output: `/tmp/openpi-performance-2026-10-23/child-startup.log`.

In an Ego browser component diagnostic, 524,301 Markdown characters produced 28,362 elements and took about 1,519 ms to render before the change; afterwards the same input produced 14 elements and took 22.5 ms. A 2,097,165-character source preview took 107.5 ms. These are single-machine development-build samples, not production latency guarantees. Small-file rendering remained rich. A separate production Web host on port 57140 loaded the current bundle: continuing a real synthetic file switched to source, then reached all 255,014 characters including `END-SENTINEL`, with no remaining pagination button. The resulting UI was inspected in a screenshot. The initial selector wait used the wrong translated label; observation corrected it before continuing.

Raw logs, probes, screenshots, synthetic workflow artifacts and the source patch are copied to the local evidence directory `/Users/tsk/Documents/Codex/evidence/openpi-performance-2026-10-23-01a16498`. This is a local inspection archive, not a public Benchmark. Provider-run JSONL contains session context and must not be published wholesale.

Validation completed in this batch:

- `bun run check`: passed, including the production Web build, lint and types.
- `bun run test`: the latest complete run including Markdown preview changes passed 2,368 Node tests, with 8 skips, and 1,512 UI tests in 97 files. `bun run check` also passed on the same implementation; later research-record edits do not alter behavior.
- Separate workflow execute/graph tests after the progress-emission change: 37 passed.
- Direct manager tests: 23 passed after retention coverage; workflow dashboard tests: 43 passed.
- `node scripts/web-performance.mjs`: all 11 browser cases passed again after the Markdown change and entered the measurement scenarios. Final production bundle SHA-256: `fe8787f8da0174eedaf2c6729bbdb99df51e5e67db35afeaf052e3478a179686`.

Browser fixtures validate synthetic transcript and reconnect behavior, not provider latency or real model quality. Cross-platform and remote CI results were unverified at the local audit boundary; the linked PR carries subsequent check results.

## Real provider runtime checks

Fresh Pi processes loaded the single installed local checkout, with provenance rechecked before execution. The existing configured `magpie/codex/gpt-6.1-sol` model at medium reasoning was used with normal tools in an isolated temporary workspace; no user settings were changed.

- Direct child session `01a164ae-45f8-76a7-abf4-700cf50f5559` has canonical `read` tool results for `OPENPI_PERFORMANCE_SMOKE_OK` and the expected missing-file ENOENT (`isError: true`). A second child produced terminal owner evidence `observed=cancelled`; whether its proposed `sleep` command started is unverified.
- Workflow `wf_5597bc1bbda4` completed with persisted success and error tool-result records matching the same fixture. Its delivery state is `consumed-inline`.
- Print mode correctly rejected a background workflow because it cannot deliver later results; the model initially also supplied conflicting deprecated/current options. Neither rejected request is counted as a launched cancellation test.
- A separate normal TUI process launched `wf_49499d7751a9` and stopped it. Its persisted status is `aborted`, child error is `Agent was aborted`, and delivery state is `delivered` with one attempt. This proves owner terminal/delivery state, not that `sleep` started.
- Computer Use refused Terminal access for safety reasons. No alternative UI automation bypass was attempted. Agent-observed native TUI visual acceptance was unavailable; the user subsequently confirmed the requested visual checks with “没问题” on 2026-10-23. This is user-reported manual acceptance, not an agent-captured screenshot. The owned Pi process was terminated after the workflow settled; an idle Terminal window may remain. The two temporary Web servers and the browser task space were closed after validation.

## Remaining opportunities and retained protections

- The repeated-write portion of #839 is repaired locally. Full transcript serialization remains; further caching needs a sound mutation/identity boundary rather than assuming public transcript arrays are immutable. The cached journal string adds at most its existing 2 MiB budget per live accumulator and is invalidated on append.
- Child package discovery resolves resources more than once. The first pass identifies blocked packages, and the second loads filtered settings; they are not interchangeable results. The installed Pi loader has no public pre-resolved-package injection option. Preserve this trust boundary while measuring whether a safe upstream primitive or narrower optimization is worthwhile.
- Completed tool-result retention and large Markdown preview costs are repaired locally. Pending tools and canonical Pi history remain outside the completed-result retention claim. Several historical concerns already changed on main: session catalog/history bounds, streaming projection and sustained terminal layout. Final review must distinguish those retained protections from this branch's changes.
- Current source inspection found bounded child output, cancellation cleanup, incremental model statistics, asynchronous/coalesced Git refresh and cron polling only when jobs exist. These are preserved protections, not proof that every path is optimal.
- Final implementation and coverage review is complete at the boundary below. The user completed native TUI visual acceptance after Terminal access was refused to the agent. Publication was subsequently authorized through PR #895, whose Issue references provide the backlink. No Issue is closed by this record; #839 retains the full-serialization follow-up.

## Final local completion audit

The current tracked implementation matches the implementation in the validated local archive. Git fetch increased abbreviated object-ID lengths in diff headers; after excluding those headers and documentation, patch content is identical. The final bundle digest also matches the browser-run receipt. The new catalog regression was collected by the full test run. No implementation edits followed that run.

| Required area | Inspected evidence and disposition |
| --- | --- |
| Direct children: progress, retention, completion, cancellation and restart | Manager and native renderer changes reviewed together with queued-event regression, existing lifecycle tests and canonical real-provider tool/cancellation records. Completed payloads are released only after observed transcript eviction; live/pending state stays available. |
| Workflow: recovery, projection, persistence, completion and cancellation | Session filter precedes hydration; graph refresh retains lifecycle/checkpoint paths; side-file reuse checks content and file identity, and terminal publication bypasses reuse. Artifact, graph, execute and runner tests plus completed/aborted runtime records cover these boundaries. |
| Web: catalog, long output and file previews | Listener cleanup and chunk-boundary regressions, existing browser performance scenarios, and the large-file production UI observation cover the repaired paths. Content is retained when large Markdown switches to source. |
| Other extension hot paths | Footer reuses fitted segments; existing layout tests cover its output. Model metrics retain prefix caching; Git refresh retains semaphore/coalescing; cron retains empty-job timer shutdown. Child resource loading retains trust filtering. These preserved mechanisms are not new speedup claims. |
| Required repository checks | Full check and test receipts inspected; current implementation matches the tested archive. Documentation contract and whitespace checks rerun after the final record edit. |
| Runtime source | Rechecked single local source with `pi list` and provenance at baseline HEAD; changes remain in the working tree. Existing running sessions require reload/restart. |
| Native visual acceptance | **User-confirmed on 2026-10-23.** In response to the request to restart Pi, inspect the narrow footer, and expand recent completed child/workflow tool results, the user answered “没问题”. This satisfies the manual inspection gate as user-reported evidence; the agent did not observe Terminal or capture a screenshot. |
| Delivery at local audit boundary | Local branch and reviewable diff; later published in PR #895. The PR carries current commit, CI and merge status. Raw evidence remains in the local archive. |

The measured improvements address concrete repeated work and retention defects. Full transcript serialization, upstream resource-loader reuse, cross-platform behavior and production-wide latency remain explicitly outside any speedup claim; no evidence justifies speculative changes to those boundaries in this audit.

Local audit closure: all nine confirmed defects are repaired, the implementation still matches the tested archive, and the user-reported TUI check closes the last local acceptance gap. At that audit boundary, remote publication, CI, merge and release had not been performed. See PR #895 for subsequent delivery status.

PR validation follow-up: Windows CI at `1061f966` returned timeout code `-1` instead of exit code `7` in the existing Git process output test. That test gave Node startup and execution a one-second budget. Its non-deadline helper now allows ten seconds; the separate explicit 20 ms timeout test and production deadlines are unchanged. Focused local output, missing-command and timeout checks passed; the final PR checks carry Windows verification.
