# Codex-style Web execution activity

- Status: validated at the source comparison, synthetic component preview, and local installed-asset boundaries. This is not an accepted architecture Decision or a fidelity Benchmark.
- Created / verified: 2026-10-08.
- Tracking: [#597](https://github.com/openpi-dev/openpi/issues/597).
- OpenPI source: main `3cb2ecfe1bfbb98252651885311d309f83749428`; UI implementation `ce87d2666ee2779d472bb58ed64186a16b4cadd2`.
- Supersedes: none. Earlier Web display-setting records retain their historical observations; this revision changes only the current outer-disclosure behavior documented in README and SETUP.

## Verified references

The user requested open-source Codex references first, then a DSH comparison. The last two supplied light screenshots depict Codex; the earlier dark execution cards depict OpenPI.

| Reference | Frozen source | Useful implementation | Boundary |
| --- | --- | --- | --- |
| [CodexMonitor](https://github.com/Dimillian/CodexMonitor) | `dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5`, MIT | `MessageRows.tsx`, `Messages.tsx`, `messages.css`: neutral outline icons, lightweight tool rows, grouped activity, optional details | Its tool groups initially expand; that default does not meet this request. It is a distinct client, not the official renderer. |
| [LuSeptem/codex-webui](https://github.com/LuSeptem/codex-webui) | `421f18acdf6928da6e35611d9d1f53443fcb0c34`, MIT | `ResponseBlockCard.tsx`, `EventTimeline.tsx`, `ProcessGroupCard.tsx`: running-open / completed-collapsed process blocks, visible final response, Markdown reasoning | Its heavier nested cards are not the desired final styling. |
| [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | `ddefc45fbc7f8e46dd73185e68295696d1297887` | `ReasoningRow.tsx`, `TurnProcessNodeView.tsx`, `ToolRow.tsx`: collapsed details, normal reasoning typography, lightweight file links | Consulted after the Codex references; no source or assets copied into OpenPI. |

`Yrd980/codex-web-ui-clone` is a visual prototype with mocked data and no detected license. Renderer-extraction/patching projects such as `friuns2/codex-mobile` and asset-derived projects such as `lezi-fun/codex-webui` do not establish an independently reusable official frontend. They were not installed or used as asset sources. No measured 97% fidelity result was found or produced.

## Implementation and ownership

Pi continues to own tool identities, arguments/results, Session history, timing and terminal receipts, configuration, and file access. The change is an operator projection at the existing Transcript and ToolEvidence seams.

Completed outer process disclosures now collapse independently of inner thinking / full-tool preferences. Running disclosures open, an explicit user toggle remains usable, and a settled native run closes the outer disclosure. Timing-backed turns retain the existing single timing owner; untimed history retains the existing consecutive-process grouping. Final responses and human answers stay outside process disclosure ownership.

The shared presentation table maps known tool names to existing Lucide outline icons and localized action text: book/read, pencil/write-edit, terminal/commands, search, directory, web, tasks, goals, Git, plans, and agent/workflow activity. Unknown tools keep their exact names and an inspectable fallback. This table does not route tools, parse shell intent, or determine execution state. Returned, failed, stopped, timed-out, and unconfirmed states still come from existing evidence projections; task/goal/agent/workflow tool returns do not claim their underlying work completed.

File names can invoke the existing artifact preview without opening the surrounding disclosure. Read/write/edit retain green labels; failures retain their evidence color. Shell details combine the command and bounded output in one panel with native copy feedback. Diff, line numbers, truncation/recovery instructions, and original arguments/results remain accessible. Thinking uses the existing sanitized Markdown component, mounted when its own disclosure is open. No new preference, dependency, model call, controller, permission, or storage plane was added.

## Validation, ablation, and limits

- `bun run check` passed configuration/docs/discipline contracts, Web and root types, production build, formatting, and lint. The pre-existing large-chunk build warning remains. Initial type/lint failures were repaired before the passing gate.
- Automated test suites were not run, per the user's instruction. Existing assertions were adjusted for independent outer collapse, lazy reasoning markup, and compact Chinese duration units; those assertions are not claimed as executed.
- A temporary page mounted the actual Transcript and ToolEvidence with synthetic snapshots, without a model/provider call. Manual observations covered timed and untimed completed collapse, independence from full-detail preferences, running-to-settled collapse, Markdown reasoning, direct file-name preview without row expansion, Shell expansion and copy feedback, and light/dark tool rows. Native tool execution, all provider-specific tools, every cancellation/timeout path, and complete application parity were not manually exercised.
- Ablation removed the outer preference propagation, previous-state ref, redundant animated grid wrapper, duplicate icon wrapper and family branching, directory-prefix clutter, and decorative process/agent frames. The scoped manual observations still met the requested behavior. The one shared presentation table was retained to keep ordinary, unpaired, and grouped tool projections consistent.
- The 57161 deployment was idle before restart. After restart, page and authenticated snapshot returned HTTP 200, eight Sessions remained available, and the served `app.js` matched the checked build: SHA-256 `2bf1f931e3bdba7156820fcf8aa61327de96ed7147dc8e6f734136739a2a22cc`. `pi list` showed exactly one OpenPI source, the existing resident `web-runtime` checkout. Previous source and built assets are retained for recovery.

Local evidence identity: `~/.local/state/openpi-web/evidence/execution-ui-20261008/` contains the synthetic preview source, light/dark and completed-collapse JPEGs, deployment receipt, and previous built assets. The passing gate log is `~/.local/state/openpi-web/logs/execution-ui-20261008-check-complete.log`; earlier failed gate logs are retained separately. Private Session data, credentials, and raw user configuration were not added to the repository.

## Follow-up: collapsed and expanded activity details

Verified on 2026-10-08 at implementation `bb7ef0272b4c5625074daa36c4d33aff891a34d9`, based on the same upstream main `3cb2ecfe1bfbb98252651885311d309f83749428`. The follow-up screenshot batch contains five Codex examples and an OpenPI component-preview example. The user accepted the current outline icons and hierarchy line, and requested further interaction polish.

The supplied [bug-superman/claude-code repository](https://github.com/bug-superman/claude-code/tree/0753dafcccf433abc40a3de6abaa24ddce7d86f3) was inspected at `0753dafcccf433abc40a3de6abaa24ddce7d86f3`. Its package identifies itself as `claude-code-best`. The relevant Web source is `packages/remote-control-server/web/components/chat/ToolCallGroup.tsx` and `components/ai-elements/{reasoning,tool}.tsx`; `packages/builtin-tools/src/tools/FileEditTool/UI.tsx` is an Ink terminal renderer. Source observations: compact one-line tool titles, collapsed raw input/output, explicit execution/error/confirmation states, and an optional delayed reasoning auto-close. The Web group remains a bordered card. No root license was detected, and this inspection does not establish official renderer provenance. No source, assets, title-based tool classifier, local timing estimator, or auto-close timer was copied. The useful interaction ideas fit OpenPI's existing native evidence and disclosure seams.

Changes in this follow-up:

- Command rows show their bounded command on one line with CSS ellipsis and a full bounded tooltip; the expanded Shell panel retains the command and output. Background tool IDs and generic query/URL targets remain visible when available.
- Edit rows show `+added −removed` counts from the displayed successful-result diff, excluding unified diff file headers. Truncated evidence carries a visible partial label. These are displayed-diff counts, not a whole-file or whole-turn change claim. Missing diffs do not produce invented counts.
- Untimed group titles show up to three action types, followed by the total number of types. Complete category names and native activity counts remain in the tooltip/accessibility label. Active groups retain their latest available requested target; completed groups omit the secondary preview.
- Activity and tool arrows point right when closed and down when open. Active text is clearer; a failed/stopped/timed-out action keeps its localized evidence label without a duplicate status column. Status icon accessibility labels are localized.
- The requested running-open / settled-collapsed default remains independent of inner detail settings. No new preference was needed. Per-command duration is not fabricated: the current tool-result protocol does not provide a dedicated execution duration receipt.

`bun run check` passed again, including the production build, Web/root types, contracts, formatting and lint; the existing large-chunk warning remains. Automated suites were not run. Manual component observations covered native-format `+2 −3` edit counts, a long command with `scrollWidth > clientWidth` and ellipsis, keyboard Shell expansion, keyboard file preview without row expansion, running auto-open, preservation of a manual close while inner settings change, settled collapse with full inner settings, compact historical group labels, and light/dark rendering. These synthetic observations do not claim native tool execution or complete Codex/Claude parity.

Ablation removed the unused `summaryMeta` prop and visible redundant group-count strip, retaining counts in the existing tooltip/accessibility projection. The scoped component observations still met the request. No additional framework, controller, duration store, or disclosure owner was introduced.

The resident 57161 checkout was idle before restart. After deployment, page and authenticated snapshot returned HTTP 200, eight Sessions remained available, and the served `app.js` matched the checked build: SHA-256 `be7717f76deef45b3bf7d231430bb75b9689e0f24c67f7c3d46184fd236d786d`. `pi list` again reported exactly one OpenPI source, the resident checkout. Previous build and source are retained for recovery. Follow-up evidence is under the stable local identity `execution-ui-20261008/polish-claude/`; its receipt names the installed implementation, and its synthetic preview source/JPEGs are separate from private Session data. The passing gate log is `execution-ui-20261008-polish-check.log`.
