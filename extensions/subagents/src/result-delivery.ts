import type { ConsumableResultDeliveryQueue } from "../../shared/result-delivery.ts";
import {
  type CompletionOwner,
  createCompletionInbox,
} from "../../shared/completion-inbox.ts";

export interface SubagentResultDeliveryOptions<T> {
  /** True only when the parent has no run or queued continuation in flight. */
  readonly isIdle: () => boolean;
  /** Deliver one drained batch and wake the parent. */
  readonly deliver: (results: readonly T[]) => void;
  /** Current Pi Session transcript owner. */
  readonly owner?: () => CompletionOwner | undefined;
}

/**
 * One-shot result delivery for fire-and-forget subagents.
 *
 * The tool contract promises that a settled child re-invokes the parent. A
 * child that settles while the parent is busy therefore remains retractable
 * until the parent's `agent_settled` event, but it must never be downgraded to
 * a `nextTurn` message that needs another user prompt. There are two symmetric
 * wake-up edges so no ordering can lose the notification:
 *
 * 1. child settles after the parent became idle -> `defer` flushes now;
 * 2. parent settles after the child -> `parentSettled` flushes the batch.
 *
 * The parent boundary wakes even if an earlier extension handler has already
 * started another turn: Pi queues the follow-up into that active run.
 *
 * The shared inbox is the one-shot gate: `subagent_wait` may consume a result
 * before it is delivered, and whichever path claims first prevents duplicate
 * delivery.
 */
export function createSubagentResultDelivery<T extends { id: string }>(
  options: SubagentResultDeliveryOptions<T>,
) {
  const inbox = createCompletionInbox<T>();
  const owner = options.owner ?? (() => ({ sessionId: "test", epoch: 0 }));

  const flush = () => {
    const envelopes = inbox.claim(owner());
    if (envelopes.length === 0) return;
    const results = envelopes.map((envelope) => envelope.payload);
    try {
      options.deliver(results);
      inbox.acknowledge(envelopes.map((envelope) => envelope.deliveryId));
    } catch (error) {
      // A synchronous session teardown may reject append/send. Preserve the
      // original batch ahead of anything deferred re-entrantly while delivery
      // ran, so a later boundary can retry without loss or reordering.
      inbox.retry(envelopes, owner());
      throw error;
    }
  };

  const queue = {
    defer(result: T) {
      const currentOwner = owner();
      inbox.defer(
        {
          deliveryId: `subagent:${result.id}`,
          owner: currentOwner ?? { sessionId: "unowned", epoch: 0 },
          producer: "subagent",
          producerId: result.id,
          terminalRef: { kind: "subagent-snapshot", id: result.id },
          wake: "follow-up",
          payload: result,
        },
        currentOwner,
      );
      if (options.isIdle()) flush();
    },
    consume(ids: Iterable<string>) {
      inbox.consume("subagent", ids);
    },
    /** Flush at the authoritative parent boundary. */
    parentSettled() {
      flush();
    },
    clear() {
      inbox.clear();
    },
    size() {
      return inbox.size();
    },
    inspectDeadLetters: inbox.inspectDeadLetters,
  };
  return queue satisfies ConsumableResultDeliveryQueue<T>;
}
