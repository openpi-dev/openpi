import type { WorkflowDetails } from "./model.ts";
import type {
  DurableResultDeliveryQueue,
  DurableResultDeliveryReceipt,
} from "../shared/result-delivery.ts";

export interface WorkflowCompletionEnvelope {
  deliveryId: string;
  runId: string;
  details: WorkflowDetails;
}

export interface WorkflowResultDeliveryOptions {
  isIdle: () => boolean;
  persist: (details: WorkflowDetails) => void;
  deliver: (
    envelopes: readonly WorkflowCompletionEnvelope[],
    wake: boolean,
  ) => Promise<readonly DurableResultDeliveryReceipt[]>;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Durable, per-run workflow completion delivery.
 *
 * Execution status remains authoritative in WorkflowDetails. This module owns
 * only the orthogonal delivery plane. A transport batch is an optimization:
 * every run keeps its own stable delivery id and receipt so partial success
 * can be retried without duplicating siblings.
 */
export function createWorkflowResultDelivery(
  options: WorkflowResultDeliveryOptions,
) {
  const pending = new Map<string, WorkflowCompletionEnvelope>();
  let flushing: Promise<void> | undefined;
  let flushRequested = false;
  let wakeRequested = false;

  const persistState = (
    details: WorkflowDetails,
    state: NonNullable<WorkflowDetails["delivery"]>["state"],
    patch: Partial<NonNullable<WorkflowDetails["delivery"]>> = {},
  ) => {
    const delivery = details.delivery;
    if (!delivery) throw new Error("Workflow delivery identity is missing");
    const next = {
      ...delivery,
      ...patch,
      state,
      updatedAt: Date.now(),
    };
    if (patch.lastError === undefined) delete next.lastError;
    details.delivery = next;
    options.persist(details);
  };

  const enqueue = (envelope: WorkflowCompletionEnvelope) => {
    pending.set(envelope.deliveryId, envelope);
  };

  const retainPending = (
    envelope: WorkflowCompletionEnvelope,
    patch: Partial<NonNullable<WorkflowDetails["delivery"]>>,
    persistenceFailure: string,
  ) => {
    // Memory owns the retry before persistence is attempted. A broken disk
    // must not make this envelope, or any sibling after it, disappear from the
    // current process.
    enqueue(envelope);
    try {
      persistState(envelope.details, "pending", patch);
    } catch (error) {
      const delivery = envelope.details.delivery;
      if (delivery) {
        envelope.details.delivery = {
          ...delivery,
          state: "pending",
          updatedAt: Date.now(),
          lastError: `${persistenceFailure}: ${errorText(error)}`,
        };
      }
    }
  };

  const flush = async (wake: boolean) => {
    if (flushing) {
      flushRequested = true;
      wakeRequested ||= wake;
      return flushing;
    }
    if (pending.size === 0) return;

    flushing = (async () => {
      let passWake = wake;
      while (pending.size > 0) {
        flushRequested = false;
        wakeRequested = false;
        const envelopes = [...pending.values()];
        for (const envelope of envelopes) {
          pending.delete(envelope.deliveryId);
        }

        let receipts: readonly DurableResultDeliveryReceipt[] | undefined;
        try {
          receipts = await options.deliver(envelopes, passWake);
        } catch (error) {
          const message = errorText(error);
          for (const envelope of envelopes) {
            retainPending(
              envelope,
              {
                attempts: (envelope.details.delivery?.attempts ?? 0) + 1,
                lastError: message,
              },
              "Pending delivery persistence failed",
            );
          }
        }

        if (receipts !== undefined) {
          const byId = new Map(
            receipts.map((receipt) => [receipt.deliveryId, receipt] as const),
          );
          for (const envelope of envelopes) {
            const receipt = byId.get(envelope.deliveryId);
            if (receipt?.delivered) {
              try {
                persistState(envelope.details, "delivered", {
                  attempts: (envelope.details.delivery?.attempts ?? 0) + 1,
                  deliveredAt: Date.now(),
                  lastError: undefined,
                });
              } catch (error) {
                // The transport already accepted the message, but the durable
                // receipt did not commit. Retain it for at-least-once recovery;
                // the visible stable id lets the parent recognize a rare replay.
                enqueue(envelope);
                const delivery = envelope.details.delivery;
                if (delivery) {
                  envelope.details.delivery = {
                    ...delivery,
                    state: "pending",
                    updatedAt: Date.now(),
                    lastError: `Delivery receipt persistence failed: ${errorText(error)}`,
                  };
                }
              }
              continue;
            }
            retainPending(
              envelope,
              {
                attempts: (envelope.details.delivery?.attempts ?? 0) + 1,
                lastError:
                  receipt?.error ?? "Completion delivery was not acknowledged",
              },
              "Pending delivery persistence failed",
            );
          }
        }

        // A completion or lifecycle edge joined this pass while transport was
        // in flight. Drain once more so that request is not lost. Failures
        // retained above do not request their own immediate retry, preventing
        // an unavailable transport from creating a busy loop.
        if (!flushRequested) break;
        passWake ||= wakeRequested;
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  const queue = {
    /** Register inline interest before the run starts. */
    holdInline(details: WorkflowDetails) {
      persistState(details, "held-for-inline");
    },

    /** Terminal won the wait/abort arbitration and will be returned inline. */
    consumeInline(details: WorkflowDetails) {
      if (details.delivery) pending.delete(details.delivery.id);
      persistState(details, "consumed-inline", {
        deliveredAt: Date.now(),
        lastError: undefined,
      });
    },

    /** Abort won the wait/terminal arbitration; deliver the result later. */
    releaseInline(envelope: WorkflowCompletionEnvelope) {
      retainPending(
        envelope,
        { lastError: undefined },
        "Initial delivery persistence failed",
      );
      if (options.isIdle()) void flush(true);
    },

    /** Queue a detached run with in-memory retry ownership before persistence. */
    defer(envelope: WorkflowCompletionEnvelope) {
      retainPending(
        envelope,
        { lastError: undefined },
        "Initial delivery persistence failed",
      );
      if (options.isIdle()) void flush(true);
    },

    /** Restore only explicitly pending/held new-format runs. */
    restore(envelope: WorkflowCompletionEnvelope) {
      const state = envelope.details.delivery?.state;
      if (state !== "pending" && state !== "held-for-inline") return false;
      // A process restart cannot still own the inline waiter. Deterministically
      // reconstruct pending delivery from the terminal artifact.
      if (state === "held-for-inline") {
        retainPending(
          envelope,
          { lastError: "Inline waiter was not active after session restart" },
          "Restored delivery state persistence failed",
        );
      } else {
        enqueue(envelope);
      }
      return true;
    },

    retryPending() {
      return flush(true) ?? Promise.resolve();
    },

    parentSettled() {
      return flush(true);
    },

    flushIfIdle() {
      if (!options.isIdle()) return Promise.resolve();
      return flush(true) ?? Promise.resolve();
    },

    size() {
      return pending.size;
    },

    clear() {
      pending.clear();
    },
  };
  return queue satisfies DurableResultDeliveryQueue<WorkflowCompletionEnvelope>;
}
