import type { WorkflowDetails } from "./model.ts";

export interface WorkflowCompletionEnvelope {
  deliveryId: string;
  runId: string;
  details: WorkflowDetails;
}

export interface WorkflowDeliveryReceipt {
  deliveryId: string;
  delivered: boolean;
  error?: string;
}

export interface WorkflowResultDeliveryOptions {
  isIdle: () => boolean;
  persist: (details: WorkflowDetails) => void;
  deliver: (
    envelopes: readonly WorkflowCompletionEnvelope[],
    wake: boolean,
  ) => Promise<readonly WorkflowDeliveryReceipt[]>;
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

  const flush = async (wake: boolean) => {
    if (flushing) return flushing;
    if (pending.size === 0) return;
    const envelopes = [...pending.values()];
    for (const envelope of envelopes) pending.delete(envelope.deliveryId);

    flushing = (async () => {
      let receipts: readonly WorkflowDeliveryReceipt[];
      try {
        receipts = await options.deliver(envelopes, wake);
      } catch (error) {
        const message = errorText(error);
        for (const envelope of envelopes) {
          enqueue(envelope);
          persistState(envelope.details, "pending", {
            attempts: (envelope.details.delivery?.attempts ?? 0) + 1,
            lastError: message,
          });
        }
        return;
      }

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
        enqueue(envelope);
        persistState(envelope.details, "pending", {
          attempts: (envelope.details.delivery?.attempts ?? 0) + 1,
          lastError:
            receipt?.error ?? "Completion delivery was not acknowledged",
        });
      }
    })().finally(() => {
      flushing = undefined;
    });
    return flushing;
  };

  return {
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
      persistState(envelope.details, "pending", { lastError: undefined });
      enqueue(envelope);
      if (options.isIdle()) void flush(true);
    },

    /** Queue a detached run after terminal status and pending are persisted. */
    defer(envelope: WorkflowCompletionEnvelope) {
      persistState(envelope.details, "pending", { lastError: undefined });
      enqueue(envelope);
      if (options.isIdle()) void flush(true);
    },

    /** Restore only explicitly pending/held new-format runs. */
    restore(envelope: WorkflowCompletionEnvelope) {
      const state = envelope.details.delivery?.state;
      if (state !== "pending" && state !== "held-for-inline") return false;
      // A process restart cannot still own the inline waiter. Deterministically
      // reconstruct pending delivery from the terminal artifact.
      if (state === "held-for-inline") {
        persistState(envelope.details, "pending", {
          lastError: "Inline waiter was not active after session restart",
        });
      }
      enqueue(envelope);
      return true;
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
}
