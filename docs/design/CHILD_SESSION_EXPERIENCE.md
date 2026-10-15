# Child session experience

- Status: validated (source and component tests only; live TUI acceptance pending)
- Created: 2026-10-04
- Verified: 2026-10-04
- Source boundary: OpenPI #658 implementation based on main b0096cce; Pi public package exports at 0.99.1
- Related issue: https://github.com/openpi-dev/openpi/issues/658
- Related pull request: none yet
- Supersedes: none; supplements CHILD_TOOL_ACTIVITY.md

## Opening and following

The shared `AgentSessionPage` opens a running child at its latest output and
follows appended rows. Upward navigation or wheel scrolling pauses following
and preserves the absolute row position. Downward scrolling to the bottom,
End, or G resumes following. The running-page separator says `following` or
`paused` and shows hidden row counts when space permits.

Settled, failed, and uncertain history deliberately retains the previous
opening policy: overflowing history opens at the beginning so the original
question and first answer are visible. This includes cancelled children whose
adapter projects error or done. The opening choice is made only once; a child
settling while being watched does not reset the operator's reading position.
Empty and short histories retain the existing follow behavior. Missing tracked
children retain the existing unavailable page.

## Public rendering seams and evidence

Pi 0.99.1 publicly exports UserMessageComponent, AssistantMessageComponent,
ToolExecutionComponent, Markdown themes, and ScrollView. The child body already
uses the first three through the shared renderer and ephemeral tool ledger.
There is no public complete conversation-view export; no internal imports or
copied interactive chat implementation are introduced here.

The existing TranscriptViewport implements the required follow contract for
these fixed-height pages in both regular and fullscreen mode. ScrollView is a
public layout node whose host layout owns viewport measurement and mouse
routing. Migrating this already shared fixed-height overlay solely to use that
class would broaden the layout change without recovering missing evidence.

When a native tool ledger exists, the host tool expansion binding and inherited
opening state still control the original native renderer. Legacy/history
previews without a ledger now respond to the same expansion binding: they
show sanitized arguments and output previews, explicitly labelled `Bounded
tool preview · native details unavailable`. Missing previews say unavailable;
empty available output remains empty. Expansion limits each preview to 4096
Unicode code points and 24 source lines, labelling any additional omission.
This is an additional display bound, not a claim that retained previews are
complete. No diff, result detail, exit code, or execution authority is inferred
from preview text. The existing owner-provided artifact metadata remains the
way to locate original evidence; this page adds no file reads or registry.

## Remaining differences and acceptance boundary

Direct and Workflow retain owner-specific identity, status, artifact metadata,
and controls around one shared body. Child history cannot recover native
arguments, tool definitions, structured results, images, or runtime state that
its adapter did not retain. Thinking uses the public native assistant
component's visible-thinking projection; the public extension UI does not
expose a getter for the parent's thinking visibility. Tool expansion is local
and does not change the parent state. Read-only Workflow history gains no
input, steering, cancellation, or execution capability.

Component tests cover long running opening, incremental output, manual pause,
End/G recovery, settlement without repositioning, history opening, regular
mouse capture and fullscreen dispatch, native tool expansion, honest legacy
expansion, theme invalidation, Markdown, code, CJK, narrow widths, and terminal
control safety. Shared-renderer equality proves component parity, not complete
adapter or installed TUI acceptance.

The installed Pi reports one OpenPI source,
`/Users/tushaokun/work/openpi-main-runtime`, different from the implementation
worktree. No package source or settings were changed. Actual Direct and
Workflow smoke in regular/fullscreen modes, including terminal image behavior
tracked by #657, remains pending against the loaded implementation revision.
