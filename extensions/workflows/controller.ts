import {
  DEFAULT_WORKFLOW_CONCURRENCY,
  DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
  MAX_WORKFLOW_AGENT_CALLS,
  MAX_WORKFLOW_CONCURRENCY,
} from "../shared/setup-config.ts";
export const RUN_SHUTDOWN_TIMEOUT_MS = 8_000;

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow was aborted");
}

class Semaphore {
  private active = 0;
  private readonly limit: number;
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  acquire(signal: AbortSignal) {
    if (signal.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          this.active++;
          resolve();
        },
        reject,
        signal,
        onAbort: () => {},
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError(signal));
      };
      waiter.onAbort = onAbort;
      this.queue.push(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    while (this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      if (waiter.signal.aborted) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      waiter.resolve();
      return;
    }
  }

  clear() {
    const queued = this.queue;
    this.queue = [];
    for (const waiter of queued) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(abortError(waiter.signal));
    }
  }
}

/** Owns every agent task and the run-wide fanout/abort budget. */
export class RunController {
  private readonly abortController = new AbortController();
  private readonly semaphore: Semaphore;
  private readonly maxAgentCalls: number;
  private readonly concurrency: number;
  private readonly tasks = new Set<Promise<unknown>>();
  private callCount = 0;
  private sealed = false;
  private settlePromise?: Promise<boolean>;
  private parentAbort?: () => void;
  private parentSignal?: AbortSignal;

  constructor(
    parentSignal?: AbortSignal,
    concurrency = DEFAULT_WORKFLOW_CONCURRENCY,
    maxAgentCalls = DEFAULT_WORKFLOW_MAX_AGENT_CALLS,
  ) {
    this.concurrency = Math.max(
      1,
      Math.min(MAX_WORKFLOW_CONCURRENCY, Math.floor(concurrency)),
    );
    this.semaphore = new Semaphore(this.concurrency);
    this.maxAgentCalls = Math.max(
      1,
      Math.min(MAX_WORKFLOW_AGENT_CALLS, Math.floor(maxAgentCalls)),
    );
    if (parentSignal) {
      this.parentSignal = parentSignal;
      this.parentAbort = () => this.abort("Parent operation was aborted");
      if (parentSignal.aborted) this.parentAbort();
      else
        parentSignal.addEventListener("abort", this.parentAbort, {
          once: true,
        });
    }
  }

  get signal() {
    return this.abortController.signal;
  }

  get calls() {
    return this.callCount;
  }

  capacity() {
    return {
      concurrency: this.concurrency,
      maxAgentCalls: this.maxAgentCalls,
      callsUsed: this.callCount,
      callsRemaining: Math.max(0, this.maxAgentCalls - this.callCount),
    };
  }

  schedule<T>(
    task: (signal: AbortSignal) => Promise<T>,
    invocationSignal?: AbortSignal,
  ): Promise<T> {
    if (this.sealed) return Promise.reject(new Error("Workflow is settling"));
    if (this.signal.aborted) return Promise.reject(abortError(this.signal));
    if (this.callCount >= this.maxAgentCalls) {
      return Promise.reject(
        new Error(
          `Workflow exceeded the limit of ${this.maxAgentCalls} agent calls`,
        ),
      );
    }
    this.callCount++;

    const running = (async () => {
      const taskAbort = new AbortController();
      const onRunAbort = () => taskAbort.abort(this.signal.reason);
      const onInvocationAbort = () => taskAbort.abort(invocationSignal?.reason);
      this.signal.addEventListener("abort", onRunAbort, { once: true });
      invocationSignal?.addEventListener("abort", onInvocationAbort, {
        once: true,
      });
      if (this.signal.aborted) onRunAbort();
      else if (invocationSignal?.aborted) onInvocationAbort();

      let acquired = false;
      try {
        await this.semaphore.acquire(taskAbort.signal);
        acquired = true;
        if (taskAbort.signal.aborted) throw abortError(taskAbort.signal);
        const result = await task(taskAbort.signal);
        if (invocationSignal?.aborted) throw abortError(invocationSignal);
        return result;
      } finally {
        this.signal.removeEventListener("abort", onRunAbort);
        invocationSignal?.removeEventListener("abort", onInvocationAbort);
        if (acquired) this.semaphore.release();
      }
    })();
    this.tasks.add(running);
    void running.finally(() => this.tasks.delete(running)).catch(() => {});
    return running;
  }

  abort(reason = "Workflow was aborted") {
    if (!this.signal.aborted) this.abortController.abort(new Error(reason));
    this.semaphore.clear();
  }

  /** Seal once and wait a bounded time for the same task snapshot on every caller. */
  settle(options: { abort?: boolean; timeoutMs?: number } = {}) {
    this.sealed = true;
    if (options.abort) this.abort();
    if (this.settlePromise) return this.settlePromise;

    const tasks = [...this.tasks];
    this.settlePromise = (async () => {
      if (tasks.length === 0) {
        this.detachParent();
        return true;
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<false>((resolve) => {
        timer = setTimeout(
          () => resolve(false),
          options.timeoutMs ?? RUN_SHUTDOWN_TIMEOUT_MS,
        );
      });
      const settled = Promise.allSettled(tasks).then(() => true as const);
      const completed = await Promise.race([settled, timeout]);
      if (timer) clearTimeout(timer);
      this.detachParent();
      return completed;
    })();
    return this.settlePromise;
  }

  private detachParent() {
    if (this.parentAbort) {
      this.parentSignal?.removeEventListener("abort", this.parentAbort);
    }
    this.parentAbort = undefined;
    this.parentSignal = undefined;
  }
}
