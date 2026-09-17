# Cleanup confirmation is not Bash execution

- Status: validated at the source and local TUI boundaries described below.
- Created and verified: 2026-09-17.
- Source boundary: OpenPI main `f6b49ae59605b1276b8267f2886d22c03f01533c`, Pi 0.85.1, with a single local OpenPI source reported by `pi list`.
- Related Issue: [#544](https://github.com/openpi-dev/openpi/issues/544).
- Supersedes: none.

## Observation

Pi emits `tool_execution_start` before it awaits the extension `tool_call` hooks. The interactive TUI marks the tool component as started at that event. OpenPI's workspace cleanup guard can then pause in `ctx.ui.confirm` before the Bash tool's `execute` function runs. On the baseline, the compact activity renderer interpreted `executionStarted` as active Bash execution and repeatedly displayed `Running rm keep.txt` with elapsed time behind the confirmation dialog.

A controlled local Provider issued a direct `rm keep.txt` for a pre-existing fixture. While confirmation was unanswered, the file was still present. Declining preserved it; approving allowed deletion. This is an operator-facing phase error, not evidence that the guarded command executed before approval.

## Repair and evidence

The guard announces only the confirmation phase through Pi's extension EventBus, keyed by Session and tool-call identity. The TUI display extension projects that phase as `Awaiting approval` without an execution spinner or timer, pauses its timer during confirmation, and resumes the ordinary running display after approval. A refusal or cancellation stays in the waiting projection until Pi reports the blocked result. The guard's allow/block decision, confirmation UI, and default selection are unchanged. Headless sessions keep Pi's native tools and do not install this display projection.

Focused tests cover the event boundary, Session isolation, waiting display and timer, approval, refusal, and ordinary activity rendering. A local Pi TUI/PTY smoke with the same fixture held the prompt for several seconds: it emitted one `Awaiting approval` row and no `Running rm keep.txt` row during that wait; Esc preserved the file. A separate approval run resumed the running row and deleted the file. Removing the event-driven invalidation as an ablation brought repeated `Running` rows back during confirmation, so the invalidation remains necessary. `bun run check` passed. The full test result and PR revision are linked from Issue #544.

## Limits

This validation is on a controlled local Provider, macOS terminal capture, and Pi 0.85.1. It is not a benchmark or proof of behavior in the original reporter's Linux terminal. The separately reported white `read/grep` tool blocks have not been reproduced with OpenPI's renderer on current main; this change does not attempt to fix or explain those blocks. No model-facing tool schema, persisted Session data, or package configuration changes are involved.
