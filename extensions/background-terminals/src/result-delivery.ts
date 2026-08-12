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
      return pending.size;
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain(maxResults = Number.POSITIVE_INFINITY) {
      const results: T[] = [];
      for (const [id, result] of pending) {
        if (results.length >= maxResults) break;
        results.push(result);
        pending.delete(id);
      }
      return results;
    },
    restore(results: readonly T[]) {
      const current = [...pending.values()];
      pending.clear();
      for (const result of results) pending.set(result.id, result);
      for (const result of current) pending.set(result.id, result);
    },
    size() {
      return pending.size;
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
export interface IdleResultBatcherOptions<TimerHandle> {
  readonly delayMs: number;
  readonly isIdle: () => boolean;
  readonly flush: (wake: boolean) => void;
  readonly startTimer: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer: (timer: TimerHandle) => void;
}

/**
 * Coalesce settlements that arrive while the agent is idle without turning
 * the window into a sliding delay. A token rejects stale callbacks after
 * cancellation, including callbacks already queued by the host event loop.
 */
export function createIdleResultBatcher<TimerHandle>(
  options: IdleResultBatcherOptions<TimerHandle>,
) {
  let timer: TimerHandle | undefined;
  let active: symbol | undefined;

  const cancel = () => {
    active = undefined;
    if (timer !== undefined) options.clearTimer(timer);
    timer = undefined;
  };

  return {
    schedule() {
      if (active !== undefined) return;
      const token = Symbol("idle-result-batch");
      active = token;
      timer = options.startTimer(() => {
        if (active !== token) return;
        active = undefined;
        timer = undefined;
        if (options.isIdle()) options.flush(true);
      }, options.delayMs);
    },
    flushNow() {
      const wake = options.isIdle();
      cancel();
      options.flush(wake);
    },
    flushWithoutWake() {
      cancel();
      options.flush(false);
    },
    clear: cancel,
  };
}

export function hasTerminalCapacity(options: {
  readonly running: number;
  readonly pending: number;
  readonly reserved: number;
  readonly maximum: number;
}) {
  return options.running + options.pending + options.reserved < options.maximum;
}

export function resultDeliveryOptions(wake: boolean) {
  return wake
    ? ({ deliverAs: "followUp", triggerTurn: true } as const)
    : ({ deliverAs: "nextTurn" } as const);
}
