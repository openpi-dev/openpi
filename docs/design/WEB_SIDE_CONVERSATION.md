# Web side conversation appearance

- Status: `validated`
- Created: 2026-10-09
- Last verified: 2026-10-09; complete repository gates, two Chrome regressions and local theme/layout/focus checks; no release or new provider acceptance claimed
- Source boundary: OpenPI `978a1c431bd99e7ab36f7ab422a0fb71b93fffda`, combining the side-conversation implementation `87959c5d` and existing PR work through `bc354538`
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

`bun run check` and the complete `bun run test` passed on the combined source: 2,324 Node tests passed with 9 platform skips, and all 1,181 UI tests passed across 83 files. The two Chrome regressions passed: the existing native action-fixture lifecycle covers create, follow-up and stop while the parent runs; the new regression verifies one visible editor at 783px and 320px, focus without a rectangular inner outline, retained independent drafts, browser-tool switching, return-to-chat focus and restored wide panes. These fixture-based checks do not claim a new live model execution.

The local 30142 preview was restarted at the named combined revision after confirming `pi list` contains one OpenPI source pointing to that checkout. Actual UI inspection covers light/dark states, 320px and 1440px layouts, disabled and ready send controls, Shift+Enter, keyboard button focus and long drafts. A 20-line draft grows to the 180px editor bound and scrolls inside it; at 320px the document remains 320px wide, the composer is 280px wide and its send control stays contained. The temporary appearance setting and viewport override were restored and inspection drafts cleared.

An earlier pre-integration full run hit the existing browser page-bound test's 5-second timeout. The final combined full run passed without a timeout adjustment. Raw screenshots, startup receipts and command logs remain outside Git in the local `side-conversation-20261009` archive. Exhaustive themes, engines without CSS content sizing, new provider acceptance and numerical reference-image fidelity remain outside this validation.

## Ablation

Removed an initial fixed-height override for the history introduction. The centered empty state needs only its zero minimum height and flex placement, so the history-specific override did not contribute to the requested appearance. No wrapper around the existing composer or shared chat component is needed: scoped styles keep the side editor independent of main-composer DOM ownership.

Removed the editor's own focus outline after browser inspection exposed the global rectangular outline inside the rounded surface. The outer composer focus boundary and individual button keyboard outlines remain. The focused layout needs no repeated main-chat caption or second composer; hiding the mounted main surface preserves draft ownership while leaving one visible editor.
