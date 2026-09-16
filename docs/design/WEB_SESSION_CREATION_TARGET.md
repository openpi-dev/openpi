# Web Session Creation Target Binding

- Status: validated
- Created: 2026-09-08
- Verified: 2026-09-08
- Source boundary: the implementation in this record's commit, based on
  `upstream/main` at `0d17f4577fe31315fe6c95370d251bdb4e2413cf`
- Related Issue: [#466](https://github.com/openpi-dev/openpi/issues/466)
- Related PR: [#490](https://github.com/openpi-dev/openpi/pull/490)
- Supersedes: none

## Problem

Creating a Web Session and sending its first prompt spans an HTTP creation
receipt, snapshot refreshes, optional model selection, and prompt admission.
Another browser tab can activate a different Session between those operations.
If the browser discards the creation receipt and reads the target back from the
latest snapshot, the original prompt can be sent to the other tab's active
Session.

The Host and runtime already reject prompts whose `sessionId` is not active.
That guard cannot recover the user's intent after the browser has replaced the
intended target with a different but currently valid Session id.

## Decision

The creation receipt carries three distinct facts:

- `commandId` correlates the creation request and its events;
- `sessionId` is the required stable target identity;
- `sessionPath` is optional because a new Pi Session may not have a persisted
  file before its first message.

The Web store retains those facts as the target of the creation operation. A
snapshot refresh may confirm the target but cannot replace it. Before model
selection, after model selection, and before prompt admission, the store checks
that both `currentSessionId` and the selected Session still match the receipt's
`sessionId`. When the receipt included a path, the selected path must also
match.

If another tab changes the active Session, the operation stops without calling
model selection or prompt admission. The Composer keeps its input because
`sendPrompt` returns `false`; the store reports that the active Session changed.
The Host's existing `SESSION_CONFLICT` validation and prompt `commandId`
idempotency remain the final runtime boundaries.

This is a browser admission context, not a second Session state machine. Pi's
runtime and `SessionManager` remain authoritative for Session activation and
persistence.

## Evidence

Validated tests cover:

- a second tab becoming active between the creation receipt and snapshot;
- creation and correlated SSE events before a Session has a persisted path;
- draft model selection refusing to target the externally activated Session;
- the runtime and Host returning the same stable Session identity;
- existing Session selection, prompt retry, and model-selection races.

Repository validation on 2026-09-08:

- `bun run check` passed;
- `bun run test` passed with 1,465 Node tests passed, 1 platform-specific test
  skipped, and 134 Web tests passed;
- `bun run test:web:e2e` passed 12/12. The new browser case starts the current
  checkout's standalone Host and Pi runtime, delays the created Session's HTTP
  receipt, switches the runtime through an independent request, suppresses the
  SSE transition, and verifies that no prompt is retargeted. No model call was
  made;
- the local shell had no separately installed `pi` executable, so `pi list`
  provenance for an installed package was unavailable. The browser test runs
  `bin/openpi.js` directly from the named checkout instead.

## Ablation

An initial implementation recorded both the expected receipt identity and
separate Session/path identities observed from creation events. Removing the
observed-identity state left the merged Web store suite at 60/60: `commandId`
already correlates the event stream, while the receipt's `sessionId` is the
only target authority needed after HTTP completion. The redundant state was
removed.

Removing receipt-bound `sessionId` validation restores the reported failure:
the snapshot can supply another tab's active Session as the first prompt target.
That validation is therefore required.
