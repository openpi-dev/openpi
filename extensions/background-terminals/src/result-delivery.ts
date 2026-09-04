import type { ConsumableResultDeliveryQueue } from "../../shared/result-delivery.ts";
import {
  type CompletionOwner,
  createCompletionInbox,
} from "../../shared/completion-inbox.ts";

/**
 * Deferred one-shot delivery adapter (same semantics as subagents'): a
 * settled terminal's result is held in the shared inbox until it is either
 * drained into a follow-up message or consumed by a tool call (bg_kill /
 * bg_status) that already returned the settlement itself. Stable ids make
 * double delivery structurally impossible — whoever claims first wins.
 */
export function createDeferredResultDelivery<T extends { id: string }>(
  options: { readonly owner?: () => CompletionOwner | undefined } = {},
) {
  const inbox = createCompletionInbox<T>();
  const owner = options.owner ?? (() => ({ sessionId: "test", epoch: 0 }));

  const queue = {
    defer(result: T) {
      const currentOwner = owner();
      inbox.defer(
        {
          deliveryId: `background:${result.id}`,
          owner: currentOwner ?? { sessionId: "unowned", epoch: 0 },
          producer: "background",
          producerId: result.id,
          terminalRef: { kind: "terminal-snapshot", id: result.id },
          wake: "producer-policy",
          payload: result,
        },
        currentOwner,
      );
      return inbox.size();
    },
    consume(ids: Iterable<string>) {
      inbox.consume("background", ids);
    },
    drain(maxResults = Number.POSITIVE_INFINITY) {
      return inbox
        .claim(owner(), maxResults)
        .map((envelope) => envelope.payload);
    },
    restore(results: readonly T[]) {
      inbox.retryClaimed(
        "background",
        results.map((result) => result.id),
        owner(),
      );
    },
    acknowledge(results: readonly T[]) {
      inbox.acknowledge(results.map((result) => `background:${result.id}`));
    },
    size() {
      return inbox.size();
    },
    clear() {
      inbox.clear();
    },
    inspectDeadLetters: inbox.inspectDeadLetters,
  };
  return queue satisfies ConsumableResultDeliveryQueue<T>;
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
