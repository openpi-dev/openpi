# Web 输入区的排队消息

- Status: validated（本地源码、构建与单元测试；未重新运行浏览器 E2E）
- Created: 2026-09-26
- Verified: 2026-09-26
- Source boundary: OpenPI PR #598 at `7a71f14` plus this change; Pi SDK 0.85.1; locally installed Codex Desktop 26.917.62051, `queued-message-list-a1d88c8d4e1f.js`
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none; supplements [Web reading and lifecycle](WEB_READING_AND_LIFECYCLE_2026-09-22.md)

## Source facts

- The installed Codex Desktop bundle renders queued items in a composer item. Each row has an icon and a one-line clamped message preview; the list scrolls within `30dvh`. It has per-message IDs for editing, deleting, sending now, and reordering. This is read-only inspection of a bundled implementation, not a screenshot or a public API guarantee. The [public Codex TUI queue preview](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/pending_input_preview.rs) is a different interface and cannot establish Desktop pixel styling.
- Pi SDK 0.85.1 provides `getFollowUpMessages()`, `getSteeringMessages()`, `followUp()`, `steer()`, and whole-queue `clearQueue()`. Its exposed text arrays have no per-item IDs or per-item mutation. Clearing and rebuilding during a running turn cannot guarantee retraction; non-text queued content would also be lost.
- OpenPI bounds each queued text to 12,000 characters in its read-only execution projection. Its authenticated `/api/prompt` entry point also rejects submitted text longer than 12,000 characters. Native template expansion or external queue sources may exceed the projection limit, but an admitted Web optimistic input cannot exceed that limit.

## OpenPI inference and design

The queue belongs inside the composer, with each pending follow-up shown as one icon-plus-preview row and the whole list height bounded. There is no independent numbered card or visible count heading; the region's accessible name retains the exact count. A row expands the available projected text on click or keyboard activation, including on touch screens. Expansion is local UI state scoped by the selected Session identity and message occurrence, not a writable queue ID. A projection ending in `[truncated]` remains a preview, not a claim that the entire native message was recovered.

The existing transcript matching remains unchanged: it suppresses only admitted optimistic occurrences with exactly matching native queued text. Unadmitted drafts and excess identical occurrences remain visible. No edit, delete, reorder, or queue recovery control is offered: Pi lacks the native operations needed to implement those safely. Steering remains outside this follow-up projection and is a separate future design question.

## Validation and limits

At the stated OpenPI boundary, `bun run check` passes and `bun run test` passes (Node 1954 passed, 5 skipped; Vitest 504 passed). The React regression checks composer containment, unnumbered rows, long-preview accessible expansion, and queue disappearance. The existing mobile browser assertion was updated to match the new containment, but the browser E2E suite was not rerun during this iteration at the user's request. Exact Desktop visual parity and live-model behavior remain unverified.

Ablation removes the previous outer card and count header while preserving a navigable, counted region. Removing the per-row expansion would leave clipped text inaccessible to touch and keyboard users. A candidate bounded-text matcher and digest protocol were discarded after verifying the input length gate: the hypothesized oversized admitted Web input is not a supported path, and lossy text matching would conceal uncertainty. The small occurrence counter remains necessary to give duplicate native text rows stable, distinct React keys without pretending they have writable IDs.
