# Web structured questions

- Status: `draft`
- Created: 2026-09-18
- Last verified: 2026-09-20 (local implementation and tests; not upstream acceptance)
- Documentation alignment: 2026-09-21, checked against PR #595 head `96a3b5e`; no new runtime or live-provider validation claimed
- Source boundary: upstream `45f12a4b216993362940277b68a147737e31beb6` plus `codex/web-ask-user` / [PR #595](https://github.com/openpi-dev/openpi/pull/595)
- Related Issues: [#343](https://github.com/openpi-dev/openpi/issues/343), [#348](https://github.com/openpi-dev/openpi/issues/348), [#470](https://github.com/openpi-dev/openpi/issues/470)
- Related work: [#549](https://github.com/openpi-dev/openpi/pull/549)
- Supersedes: none

## Scope and ownership

Expose the existing parent-only `ask_user` tool as a Web questionnaire. Pi owns
the tool call, its abort signal and Session history. The model chooses whether
and what to ask; Web renders the questions and returns explicitly reviewed
answers to the original waiting invocation. Existing Plan/Setup tool visibility
is unchanged. This does not add configuration writes, Plan Ready handoff,
provider login, Trust mutation or arbitrary extension `ui.custom` support.

A versioned same-process bridge is keyed by the actual Pi SessionManager. It
does not install a partial UIContext or set `hasUI` for TUI-only extensions.
TUI and native dialog handling retain their current path. Without a registered
Web bridge or attributable controller, the existing no-UI feedback is retained.

The Host uses the controller contract introduced by PR #549:
`openpi.web.controller`, `X-OpenPI-Web-Controller`, and a UUID v4 `controllerId`
on prompt admission. That PR is not merged into this branch. The small identity
changes will need reconciliation when integrating both branches; cleanup
confirmation and its policy are not duplicated here.

PR #595 review follow-up: a sessionStorage value alone is not a unique tab
identity, because opener windows and duplicated tabs can inherit it. Before
issuing any HTTP/SSE request, the page now claims an exclusive Web Lock for
that UUID. A conflicting page rotates to a new UUID before sending its first
request. Concurrent clients within one document share the pending claim.
Page exit releases the claim; BFCache restoration reclaims before later
requests. Without Web Locks, or if claiming is denied, a fresh UUID fails
closed on inherited authority but cannot guarantee refresh recovery.
This remains local controller isolation, not isolation from malicious
same-origin JavaScript or shared transcript visibility.

## Runtime and transport

The Host binds a pending question to workspace, Session, command, turn epoch,
initiating controller and random request ID. A native command may return before
its `triggerTurn` starts; the runtime retains its origin through AsyncLocalStorage
and reclaims only that invocation's unused trace at `agent_start`. Unrelated
background starts never inherit the latest HTTP request by guesswork.

`GET /api/questions/pending?sessionId=…` returns a pending request only to its
controller. `POST /api/questions/answer` accepts the exact Session/request IDs,
an answer or dismissal action and, for answers, a complete ordered result.
Existing bearer and origin checks apply. SSE carries only `questions_changed`,
without the question payload or controller identity. This is a local-tab control
boundary, not a new remote identity or permission system. Native transcript
projection still contains the model's tool arguments and the final tool result.

One question batch waits at a time, at most three questions with five options
each. Existing per-field question limits and 8,000-byte answer/note limits are
enforced at the server boundary; answer POST bodies are capped at 64 KiB.
Missing/foreign question IDs, invented options, ambiguous answer modes and
partial answer sets are rejected without settling the request.

Requests expire after 15 minutes. Native abort, owner replacement and Host
shutdown settle pending calls without answers and release timers/listeners.
Refreshing the same tab restores an unexpired request, but not unsubmitted
drafts. Disconnect alone does not invent a response. At most 128 terminal
receipts are retained in memory; duplicate submissions replay the receipt,
never the answer. After eviction/restart the result is stale/unknown, not proof
that an earlier answer was never delivered. No question or draft database is
created; canonical answered tool results remain in Pi's Session.

## UI

An inline panel above the Composer uses the existing theme tokens, typography,
spacing and light/dark behavior. Its compact, Composer-width layout follows the
user-provided reference: a quiet question label, numbered option rows and a
bottom row combining the free-form choice with navigation and submission.
The header and actions have no separate divider bars. Native radio inputs
remain keyboard accessible; notes and previews expand only on request.
It presents one question at a time, notes per option, and a free-form choice. Blank
free-form answers explicitly request rephrasing. The review screen allows
editing any answer; navigation never submits. Dismissal sends no draft answers.

Answer drafts stay in memory. While a submission is uncertain, editing is
locked and retry reuses the original payload and request ID. Only a confirmed
receipt is shown as submitted. Controls have labels, keyboard focus and mobile
touch targets; question content can scroll without losing the submit controls.
Product labels support Chinese and English; model-provided text is not translated.

## Plan result presentation

The adjacent `plan_ready` result uses a compact, initially expanded Markdown
card with collapse and copy controls, using the existing theme and typography.
It renders the successful tool result's structured plan, never the proposed
tool arguments. Failed, pending and cancelled calls retain ordinary tool
evidence. Live delivery and persisted history share the same card; a result
whose original call was omitted from bounded history can render on its own.

The result is historical evidence, not current Plan state or implementation
approval. No implementation action is added. If the Web protocol omits oversized
details, the remaining result text is explicitly a preview, without claiming
readiness. Markdown task checkboxes remain read-only and receive accessible
labels from their item text.

`/plan` is registered by `extensions/plan-mode/index.ts`, using Pi's extension
command and Session primitives. The Web runtime binds extensions in print mode;
Plan Ready's interactive editor/select actions still require a separate bridge
([#470](https://github.com/openpi-dev/openpi/issues/470)). The Composer mode
control is implemented in PR #595 and projects the canonical
inactive/planning/ready state. It changes mode through the owning Plan extension,
which persists the state in the Pi Session; the runtime checks that the Session
is idle and the state revision is current. Switching mode does not send a prompt,
call the model or clear the draft. Turning planning off does not approve
implementation of a previous plan. See
[Plan ownership and presentation](WEB_INTERACTION_UI.md#plan-ownership-and-presentation)
for the control's lifecycle and limits. This describes the implementation under
review, not an accepted architectural Decision.

## Validation contract

- Broker tests: exact answers, byte bounds, controller isolation, replay,
  expiry, abort, replacement, single pending capacity and cleanup.
- Host tests: real authenticated HTTP reads/writes and extension bridge,
  prompt identity conflicts, foreign controllers and Session replacement.
- Component tests: selection, drafts, review/edit, dismissal, UTF-8 bounds,
  rephrasing and uncertain submission recovery.
- Browser tests: real Host, current local OpenPI package, native Pi tools and a
  local synthetic provider; refresh, another tab, light/desktop, dark/mobile,
  accessibility, answer propagation to the next provider request and Stop.
- Required repository checks: `bun run check` and `bun run test`.

Local results at the source boundary above:

- `bun run check` passed, including the production Web build.
- `bun run test` completed the Node suite: 1,662 passed, one skipped and two
  existing PlanMode rendering failures. The failing tests are
  `a rich plan renders without throwing and keeps its content` and
  `expanded survives edge-content plans at extreme widths`; their ANSI stripping
  leaves OSC 8 hyperlinks in the text. Those unrelated tests were not changed.
- The runner stops before Vitest on a Node failure, so the complete Vitest
  suite was run separately: 226 passed after the compact-layout revision,
  including the stale-receipt and optional-note disclosure coverage.
- All four provider browser tests passed: the existing thinking selector and
  three new structured-question scenarios. After the final layout adjustment,
  all three question scenarios passed again, including scoped axe checks.
- The runtime suite passed again after disposal cleanup: 42 tests.
- With Plan result cards, all 236 Vitest tests passed, including ten plan
  rendering/interaction cases. Two additional real Pi/local synthetic-provider
  browser tests cover `/plan` → reviewed `ask_user` → `plan_ready`, idle
  termination, history refresh, light desktop/dark mobile, collapse and scoped
  axe checks. The Node suite still has the same two baseline failures above.

Browser fixtures are not live-provider acceptance and do not validate Safari,
physical mobile keyboards, or every third-party extension. These tests do not
claim to complete the broader #343 or #348 issues.

Follow-up on 2026-09-20: the mode control previously described as a future
recommendation is now implemented through the owning Plan extension. See
[Web interaction UI](WEB_INTERACTION_UI.md) for its source boundary, human
handoff, command feedback, streaming/cancellation corrections and limits.
The associated PR records final validation after synchronization with main;
the counts above remain historical observations of the earlier source boundary.

Integration with #561 on 2026-09-20 retains the upstream workbar, image
attachments and Setup episode filtering. Pending questions render inside the
settings dialog while it is open, together with a Stop action; otherwise they
use the inline panel. The main conversation grid reserves separate rows for
the view switch, transcript, questions and Composer. Browser regressions use
a real opener window (and therefore genuinely copied sessionStorage), reject
its foreign dismissal with HTTP 403, recover the source question after refresh,
and complete or cancel Setup questions inside the settings dialog. Setup
completion is checked in native Session evidence, since #561 intentionally
hides configuration replies from the main conversation.
