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
