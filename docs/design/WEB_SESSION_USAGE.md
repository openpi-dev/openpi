# Web session usage

- Status: `validated`
- Created: 2026-10-09
- Last verified: 2026-10-09; component checks, repository gates and local browser UI; no release or new provider acceptance claimed
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

Six component checks cover the always-visible metrics, one-click precise statistics, native totals containing cache, folded identity, unknown versus zero, absent usage and closing with focus restoration. Repository validation uses `bun run check` and `VITEST_MAX_WORKERS=2 bun run test`; the PR contains the final receipt.

The real local preview was inspected at 320px and 1280px. The strip and expanded Session ID stayed within the viewport, the panel followed its trigger, and Escape returned focus to the strip. Native usage was read from an existing connected Session; no new model request was necessary. The dark theme was visually inspected. Other themes reuse the same existing tokens but are not claimed as separate visual acceptance runs here.

## Ablation

Removed the custom trigger ref and explicit focus restoration. The shared Popover retained correct focus behavior in both component and native browser checks, so the extra code stayed deleted. Removed the obsolete fixed-position popup styling, nested cumulative-usage disclosure and unused translation keys. Kept the separate current-context and cumulative sections: merging their numbers would hide the distinction between occupancy and repeated request accounting.
