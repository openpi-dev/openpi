# Web control after a native continuation

- Status: validated at the local source, Pi fixture, Host and rendered-UI boundaries below; not a new architectural Decision.
- Created / verified: 2026-10-21.
- Source: PR [#865](https://github.com/openpi-dev/openpi/pull/865), extending `db3d40ed93439f30c148b03c9a3f2c03827cc098`; `web/runtime/pi-runtime.ts`, `web/host/web-host.ts`, `web/host/browser-control.ts` and `web/ui/src/features/transcript/Transcript.tsx`.
- Tracking: [#867](https://github.com/openpi-dev/openpi/issues/867).
- Supersedes: none; supplements [browser ownership](../design/WEB_BROWSER_SETUP_2026-10-09.md) and [Web question ownership](../design/WEB_STRUCTURED_QUESTIONS.md).

## Observed failure

Read-only installed-runtime inspection confirmed one OpenPI package source and enabled browser control with Chrome allowed. The relevant installed runtime, Host and browser bridge files matched the checkout baseline. Browser failures occurred after a child-result custom message started a fresh native run, following the original Web run's terminal timing record. The broker's combined “enabled, active turn” error obscured the missing controller origin; the connection itself had not been rejected.

The Host looked up the new native command ID in HTTP prompt admissions. A native continuation correctly has its own command ID and epoch, but no new HTTP admission. Reusing the last visible controller would incorrectly authorize unrelated background starts.

A separate UI defect rendered any saved file-change receipt immediately. Receipts can exist while the owning user turn still runs, including a queued message boundary. Hiding activity during compaction also does not mean the turn has finished.

## Scoped correction

Keep Pi's fresh native execution identity. Carry only the exact invocation already present in the runtime's AsyncLocalStorage context, after checking the Session ID and path. The Host resolves that invocation's existing admission and controller; it never searches for a recent request or invents an admission. A cancelled continuation revokes that origin for sibling completions too. Unrelated starts, different Sessions, copied Session files, absent admissions, disabled browser grants and idle runs remain denied. Pending browser observations still belong to the current command/epoch/document and cannot cross the boundary. The bounded admission cache retains the active continuation's origin.

Browser errors now distinguish a disabled setting from a run without an originating Web tab. The latter suggests a new message in the chat instead of extension reinstallation. The shared question broker uses the same exact controller ownership.

The transcript withholds only the active turn's change summary until execution stops. Compaction retains this execution fact even while activity animation is hidden. Older finished turns retain their summaries. No new UI state, lifecycle timer, configuration, Session record or persistent authority store is introduced.

## Validation and limits

- The original UI and native-origin regressions failed before the fix. Two backend cases cover native continuation provenance, unrelated starts, cancellation and Host authorization; the existing UI receipt case now also covers active execution, compaction, settlement and a subsequent user turn. No E2E suite was added.
- `bun run check` passed. `VITEST_MAX_WORKERS=1 bun run test` passed 2,362 Node tests with eight existing skips and all 1,511 UI tests across 97 files. The focused native/Host suite passed 114 checks.
- Ablation removed origin revocation at cancellation: the late sibling completion incorrectly recovered its origin and the regression failed. Restoring the existing-trace revocation passed. The initial simpler display-only running condition was insufficient for compaction; the final card condition uses the existing execution fact without adding state.
- A read-only synthetic preview using frozen before/after Web bundles reproduced the early card, verified its absence during execution and compaction, and verified the final expandable file list. Screens were reviewed at 1440, 768 and 390 pixels. The app inspector allows the existing 4% composer shadow; sparse-chat whitespace is reserved conversation space, not a new fixed-height card.
- Local evidence: `~/.codex/evidence/openpi-browser-continuation-20261021/`, including check/test logs, the cancellation ablation, frozen bundles, screenshots and `comparison.html`. Private Session content and credentials are excluded from this record and the repository.
- The running user service was not updated or restarted. Native lifecycle tests use Pi with a deterministic provider; no claim is made about a new live website login, native browser action or model-provider smoke.
