/**
 * Deferred one-shot delivery map (same semantics as subagents'): a settled
 * terminal's result is held here until it is either drained into a follow-up
 * message or consumed by a tool call (bg_kill / bg_status) that already
 * returned the settlement itself. Keyed by id, so double delivery is
 * structurally impossible — whoever drains first wins.
 */
export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();

  return {
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results = [...pending.values()];
      pending.clear();
      return results;
    },
    clear() {
      pending.clear();
    },
  };
}

/**
 * How a settled background result reaches the model.
 *
 * `followUp` + `triggerTurn` costs a whole turn, which is right when the model
 * is idle and waiting on this result, and wrong for a backlog that piled up
 * while it worked: waking once per stale process forces a turn each, and the
 * model can only answer "that one already finished". `nextTurn` still puts the
 * result in context — carried alongside the user's next message — without
 * demanding a reply.
 */
export function resultDeliveryOptions(wake: boolean) {
  return wake
    ? ({ deliverAs: "followUp", triggerTurn: true } as const)
    : ({ deliverAs: "nextTurn" } as const);
}
