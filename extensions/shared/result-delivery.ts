/** Minimum lifecycle contract shared by deferred result queues. */
export interface ResultDeliveryQueue<T> {
  defer(result: T): void;
  size(): number;
  clear(): void;
}

/** One-shot results are removed by either an explicit consumer or delivery. */
export interface ConsumableResultDeliveryQueue<T, TId = string>
  extends ResultDeliveryQueue<T> {
  consume(ids: Iterable<TId>): void;
}

/** Stable identity carried by a durable, at-least-once result. */
export interface DurableResultEnvelope {
  deliveryId: string;
}

/** Per-result acknowledgement for a durable delivery attempt. */
export interface DurableResultDeliveryReceipt {
  deliveryId: string;
  delivered: boolean;
  error?: string;
}

/**
 * Durable queues can reconstruct pending ownership after restart and retry it
 * at an explicit lifecycle boundary without changing the stable delivery id.
 */
export interface DurableResultDeliveryQueue<T extends DurableResultEnvelope>
  extends ResultDeliveryQueue<T> {
  restore(result: T): boolean;
  retryPending(): Promise<void>;
}
