/**
 * Session-local admission for active child executions.
 *
 * This deliberately counts execution attempts, not child Session objects:
 * settled Direct children may remain available for a later `send`, but they do
 * not retain a permit. The parent `SessionManager` is the owner identity, so a
 * second top-level Pi Session gets an independent pool even though extensions
 * share this module instance in one process.
 */

export const MAX_CHILD_EXECUTION_QUEUE = 256;

export type ChildExecutionOrigin = "workflow" | "direct" | "btw";

export interface ChildExecutionAdmissionOptions {
  /** Omit to keep the historical, unbounded behaviour. */
  readonly maxActive?: number;
  /** A hard safety bound for waiters; production uses the exported default. */
  readonly maxQueued?: number;
}

export interface ChildExecutionLease {
  readonly origin: ChildExecutionOrigin;
  /** Idempotent and scoped to this exact execution attempt. */
  release(): void;
}

type OriginCounts = Record<ChildExecutionOrigin, number>;

export interface ChildExecutionAdmissionSnapshot {
  readonly enabled: boolean;
  readonly limit?: number;
  readonly held: number;
  readonly queued: number;
  readonly heldByOrigin: OriginCounts;
  readonly queuedByOrigin: OriginCounts;
  /** Never contains a child prompt or other private task content. */
  readonly blockedReason?: string;
}

export class ChildExecutionAdmissionAbortedError extends Error {
  constructor(message = "Waiting for a child execution slot was aborted.") {
    super(message);
    this.name = "ChildExecutionAdmissionAbortedError";
  }
}

export class ChildExecutionAdmissionQueueFullError extends Error {
  constructor(maxQueued: number) {
    super(
      `Too many child executions are already waiting (maximum ${maxQueued}).`,
    );
    this.name = "ChildExecutionAdmissionQueueFullError";
  }
}

interface Waiter {
  readonly origin: ChildExecutionOrigin;
  readonly resolve: (lease: ChildExecutionLease) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abort?: () => void;
}

const counts = (): OriginCounts => ({ workflow: 0, direct: 0, btw: 0 });

const abortError = (signal?: AbortSignal) =>
  new ChildExecutionAdmissionAbortedError(
    signal?.reason instanceof Error
      ? signal.reason.message
      : "Waiting for a child execution slot was aborted.",
  );

/**
 * A FIFO semaphore with observable state.  JavaScript turns make the check and
 * claim atomic; a queued caller can never pass an older waiter.
 */
export class ChildExecutionAdmission {
  private limit: number | undefined;
  private readonly maxQueued: number;
  private readonly held = new Map<number, ChildExecutionOrigin>();
  private readonly waiters: Waiter[] = [];
  private readonly listeners = new Set<() => void>();
  private nextAttempt = 0;
  private closed = false;

  constructor(options: ChildExecutionAdmissionOptions = {}) {
    this.limit = options.maxActive;
    this.maxQueued = options.maxQueued ?? MAX_CHILD_EXECUTION_QUEUE;
  }

  snapshot(): ChildExecutionAdmissionSnapshot {
    const heldByOrigin = counts();
    for (const origin of this.held.values()) heldByOrigin[origin]++;
    const queuedByOrigin = counts();
    for (const waiter of this.waiters) queuedByOrigin[waiter.origin]++;
    return {
      enabled: this.limit !== undefined,
      ...(this.limit === undefined ? {} : { limit: this.limit }),
      held: this.held.size,
      queued: this.waiters.length,
      heldByOrigin,
      queuedByOrigin,
      ...(this.waiters.length > 0 && this.limit !== undefined
        ? {
            blockedReason: `Waiting for a shared child execution slot (${this.held.size} active / ${this.limit} limit).`,
          }
        : {}),
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Apply a new package configuration without ever pretending live children
   * stopped. Shrinking below currently held permits is rejected so setup's
   * transactional rollback can preserve the old, truthful runtime contract.
   */
  configure(options: ChildExecutionAdmissionOptions) {
    if (options.maxActive !== undefined && options.maxActive < this.held.size) {
      throw new Error(
        `Cannot lower the session child execution limit below ${this.held.size} active child executions. Wait for them to settle first.`,
      );
    }
    this.limit = options.maxActive;
    this.drain();
    this.notify();
  }

  acquire(origin: ChildExecutionOrigin, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.closed)
      return Promise.reject(
        new ChildExecutionAdmissionAbortedError(
          "The parent Session is shutting down.",
        ),
      );
    // Disabled means unbounded, not unobserved. Keep an attempt-scoped lease
    // for active work so a live setup change cannot enable a lower limit and
    // silently ignore children that started while the feature was disabled.
    if (this.limit === undefined) return Promise.resolve(this.claim(origin));

    if (this.waiters.length === 0 && this.held.size < this.limit) {
      return Promise.resolve(this.claim(origin));
    }
    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(
        new ChildExecutionAdmissionQueueFullError(this.maxQueued),
      );
    }

    return new Promise<ChildExecutionLease>((resolve, reject) => {
      const waiter: Waiter = { origin, resolve, reject, signal };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        signal?.removeEventListener("abort", abort);
        reject(abortError(signal));
        this.notify();
      };
      waiter.abort = abort;
      this.waiters.push(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      // A caller can abort between the first check and listener registration.
      if (signal?.aborted) abort();
      else this.notify();
    });
  }

  /** Reject queued work; held work remains held until terminal evidence releases it. */
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      waiter.reject(
        new ChildExecutionAdmissionAbortedError(
          "The parent Session is shutting down.",
        ),
      );
    }
    this.notify();
  }

  private claim(origin: ChildExecutionOrigin): ChildExecutionLease {
    const attempt = ++this.nextAttempt;
    this.held.set(attempt, origin);
    this.notify();
    let released = false;
    return {
      origin,
      release: () => {
        if (released) return;
        released = true;
        // A stale callback has only its own attempt number, never the later
        // attempt that happened to reuse the same child Session.
        if (!this.held.delete(attempt)) return;
        this.drain();
        this.notify();
      },
    };
  }

  private drain() {
    if (this.closed) return;
    while (
      (this.limit === undefined || this.held.size < this.limit) &&
      this.waiters.length > 0
    ) {
      const waiter = this.waiters.shift()!;
      waiter.signal?.removeEventListener("abort", waiter.abort!);
      if (waiter.signal?.aborted) {
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      waiter.resolve(this.claim(waiter.origin));
    }
  }

  private notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Read-model observers never own the runtime state machine.
      }
    }
  }
}

const sessionAdmissions = new WeakMap<object, ChildExecutionAdmission>();

/** Return the one admission owner for this top-level Pi Session. */
export function sessionChildExecutionAdmission(
  sessionOwner: object,
  options: ChildExecutionAdmissionOptions,
) {
  let admission = sessionAdmissions.get(sessionOwner);
  if (!admission) {
    admission = new ChildExecutionAdmission(options);
    sessionAdmissions.set(sessionOwner, admission);
  }
  return admission;
}
