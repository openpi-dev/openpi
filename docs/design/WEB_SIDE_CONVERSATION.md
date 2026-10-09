# Web side conversation appearance

- Status: `draft`
- Created: 2026-10-09
- Last verified: 2026-10-09; initial source and local appearance inspection; repository and lifecycle checks pending
- Source boundary: OpenPI `bd66a9e27bf496b66fe568f5985e33c422811940` plus the WorkbarPanel/workbar stylesheet iteration on `codex/settings-resources`
- Related Issue: [#730](https://github.com/openpi-dev/openpi/issues/730)
- Related PR: [#711](https://github.com/openpi-dev/openpi/pull/711)
- Supersedes: none

## Accepted direction

The user requested a simple, Apple-like side-chat appearance closer to the supplied Codex screenshot. The empty state is centered in the available content area with a speech-bubble-plus icon, a readable heading and one muted description. The composer has inset margins, a single rounded surface, a borderless editor and an integrated circular arrow control. Existing workbar tabs and panel hierarchy remain intact.

The scope is presentation within the existing Pi side-conversation panel. This is not a new project-wide design system. The reference's temporary-chat lifecycle and extra composer features are not copied: the existing Pi-owned session lifecycle and available actions determine this panel's behavior.

## Ownership and implementation

SideConversationPanel still uses the native `spawn-btw`, `send-btw` and `cancel-btw` actions. Session identity checks, navigation epochs, action locks, per-conversation drafts, abort cleanup and transcript ownership remain unchanged. The round submit button retains its localized accessible name and tooltip; the running conversation's stop action retains its visible label. Enter, modifier keys and composition guards retain their existing handling.

Existing theme tokens supply colors and focus boundaries. The editor uses native CSS content sizing with a bounded height; engines without that property retain a scrollable textarea. There is no new component, preference, provider call, model selector, attachment action or persistence layer.

## Validation boundary

Repository gates, the existing side-conversation lifecycle regression, keyboard focus, long drafts, theme appearances and narrow layouts are pending. Validation will identify its local source and test boundary rather than claiming release or provider acceptance. Raw screenshots and logs stay outside Git in the local `side-conversation-20261009` evidence archive.

## Ablation

Removed an initial fixed-height override for the history introduction. The centered empty state needs only its zero minimum height and flex placement, so the history-specific override did not contribute to the requested appearance. No wrapper around the existing composer or shared chat component is needed: scoped styles keep the side editor independent of main-composer DOM ownership.
