# Background Completion Inbox

- Status: validated
- Created: 2026-09-04
- Verified: 2026-09-04
- Source boundary: OpenPI implementation and tests in the pull request that closes issue #160
- Related issue: https://github.com/openpi-dev/openpi/issues/160
- Related pull request: https://github.com/openpi-dev/openpi/pull/382
- Supersedes: the three producer-local consumption maps, not their execution state machines

## Boundary

Direct Subagent, Background Terminal, and Workflow keep independent execution
lifecycles and canonical terminal records. The shared completion inbox is a
small in-process delivery mechanism. It does not own execution status, result
bytes, artifacts, cancellation, Goals, Tasks, model judgment, or UI state.

The four relevant projections stay distinct:

1. `SubagentSnapshot`, `TerminalSnapshot`, and `WorkflowDetails` are canonical
   execution facts.
2. `CompletionEnvelope` carries only delivery identity, owner, producer,
   terminal reference, wake policy, and an in-process payload.
3. Pi's existing `followUp` and `nextTurn` messages create model-visible
   context.
4. Existing TUI and Web surfaces render producer state; they do not infer
   completion from the inbox.

This uses Pi's SessionManager identity and message-delivery APIs rather than
adding a second Session mailbox, scheduler, or agent runtime.

## Envelope and ownership

Every envelope has a stable `deliveryId`, `{sessionId, epoch}` owner,
`producer`, `producerId`, `terminalRef`, and producer-selected `wake` policy.
All producers observing the same Pi SessionManager object share one
process-local epoch. Replacing that object, or changing its Session id, creates
a new epoch. A claim with a missing or mismatched owner becomes an inspectable
dead letter and is never redirected to another transcript.

Workflow alone has durable producer state. Its delivery owner is persisted in
`WorkflowDetails`. On restart, restoring a pending terminal artifact is the
explicit revival boundary: the same Session id is rebound to the current
process-local epoch and persisted; a different Session remains pending in
canonical Workflow state and is dead-lettered by the inbox. Direct Subagents
and Background Terminals do not survive Pi's `session_shutdown`, so their
process-local inbox entries are cleared with their existing runtime lifecycle.

## Consumption and receipts

Pending and in-flight maps form one atomic consumption gate. Explicit
`wait`/`status` consumption and automatic delivery race on that gate; the first
claim wins. A transport failure restores the exact in-flight envelopes ahead
of newer work. Independent batches can be acknowledged or retried without
overwriting each other.

The contract deliberately does not claim distributed exactly-once delivery:

- Direct and Background transports consume after synchronous acceptance and
  restore on synchronous rejection.
- Workflow keeps its stable per-run receipt and durable at-least-once recovery.
  If transport succeeds but receipt persistence fails, the same delivery id
  may replay so the parent can identify it.
- Partial Workflow receipts retry only unacknowledged siblings.

Wake behavior remains producer-owned: Direct always follows up at its parent
boundary, Background preserves its idle-follow-up versus busy-next-turn
policy, and Workflow preserves its client-aware delivery adapter.

## Validation

Focused tests cover atomic explicit/automatic consumption, independent
in-flight batches, retry ordering, stable producer identities, partial
receipts, persistence failure, same-Session revival, Session id and epoch
switches, owner loss, and dead letters. Existing integration tests retain the
producer-specific wake, shutdown, process-restart, and canonical-state
behavior. Repository gates are `bun run check` and `bun run test` on Node 22.
