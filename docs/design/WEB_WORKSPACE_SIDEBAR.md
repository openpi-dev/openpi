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

## Model page amendment — 2026-09-30

Status: locally validated design, pending user preview review; not an accepted
project-wide constraint. Source boundary: PR #598 / Issue #597, `05f1069` plus
this model-page change. This amendment supersedes only the model-form design
in the 2026-09-29 interaction amendment. The user requested DSH's model-page
content and interactions while explicitly retaining OpenPI's surrounding
settings layout and navigation.

The primary reference is the installed `@deepseek-ai/dsh-client-ui-settings-models`
`0.1.7-rc.2` client, SHA-256
`67ebf868e5278f9e260d164b048a8abb320a4de16d63c05b6dad7302071abaa2`.
Its `ModelsSection`, `ProviderEditor`, `ModelListEditor` and `ModelRow`
implementations were compared with local DeepSeek Harness `ddefc45fbc` and
the user's screenshots. The installed version supplies the two-mode segmented
add control absent from that older checkout. The adapted styles retain its
54px provider rows, 16px row corners, 32px desktop fields, 12px filled editor
corners, inline disclosures and compact checkbox picker. MIT attribution is
included in `THIRD_PARTY_NOTICES.md` and the settings directory's license file.

Verified behavior: provider rows expand in place; existing cards and the two
add modes retain independent drafts; cancel does not save; discovery adds
checked models to the draft, with search preserving offscreen selections.
Existing entries are disabled, and selected plus existing entries cannot exceed
100. Model rows support manual additions, removal and an expandable editor for
context/output limits, text/image input capabilities and Pi's reasoning flag.
At least one input type remains selected. Modal search receives keyboard focus,
Enter does not submit the underlying form, and closing the picker returns focus
to its trigger. The page keeps errors and unsaved work on failed saves and
blocks conflicting revision writes. A provider-profile success followed by a
credential failure is shown as partial success; retry writes only the key.

Pi remains the owner of providers, native `models.json`, credentials and Session
admission. Provider-level updates use the existing revision-checked atomic file
writer, preserving unrelated provider fields and surviving models' unexposed
fields. Incomplete or unsupported projections cannot replace a model list.
Provider deletion needs confirmation and preserves separately managed Pi
credentials; deleting the active custom model requires switching models first.
Model discovery can reuse native credentials only for the exact registered
endpoint and API, including built-in providers. It never performs a model call.

Ablation removed the old per-model sidebar, its editor, the separate credential
panel, duplicate model metadata and their unused styles. The provider-card
flows and full checks still pass. Per-card drafts and the revision guard remain
because the cross-card editing and stale-write tests require them. No additional
provider registry, persistence layer, UI preference or dependency was added.

Validation on 2026-09-30: `bun run check` passed; `VITEST_MAX_WORKERS=4 bun run test`
passed 2,024 Node tests (eight skipped) and 837 Vitest tests. The Chromium scenario
passed at 1440px and 390px, with light/dark screenshots, add-mode draft retention,
model discovery, capability editing, cancellation, modal focus and overflow
checks. Its providers and credentials are fixtures; no live credentials were
changed. Evidence: `/Users/admin/Documents/ChatGPT/openpi-evidence/model-settings-20260930`
(`check.log`, `test.log`, `browser.log`, `browser/`). The browser tool refused
direct access to the user's 57123 preview, so these screenshots verify the
isolated repository test server, not that authenticated browser tab.

### Model-options correction — 2026-09-30

Status: locally validated follow-up to the model-page amendment above, pending
user preview review; same PR #598 / Issue #597 source boundary. A second
comparison with DSH's `ModelRow`, `parseCapacity`, `formatCapacity`, and
`ModelListEditor` found that the first pass retained OpenPI's numeric controls
and eager default values. This correction supersedes that parameter editor.

Capacities now use DSH's text input and decimal K/M vocabulary: `128K` is
128,000 tokens and `2.3M` is 2,300,000. Display formatting abbreviates exact
thousands/millions and preserves other counts without rounding. Typed text
survives blur and editing another row. Empty capacities remove their native
overrides; Pi supplies its own defaults, rather than importing DSH adapter
defaults. Invalid values block submission and name the affected row. Multiple
model rows can remain expanded, and deleting one preserves the other rows'
text and expansion. The picker initially selects new candidates within the
existing provider limit. Display names can be empty and fall back to model IDs.

Ablation removed the numeric spinners, mandatory capacity values, redundant
default-model object, exclusive expansion state and extra reasoning checkbox.
Existing reasoning configuration remains preserved. The capacity buffer is
retained because removing it rewrites partially typed values; stable row keys
avoid index-repair machinery after deletion. No surrounding settings layout,
new preference or model call is involved.

Validation: `bun run check` passed; the full suite passed 2,026 Node tests (eight
skipped) and 839 Vitest tests. The isolated Chromium scenario passed at 1440px
and 390px with light/dark screenshots. Tests cover decimal suffix round trips,
native override removal, invalid input, independently expanded rows, sibling
deletion, default selections and staged discovery. Additional evidence in the
same external directory: `capacity-check.log`, `capacity-test.log`,
`capacity-browser.log`, and `capacity-browser/`. The local preview was restarted
and its served bundle matched the rebuilt source (`preview-restart.json`).

### Composer model and thinking controls — 2026-09-30

Status: local implementation pending preview review, same PR #598 / Issue #597
source boundary. The user's DSH model-menu and Codex thinking-popover screenshots
are the visual references. Automatic safety review denied direct Codex app
inspection; reset behavior below is an OpenPI choice, not a verified claim about
Codex's implementation.

The model menu groups entries by provider and retains search, keyboard navigation,
the current-model check and the existing configuration entry. The thinking button
shows the current level and opens a compact popover: centered level, model link,
reset and a discrete slider. Stops come only from Pi's supported levels. Dragging
previews a level and releasing commits it through the existing native selection
queue; arrow keys, Home and End also work. Escape discards an unfinished drag.
Reset restores the confirmed level from when the popover opened. The model link
opens the existing model picker. Session/model changes close the popover and
discard unfinished edits. Existing running/read-only restrictions and failed-write
reconciliation remain in force.

The model editor now uses the explicitly requested `256K` and `32K` placeholders.
They are example text, not saved values or replacements for Pi's native defaults.
The surrounding settings layout remains the same.

Ablation removed the old colored thinking-icon rules, the extra pending message
inside the popover and an unused default-capacity translation. The existing
composer pending hint and accessible busy state provide feedback without resizing
the popover. Provider grouping uses one local map; no provider registry, preference
or persistence layer was added. Preview images use the isolated browser fixtures
and never call a model. Evidence remains in the external model-settings directory
above, under `thinking-browser/` and the `thinking-*` validation receipts.

Validation: `bun run check` and the full test suite passed (2,026 Node tests,
eight skipped; 841 Vitest tests). Twenty isolated Chromium scenarios passed,
including drag/release, Escape, reset, pending-write coalescing, failure recovery,
model-link navigation, light dismissal without stealing composer focus, first-use
Session preparation, accessibility and light/dark/narrow rendering. The model-page
scenario also verifies the new empty-field hints. Final logs are
`thinking-check-final.log`, `thinking-test-final.log`, `thinking-browser-final.log`
and `thinking-dismiss-browser.log`. The existing authenticated preview responds
successfully and serves the rebuilt bundle; no runtime restart was needed.

### Combined model control and capability metadata — 2026-09-30 amendment

Status: local implementation pending user review, for Issue #597 / PR #598 at
`05f1069157e49e03822222075ea9862a4444537c` plus working changes. This amendment
supersedes the separate thinking button and removal of the reasoning checkbox
described above. It does not change the surrounding settings layout.

The composer has one model / thinking trigger and one popup. A reasoning model
opens its native-level slider; its model link switches the same popup to the
grouped model list. Models without reasoning keep model selection available,
omit the redundant Off control, and explain where to enable the capability.
Opening a configured model in a workspace draft first prepares its native
Session, so the popup can read the selected model's real supported levels before
the first prompt. Model selection, configuration and Session preparation never
send a model request.

The expanded model row exposes Pi's existing `reasoning` flag. Saving refreshes
the native registry and reapplies the current model; the ordinary snapshot update
then refreshes the control. The slider uses Pi's supported set and existing write
queue, including native `thinkingLevelMap` restrictions. It does not infer
capabilities from a model name or invent Codex's Max/Ultra stops.

Source observations:

- [pi-web at 550a17f8](https://github.com/jmfederico/pi-web/blob/550a17f8fc7837bc53d0f978791fad72a2100b07/src/server/sessions/piSessionService.ts)
  projects and validates levels through `session.getAvailableThinkingLevels()`.
- [Maka at e98c2f4c](https://github.com/apache/maka/blob/e98c2f4cf31e0812e4c253758c119975c80303a2/packages/core/src/model-thinking.ts)
  combines declared per-model levels with catalog metadata and provider adapter
  knowledge. Its model metadata code also supports explicit vision overrides;
  it does not assume every model accepts images.
- [OpenAI's model object](https://platform.openai.com/docs/api-reference/models/object)
  does not specify context, output-limit, image or reasoning fields.
  [OpenRouter's catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties)
  provides context, top-provider output limits, input modalities and supported
  parameters. Catalog richness therefore depends on the endpoint.
- Installed Pi 0.85.1 uses `reasoning` and `thinkingLevelMap` to compute the
  supported levels. Its message transformer substitutes an omission notice for
  images when the selected model lacks image input support. Marking an incapable
  endpoint as image-capable may instead cause the provider to reject the request.

Discovery now retains explicit, validated capability metadata through selection
and staging. Missing metadata remains absent; `256K` and `32K` remain examples,
not assertions about a discovered model. Text remains the conservative default.
The image checkbox explains that an unchecked capability prevents image delivery.
No new metadata store, network refresh loop, provider stack or model call is added.

Ablation removed the standalone thinking trigger, its separate popup lifecycle
and its icon styles. Reusing the existing selector retained keyboard/model search
behavior, but its unconditional focus return failed the outside-click test. A
small pointer-target receipt is retained so clicking the composer can immediately
continue typing. No metadata guessing by model name is needed: catalog facts or
user declarations supply capabilities; Pi supplies the runtime levels and clamps
selections. Before workspace selection the ordinary model catalog stays usable;
Session preparation begins only after a workspace is selected.

Validation: `bun run check` and `VITEST_MAX_WORKERS=2 bun run test` passed
(2,027 Node tests, eight skipped; 841 Vitest tests). Twenty isolated Chromium
scenarios passed, including native-capability arrival before the first prompt,
pending writes, keyboard/drag/reset, focus, accessibility and responsive layouts.
Native registry tests confirm that saving the reasoning flag updates the current
model's available levels. Discovery tests cover rich and ID-only catalogs,
explicit false capabilities, unsupported modalities and invalid capacities.

The authenticated preview was restarted from this worktree with its selected
model preserved and the served asset hash verified. A read of its configured
catalog returned ten models without usable capability metadata; their actual
reasoning, vision and token limits remain unverified. No inference call was made.
Final receipts are in the external model-settings directory above:
`combined-check-delivery.log`, `combined-test-delivery.log`,
`combined-browser-delivery.log`, `combined-preview-receipt.json` and
`combined-catalog-receipt.json`. Browser screenshots use explicit example data,
not the user's live provider or a claim that every model supports Max.
