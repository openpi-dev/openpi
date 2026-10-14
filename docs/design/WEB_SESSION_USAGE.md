# Web session usage

- Status: `validated`
- Created: 2026-10-09
- Last verified: 2026-10-10; the original design acceptance and the scoped display-recovery acceptance below retain separate source and provider boundaries
- Source boundary: OpenPI `eb22b2ff3e70fbfcea11600f0dc68b9b7c5e8ca0` plus the SessionUsageBar iteration on `codex/settings-resources`; Pi 0.99.1; Astryx 0.5.2
- Related Issue: [#728](https://github.com/openpi-dev/openpi/issues/728)
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Presentation

The accepted presentation keeps input, output, context percentage and model capacity visible together in a compact header strip. Arrows and a gauge identify the three metrics, with 12px between them. Compact numbers stay readable without opening a panel; accessible names and hover titles explain the metrics.

One click opens precise context usage and capacity, a context progress bar, cumulative input/output/total, the workspace name and a folded Session ID. This panel excludes the Session file, activity statistics and model/provider/connection summary. The shared Astryx Popover owns positioning, surface styling, dismissal and focus restoration. Existing theme tokens keep the inner content consistent with the workbench. Narrow conversation columns put the strip on its own header row instead of hiding metrics.

## Native facts and their meaning

Pi remains the source of usage facts. `PiWebRuntime.getSessionUsage()` projects the tokens and `contextUsage` returned by `getSessionStats()` through the existing `WebSessionUsage` protocol. This change adds no accounting store, provider call or persisted preference.

Current context and cumulative usage are different readings. The former estimates the current branch's occupancy relative to the model window. The latter accumulates provider-reported usage; Pi's total includes cache reads and writes, so the displayed total must use `usage.total` rather than input plus output. Unknown context remains unknown and has no fabricated progress bar. Actual zero remains zero. Missing native usage produces no invented statistics.

Workspace name and Session ID come from the same selected Session projection as the header. The component is keyed by exact Session identity so an open panel cannot carry its disclosure state to another Session. Historical Sessions retain the adapter's existing availability boundary for live usage.

Workspace drafts and pending Session switches hide the strip so the previous Session's retained snapshot cannot present usage under a new target.

## Validation and limitations

Six component checks cover the always-visible metrics, one-click precise statistics, native totals containing cache, folded identity, unknown versus zero, absent usage and closing with focus restoration. The closing check waits for the popup's initial focus before activating its close button, then verifies both dismissal and restored focus. The workspace-draft regression also includes retained native usage.

Repository validation runs `bun run check` and `bun run test`. Final UI acceptance runs the same complete set of discovered `.spec.ts` files through the Vitest CLI with `--maxWorkers=1`. This checkout does not read `VITEST_MAX_WORKERS`, so setting that environment variable does not bound workers. Assertions and deadlines remain unchanged; the PR distinguishes the native and UI receipts and earlier failed runs.

The real local preview was inspected at 320px and 1280px. The strip and expanded Session ID stayed within the viewport, the panel followed its trigger, and Escape returned focus to the strip. Native usage was read from an existing connected Session; no new model request was necessary. The dark theme was visually inspected. Other themes reuse the same existing tokens but are not claimed as separate visual acceptance runs here.

## Ablation

Removed the custom trigger ref and explicit focus restoration. The shared Popover retained correct focus behavior in both component and native browser checks, so the extra code stayed deleted. Removed the obsolete fixed-position popup styling, nested cumulative-usage disclosure and unused translation keys. Kept the separate current-context and cumulative sections: merging their numbers would hide the distinction between occupancy and repeated request accounting.

## 2026-10-10 display-recovery follow-up

Status: `validated`; created and verified 2026-10-10 at implementation `29f567171715aa1bbea51a0123222492597eedca`, based on integrated PR source `92a722c2`. Tracking remains [#728](https://github.com/openpi-dev/openpi/issues/728), [#597](https://github.com/openpi-dev/openpi/issues/597) and [PR #711](https://github.com/openpi-dev/openpi/pull/711). This append preserves the preceding design acceptance; it adds no project constraint.

Two presentation defects reproduced independently. Usage and overview were siblings with the same React key, allowing a previous Session's usage strip to remain after switching. Their keys now distinguish the component while retaining the native Session ID/path. Pi persisted a user image's data and MIME type without its browser filename; comparing that filename left the admitted optimistic preview as another waiting turn. User-image presentation matching now excludes the filename. Existing Session/path, admission, native-order anchor, queue and one-to-one projection checks remain in force; this matching is not a delivery receipt or execution fact.

The inspected native image Session contained one user input, two upstream 502 failures and a subsequent successful answer. The upstream retries had recovered; neither the old usage strip nor the remaining waiting preview described native state. No provider, retry policy, message data, configuration or accounting store was changed.

`bun run check` passed. The complete canonical `VITEST_MAX_WORKERS=1 bun run test` passed 2,354 Node tests with nine platform skips and 1,276 UI tests across 87 files. The 135 scoped component checks include repeated Session switches, the same Session ID at a different path, a pending switch, and native images with and without filenames. Three installed-Chrome regressions passed for image admission, saved native image bytes and cancellation when switching Sessions. Ablation removed both identity corrections: the two new regressions failed again. Restoring the exact checked bytes passed all three targeted cases. No new state owner or abstraction was needed.

The actual 30142 frontend and backend were restarted at `29f56717`, after idle/native-login checks. `pi list` reported one OpenPI source, the checked worktree, and served JavaScript/CSS hashes matched its build. Original configuration and Session bytes were preserved. A real text request through the normal native runtime used `codex-local/gpt-6.1-sol` / `medium`, returned “连接成功”, and settled idle with one user input and one successful assistant message. Returning to the original image Session showed one usage strip, one user message and zero waiting turns. A fresh live image upload was declined by browser approval and was not retried through another channel; nameless-image reconciliation is established by component regressions, rather than a new provider image request.

Private evidence stays outside Git in `~/.codex/visualizations/2026/10/08/01a11ad3-f3c1-7da0-b791-cde3e3be237b/side-conversation-20261009/`, under `session-display-recovery-*`: failing and passing regression logs, full gates, Chrome receipt, restart/source/asset hashes, bounded native model evidence and actual browser screenshots. This is local acceptance, not release, new-commit CI or a guarantee of upstream availability.
