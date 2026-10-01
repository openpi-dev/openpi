# Web Session working position

- Status: validated (named source inspection, component regressions, full checks/tests, and isolated browser observations; not production deployment)
- Created: 2026-09-26
- Verified: 2026-09-26
- Source boundary: OpenPI PR #598 at `c9350af` plus this change; Pi SDK 0.85.1; installed Codex Desktop 26.917.62051; frozen Maka `5b9db1ce8fdb83f0841cfd058084abe143847348` and Pi Web `a345b2ac363b644d5ef43b1da75b9bc53cd055c4`
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none; supplements [reading and lifecycle](WEB_READING_AND_LIFECYCLE_2026-09-22.md) and [background observation](WEB_BACKGROUND_SESSION_OBSERVATION_2026-09-26.md)

## Source Facts

Codex's installed static bundles separate composer drafts by conversation identity. `app-initial-37097744327a.js` uses the `composer-prompt-drafts-v2` record and local `clientThreadId`; current images and view state are scoped separately. This does not establish attachment persistence across an application restart. `local-conversation-thread-7879e0e60b1b.js` saves per-conversation distance from bottom, virtualized turn-list state, and latest-turn follow state. Returning to a conversation does not unconditionally jump to its tail. These are read-only bundled-source observations, not native UI verification or a public API guarantee.

Maka's composer draft hook saves and restores text by `draftKey`; its attachment hook manages separate buckets. Its reading controller saves turn bookmarks and cancels a bookmark for an explicit send. Pi Web keys draft text and staged attachments by machine and Session; its reader saves an element ID and pixel offset. Neither reference proves a native archived-directory pagination interaction, and neither image-import implementation establishes OpenPI's captured-owner invariant. These implementations are references, not OpenPI authority contracts.

At the OpenPI baseline, selecting the already controlled Session resets streamed projections. Removing an unrelated workspace clears the viewing selection even though the native operation only ungroups Sessions. Sidebar selection requires controller identity, hiding an observer's selection and conflating copied paths. The archived-directory query/cursor API exists, but the UI only filters the bounded snapshot.

Composer clears settled text and attachments before a Session selection succeeds. The old same-workspace new-Session fallback can carry a draft into an existing Session without a creation receipt. Omitting an empty image array during admission recovery falls back to the original images. A text-only late-admission comparison can clear newly edited attachments. These defects were reproduced with in-memory clients and React fixtures, not the resident 57161 runtime.

## Implemented Projection

- Text, caret, completed images, and revision belong to an exact confirmed `(id, path)` or an explicit new-workspace draft. Pending selection freezes the old owner. Leaving and returning restores it; loss or recovery of input control does not change its identity.
- Only an exact creation receipt can transfer the workspace draft to a created Session. Existing manual new-Session carry behavior is retained without discarding the original draft or overwriting a nonempty new-workspace draft.
- A send captures owner, revision, and payload. Success clears only that version. Recovery always supplies the visible image array, including `[]`. A resolution comes from native handled evidence, not from navigation. Retaining text does not prove that an uncertain send failed.
- Drafts stay in memory, not Session JSONL or localStorage. Limits are 32 nonempty drafts, 1 MiB text, and 32 MiB raw image bytes. New content over the bound is rejected with visible feedback; existing drafts are not silently evicted.
- The App owns four recent renderer reading states. Each pairs an entry/offset bookmark with its already bounded native reading window (at most 1,000 entries and 8 MiB). The pair is evicted together. Incoming state is captured before the departing layout cleanup can evict it.
- Leaving bottom following retains the bounded snapshot. Returning uses the same native branch-anchor validation as earlier history paging. A rejected branch removes the old pair. A verified gap keeps the old reading window until the reader explicitly jumps to latest. Send and Jump to latest clear old reading intent.
- Confirmed controlled re-selection and duplicate in-flight selection do not restart the same request. Observer activation still uses Pi's existing selection mechanism. Sidebar highlighting identifies the confirmed reader; input authority still uses the native exact-file control predicate.
- Removing a workspace does not implicitly leave a valid reader. Archived Sessions use the existing query/cursor endpoint, scoped abortable reads, loading/more/retry, and stale-cursor refresh. Restoration does not automatically select a Session.

These are operator-facing projections. They neither change model context nor infer lifecycle completion from presentation. There is no new Session service, admission ledger, queue mutation, or provider stack.

## Validation And Limits

- Full `bun run check` passed, including configuration/documentation contracts, Web build, formatting, lint, and TypeScript. The existing bundle-size warning remains. Full `bun run test` passed: Node 1,956 passed, five skipped, zero failed; Vitest 634/634 across 38 files. Final logs are `/private/tmp/openpi-pr598-session-check-complete-20260926.log` and `/private/tmp/openpi-pr598-session-tests-complete-20260926.log`, outside Git. Browser E2E was intentionally not rerun at the user's request.
- Focused regressions passed: 59 composer tests; 168 store/sidebar/archive-client tests; 95 history/App tests. They cover exact creation receipts, late sends and imports, recovery images, observer ownership, removed workspaces, archive request/query races, native restore success during navigation, changed leaves, rejected branches, and bounded reading-cache eviction. Runtime facts, transient UI state, and persisted native state remain separate test surfaces.
- Independent source review found two defects during implementation: composer ownership incorrectly depended on workspace registration, and native unarchive success could be reported as failure after navigation during a snapshot refresh. Both were fixed with regressions. A full incoming reading pair is captured before a departing Session's cleanup can evict it. Initial validation failures were stale fixture expectations, effect dependencies, and fixture typing; final gates above passed after correction.
- In the isolated preview at `http://127.0.0.1:57162/`, reselecting the current Session preserved a synthetic unsent draft. The native archive empty state and refresh action worked. Final `1280x900` and `390x844` screenshots showed no document-width overflow; the mobile drawer was 300 px wide after its opening transition. The viewport was reset and the synthetic input cleared. These are manual observations, not a stored screenshot archive or formal Benchmark.
- Manual A-to-B draft restoration, attachment imports, historical-window restoration with real messages, real model calls, Safari, and full IME behavior are not claimed verified in this batch. The isolated empty Session is not a substitute for those acceptance cases; the corresponding race and ownership claims above are grounded in component fixtures.

Runtime source was proven for the isolated 57162/57163 preview: the PR checkout and its isolated Pi directory report exactly one OpenPI source. The default Pi installation reports another worktree; these source findings do not diagnose installed behavior on 57161.

Native Codex automation was retried and the Computer Use API rejected `com.openai.codex` with an app-access safety error. It supplied no policy identifier or remedy. No alternate UI channel was used to bypass that rejection. Static-source inspection remains separate evidence.

## Ablation

- Removing the incoming reading-pair reinsertion made the oldest-reader return regression restore scrollTop 1,000 instead of 180. Restoring it passed. Logs: `/private/tmp/openpi-pr598-session-ablation-pair-20260926.log` and `/private/tmp/openpi-pr598-session-ablation-restored-20260926.log`.
- Removing the archive restore query/view guard leaked an old Alpha restore failure into Beta. Removing canonical selected-Session cwd priority selected another workspace or no workspace. Restoring the guards passed the 168 focused tests.
- Removing exact creation-path validation transferred a workspace draft into a mismatched existing Session path. Restoring validation passed the 59 composer tests.
- Removed a redundant recovery Map and cleanup effect; the existing single-command UI-revision association is sufficient. All 59 composer tests still pass. No persisted draft store or generalized navigation framework was added.

## Continuing Work

This batch does not close #597 or declare Web interaction complete. Native Codex UI comparison remains unavailable through the denied automation channel; installed static sources and user screenshots have a narrower evidence boundary. Further interaction iteration remains in PR #598 without changing the resident 57161 service or publishing private Sessions.
