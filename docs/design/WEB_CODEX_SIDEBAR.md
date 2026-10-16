# Codex sidebar behavior in the OpenPI Web workbench

- Status: draft local implementation; not an accepted project constraint
- Created: 2026-10-12
- Source review: 2026-10-12; local implementation and visual validation recorded below
- Source boundary: OpenPI PR #711 at `d526ec8d852c5582d713bae2182f178be7b6b4b6` plus this branch's changes
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#711](https://github.com/openpi-dev/openpi/pull/711), implementation base
- Supersedes: the sidebar interaction and reading-state choices in [Workspace sidebar refinement](WEB_WORKSPACE_SIDEBAR.md) for this local implementation; historical validation receipts remain unchanged
- Publication: local review only; an Issue backlink is pending publication
- Follow-up: [rework causes and gap audit](../research/WEB_CODEX_SIDEBAR_REWORK_2026-10-12.md), including the Oct13 hover/input correction and its 28-case browser receipt; the original validation receipt below remains scoped to its earlier run

## Request and evidence boundary

Reconstruct the sidebar in the supplied Codex screenshot, including its search,
activity, project and conversation interactions. The user specifically requires
visible Web menu controls because a native right-click interaction conflicts
with browser behavior. They also request the open-source Codex App Server as the
backend reference.

The public backend reference is
[`openai/codex` at `a9b0815167c27ab13719dd12d13b63e02b70d221`](https://github.com/openai/codex/tree/a9b0815167c27ab13719dd12d13b63e02b70d221).
In particular, its
[App Server README](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/app-server/README.md)
defines the thread/turn/item lifecycle, and
[durable reading-state implementation](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/state/src/runtime/thread_read_state.rs)
guards both read and unread writes with a revision. Every eligible new result
advances the revision even when the first unread position remains unchanged.
Repeated explicit marks also advance it. Reads do not materialize metadata;
stale writes conflict and must not be retried blindly.

The UI evidence is the supplied screenshot and static inspection of the locally
installed `com.openai.codex` app, version `26.1002.52244`, build `13536`.
Its `app.asar` SHA-256 is
`40efd7acdf03a24817fcd7f35684fc2173b154df06774243cb4ab227e36fa915`.
REA parsed four selected JavaScript modules; ordinary bounded source inspection
covered related root-bundle functions. This is not complete application analysis
or a live observation of feature flags. Native Codex UI access was unavailable;
no private conversations, credentials or preferences were inspected.

Raw installed-app evidence remains outside Git at
`/Users/admin/.local/share/openpi/research/codex-sidebar-2026-10-12-13536/`.
`source-manifest.json` identifies the modules and `rea-evidence.json` preserves
the bounded analysis receipts. The three extracted CSS files match their ASAR
members' declared SHA-256 integrity values. These focused records retain exact
module names and zero-based Unicode character offsets, not runtime measurements:

| Local evidence record | Boundary |
| --- | --- |
| `findings.md` | Sidebar state and interaction investigation; REA coverage limits |
| `ui-spec.md` | Product switch versus section and row controls, hierarchy, conditional layouts |
| `ui-token-evidence.md` | Verified CSS identity, typography, geometry, menu variants and theme limits |
| `search-activity-ui-spec.md` | Search surface and feedback, Activity controls, token remapping and unknowns |
| `archive-and-shell-notes.md` | Settings/conditional Archive destinations, shell collapse, divider and section-title conditions |

Public backend source is retained separately in
`/Users/admin/.local/share/openpi/research/codex-app-server-2026-10-12/`.
OpenPI uses newly written components, not redistributed application bundles.

## Entry points and correction to the earlier draft

The earlier draft put OpenPI display options in the brand dropdown. That was an
invented replacement for Codex's product switch and the user rejected it. The
current design uses a static OpenPI brand and places controls at the relevant
section. Omitting a product switch does not justify assigning it another action.

| Entry | Codex static evidence | OpenPI implementation choice |
| --- | --- | --- |
| Brand | `$1o` selects Codex or ChatGPT Work; its disabled branch is static. It has no organize/sort controls. | Static OpenPI wordmark, without a chevron or replacement menu. |
| Projects / Recents heading `…` | `XZo` is called by each section's title actions. `yH` reveals actions on title hover/focus-within or an open menu; `HUo` reveals the arrow on the entire section's hover, title keyboard focus or collapse. | Section menus expose project/flat grouping, shared chat sort, and applicable Projects in Recents. Hovering a project reveals its section arrow, while section actions retain their own trigger conditions. OpenPI does not add an unavailable connection mode. |
| Pinned heading `…` | `lls` provides independent Last updated / Manual order sorting; its presence depends on eligible pins. | The mixed pin list owns its separate sort control. |
| Project or conversation row `…` | `Ucs` / `W$o` and the chat action rail are separate from section organization. Controls appear on row hover, keyboard-visible focus or an open menu. | Explicit buttons expose rename, pin, read/unread, order and archive/restore. Mouse focus alone does not reveal them. Non-hover/coarse input keeps the menu reachable. Browser context menus remain native. |
| Ordinary project leading/trailing icons | `pus → xcs → Acs` supplies a folder without disclosure: 16px closed/open folder follows collapse state. The hover arrow belongs to the separate connection-group branch. `Ucs` uses square-and-pencil for new chat. | Keep Folder/FolderOpen through hover/focus; use SquarePen for project-scoped creation and a sidebar-specific Projects heading. An empty expanded complete project gets an indented empty-state row. |
| Bell | The default `l$o` toggle enters Activity; clicking the same active bell leaves it. Options belong beside Priority, or the first date heading when Priority is disabled. Clear read is an adjacent conditional icon, not a dropdown item. | Activity replaces the list without changing selection. The same bell returns; options and Clear read stay beside the section title. |
| Search | `LEo` dispatches the dedicated chat-search command dialog. | Header icon opens the compact search dialog; it is not an always-expanded sidebar input. |
| Sidebar collapse | `a8r` / `l8r` belong to the application shell/topbar. The content-header `gTo` returns null in this build. Settings and some fixed-panel layouts suppress the shell trigger. | Desktop collapse is in the main topbar. The mobile drawer uses its own accessible control; there is no duplicate collapse button beside the brand. |
| View archived chats | Settings has the `archived-chats` page. A separate Archive navigation destination requires a feature gate and desktop navigation support and is declared hidden by default. Its Electron sidebar view has Back to sidebar. | A bottom Archive entry reuses OpenPI's existing archived view. This placement is an explicit Web adaptation, not an observed Codex footer item or brand/section-menu action. |

The detailed callsites and conditions are in `ui-spec.md` and
`archive-and-shell-notes.md`. Native popup presentation, current feature flags,
and collision-adjusted placement were not observed. OpenPI uses browser nested
menus with Escape returning through the open menu before closing the mobile
drawer, and focus restored to the trigger. Remote-host, cloud, native-window and
worktree actions are included only where existing OpenPI capabilities support
them. This iteration does not add the original Activity bulk archive action.

## Geometry and visual boundary

| Surface | Source-supported default | OpenPI choice / limit |
| --- | --- | --- |
| Ordinary desktop rows | 30px navigation row; 14px main text; 10px radius; 8px cell/outer padding; 1px list gap. Hover/selected feedback does not make every row a bordered card. | Adopt this desktop density and single-line title hierarchy. Activity rows can grow for a project subline. |
| Brand and section headings | Brand 18px/24px, weight 600, 32px fallback container; section title 14px/21px, weight 500. Default sections have 16px gaps; controls have 4px gaps. | Static brand and section-local controls follow these relationships. A 52px shell-header override exists in Codex and is not asserted active in the screenshot. |
| Mobile / browser variants | Codex has separate 36px browser rows and a conditional 36px ConversationSidebar branch. Neither establishes the screenshot's live branch. | OpenPI uses 44px targets for non-hover/coarse input. Narrow mouse windows retain 30px ordinary rows and reveal actions on hover or keyboard-visible focus; viewport width only changes the drawer layout. This is an explicit Web input adaptation. |
| Search surface | At scale 1, width min(520px, 92vw), radius 16px, padding/gap 4px. List maximum is min(440px, max(120px, 90vh − 64px)); total maximum adds 64px. The top is max(16px, (viewport height − total maximum)/2). | Use these proportions with browser dynamic viewport units, keeping the top edge stable as results change. A hidden accessible heading replaces the visible title; there is no separate close footer or bordered input wrapper. |
| Search rows | Input padding 6px/10px; title with a right-aligned 96px project column; optional single-line 12px snippet. Row radius 10px. | Keep title/project truncation and exact-message snippets within one result list. Loading has a small heading spinner or 48px empty-list area. Empty history uses a 144px centered area with the existing create action. |
| Activity | Sticky row-height section headings, 16px section gaps, native-style chat rows and a quiet left-aligned empty Priority message. Initial 10 items and increments of 10 use a tail sentinel/spinner. | Options remain next to the section title; the same bell exits. No Priority/Read/All tabs, independent back button or boxed empty card. |

OpenPI retains its 340px default sidebar width, 240–520px interactive range and
space reserved for the main view; these are OpenPI layout choices. Existing
saved narrow widths must remain usable.

Color and material are not established by raw screenshot pixels. The capture
was resized and its zoom is unknown. Codex's Electron sidebar can mix a native
window material with a partly transparent surface. Search's base color tokens
are also remapped by the application theme: the elevated surface may come from
a dynamic opaque-control token, while ghost hover resolves to light foreground
at 5% / dark white at 8%. OpenPI uses its canonical theme surfaces and that search
hover relation, without claiming native glass equivalence. The supplied image
does not show some headings rendered by the inspected default path; the reason
is unknown. Likewise, its divider below New chat is consistent with a
conditional scrolled-header line, not proof of a permanent New chat separator.

## Behavior and deliberate Web adaptations

- On 2026-10-13 the user requested a blue folder icon for the project containing
  the conversation currently being read. It follows the snapshot-confirmed
  selected Session, independently of background execution or the draft's
  preselected project. The previous project returns to its ordinary icon color
  on selection change. Open/closed folder shape continues to follow the user's
  collapse choice, with a brighter blue in dark themes. This is an intentional
  OpenPI navigation cue, not a claim about Codex's home draft project semantics.
- Reading a conversation changes its project's blue icon without promoting that
  project. Ordinary projects retain the adapter's name order, with their full
  paths breaking equal-name ties. Selection and reload do not change that order;
  no separate client-side ordering cache is needed.
- A shared ordered list mixes pinned projects and individual conversations.
  Pinned projects are removed from the ordinary project list. Their conversations
  and individually pinned conversations are excluded from Recents.
- Project grouping is the default; a flat list is also available. Ordinary project
  conversations may appear in Recents by default. Conversation sorting is shared
  across project and Recent views; pin sorting remains independent.
- Initially show five projects, five conversations per project, and ten Recents.
  Show the last extra item directly rather than requiring one-item expansion.
  Keep the selected conversation and its project visible across truncation.
- Manual ordering supports drag placement and keyboard-accessible menu actions.
  Changes are confirmed by the backend; errors retain the previously confirmed
  order. Pins and sorting survive reload.
- The bell replaces the sidebar list with Activity while retaining the selected
  conversation. Priority includes unread, running and waiting conversations.
  Its initial order is waiting, unread, active, then recency within each group;
  reading an entry keeps its position while Activity remains open. Existing
  conversations that gain attention append; newly created conversations prepend.
  Read-through entries remain until Clear read; that action changes the view,
  not conversation history or read metadata. Turning Priority off merges its
  entries into chronological activity. Dated activity covers seven calendar
  days. Mark all read uses the eligible Priority revisions and is disabled when
  Priority is hidden. Project menus
  restrict it to that project's loaded, non-archived unread conversations with
  a revision, including individually pinned conversations.
- Search with empty input offers all loaded pins and up to ten recent unpinned
  conversations. Nonempty input combines up to nine title/project matches with
  the existing bounded native transcript results in one group. Retaining all
  returned message anchors and partial-search evidence is an OpenPI extension
  to Codex's nine-chat search preview. The archive checkbox is removed; the
  existing entry-point scope still controls both local and backend matching.
  The first result is selected initially. Arrow/Home/End navigation updates
  the input's active descendant without moving keyboard focus, so typing can
  continue; Enter opens the selection outside IME composition. Native
  Escape/outside dismissal and focus return remain. Cancelled or superseded navigation does not close the dialog
  as if it succeeded. Failed transcript requests leave title matches usable;
  retry, navigation errors and partial results remain explicit.
- Search supports Cmd/Ctrl+K and Cmd/Ctrl+Shift+P, Activity Cmd/Ctrl+Alt+U, and sidebar visibility
  Cmd/Ctrl+Shift+B/S. These bindings remain OpenPI choices; browser-reserved
  shortcuts are not required to use a feature.

## Pi ownership and concurrency

Pi Session files, native identities, turn-timing entries and runtime events
remain the execution source of truth. The existing serialized, atomic workspace
metadata writer owns only presentation receipts: mixed pins, manual order and
explicit reading choices. Archive/restore retains OpenPI's metadata-based
hide/restore behavior; it does not implement Codex's file relocation or loaded
thread eviction. Native Session identity, bounded history projection, selection
cancellation and host admission remain authoritative.

Ordinary session projection filters archived records and applies the canonical
chat order before the 500-record cap. Current, selected and individually pinned
sessions remain eligible; archive pagination is separate. Workspace discovery
still uses the full Pi catalog, including projects whose chats are all archived.
This count limit does not prove retention under the later snapshot byte budget;
that remaining boundary is recorded in the follow-up audit.

`readRevision` binds the exact Session path/id, the last eligible native result
and a fresh nonce for each explicit read/unread edit. The host rejects stale
revisions with `SESSION_READ_STATE_CHANGED`. The client refreshes on conflict
without replaying the edit. A snapshot cannot itself acknowledge a result.
The visible, confirmed conversation view can acknowledge the exact revision it
observed; background, hidden, blocked, disconnected or replaced views cannot.
A visible execution-trajectory tab also cannot acknowledge a result; only the
confirmed conversation tab can do so.
A manual unread mark in another window is not immediately undone by an already
open view. Clicking the conversation again is a new explicit reading action.

OpenPI derives attention from Pi timing history rather than adding Codex's
SQLite execution database. Eligible native results preserve the earliest unread
position, including across a subsequent running, cancelled or uncertain turn.
The snapshot exposes this as `firstUnread`: an explicit unread mark begins at
`sessionStart`; a native result identifies its command, finish time, outcome and
optional result entry. Native branch order determines the first unread result,
not wall-clock timestamp sorting. Acknowledged branch ancestors stay read after
a rewind, while a new eligible branch result becomes unread. The UI uses the
first unread result's outcome/date so a later cancelled turn cannot hide an
earlier unread failure.
Fork-inherited timing entries must match the new native Session id before they
can become its unread result. Legacy unacknowledged eligible Pi results can
appear unread on first discovery; this intentionally differs from Codex's
live-publication-only unread seed. Bounded snapshots disclose omitted history,
so bulk actions apply only to loaded, eligible conversations.

The legacy-first-discovery choice above is superseded by the Oct13 upgrade
correction below; the earlier validation receipts retain their original scope.

Display preferences use the existing validated configuration writer and are
also available through `/openpi-setup`: grouping, conversation sort, pin sort
and project inclusion in Recents. Defaults, status output, setup schema and
README/SETUP documentation are updated together. No model-facing tool, provider,
model call, new package dependency or additional Session owner is introduced.

## Simplification and validation

The implementation removes tab-local completion acknowledgement storage and
uses the backend reading projection. It retains one row renderer and one
metadata writer. An unused workspace-pin API wrapper was removed in favor of
the mixed target primitive. Context-menu components and their extra DOM/CSS
wrappers were removed because explicit menus satisfy pointer, touch and keyboard
acceptance. The substitute brand menu and duplicate sidebar-header collapse
entry were removed. Hidden relative-time row markup and repeated sidebar CSS
overrides were removed after checking geometry and action placement. Activity
uses section controls and the existing bell.
Search lost its extra
visible heading/footer, scope checkbox, duplicate archive state, and redundant
height declaration; the original scope parameter and cancellation mechanism
remain. Closed search dialogs retain only their native dialog shell rather than
a second hidden result tree. Repeated test-only `matchMedia` shims were replaced
by one browser-environment fixture. These removals preserve the authorized
behavior while reducing competing entry points and duplicated state.

Validation distinguishes metadata/runtime facts, client navigation, rendered UI
and browser behavior. The local receipt dated **2026-10-12** covers
`codex/codex-sidebar-parity`, based on the PR revision above with uncommitted
implementation changes. `validation.json` records the changed-file hashes.

The preview's provenance reports exactly one OpenPI source,
`/Users/admin/.codex/worktrees/codex-sidebar-parity/openpi`, matching this checkout.
Its generated native Pi Session fixtures and settings live under
`/Users/admin/.local/share/openpi/previews/codex-sidebar-2026-10-12/`.
The preview and browser tests do not call a model or change the user's installed
package source.

| Check | Result and boundary |
| --- | --- |
| `bun run check` | Passed: configuration/docs contracts, Web build, formatting, lint and TypeScript. |
| `VITEST_MAX_WORKERS=2 bun run test` | Passed: 2,384 Node tests, 9 skips; 1,328 frontend tests in 88 files. This includes read-state revisions/branch order, native result identity, selection cancellation and conversation-only acknowledgement. |
| Focused Playwright suite | 24 passed across sidebar parity, workbench polish, transcript search, pane resizing, compact navigation, mobile focus and archive restore. Includes light/dark checks, 320px/390px focus containment, touch menus, persistence and cancelled search navigation. |
| Manual browser review | Inspected 1440px desktop and 390px narrow layouts, section/nested-menu placement, search and Activity. Narrow menu controls measured 44×44px with no horizontal page overflow. |

The browser checks exposed and resolved a desktop CSS specificity override that
shrunk touch buttons, invisible narrow-screen section actions and insufficient
light-theme secondary-text contrast. Desktop tests now reveal controls by
hover/focus, and a pane test resets both widths before asserting geometry so a
previous test's saved width cannot change its starting layout.

Logs, screenshots and provenance are retained outside Git under
`/Users/admin/.local/share/openpi/evidence/codex-sidebar-2026-10-12/`:
`check.log`, `test.log`, `browser.log`, `provenance.txt`, `validation.json`,
`sidebar-project-menu.png`, `sidebar-project-menu-detail.png`,
`search-desktop.png`, `search-mobile.png`, `activity-desktop.png`,
`sidebar-mobile.png` and `sidebar-mobile-menu.png`. Test-generated screenshots
are retained in `browser-results/`. These are local fixtures, not private Codex
conversations or proof of Codex's live native rendering.

Native Codex rendering, feature flags, zoom, effective theme variables,
native-menu material and exact animation/ranking behavior remain unobserved.
This draft does not claim pixel-level parity or replace the pending Issue
backlink/publication review.

## 2026-10-13 project ordering and conversation-menu follow-up

This dated addendum updates the implementation and validation scope without
rewriting the earlier receipts. Detailed findings, rework causes and current
gaps are recorded in [the retrospective](../research/WEB_CODEX_SIDEBAR_REWORK_2026-10-12.md).

Ordinary projects now have an order in the existing atomic workspace metadata
writer. Whole project containers, including expanded conversations, own their
drop regions. Moves within projects and between projects and mixed pins preserve
unseen members. Sorting precedes the bounded projection. Reading a conversation
changes its folder's blue indicator, never its order. Escape/blur cancel drag;
Alt+Up/Down and menu actions provide a keyboard alternative. Web uses HTML5 drag,
not Codex's exact pointer sensor, drag image or auto-scroll implementation.

The explicit conversation ellipsis now exposes the observed context-menu groups:
rename/pin/read state, fork, copy, new window/open with, archive/delete. The brand
is still static and browser right-click is unchanged. Nested Escape and focus
return, busy-state explanations, shortcut/input guards and a cancel-focused
delete confirmation are part of the contract. Closed menus and unneeded delete
dialogs do not mount full hidden content trees.

Whole-conversation fork extends the existing Pi lifecycle with an explicit
conversation scope and reads the native leaf, including trailing metadata.
It creates no model turn, preserves the source and reuses existing command
receipts. Replaying a lost response can reactivate the same child. Worktree
forking and activity snapshot forks are not exposed as available capabilities.

Delete is restricted to canonical native files directly inside the Web Session
directory. It validates identity, file type and inode, rejects unsafe links and
busy/queued owners, and follows Pi replacement/disposal before unlinking. Host
rename and delete serialize their file mutations. Cancellation, uncertainty,
confirmed deletion and incomplete metadata cleanup remain distinct. Successful
and uncertain commands replay instead of executing again; confirmed preflight
failure or cancellation allows retry. Independent Pi fork files are retained.

Markdown export reads the full native current branch with an explicit 10 MiB
JSON response bound; it never silently exports only the visible snapshot.
Links bind both native path and ID and do not carry the Web authentication token.
Web new-window behavior opens a browser tab. Open-with uses installed applications
from a fixed platform allowlist and passes a canonical directory as arguments,
without accepting arbitrary commands. Archive retains its previous visibility
metadata semantics; it does not implement Codex shutdown and storage relocation.

The final gate used Node 24.20.0 and an isolated agent directory with this checkout
as its single OpenPI source: `bun run check` passed; `bun run test` passed with
2,415 Node tests, 9 skips and 1,355 UI tests in 90 files. The ambient configuration
run had six failures; an isolated comparison traced them to user setup assumptions
and documented a pre-existing Pi full-rendering difference without changing user
preferences. Browser evidence covers 13 behaviors across an initial 11 passes and
two corrected-locator reruns, including real Host/runtime fork/delete/order and
restart persistence. Raw failure receipts remain available.

Unlike the earlier fixture-only preview, this follow-up also made user-authorized
real model calls through the local 8080 gateway with `gpt-6.1-sol`, `medium`.
The first credential encountered upstream proxy authentication failure. After
the user supplied a replacement, native responses verified arithmetic, bounded
bash/write/read work, background completion/unread acknowledgement, conversation
fork context inheritance and source-file isolation. Separate stops confirmed
model-request cancellation and a running bash returning `Command aborted`.
Deleting the disposable test branch replayed safely and preserved both retained
Sessions. Credentials remain in the isolated Pi auth store, outside Git and the
evidence receipts. Runtime evidence proves requested/returned model identity,
not the proxy's internal upstream model implementation.

Receipts are under `/Users/admin/.local/share/openpi/evidence/codex-sidebar-2026-10-13/`
in `project-drag/`, `session-menu-backend/`, `test-environment/` and `live-model/`.
These tests do not prove native Codex rendering or eliminate the remaining
visual, activity, search and lifecycle differences listed in the retrospective.

## 2026-10-13: running snapshots and worktree forks

This follow-up replaces the earlier idle-only conversation-fork capability
boundary. It does not rewrite that iteration's validation receipts. The source
boundary remains PR #711 plus this worktree's local changes. The installed Codex
artifact and public App Server revisions are the fixed identities above;
equivalence between those two builds was not established.

REA traced the actual sidebar action through pending-worktree creation, the Git
worker and the App Server fork request. The artifact's new-worktree fork starts
from the source working tree, creates a detached checkout at source HEAD, brings
over working changes, and then forks history. It is different from the separate
new-worktree tool's remote-default-branch behavior. App Server's interrupted fork
copies a persisted history prefix and closes the child boundary; it does not
freeze the source or copy every unpersisted streaming token. Raw evidence and
source maps are in `fork-depth/codex-app-contract.md`, under the evidence root
above. These are static observations, not live Codex A/B testing.

OpenPI implements this at Pi's existing seams:

- Conversation forks use an independent native `SessionManager`, preserving the
  loaded source's selected persisted leaf. They do not invoke the live source's
  destructive replacement lifecycle. Source execution, tools and queued inputs
  remain on their owner; the new branch starts idle and makes no model call.
  Existing message/edit/regenerate forks retain Pi's normal idle-only lifecycle.
- The history boundary is captured after the requested environment is ready,
  before the native `session_before_fork` veto hook. Only the frozen branch goes
  into `createBranchedSession`. Any missing tool result in the child is explicitly
  unknown; it is not evidence that the source tool failed, was cancelled or ran
  again. Child UI and model context receive distinct projections of that fact.
- New worktrees use a fixed source commit, detached HEAD, the final combined
  staged/unstaged tracked contents, binary changes and nonignored untracked files.
  Copied changes are unstaged in the child. Ignored regular `AGENTS.override.md`
  and `.worktreeinclude` matches follow the observed local Codex rules. The source
  index remains unchanged and a source subdirectory maps into the child root.
- Git creation is a bounded shell-free backend operation. Unsupported sparse,
  unmerged or submodule snapshots fail explicitly. Source/child content checks
  detect ordinary concurrent changes; they do not claim a globally atomic
  filesystem snapshot. Limits are 32 MiB Git output/patch, 128 MiB checked
  contents, 20,000 selected entries, 10 seconds per Git command and 90 seconds
  for an operation. Ordinary ignored dependency trees are not copied or counted
  as selected files.
- Cancellation uses the fork command's own abort controller. It never cancels
  the source turn. A request acknowledged as `requested` still waits for the
  terminal fork receipt. After native creation starts, cancellation reports
  `too-late`, without asserting success before it is confirmed. Cleanup requires
  exact ownership, Git identity and unchanged baseline contents. New or uncertain
  contents are preserved with their path. Session deletion does not delete a
  worktree.
- Native custom entries retain source identity, actual child cwd, original
  sidebar project and worktree provenance. The original project owns grouping,
  ordering and the blue current-reading indicator; files, terminal, Git, model
  tools and Pi Trust use the actual child cwd. A selected project's folder opens
  on navigation without changing its order; users can subsequently collapse it.
  Further conversation or message/rerun forks preserve that project provenance.
- Titles begin at `(2)`, follow verified native fork ancestry, preserve a user's
  unrelated numeric suffix, and avoid occupied titles. The two menu choices are
  available while a conversation runs; the worktree choice requires Git. A local
  fork of an existing worktree explicitly says it stays in the same worktree.

The existing bounded command receipt map owns same-process replay; no second
Session database or provider stack was added. Native child identity and metadata
survive restart, but in-flight HTTP command replay is not durable across process
crashes. No Codex environment setup subsystem, automatic dependency installation,
Trust grant, UI layout copy, remote/cloud host fork or worktree garbage collector
was added. Those remain explicit differences. Detailed validation and rework
causes for this follow-up are appended to the linked retrospective.

## 2026-10-13: browser adaptation and archive feedback

At the user's request, worktree badges are removed from conversation rows and
the sidebar's application shortcut hints and modifier-key bindings are removed.
This supersedes the earlier shortcut choice: search, activity, sidebar visibility,
conversation actions and project ordering use their visible controls. Normal
Tab/Enter/Escape and menu arrow navigation remain available.

A confirmed archive displays a compact card at the top of the conversation with
the archived title, View, Undo and Close. View opens the exact archived Session;
Undo restores only that path without switching the reader. Up to three cards are
shown, deduplicated by path. Astryx's existing Toast handles eight-second expiry,
pointer/focus pause and touch dismissal. Pending or failed actions stay available
for completion or retry. The cards are transient presentation state, not persisted
Session state, and failed archive writes never show a success card.

## 2026-10-13: historical unread markers after an upgrade

- Status: source-validated correction; local and CI validation are recorded in
  PR [#711](https://github.com/openpi-dev/openpi/pull/711).
- Source boundary: OpenPI `c0c176221826288430798a8ad75180eafa62dd28` plus this
  correction; Codex App Server `a9b0815167c27ab13719dd12d13b63e02b70d221` and
  the same desktop ASAR identity recorded above. Related tracking: [#763](https://github.com/openpi-dev/openpi/issues/763).
- Verified: 2026-10-13. Supersedes the legacy-first-discovery behavior above.

The upgrade exposed old completion records as blue unread dots because OpenPI
treated history discovery as new attention. The App Server reference instead
returns a default read receipt without writing on history lookup
(`state/src/runtime/thread_read_state.rs:110`); its live event processor seeds
attention only after flushing the native rollout
(`app-server/src/request_processors/thread_read_state.rs:91`). Each eligible
publication and explicit read/unread edit advances its revision. These public
backend facts are separate from the desktop build's host/account-scoped saved
unread IDs; this investigation does not establish that desktop build's use of
the experimental App Server revision API.

OpenPI now records automatic unread eligibility on new native turn-timing
entries. Unanchored old history stays quiet without a catalog migration or
rewriting Sessions. Explicit unread marks remain, and an existing exact
`lastReadTurn` retains older pending results after that acknowledged position.
Execution's recovered `lastTurn` remains available but cannot itself seed
attention. If Pi appends in memory before persistence fails, the failed record
is explicitly ineligible, including through legacy compatibility. Acknowledging
one revision still cannot clear a result published during the write. Native
branch order, first unread position, fork identity and terminal distinctions
retain their existing owners.

The desktop `local-conversation-thread-faa16cd8ed14.js` watcher at Unicode
offsets 314472–315249 requires the app focus signal and a changed activity
identity; a manual unread edit alone does not trigger another automatic read.
OpenPI retains its confirmed conversation-view and explicit reselect guards and
now also requires `document.hasFocus()`, retrying on window focus. Hidden,
unfocused, disconnected, dialog-blocked and trajectory-only views do not
automatically acknowledge. Explicit sidebar read/unread actions remain separate.

Limits: no-receipt old history cannot distinguish a genuine old pending result
from replay. A copied native file carrying a new eligibility marker retains
that fact; this is not a second Codex receipt database. Codex settings import
has its own explicit mark-unread path (desktop `app-initial` offsets
5356210–5357900), so no universal import parity is claimed. Codex's goal-specific
and `DONT_NOTIFY` publication rules are not adopted as Pi runtime rules.
Desktop findings are bounded static observations, not native UI execution.
The detailed identity and source ledger is retained outside Git at
`/Users/admin/.local/share/openpi/evidence/pr711-ci-unread-2026-10-13/codex-read-state-reference.md`.

Simplification: removed the proposed startup baseline scan and its persisted
flag; removing the publication gate instead reproduces the legacy blue-dot
regression. The implementation uses existing Pi timing and presentation
receipts, with no new settings, model-facing tool or independent activity store.

## 2026-10-15: explicit release of retained fork worktrees

- Status: implementation candidate for PR #821 / Issue #798; independent final
  review and the sidebar UI acceptance remain separate gates.
- Source boundary: PR #821 `079ace4d`, integrated with main `f98d6a47`.
- This amendment extends the earlier retention policy; it does not change the
  historical snapshot or cancellation receipts above.

Session deletion still retains its worktree. A separate explicit release request
uses the original private Git ownership receipt, bound to the newly persisted
native child before activation. If binding persistence fails, the fork reports
`uncertain` and preserves the child and checkout. Public fork provenance and a
browser-supplied path alone never grant cleanup authority.

The Host provides workspace-scoped discovery from those private receipts at
`GET /api/workspaces/worktrees?path=…&cursor=…`. Pages scan at most 128 managed
entries; a continuation cursor also advances through unavailable entries. The
projection contains only native child id/path and worktree path, with explicit
partial/unavailable counts. It survives deletion of the child Session and Host
restart without a second Session registry or a global garbage collector.

`POST /api/sessions/worktree-release` takes the exact command id, original native
child id/path and worktree path. It is separate from Session deletion. Release
refuses an existing original Session, any saved Session sharing the checkout,
active/retained/candidate/in-flight native cwd holders, incomplete reference
inspection and unverified shutdown. In particular, deleting an active Session
can create an idle native replacement in the same cwd; that replacement still
prevents release until the operator genuinely leaves the checkout. Host PTY
creation and release share the existing mutation queue; pending creation and
closed terminals remain holders until native exit is observed. A missing holder
inspection seam is unknown and preserves the checkout, and closing processes
continue consuming the existing terminal capacity until exit.

Only an unchanged checkout with matching private marker, directory/Git identity,
HEAD, index and full contents can be removed. Confirmed modifications and shared
references produce a `preserved` refusal with their path and reason. Unavailable
canonical Git identity or missing, unreadable, corrupt or unbound original
private receipts produce typed `uncertain` refusal, even if the checkout still
exists. Claim inspection precedes marker parsing; a claim never recreates a
missing native child binding or grants deletion authority. Fully verified
terminal state precedes new holder observations. A failed removal after Git was invoked is
`uncertain`, rather than a claim that the checkout remains intact. Command
receipts replay the exact same-process result and reject identity reuse; after
restart, a missing checkout is uncertain rather than evidence of successful
release. A destructive attempt first exclusively claims this resource in its
private Git directory and writes a terminal `uncertain` barrier into the original
receipt. A different command or Host restart cannot repeat removal after that
barrier, including when only the claim survived an interrupted marker update.
Failure to persist or inspect the barrier prevents Git removal. The resource has
no automatic unlock or retry-after-uncertain path. An exclusive claim rejected
before creation is `preserved` only if inspection confirms no claim, no marker
change and no destructive Git invocation. A definitive pre-removal
`preserved` outcome still permits a new explicit command after its cause is fixed.
Discovery does not promise eligibility, and every release rechecks it.

The #822 sidebar owns the explicit confirmation, retained-worktree list and
response-loss interaction. The #821 runtime/Host candidate itself adds no model
tool, setup preference, automatic cleanup or dependency installation.
