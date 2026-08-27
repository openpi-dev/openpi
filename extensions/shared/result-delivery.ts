/** Minimum lifecycle contract shared by deferred result queues. */
export interface ResultDeliveryQueue<T> {
  defer(result: T): void;
  size(): number;
  clear(): void;
}
