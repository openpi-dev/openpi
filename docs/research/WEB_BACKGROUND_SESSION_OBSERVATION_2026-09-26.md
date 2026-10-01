# Web 后台会话的观察身份

- Status: validated（本地源码与测试；CI 待 PR 更新）
- Created: 2026-09-26
- Verified: 2026-09-26
- Source boundary: OpenPI PR #598 at `6e78546` plus this change; Pi SDK 0.85.1; Pi Web reference `a345b2a`; Maka reference `c0229b0c6`; public Codex TUI and Claude Desktop documentation reviewed on this date
- Issue: [#597](https://github.com/openpi-dev/openpi/issues/597)
- PR: [#598](https://github.com/openpi-dev/openpi/pull/598)
- Supersedes: none; supplements [Web reading and lifecycle](WEB_READING_AND_LIFECYCLE_2026-09-22.md)

## Source facts

- Pi Web keeps activity and status keyed by Session even when it is not selected; its main chat only projects the selected Session. See local reference `src/client/src/controllers/sessionController.ts` and `PiWebApp.ts` at `a345b2a`. Its navigation combines running and unread without replacing one with the other.
- Maka's Session rail receives per-Session streaming and status facts, independent of the transcript. Its WorkHub explicitly treats ordinary Sessions as a read-only status/routing projection. See local reference `packages/ui/src/session-history-list.tsx` and `apps/desktop/src/renderer/workhub-surface.tsx` at `c0229b0c`. This does not establish that every Maka secondary panel is read-only.
- [Claude Desktop documentation](https://code.claude.com/docs/en/desktop#watch-background-tasks) distinguishes tasks of the current Session from other Sessions visible in the sidebar. The [public Codex TUI composer](https://github.com/openai/codex/blob/main/codex-rs/tui/src/bottom_pane/chat_composer.rs) keeps local navigation available while direct input may be blocked. These sources do not prove Codex Desktop's exact visual layout.

## OpenPI inference and design

When A continues executing and a user reads B, the navigation row is a compact, persistent observation point, not an input authority transfer. A known Pi runtime projects `running` and native follow-up count only for its exact `(id, path)`; an unloaded or mismatched Session stays neutral. The selected transcript retains its own running line and bounded live tool evidence. The sidebar does not copy queue text or tool output, and only the controlling Pi Session exposes send/stop controls.

Five related issues share that identity boundary: Files could append A's live edits to B; Trajectory used A's running flag; hidden Git review deferred B's refresh when A ran; a running B's activity was absent from navigation; the selected background view had no concise live-tool count outside its transcript details. The fix scopes Files, Trajectory and Review to the selected execution, projects small sidebar status/queue facts, and extends the existing transcript running line instead of adding a second status surface.

This is UI and wire projection only. It adds no parallel Session store, runtime command, control permission, model-visible context or persisted queue. The sidebar's visible count caps at `99+`; its accessible label retains the exact count. Native Pi remains the source of truth for the queued messages and the runtime state.

## Validation and limits

At the source boundary above, `bun run check` and `bun run test` pass (Node 1954 passed, 5 skipped; Vitest 504 passed). The production-build Chromium suite passes 67/67. Its real Pi SDK/faux-provider scenario confirms A running with two queued follow-ups while B runs, exact sidebar identity during controller switches, mobile drawer geometry at 390px, and A settling without stopping B. React regressions cover B's Files/Trajectory/Review while A remains active. New PR CI is pending; these deterministic fixtures are not real-model reliability evidence.

Ablation removed a duplicated composer running banner and sidebar animation: the existing transcript line plus static icon still convey the selected and navigational states. Unknown Sessions deliberately remain unlabelled; this design does not claim cross-device unread counts or control of an unselected background Session.
