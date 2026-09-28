# Web interaction UI

- Status: draft — follow-up implementation under review, not an accepted architectural Decision
- Created / verified: 2026-09-20 / 2026-09-28
- Source boundary: current main `4cda5494f0ea4f0b2fa032f5096ed0389d43ecce`, plus the #470 implementation
- Issue: https://github.com/openpi-dev/openpi/issues/562
- PR: https://github.com/openpi-dev/openpi/pull/595
- Follow-up issue: https://github.com/openpi-dev/openpi/issues/470
- Follow-up PR: pending
- Related: #348 (Setup), #470 (implementation handoff), #549 (controller identity), #540 (Stop), #561 (Web UI)
- Supersedes: none; complements [Web structured questions](WEB_STRUCTURED_QUESTIONS.md)

## Scope

Expose existing Pi tools and extension commands in Web: structured questions,
human handoff, completed plan cards, Plan control and Plan Ready handoff, and
command feedback. Theme controls and direct preference writes are excluded.
Configuration continues through `/openpi-setup`; this change does not alter
that contract.

## Plan ownership and presentation

POST `/api/plan` uses the Host's existing authentication and mutation drain.
The serialized runtime controller validates the selected Session, idle and
unqueued state, and availability of the owned Plan command. A Session-scoped
callback in the Plan extension compares the latest persisted Plan entry ID,
then uses its existing persistence, tool gate and broadcast function. Stale
revisions fail closed. Ready or invalid state requires an explicit exit.
Registration is removed on shutdown and refreshed on branch restoration.

Changing mode sends no prompt, creates no model turn and preserves the draft.
The extension projects its current read-only/ready stance at
`before_agent_start`, including after Session restoration. Permission enforcement
remains in runtime tool gates. The placeholder appears after a real user message
in the current planning episode and is derived from branch entries, not a
second persisted mode flag. `/plan <objective>` retains its immediate-start path.

The plan card displays a successful `plan_ready` result, not streamed arguments.
It does not imply implementation approval. Ready state remains read-only until
an explicit owner action. The #470 follow-up adds an authenticated
`POST /api/plan/implement`: the serialized runtime checks the exact active
Session id and path, idle state, and Plan extension availability; the extension
checks the persisted revision and `ready` state, persists `inactive`, and
returns its existing implementation prompt. The Composer asks before replacing
a nonempty draft, then makes the prompt editable without sending it. The visible
exit action remains available while the plan is ready. Starting a fresh
implementation Session still requires the TUI. The persisted `plan_ready`
transcript result remains available after the gate is released.

The handoff uses the existing Plan projection and owner callback; it adds no
second Plan store or approval state. A stale revision, wrong Session, busy
runtime, unsupported extension, or failed persistence leaves the Plan gate
closed. Refreshing or switching Sessions before the explicit handoff leaves the
persisted ready plan intact. After handoff, the editable prompt follows the
Composer's existing draft lifecycle.

## Native commands and model-visible context

Registered command identities and owning source paths determine the reviewed
Web menu entries. Unknown extensions remain unadapted; manually submitted input
still reaches Pi with an operator warning. No second command dispatcher exists.

Command input and Plan/Cron/Usage feedback are bounded custom Session entries
used for operator display, not additional model messages. The input records
submission, not success. Native command errors are visible. Usage reuses the
existing provider adapters; Cron output is a historical command result, not a
second scheduler or live task store.

Setup instructions now require explaining invalid values in the user's language
and obtaining an explicit legal alternative before writing. Footer presets and
footer style enum values are distinguished. This guides model interpretation;
the typed writer retains actual input validation. Prompts cannot prove that a
model-selected legal substitute was authorized by the user.

## Human handoff

The existing parent-only `human_handoff` shares the controller-bound question
transport. Done and Unable require explicit review and submission; notes retain
the 8,000-byte limit. Free-form input cannot manufacture completion. Abort,
expiry and missing UI never imply completion. Done remains a user report; the
model must verify the completion signal with available tools.

## Streaming and cancellation corrections

Transcript reconciliation uses native timestamps/tool-call identity and original
part order. Hidden custom entries occupy no blank rows. Uncollapsed tool rows
retain independent keys so regrouping does not discard answer DOM or expanded
state. Collapsed groups retain their existing four-row threshold.

A provider burst regression reproduces disappearing unfinished messages:
`response.write(false)` was treated as a broken SSE connection even though it
only indicates buffered backpressure. Reconnection restored a persisted-only
snapshot, losing unfinished assistant content. Live records and heartbeats now
tolerate native buffering while bounding outstanding bytes plus the next record
at 256 KiB. A separate regression verifies disconnection above that budget.
Genuine disconnect recovery can still temporarily drop unfinished projections.

Stopping a pending question can return its cancelled result before Pi attempts
another model step. Pi's lazy auth setup classified an already-aborted signal as
an ordinary error. Web checks the original signal before delegating to the
existing stream function so Agent's native run lifecycle emits `aborted`.
No dependency file, error-text classifier or provider replacement is introduced.
The guard covers already-aborted steps, not every cancellation timing during auth.

## Validation and limits

Separate tests cover owner state and read-only enforcement, authenticated Host
operations, question ownership/replay/expiry, UI drafts and recovery, native
persisted cancellation evidence and deterministic provider/browser flows.
Question cancellation asserts the receipt and a subsequent successful message,
not just card disappearance. Plan streaming includes both spaced deltas and a
90-delta burst followed by a pause before completion.

Manual acceptance reports confirm that continuous flicker stopped, pending
questions restore on refresh, Plan generation can be stopped, the mode switch
preserves drafts, and completed plans restore on refresh. The final cancellation
classification change has automated coverage; fresh live-model acceptance is
not claimed. No private Session, recording, credential or raw diagnostic export
is included. Final check commands and results belong in the associated PR.

At the earlier `9d8ce99` source boundary, `bun run check` passes; the separate Vitest run passes
245 cases across 13 files; the standard browser suite passes 34 cases and the
native-provider browser suite passes 10. The full Node suite reports 1,683
passes, two failures and one platform skip. Both failures are the existing
PlanMode Markdown tests (`a rich plan renders without throwing and keeps its
content`, `expanded survives edge-content plans at extreme widths`). An archive
of unmodified upstream `9d8ce99`, using the same installed dependencies,
reproduces both failures (22 passes, two failures in that file). No full-suite
green result is claimed. These results use local Node 24.16.0 and synthetic
browser data, not private provider requests.

At that earlier boundary, open PRs #549, #540 and #561 modified shared Web
surfaces and had not been integrated. The 2026-09-20 semantic rebase now includes
#561 at `45f12a4`, preserving its image transport, workbar, settings dialog,
transcript processes and Setup filtering. The Web echo of a Setup command is
hidden with its native episode so hidden replies cannot leave a permanently
waiting command bubble. Settings-hosted questions and Stop remain accessible
inside the active dialog. Exclusive Web Locks prevent inherited controller IDs
from being used concurrently; see [the controller contract](WEB_STRUCTURED_QUESTIONS.md).
#549 and #540 remain separate work. #578 is a separate TUI answer-editor
fix, not this Web questionnaire. The earlier work did not close #343, #348,
#470 or the remaining proposals in #562; the #470 handoff follow-up is tracked
separately below.

Integrated validation on 2026-09-20 against `45f12a4`: `bun run check`
passed; the Node suite reported 1,712 passes, two failures and one platform
skip. An unmodified archive of this upstream revision reproduced the same
two Plan rendering failures (22 passes / two failures). The separate complete
Vitest suite passed 318 tests across 22 files with `--maxWorkers=2`; default
high parallelism had produced timeout failures in existing settings/sidebar
tests. No timeout or assertion was relaxed. The standard browser suite passed
50 tests and the native-provider suite passed 12, including copied-storage
controller isolation and settings-dialog answer/cancellation flows. After the
final CSS ordering adjustment, all seven question/handoff browser tests passed
again. These are local automated results, not upstream acceptance or a fresh
live-provider manual smoke.

## #470 Plan Ready handoff follow-up

The 2026-09-28 implementation adds a same-Session Web action to prepare the
native Plan extension's editable implementation prompt. It does not start a
model turn; the user reviews and sends the prompt. The API and extension tests
separately cover Session identity, revision checks, persisted Plan state, and
the write gate; Composer tests cover draft replacement confirmation and the
absence of automatic submission. The fresh-Session handoff remains a TUI-only
operation. Source: [Issue #470](https://github.com/openpi-dev/openpi/issues/470).

Local verification on 2026-09-28 used Bun 1.3.14 and the bundled Node 24.19.0:

- `bun run check` passed, including Web build, format, lint, and both TypeScript checks. Vite reported its existing 500 KB chunk-size advisory.
- Focused Node tests passed for Plan control persistence/gating, active Session identity, and Web Host handoff request validation/response.
- Focused Vitest passed 2 Composer/Store tests; 171 unrelated cases were skipped by the name filter.
- `bun run test` did not complete. Seven existing real-Pi formatter lifecycle cases in `tests/extensions/post-edit/lifecycle.test.ts` timed out at 15 seconds, and the runner remained active without output. The foreground formatter timeout reproduced when run alone; its test process also did not exit cleanly. No aggregate full-suite result is claimed.

The follow-up PR link is added when the branch can be published.
