export type CompletionProducer = "subagent" | "workflow" | "background";
export type CompletionWakePolicy =
  | "follow-up"
  | "next-turn"
  | "producer-policy";

export interface CompletionOwner {
  readonly sessionId: string;
  readonly epoch: number;
}

export interface CompletionSessionIdentity {
  getSessionId(): string;
}

/** Transport metadata only; producer state remains the terminal authority. */
export interface CompletionEnvelope<T> {
  readonly deliveryId: string;
  readonly owner: CompletionOwner;
  readonly producer: CompletionProducer;
  readonly producerId: string;
  readonly terminalRef: unknown;
  readonly wake: CompletionWakePolicy;
  readonly payload: T;
}

export interface CompletionDeadLetter {
  readonly deliveryId: string;
  readonly producer: CompletionProducer;
  readonly producerId: string;
  readonly failure: "owner-unavailable" | "stale-owner";
}

function sameOwner(left: CompletionOwner, right: CompletionOwner) {
  return (
    Boolean(left.sessionId) &&
    left.sessionId !== "unowned" &&
    left.sessionId === right.sessionId &&
    left.epoch === right.epoch
  );
}

let nextOwnerEpoch = 1;
const ownerBySessionIdentity = new WeakMap<object, CompletionOwner>();

/**
 * Bind one process-local generation to a Pi SessionManager identity.
 *
 * All OpenPI producers observing the same manager share an owner. A replaced
 * manager, or a manager whose Session id changes, receives a new epoch so late
 * callbacks cannot target the replacement transcript.
 */
export function completionOwnerFor(
  identity: CompletionSessionIdentity,
): CompletionOwner {
  const sessionId = identity.getSessionId();
  const existing = ownerBySessionIdentity.get(identity);
  if (existing?.sessionId === sessionId) return existing;
  const owner = { sessionId, epoch: nextOwnerEpoch++ };
  ownerBySessionIdentity.set(identity, owner);
  return owner;
}

/**
 * One atomic consumption gate shared by all background producers.
 *
 * Claim removes before transport; a failed transport retries the exact
 * envelopes. A successful transport leaves them consumed. No execution facts
 * or result bytes are stored here.
 */
export function createCompletionInbox<T>() {
  const pending = new Map<string, CompletionEnvelope<T>>();
  const inFlight = new Map<string, CompletionEnvelope<T>>();
  const deadLetters: CompletionDeadLetter[] = [];

  const reject = (
    envelope: CompletionEnvelope<T>,
    failure: CompletionDeadLetter["failure"],
  ) => {
    deadLetters.push({
      deliveryId: envelope.deliveryId,
      producer: envelope.producer,
      producerId: envelope.producerId,
      failure,
    });
    return false;
  };

  const admit = (
    envelope: CompletionEnvelope<T>,
    owner: CompletionOwner | undefined,
  ) => {
    if (!owner) return reject(envelope, "owner-unavailable");
    if (!sameOwner(envelope.owner, owner)) {
      return reject(envelope, "stale-owner");
    }
    pending.set(envelope.deliveryId, envelope);
    return true;
  };

  /** Restore a failed attempt ahead of completions that arrived meanwhile. */
  const retry = (
    envelopes: readonly CompletionEnvelope<T>[],
    owner: CompletionOwner | undefined,
  ) => {
    const current = [...pending.values()];
    pending.clear();
    for (const envelope of envelopes) {
      inFlight.delete(envelope.deliveryId);
      admit(envelope, owner);
    }
    for (const envelope of current) admit(envelope, owner);
  };

  return {
    defer(envelope: CompletionEnvelope<T>, owner: CompletionOwner | undefined) {
      return admit(envelope, owner);
    },

    /** Explicit status/wait and automatic delivery atomically race here. */
    consume(producer: CompletionProducer, producerIds: Iterable<string>) {
      const ids = new Set(producerIds);
      for (const [deliveryId, envelope] of pending) {
        if (envelope.producer === producer && ids.has(envelope.producerId)) {
          pending.delete(deliveryId);
          inFlight.delete(deliveryId);
        }
      }
    },

    consumeDeliveryIds(deliveryIds: Iterable<string>) {
      for (const deliveryId of deliveryIds) {
        pending.delete(deliveryId);
        inFlight.delete(deliveryId);
      }
    },

    claim(
      owner: CompletionOwner | undefined,
      maximum = Number.POSITIVE_INFINITY,
    ) {
      const claimed: CompletionEnvelope<T>[] = [];
      for (const [deliveryId, envelope] of pending) {
        if (claimed.length >= maximum) break;
        pending.delete(deliveryId);
        if (!owner) {
          reject(envelope, "owner-unavailable");
          continue;
        }
        if (!sameOwner(envelope.owner, owner)) {
          reject(envelope, "stale-owner");
          continue;
        }
        inFlight.set(deliveryId, envelope);
        claimed.push(envelope);
      }
      return claimed;
    },

    retry,

    retryClaimed(
      producer: CompletionProducer,
      producerIds: Iterable<string>,
      owner: CompletionOwner | undefined,
    ) {
      const ids = new Set(producerIds);
      const envelopes = [...inFlight.values()].filter(
        (envelope) =>
          envelope.producer === producer && ids.has(envelope.producerId),
      );
      retry(envelopes, owner);
    },

    acknowledge(deliveryIds: Iterable<string>) {
      for (const deliveryId of deliveryIds) inFlight.delete(deliveryId);
    },

    size() {
      return pending.size;
    },

    inspectDeadLetters() {
      return [...deadLetters];
    },

    clear() {
      pending.clear();
      inFlight.clear();
      deadLetters.length = 0;
    },
  };
}
