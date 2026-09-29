# Workspace sidebar refinement

- Status: draft; local design and implementation, not an accepted project constraint
- Created: 2026-09-29
- Verified: source inspection and local browser checks 2026-09-29
- Source boundary: OpenPI PR #598 at `295edfe6676733d7bc91267985956b12c34b0853`
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none
- Publication: submitted with PR #598; tracked in Issue #597

## Problem and direction

The workspace rail repeats hierarchy through a path subtitle, a workspace left
border, a selected Session left border, and a full-width Current/Archived switch.
The user's reference gives more space to names and makes folders the primary
navigation cue. Refine this rail before changing other workbench surfaces.

Use a quiet neutral surface, 14px names, 36px desktop rows and 8px corners.
Keep the OpenPI brand and a modest, left-aligned New Session action. A workspace
uses a folder icon; hover/focus reveals a chevron in the same slot. Only the
active workspace's folder uses accent color. A selected Session uses one soft
background, with no second vertical selection mark. Timestamps stay secondary.
Empty workspaces take one folder row instead of repeating an empty-list caption.

Paths remain available in the workspace tooltip. Duplicate names also show
their paths inline, so removing routine path subtitles does not erase identity.
Workspace actions appear on hover/focus and remain visible on touch devices.
Keyboard focus and open menus must keep their action controls visible.

## Source observations and alternatives

- [DSH Rows](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/client/ui-workspace/src/client/rows/Rows.module.css)
  uses single-line folder rows, an accent active folder, neutral selected Session
  fill and a folder-to-chevron hover affordance. Its WorkspaceBrowser also owns
  grouping and ordering; those mechanisms are outside this refinement.
- [Maka sidebar](https://github.com/apache/maka/blob/e98c2f4cf31e0812e4c253758c119975c80303a2/apps/desktop/src/renderer/styles/sidebar.css)
  uses a consistent reading size and restrained separators. Its navigation and
  collapse stay with its native component; OpenPI likewise keeps its existing
  sidebar owner.
- [Pi Web SessionList](https://github.com/jmfederico/pi-web/blob/dd771618a9aa6df789539d692870e9b798266b0a/src/client/src/components/SessionList.ts)
  progressively reveals archives. OpenPI already has bounded archive paging;
  retain that source of truth and its error/retry states.

These are inspected source facts, not comparative performance results. The
layout and density above are design choices informed by the supplied images.

An options menu was considered, then removed during design simplification:
there is only one existing filter. A compact Archive toggle is sufficient. In
archive mode the heading explicitly reads Archived and becomes a back-to-current
button. Search and Add Workspace remain adjacent. No new display preference,
sort mode, generalized menu state or persistent store is needed.

## Ownership and acceptance

### Local amendment: pinned conversations (2026-09-29)

Status: draft extension based on PR #598 at `4ecc5a3`; pending the user's
preview review before submission. The earlier no-new-preference conclusion
applies to the folder refinement above, not to this explicitly requested feature.
The user's Codex screenshots show a separate collapsible Pinned section and
Recently updated / Manual order choices; the DSH screenshot shows a row pin.

Project pins above Workspaces, without duplicate rows in the workspace list.
Both sections share one scroll area. Preserve each Session's native workspace,
identity, selection and execution facts. Show a row pin on hover/focus or touch;
keep the same action in its menu. Manual order supports drag placement and
keyboard-accessible Move up / Move down actions. Updated order is a projection;
switching back restores the stored manual order. Archive hides a pin, and
restoring the Session reveals it again. An empty Pinned section is omitted.

Reuse the existing serialized, atomic workspace metadata writer. Store up to
100 exact file-path / native-id pairs, with their array position as manual order.
The endpoint changes one pin relative to an existing anchor, preserving unrelated
concurrent edits; invalid identity/anchor and write failures leave the prior state.
Retain active pins within the existing bounded Session projection. Pi remains
the sole Session store; no model calls or model-facing tools are introduced.
Persist the presentation choice as `ui.webPinnedSort` through the existing setup
writer, status, docs and appearance API; default to manual.

Simplification: a shared row renderer replaces duplicated pinned/workspace row
actions. One retention set covers current, selected and user-pinned Sessions;
removing the separate repeated pin lookup still passes bounded-history checks.
No drag framework, parallel Session store or optimistic ordering cache is added.
Local validation covers atomic failure, concurrency, exact identity, reload,
archive restoration, projection bounds, sorting, drag, keyboard and viewport
behavior. The preview uses isolated example Sessions and does not call a model.

Pi still owns Sessions. The existing Web store owns selection, collapse and
mutation receipts; the existing archive API owns pagination and failure facts.
This change only projects those facts. No model judgment, tool authority,
provider, cancellation or cleanup lifecycle changes.

Verify folder collapse, search, archive/return, rename, new Session and settings;
preserve errors, drafts, running/queued indicators and exact Session identity.
Inspect light/dark themes, long and duplicate names, keyboard focus, mobile
44px targets and desktop collapse. Run the existing sidebar tests plus
`bun run check` and `bun run test`. Keep raw screenshots and logs outside Git.

## Local validation and simplification

The preview uses this worktree on port 57123 with a separate agent directory.
`scripts/provenance.mjs` reports the base revision above and one matching OpenPI
source from `pi list`. The user's global Pi package source, the main checkout
and the separate 57161 Host were not changed. The requested DSH 3080 service
was restarted using its existing lab launcher/profile; Chrome again displayed
its existing workspaces and conversation.

All 42 existing sidebar tests pass. Five real Chromium checks pass: light/dark
layout, keyboard archive/return and folder collapse, 44px narrow-screen targets,
touch menus/dialogs, focus containment at 320/390px, resizing back to desktop
and axe accessibility. The new visual scenario injects explicit workspace/name
fixtures into the real Host snapshot; these are not live model results. A
separate Safari check opened the real preview and exercised the archive toggle.
No model request was made for this UI validation.

The first full-suite attempt caught path disambiguation disappearing after a
search filtered out the other same-named workspace. Compute that fact before
filtering; the existing regression now passes. That run also hit a sidebar
rename timeout, which passed in the targeted retry. Existing mobile E2Es used
two stale English workspace-menu locators in a Chinese page; those now match
the displayed label. Axe caught the new selected-row timestamp contrast at
4.47:1; darkening the light sidebar's secondary text fixed the violation.

Simplification removed the proposed options menu, old segmented-switch markup
and CSS, both selection strokes, and repeated empty-workspace captions. The
sidebar and browser checks still pass without those elements. Duplicate-path
disambiguation was retained because removing it fails the identity/search
acceptance criterion. There is no new state owner, dependency or setting.

Evidence remains outside Git under
`/Users/admin/Documents/ChatGPT/openpi-evidence/workspace-sidebar-20260929`:
`provenance.txt`, `sidebar-tests.log`, `check.log`, `browser-final.log` and
`browser-final/` screenshots/traces. `bun run check` and final `bun run test`
passed (2,005 Node tests passed, eight skipped; all 852 Vitest tests passed).
The full retry is retained as `test-final.log`. These results apply to the base
revision plus this branch's local sidebar changes. This is functional UI
evidence, not a performance Benchmark or an accepted architectural Decision.

## Interaction refinement — 2026-09-29 draft amendment

Scope: PR #598 / Issue #597, checkout `4ecc5a3` plus local changes, pending user
preview review. This amendment does not revise the earlier validation receipt.
Reference inspection used Maka main `ae71ab319c920b856c2f18ee6c8d022e38376f71`
(`packages/ui/src/session-status-presentation.ts` and desktop status contracts)
and local DeepSeek Harness `ddefc45fbc` (`ui-settings-models/ModelListEditor.tsx`
and its README). The user's Codex screenshots supply visual hierarchy; source
inspection supplies behavior references, not requirements on OpenPI's runtime.

The chosen design reserves one quiet trailing slot for each Session's own
activity: rotating ring, input-needed amber, completed green, failure red,
cancelled neutral and uncertain neutral. Compaction keeps the ring but names
its activity. Disconnected running rows show uncertainty rather than continuing
an apparently live ring. Exact file/id ownership and Pi `agent_settled` timing
evidence determine the projection. A bounded 500-entry in-memory display receipt
survives background runtime release; its status remains unknown, not idle. It
is cleared on the next observed turn and does not survive a Host restart.
Loaded native branches can supply their persisted timing record. Reading the
selected completed Session for four visible seconds consumes that marker in
tab-scoped browser storage; it never modifies the canonical Session result.

The model form groups provider, endpoint and API before model identity, with
less frequent capability fields behind Advanced. A focused picker uses a
searchable checkbox list, disabled existing entries, retained hidden selections,
visible-result selection, retry, selected count and one explicit save. Search
does not mutate native configuration. GET catalog discovery and atomic batch
write are orthogonal mechanisms; Pi retains credentials, registry refresh,
Session identity, idle/Plan admission and the existing configuration revision
guard. Saved credentials are reused only for an exact saved connection;
temporary query credentials are not persisted. Queries reject redirects and
bound time, bytes and entries. Capability defaults are disclosed because model
catalogs do not reliably report context/output limits.

Simplification keeps one row renderer, one existing model writer for both single
and bulk saves, and native buttons in the picker rather than another button
adapter. Removing the background receipt fails the real Session-release test;
removing hidden selections breaks search-and-batch selection. These mechanisms
are retained. No new runtime owner, model tool, dependency, polling loop, toast
framework or user preference is introduced.

Local evidence is retained under
`/Users/admin/Documents/ChatGPT/openpi-evidence/interaction-refinement-20260929`.
The catalog and state screenshots use explicit test fixtures, not live model
results. Validation receipts are recorded separately after final checks.

Final local validation (2026-09-29): `bun run check` passed. The default full
test run hit one existing terminal-focus timing timeout; the full rerun with
`VITEST_MAX_WORKERS=2 bun run test` passed 2,010 Node tests (eight skipped) and
856 Vitest tests. Five Chromium scenarios passed, covering pins/reload/order,
light/dark/touch workspace layouts, per-Session states and model selection.
The receipt ablation failed the background-settlement check as expected, and
restoring it passed. Logs: `check-final.log`, `test-final.log`,
`browser-final.log`, `ablation-without-receipt.log`, `ablation-restored.log`.
The isolated 57123 Host was restarted and Safari verified the connected page
and new model connection form. It opens a fresh current Session; resuming an
older preview-only provider failed, while both pinned example transcripts
remain available. No real provider or model request was used for validation.

### User review amendment: reduce visible states

The user requested a closer visual match to Codex after inspecting the demo.
This supersedes the icon vocabulary above: retain only a running ring, a small
unread completion dot and one attention icon shared by input waits and failures.
Stopped and uncertain outcomes have no row decoration. Disconnection suppresses
stale running indicators and uses the existing page-level connection feedback.
Specific outcomes remain in the canonical receipt and conversation; removing
their dedicated icons, colors and translations does not erase runtime facts.
Compaction uses the same ring with its specific accessible/hover description.
This is a design choice based on the supplied visual reference, not a claim
about Codex's complete internal state model. The demo's main controls are
reduced to these three states; edge cases move under an optional disclosure.

Simplification validation: `bun run check` and the complete two-worker test run
passed again (2,010 Node, eight skipped; 856 Vitest). The real browser scenario
and interactive demo verify the shared attention marker, quiet stopped row,
four-second completion acknowledgement and page-level disconnection feedback.
Removing the three extra icon branches preserves the underlying terminal
receipt tests and satisfies the revised visual acceptance criteria. Evidence:
`simplified-check.log`, `simplified-test.log`, `simplified-browser.log` and
`simplified-demo-validation.log` in the same external evidence directory.

Final menu simplification: pin/unpin is available only through the row's pin
button. Remove the duplicate overflow-menu item and its unused icon; keep
rename, archive and manual Move up / Move down. The existing browser scenario
checks both pinned and unpinned menus and still exercises pin persistence
through reload. This is the user's final review adjustment before PR update.
