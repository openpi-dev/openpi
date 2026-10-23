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

## Follow-up: tool replay and background child ownership

The follow-up starts from PR #892 `3f306b15e296c7b139bf2aec7683c487121e0538`. The inspected running Web copy was `642291f6bd9be92b0ebb7d0152872798b0e7aa5e`; its isolated agent directory's `pi list` identified that checkout as its single OpenPI source. Neither source identity makes the development checkout the running application.

Two source failures were reproduced before the fix:

- Live/native message reconciliation required equal payload signatures even when the messages carried the same exact tool-call IDs. A bounded snapshot can shorten thinking, output or details, so a still-retained live message was appended as another execution. Replayed live copies amplified the duplicate display. Reconciliation now uses intact tool-result identities and complete assistant tool-call identity lists; ordinary prose and ambiguous/truncated identities retain the existing conservative matching. Distinct tool-call IDs remain separate, even when command text and provider timestamps are identical. This is a display correction, not tool replay or suppression of actual repeated commands.
- A Web runtime retained after a chat switch was disposed as soon as its parent model was idle. Independently running child Sessions were then shut down with it. Retention now reads the existing Session-local child execution leases, including queued work and unlimited-mode executions, and subscribes to lease changes. A microtask lets the settlement callback admit its native parent continuation before cleanup. Once no work remains, the runtime is released; explicit application shutdown still disposes owned runtimes.

Pi's extension loader and the Web host's native TypeScript import can instantiate separate copies of the admission module. A cross-loader regression demonstrated that a module-local WeakMap hid the extension's leases from the host. A versioned process-local WeakMap, keyed by the actual Pi SessionManager object, now preserves one admission owner across those copies. The read accessor does not create a pool, reconfigure limits, inspect child transcripts or infer work from a bounded UI list.

The inspected private incident logs showed that the parent ended its current response while three children continued; all three later recorded interruption/failure at the same instant. The source reproduction establishes the chat-switch failure path, not the exact initiating action in that historical incident. Private Session bytes, task text and screenshots remain outside the repository. Historical owner-lost records are not automatically resumed or relabeled successful.

A separate inspected incident had four child results waiting while the parent was busy. Its `agent_settled` boundary delivered one completion batch, followed by a native parent response lasting approximately 17 seconds. This establishes a deferred completion notification, rather than a network retry or tool re-execution. The existing one-shot inbox tests cover batching, explicit wait consumption and competing settlement edges. This follow-up preserves that delivery contract: finishing one parent response does not promise that every background child has finished, and it does not cancel them. Mandatory waiting or suppressing the resulting model response would change delegation semantics and is not part of this correction.

### Codex source comparison

The user-requested comparison inspected OpenAI's public `openai/codex` checkout at `86e17e98c7f901277aeeb4649cf1b01462b082f2`. Its [computer activity cells](https://github.com/openai/codex/blob/86e17e98c7f901277aeeb4649cf1b01462b082f2/codex-rs/tui/src/history_cell/computer_activity.rs#L41) admit a start only when its `call_id` is absent, then complete the matching call. Its [regression](https://github.com/openai/codex/blob/86e17e98c7f901277aeeb4649cf1b01462b082f2/codex-rs/tui/src/history_cell/computer_activity_tests.rs#L68) explicitly repeats the same start ID. Command [completion and output routing](https://github.com/openai/codex/blob/86e17e98c7f901277aeeb4649cf1b01462b082f2/codex-rs/tui/src/exec_cell/model.rs#L137) also match `call_id`; [snapshot replay](https://github.com/openai/codex/blob/86e17e98c7f901277aeeb4649cf1b01462b082f2/codex-rs/tui/src/chatwidget/replay.rs#L383) treats persisted command status separately from live rendering.

The reusable mechanism is stable execution identity and an explicit live/replay distinction, rather than tool-name or command-text equality. OpenPI applies that mechanism at its existing Pi message projection seam and keeps native persisted rows authoritative. This is a source comparison with the public Rust TUI and protocol, not a claim to have inspected the Codex desktop application's frontend.

The simplification pass removed an intermediate cleanup timer: the existing microtask settlement boundary passed the native Pi continuation regression. Removing the cross-loader shared registry failed the loader-identity regression; removing execution-identity reconciliation failed the bounded-snapshot regression. No synchronous-wait policy, new task manager, polling loop, tool, configuration option or model call was added.

Follow-up validation and synthetic browser evidence are recorded with PR #892. The browser fixture sends overlapping live/native messages and duplicate events, retains a real second execution of the same command, then reloads the page at [desktop](../../.github/issue-evidence/issue-890/tool-replay-desktop.png) and [narrow](../../.github/issue-evidence/issue-890/tool-replay-mobile.png) widths. It does not operate the user's active conversations or call a real model provider.

Final follow-up validation passed `bun run check` and `bun run test`: Node **2,381 passed / 8 skipped / 0 failed**; UI **99 files / 1,533 passed / 0 failed**. The complete run used process-local umask `022`, an isolated temporary `PI_CODING_AGENT_DIR` and `VITEST_MAX_WORKERS=2`. An earlier run inherited local display preferences and failed six default-rendering assertions; the isolated run does not rewrite those preferences. The nine conversation/streaming Chrome tests passed, including both new execution-identity cases. Raw validation logs are retained outside Git at `/Users/admin/Documents/ChatGPT/openpi-evidence/pr892-followup-20261022`.

## Follow-up: grouped child task display

The display follow-up starts from PR #892 `044e38b5277eded851f12798c53c97bf7257d5e7`. The requested reference uses a quiet grouped list with stable child avatars, a title and right-aligned time. Running rows now show a short assigned-task input underneath; completed rows retain only the title and completion time. Failed/interrupted and unconfirmed records keep their own groups and explicit labels. Exact child navigation, progressive disclosure and list scroll restoration remain available.

The second line is assigned input, not recent output or reasoning. The existing capability projection carries at most 96 code points, normalizes whitespace and preserves whole Unicode characters; CSS applies a further single-line ellipsis at the available width. Direct children use the manager-owned prompt, and Workflow children use an available user input in their owner transcript. Missing inputs use the localized processing label. Reading the list does not open every child Session file or fetch every detail. Full assigned input stays available through the existing detail view.

Elapsed time updates while the running-task list is open, using existing creation timestamps. The list uses native list/button elements with one shared title/time grid, removing the general List adapter for this specific layout. Existing activity and detail views retain their own avatars and status semantics. This display change does not alter completion consumption, automatic parent wake-up, or model-visible tools.

Validation covers bounded Direct/Workflow task inputs, elapsed time updates, completed-row density, exact detail navigation, list scroll, unknown/interrupted groups, desktop and narrow layouts, mouse/touch interaction, keyboard access and accessibility. Synthetic screenshots: [desktop](../../.github/issue-evidence/issue-891/subagent-task-list-desktop.png) and [narrow](../../.github/issue-evidence/issue-891/subagent-task-list-mobile.png). This is fixture validation of the PR source, not deployment to the running installation.

`bun run check` passed. The complete isolated `bun run test` passed **2,382 Node tests / 8 skipped / 0 failed**, and **99 UI files / 1,534 tests / 0 failed**. Six Chrome subagent inspection cases passed, including the two new task-list layouts; the final desktop/narrow screenshot confirmation also passed both cases. Source layout and app-pattern scans reported no findings. Logs are archived with the other follow-up evidence under `pr892-followup-20261022`.

## Follow-up: complete Sources view

The Sources follow-up starts from `7f94752175e8c821b22192ea58aff444f6f33894` and implements the user's additional reference. The conversation overview keeps three source previews and an independent Add control; its Sources heading can collapse the preview and retains a count. The existing Session source endpoint now supplies an optional retained total on each page, so the first page of 50 is not mislabeled as the complete set. Older responses without a total do not invent one for a partial page; bounded totals retain the existing partial-list indication.

View all opens Sources through the existing workbar tabs and exact Session identity. The complete list shows the recorded name, available file reference and attached-to-conversation status. Long names ellipsize, long references wrap at narrow widths, and image thumbnails use the existing visibility-bound reader. Image preview remains in the native dialog; file preview uses the existing artifact owner. The new workbar bookmark stores only the active tab and scroll position, not source contents or image bytes. Existing pagination, error retry and Session/branch authorization remain in force.

The simplification pass shares one Sources list between the existing fallback dialog and workbar. Removing the native dialog component on close broke focus return; its lifecycle was restored while its closed contents are omitted, avoiding duplicate hidden rows. Opening the nonmodal Sources view explicitly transfers keyboard focus into it, allowing Escape to close the view and return to the existing opener. No parent-wake or child-completion policy changed.

The native HTTP regression verifies a stable total of 52 on both a 50-source first page and a two-source second page. The workbar/UI set passed 79 cases. The isolated Chrome flow passes overview fold/unfold, exact totals, image-to-list return, all-source tab navigation, file preview, reload, draft preservation, long paths, dark narrow layout and keyboard focus return. Synthetic evidence: [collapsed overview](../../.github/issue-evidence/issue-891/sources-collapsed.png), [desktop Sources tab](../../.github/issue-evidence/issue-891/sources-panel-desktop.png), [narrow Sources tab](../../.github/issue-evidence/issue-891/sources-panel-mobile.png).

The source catalog remains the native conversation's saved images and explicit local file references. An embedded image without a saved original path has no fabricated path. The reference screenshot's web/tool counters are not asserted as available OpenPI source facts. Validation does not deploy the installed runtime or expose the user's private attachments.

Final source validation passed `bun run check`; the complete `bun run test` passed **2,382 Node tests / 8 skipped / 0 failed**. Its only UI failure was the existing terminal test's old five-item launcher count. After updating that assertion to six and checking the Sources entry, the complete `bun run test:ui` rerun passed **99 files / 1,534 tests / 0 failed**. The combined final Chrome run passed all **seven** child/source navigation cases. Validation logs, including the initial assertion failure and final UI rerun, are archived outside Git alongside the earlier evidence.

## Follow-up: CI integration, 2026-10-23

At `fd9624676f6213881b6f184c836920f29681a42c`, CI failed two browser cases because their launcher assertions still expected five tools after Sources became the sixth. The menu contract now checks all six named entries; the independent-terminal case checks its required terminal entry instead of duplicating the entire catalog count. Both Chrome cases pass. The same CI run timed out the first real post-edit lifecycle test on Windows at 15 seconds, while later cases passed. This is consistent with cold process contention, rather than evidence that formatter ordering failed. The fixture now uses the existing Windows isolated-process group; its socket-gated ordering checks and deadline remain intact. Removing this grouping in a temporary copy fails the existing partition regression. Native Windows acceptance remains a CI boundary, not a claim from the macOS run.

The complete isolated `bun run test` passed **2,382 Node tests / 8 skipped / 0 failed** and **99 UI files / 1,534 tests / 0 failed**; `bun run check` also passed. The PR already contains main `ea4dfb993793ccdb093229588b6ccd3467afd90a`; local merge computation and GitHub report no conflict at that boundary. No child wake policy or installed runtime changed.

## Limits and interpretation

This evidence demonstrates source behavior, native fixtures and an isolated browser. It does not claim a real computer reboot test, deployment to the user's installed runtime, automatic execution recovery, or a comparative performance improvement. The installed OpenPI source remains separate from this checkout. Lists and transcript previews retain explicit bounds; deleted files, missing private bindings and historical in-memory data remain unavailable rather than reconstructed by title or working-directory guesses.
