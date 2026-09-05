import {
  type CompletionEnvelope,
  type CompletionOwner,
  createCompletionInbox,
} from "../shared/completion-inbox.ts";
import type {
  DurableResultDeliveryQueue,
  DurableResultDeliveryReceipt,
} from "../shared/result-delivery.ts";
import type { WorkflowDetails } from "./model.ts";

export interface WorkflowCompletionEnvelope {
  deliveryId: string;
  runId: string;
  details: WorkflowDetails;
}

export interface WorkflowResultDeliveryOptions {
  isIdle: () => boolean;
  owner?: () => CompletionOwner | undefined;
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
  const inbox = createCompletionInbox<WorkflowCompletionEnvelope>();
  const currentOwner =
    options.owner ?? (() => ({ sessionId: "test", epoch: 0 }));
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

  const inboxEnvelope = (
    envelope: WorkflowCompletionEnvelope,
  ): CompletionEnvelope<WorkflowCompletionEnvelope> => {
    const delivery = envelope.details.delivery;
    const deliverySessionId = delivery?.ownerSessionId;
    const detailsSessionId = envelope.details.sessionId;

    // Conflicting owner fields invalidate delivery ownership fail-closed.
    const hasConflict =
      deliverySessionId !== undefined &&
      detailsSessionId !== undefined &&
      deliverySessionId !== detailsSessionId;

    const ownerSessionId = hasConflict ? undefined : deliverySessionId;
    return {
      deliveryId: envelope.deliveryId,
      owner: {
        sessionId:
          ownerSessionId && ownerSessionId !== "unowned"
            ? ownerSessionId
            : "unowned",
        epoch: delivery?.ownerEpoch ?? 0,
      },
      producer: "workflow",
      producerId: envelope.runId,
      terminalRef: {
        kind: "workflow-terminal",
        runId: envelope.runId,
        status: envelope.details.status,
      },
      wake: "producer-policy",
      payload: envelope,
    };
  };

  const enqueue = (envelope: WorkflowCompletionEnvelope) =>
    inbox.defer(inboxEnvelope(envelope), currentOwner());

  const retainPending = (
    envelope: WorkflowCompletionEnvelope,
    patch: Partial<NonNullable<WorkflowDetails["delivery"]>>,
    persistenceFailure: string,
  ) => {
    // Memory owns the retry before persistence is attempted. A broken disk
    // must not make this envelope, or any sibling after it, disappear from the
    // current process.
    const admitted = enqueue(envelope);
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
    return admitted;
  };

  const flush = async (wake: boolean) => {
    if (flushing) {
      flushRequested = true;
      wakeRequested ||= wake;
      return flushing;
    }
    if (inbox.size() === 0) return;

    flushing = (async () => {
      let passWake = wake;
      while (inbox.size() > 0) {
        flushRequested = false;
        wakeRequested = false;
        const claimed = inbox.claim(currentOwner());
        const envelopes = claimed.map((envelope) => envelope.payload);
        if (envelopes.length === 0) break;

        let receipts: readonly DurableResultDeliveryReceipt[] | undefined;
        try {
          receipts = await options.deliver(envelopes, passWake);
        } catch (error) {
          const message = errorText(error);
          for (const envelope of envelopes) {
            inbox.acknowledge([envelope.deliveryId]);
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
              inbox.acknowledge([envelope.deliveryId]);
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
            inbox.acknowledge([envelope.deliveryId]);
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
      if (details.delivery) inbox.consumeDeliveryIds([details.delivery.id]);
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
      const owner = currentOwner();
      const deliverySessionId = envelope.details.delivery?.ownerSessionId;
      const detailsSessionId = envelope.details.sessionId;
      const hasConflict =
        deliverySessionId !== undefined &&
        detailsSessionId !== undefined &&
        deliverySessionId !== detailsSessionId;
      const storedSessionId = hasConflict
        ? undefined
        : (deliverySessionId ?? detailsSessionId);

      // Restoring canonical producer state is the explicit owner-revival
      // boundary. Rebind only the same transcript to this process-local
      // SessionManager generation; a different Session still dead-letters.
      if (
        owner &&
        storedSessionId !== undefined &&
        storedSessionId === owner.sessionId
      ) {
        envelope.details.delivery = {
          ...envelope.details.delivery!,
          ownerSessionId: owner.sessionId,
          ownerEpoch: owner.epoch,
        };
        return retainPending(
          envelope,
          {
            ownerSessionId: owner.sessionId,
            ownerEpoch: owner.epoch,
            lastError:
              state === "held-for-inline"
                ? "Inline waiter was not active after session restart"
                : undefined,
          },
          "Restored delivery state persistence failed",
        );
      }
      // Keep the canonical terminal artifact pending, but record that this
      // process is not its transcript owner instead of redirecting it.
      return enqueue(envelope);
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
      return inbox.size();
    },

    clear() {
      inbox.clear();
    },
    inspectDeadLetters: inbox.inspectDeadLetters,
  };
  return queue satisfies DurableResultDeliveryQueue<WorkflowCompletionEnvelope>;
}
