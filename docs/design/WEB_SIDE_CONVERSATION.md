# Web side conversation appearance

- Status: `validated`
- Created: 2026-10-09
- Last verified: 2026-10-09; complete repository gates, two Chrome regressions and local theme/layout/focus checks; no release or new provider acceptance claimed
- Source boundary: OpenPI `7282f681d51e9b4904b10b94c615022355a247b1`, combining the side-conversation implementation `87959c5d` and existing PR work through `b976ed23`
- Related Issue: [#730](https://github.com/openpi-dev/openpi/issues/730)
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Accepted direction

The user requested a simple, Apple-like side-chat appearance closer to the supplied Codex screenshot. The empty state is centered in the available content area with a speech-bubble-plus icon, a readable heading and one muted description. The composer has inset margins, a single rounded surface, a borderless editor and an integrated circular arrow control. Existing workbar tabs and panel hierarchy remain intact.

The scope is presentation within the existing Pi side-conversation panel. This is not a new project-wide design system. The reference's temporary-chat lifecycle and extra composer features are not copied: the existing Pi-owned session lifecycle and available actions determine this panel's behavior.

## Ownership and implementation

SideConversationPanel still uses the native `spawn-btw`, `send-btw` and `cancel-btw` actions. Session identity checks, navigation epochs, action locks, per-conversation drafts, abort cleanup and transcript ownership remain unchanged. The round submit button retains its localized accessible name and tooltip; the running conversation's stop action retains its visible label. Enter, modifier keys and composition guards retain their existing handling.

Existing theme tokens supply colors and focus boundaries. The editor uses native CSS content sizing with a bounded height; engines without that property retain a scrollable textarea. There is no new component, preference, provider call, model selector, attachment action or persistence layer.

When the workbar occupies the content area at a narrow width or the main conversation is collapsed, an active side editor takes the available page height and the main conversation surface is hidden. It remains mounted, retaining its draft. Returning to chat restores that surface and its input focus. Switching to a tool without its own editor restores the compact main composer. Wide side-by-side panes retain their separate editors. Scoped CSS follows the existing active panel's rendered editor rather than adding a second active-tool state.

## Validation boundary

`bun run check` and the complete `bun run test` passed on the first combined source `978a1c43`: 2,324 Node tests passed with 9 platform skips, and all 1,181 UI tests passed across 83 files. The two Chrome regressions passed: the existing native action-fixture lifecycle covers create, follow-up and stop while the parent runs; the new regression verifies one visible editor at 783px and 320px, focus without a rectangular inner outline, retained independent drafts, browser-tool switching, return-to-chat focus and restored wide panes. These fixture-based checks do not claim a new live model execution.

Delivery integration `7282f681` also incorporates the latest accepted chronological-activity, manual-reading and typography work through `b976ed23`. The side-conversation source, scoped stylesheet and browser regression remain unchanged from the first combined source. The complete gates passed again: 2,324 Node passes with 9 platform skips and 1,196 UI passes across 83 files; both Chrome side-conversation regressions also passed again. The preview was restarted at this delivery revision, its unique package source verified and its restored dark view confirmed to have one visible editor and an empty draft at 320px.

The local 30142 preview was restarted at the named combined revision after confirming `pi list` contains one OpenPI source pointing to that checkout. Actual UI inspection covers light/dark states, 320px and 1440px layouts, disabled and ready send controls, Shift+Enter, keyboard button focus and long drafts. A 20-line draft grows to the 180px editor bound and scrolls inside it; at 320px the document remains 320px wide, the composer is 280px wide and its send control stays contained. The temporary appearance setting and viewport override were restored and inspection drafts cleared.

An earlier pre-integration full run hit the existing browser page-bound test's 5-second timeout. The final combined full run passed without a timeout adjustment. Raw screenshots, startup receipts and command logs remain outside Git in the local `side-conversation-20261009` archive. Exhaustive themes, engines without CSS content sizing, new provider acceptance and numerical reference-image fidelity remain outside this validation.

## Ablation

Removed an initial fixed-height override for the history introduction. The centered empty state needs only its zero minimum height and flex placement, so the history-specific override did not contribute to the requested appearance. No wrapper around the existing composer or shared chat component is needed: scoped styles keep the side editor independent of main-composer DOM ownership.

Removed the editor's own focus outline after browser inspection exposed the global rectangular outline inside the rounded surface. The outer composer focus boundary and individual button keyboard outlines remain. The focused layout needs no repeated main-chat caption or second composer; hiding the mounted main surface preserves draft ownership while leaving one visible editor.

## Follow-up: match the main composer

On 2026-10-10 the user requested that the side composer match the main composer exactly. Implementation `c2a2a323`, integrated into `5ed9fb8b7a8a38e9e837c3c17d1de912a486a916`, replaces the earlier independent appearance with the shared composer classes, spacing, textarea sizing, focus boundary, workspace row, circular send/stop control and existing model selector. This follow-up supersedes only the earlier statement that this panel has no model selector or attachment action; the historical validation above still describes its named revision.

The plus action reuses the existing native file-reference dialog. Before a side Session exists, its model selector uses the parent projection; after creation, it uses the verified child detail. Pi still owns the child model, thinking level, creation, follow-up and cancellation. The main mounted draft remains independent. Narrow layouts keep one visible editor; wide layouts retain one editor per visible conversation.

The two Chrome regressions passed again at `5ed9fb8b`: matching composer geometry and styles, 320px/783px visibility, retained drafts and focus, and the existing native side-conversation action-fixture lifecycle. The shared editor bound is now 220px. Removing the side editor's focus-outline exception reproduced a rectangular inner outline and failed the focused browser check, so that scoped exception was restored. A custom model-button/popover implementation and approximately 90 lines of duplicated composer styling were removed in favor of the existing selector and styles.
