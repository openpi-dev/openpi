import type { ConsumableResultDeliveryQueue } from "../../shared/result-delivery.ts";

export interface SubagentResultDeliveryOptions<T> {
  /** True only when the parent has no run or queued continuation in flight. */
  readonly isIdle: () => boolean;
  /** Deliver one drained batch and wake the parent. */
  readonly deliver: (results: readonly T[]) => void;
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
 * The Map is the one-shot gate: `subagent_wait` may consume a result before it
 * is delivered, and whichever path drains first prevents duplicate delivery.
 */
export function createSubagentResultDelivery<T extends { id: string }>(
  options: SubagentResultDeliveryOptions<T>,
) {
  const pending = new Map<string, T>();

  const flush = () => {
    if (pending.size === 0) return;
    const results = [...pending.values()];
    pending.clear();
    try {
      options.deliver(results);
    } catch (error) {
      // A synchronous session teardown may reject append/send. Preserve the
      // original batch ahead of anything deferred re-entrantly while delivery
      // ran, so a later boundary can retry without loss or reordering.
      const current = [...pending.values()];
      pending.clear();
      for (const result of results) pending.set(result.id, result);
      for (const result of current) pending.set(result.id, result);
      throw error;
    }
  };

  const queue = {
    defer(result: T) {
      pending.set(result.id, result);
      if (options.isIdle()) flush();
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    /** Flush at the authoritative parent boundary. */
    parentSettled() {
      flush();
    },
    clear() {
      pending.clear();
    },
    size() {
      return pending.size;
    },
  };
  return queue satisfies ConsumableResultDeliveryQueue<T>;
}
