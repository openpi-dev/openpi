# Sessions picker: focus follows the visible panes

- Status: validated at the source and component-test boundary
- Created / verified: 2026-09-23
- Source baseline: `43cd2e94cc584f81cc1f27512ae99c9a4099b231` (OpenPI 0.8.1, Pi 0.85.1)
- Fix boundary: the `extensions/sessions/index.ts` change and `tests/extensions/sessions/picker.spec.ts` in the linked PR
- Issue: [#608](https://github.com/openpi-dev/openpi/issues/608)
- Supersedes: none

## Verified facts

`getSessionPaneLayout` selects a single list pane below 80 columns. The picker
previously changed focus to `preview` on Tab or Right regardless of layout.
Ordinary input was then handled by neither the split-preview branch nor the
list branch. Search, selection, Enter, and Escape stopped working until focus
was returned with Left or Tab. Shrinking a terminal with the preview focused
produced the same state.

Six regressions failed on the baseline and passed with the fix. They exercise
the registered `/sessions` command and native Pi SelectList/keybindings with a
test UI host and synthetic Session metadata. Each of Tab, Right, and a resize
from a focused preview is checked for search/navigation/open and cancellation.

## Change and ownership

The existing picker now restores list focus when rendering a single pane and
before dispatching input in that layout. The second check covers input that
arrives after a resize but before repaint. Tab and Right can move focus into
the preview only when the split layout is available.

This is a local input-dispatch invariant in Pi's custom component seam. It
adds no model-facing tool, configuration, orchestration, or Session storage.
Pi's existing selection callbacks still own opening and cancelling the picker.

## Validation and limitations

- The component suite has 11 passing cases, including wide-preview tool/thinking
  toggles, Enter/Escape, narrow `t`/`h` filtering, input before repaint after a
  shrink, and shrinking then widening without intervening input.
- `bun run check` passed on Windows with Node 24.20.0 and Bun 1.3.14.
- Full-suite validation is recorded in the PR; component tests do not establish
  the status of unrelated runtime and process tests.
- In an isolated Pi agent directory, `pi list` reported exactly one OpenPI
  source: the current checkout at `E:\CODE\openpi`. No model call was made.
- Manual visual acceptance in a real interactive terminal was not performed.
  The automated host does not prove terminal emulator rendering or resize-event
  delivery. This record is not a benchmark or a new architectural Decision.
