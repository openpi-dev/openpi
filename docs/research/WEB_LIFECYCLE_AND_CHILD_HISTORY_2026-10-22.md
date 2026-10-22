# Web lifecycle and saved child history

- Status: validated for the named source and local fixture boundaries below
- Created: 2026-10-22
- Verified: 2026-10-22
- OpenPI source: `ea4dfb993793ccdb093229588b6ccd3467afd90a`, integrated with PR #892 commit `47080a050a9f2a07348ac80840dd99eaac39403e` and the scoped child-history/application-exit changes for [Issue #891](https://github.com/openpi-dev/openpi/issues/891)
- Comparison sources: Kimi Code `874d9abb32f7d8e23fd95da5fbfbd446266653ec`; DeepSeek Harness `687f282e8625c6b8d11ff58211a90524be2e4317`
- Related Issues: [#890](https://github.com/openpi-dev/openpi/issues/890), [#891](https://github.com/openpi-dev/openpi/issues/891)
- PR: [#892](https://github.com/openpi-dev/openpi/pull/892)
- Supersedes: none

## Verified source facts

OpenPI's Web Host owns execution separately from its browser event connections. Closing a page removes its subscription. The CLI handles application shutdown by disposing the Host and aborting owned Pi Sessions. Session files preserve history; restarting the process does not resume the old execution loop.

At the baseline, the child list used the live manager and receipts from the loaded transcript window. The detail endpoint addressed the current manager. Consequently, native child files and parent completion records could survive while the Web workbench could not discover or inspect them. BTW children used in-memory Sessions, so their full conversations were not persisted.

Kimi's parent `state.json.agents` retains its agent catalog. Individual agent `wire.jsonl` logs support cold transcript reconstruction. Its server separates WebSocket subscription teardown from agent execution and recognizes owner-lost tasks rather than treating persisted running state as live execution. See [transcriptService.ts](https://github.com/MoonshotAI/kimi-code/blob/874d9abb32f7d8e23fd95da5fbfbd446266653ec/packages/kap-server/src/services/transcript/transcriptService.ts#L524) and [WebSocket teardown](https://github.com/MoonshotAI/kimi-code/blob/874d9abb32f7d8e23fd95da5fbfbd446266653ec/packages/kap-server/src/transport/ws/v1/wsConnectionV1.ts#L486).

DeepSeek appends `subagent/catalog` events to the parent's durable log and projects child membership from those events. Children retain independent Session logs. The desktop shell hides its primary window on ordinary close and preserves its Host; actual Quit closes the backend. See [catalog.ts](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/catalog.ts#L131) and [desktop close](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/main.ts#L1078).

Neither comparison's browser Web UI was found to expose an explicit application quit action at these revisions. Kimi exposes a [shutdown API](https://github.com/MoonshotAI/kimi-code/blob/874d9abb32f7d8e23fd95da5fbfbd446266653ec/packages/kap-server/src/routes/shutdown.ts#L22), but that alone is not a browser control. Kimi's frontend-source conclusion is limited to the committed prebuilt bundle; its external code-app repository was not inspected.

## Candidate behavior

The parent retains private child Session locators and run-start boundaries in its native branch. These entries do not enter model context. Web snapshots derive the selected parent's child directory from the complete branch, independently of transcript pagination. Live manager facts take priority over saved receipts. Owner loss projects unknown state; recorded cancellation remains interrupted, and terminal completion remains completed.

Read-only details require the exact parent ID and path, a parent-bound child identity, and valid child run ancestry. Finished evidence validates sealing, binding, generation and anchors. Reads reject mismatched files, sibling branches, broken/cyclic ancestry and unsuitable sources. Earlier runs remain conversation history without becoming a later interrupted run's final result. Native child files are loaded only when opening a detail. Workflow discovery follows parent-bound run references and validates the persisted manifest's Session identity; a missing transcript artifact preserves available terminal metadata.

BTW now uses Pi's native persistent child Sessions. Empty parent conversations retain Pi's existing lazy-save behavior. There is no requirement to send a main-conversation message before opening an aside, and no fabricated user message or forced parent-file write. If an empty parent has never persisted, its private association may remain ephemeral. Previously ephemeral BTW transcripts cannot be reconstructed retroactively.

The sidebar exposes an explicit Quit OpenPI action with confirmation. An authenticated POST is acknowledged before the CLI's once-only shutdown callback runs. The screen distinguishes an accepted shutdown request from terminal-confirmed cleanup. Closing a tab remains independent of this action. Neither history inspection nor quitting invokes a model.

## Local validation and evidence

A regression creates native parent/child files, places the delegation outside a subsequent 300-message transcript window, and uses a fresh adapter without a child manager. Both initial completed and owner-lost cases fail on the baseline because the child directory is absent. The candidate reads the saved conversations without changing the active Session or rewriting the parent file.

Additional fixture checks cover run boundaries, sibling/cyclic ancestry, root BTW bindings, failed BTW state, live-first bounded merges, Workflow completion and launch shapes, actual background completion display, and missing transcript artifacts.

A real Pi Session with the native faux provider continues through two tool boundaries after its Web event connection is closed. Reopening the snapshot shows the completed answer. This exercises local Pi execution without a remote model request.

An isolated Chrome fixture opens a cold saved parent, reads a child whose receipts are outside the current transcript page, cancels application exit without stopping the Host, then confirms exit and observes exactly one cleanup callback. It produced zero model requests and zero page errors. Screenshots contain synthetic data only:

- [Recovered child conversation](../../.github/issue-evidence/issue-891/recovered-child-history.png)
- [Accepted application shutdown](../../.github/issue-evidence/issue-891/explicit-application-exit.png)

### Original shared-worktree validation

Before integration with the final retry/reading commit, repository `bun run check` passed. The final focused Web/native set passed 76 cases, the subagent set passed 71 cases, and the child/shutdown UI set passed 39 cases. The full `bun run test` completed under process-local umask `0022`: Node 2,375 passed / 8 skipped / 0 failed; UI 1,512 passed / 17 failed. The two app/settings files pass separately (159 tests); the 13 transcript-navigation failures reproduce in a baseline copy containing only the other session's reading changes and none of this lifecycle/history implementation. The full gate is therefore not reported green. The later one-line early-catalog ID recognition update is covered by the final subagent set and final repository check.

The [validation receipt](../../.github/issue-evidence/issue-891/validation.json) preserves that original result separately from the integrated validation below. The original shared worktree's retry and transcript-reading changes remain preserved; integration uses the final reviewed `47080a05` version instead of those intermediate files.

### Integrated PR #892 validation at `dc21c90d`

The lifecycle/history changes were applied on top of the final retry/reading commit `47080a050a9f2a07348ac80840dd99eaac39403e` in `openpi-web-retry-reading`. The final retry, store, transcript and reading-anchor source files were retained. Web assets were rebuilt from the combined source. The earlier shared-worktree failures above do not describe this integrated result.

- `bun run check`: passed.
- `(umask 022 && VITEST_MAX_WORKERS=2 bun run test)`: Node **2,376 passed / 8 skipped / 0 failed**; UI **99 files / 1,532 passed / 0 failed**. The process-local umask and UI concurrency match the original PR validation conditions.
- Chrome Playwright conversation/streaming reading: **7 passed**, including desktop and 390px narrow-screen anchoring.
- Isolated cold-child-history and explicit-exit smoke: passed with one shutdown callback, zero remote model requests and zero page errors.
- Integration review found a missing omitted-run count above 32 saved Workflows. The count is now preserved and displayed separately from child omissions, with native and UI regressions. The final full-suite results above include those regressions.

The updated receipt and synthetic screenshots are included with [PR #892](https://github.com/openpi-dev/openpi/pull/892), which addresses Issues #890 and #891. No installed runtime was replaced.

## CI integration follow-up

The first integrated CI run at [`dc21c90d`](https://github.com/openpi-dev/openpi/actions/runs/39717799324) passed source checks, committed-asset verification, native tests and all UI jobs. It exposed a packed-startup failure and seven browser failures that the initial local reading smoke did not cover.

The packed CLI could not resolve `@earendil-works/pi-tui` after child-history recovery began importing Workflow presentation helpers. Standalone aliases now resolve that dependency from the selected Pi Host, preserving the same host identity used for the coding-agent entry and provider catalog. A regression distinguishes that Host's TUI from an unrelated install's TUI. A fresh peerless package successfully started, served all four local assets, accepted `POST /api/shutdown` with HTTP 202 and exited zero, with no model requests.

The active Session now publishes its combined saved/live directory in the runtime projection. The UI uses that runtime projection for the controlled Session and the selected parent's saved projection for a cold Session. SSE reconnection does not hide a scoped directory or prevent read-only HTTP detail requests. The sidebar keyboard test now includes the explicit Quit button after Settings. All seven previously failing browser cases pass on the follow-up source, including narrow-screen keyboard wrapping and Direct/Workflow inspection.

Final follow-up validation passed `bun run check` and the same complete suite: Node **2,377 passed / 8 skipped / 0 failed**; UI **99 files / 1,532 passed / 0 failed**. These results include the Host-TUI identity regression and current/cold parent capability assertions. The original seven reading cases and the seven CI-discovered inspection/focus cases are recorded separately; the latter all passed in the final targeted rerun.

## Limits and interpretation

This evidence demonstrates source behavior, native fixtures and an isolated browser. It does not claim a real computer reboot test, deployment to the user's installed runtime, automatic execution recovery, or a comparative performance improvement. The installed OpenPI source remains separate from this checkout. Lists and transcript previews retain explicit bounds; deleted files, missing private bindings and historical in-memory data remain unavailable rather than reconstructed by title or working-directory guesses.
