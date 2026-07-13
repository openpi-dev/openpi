const DEFAULT_CONCURRENCY = 4;
export const MAX_AGENT_CALLS = 32;
export const RUN_SHUTDOWN_TIMEOUT_MS = 8_000;

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
    if (signal.aborted)
      return Promise.reject(new Error("Workflow was aborted"));
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
        reject(new Error("Workflow was aborted"));
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
        waiter.reject(new Error("Workflow was aborted"));
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
      waiter.reject(new Error("Workflow was aborted"));
    }
  }
}

/** Owns every agent task and the run-wide fanout/abort budget. */
export class RunController {
  private readonly abortController = new AbortController();
  private readonly semaphore: Semaphore;
  private readonly tasks = new Set<Promise<unknown>>();
  private callCount = 0;
  private sealed = false;
  private parentAbort?: () => void;
  private parentSignal?: AbortSignal;

  constructor(parentSignal?: AbortSignal, concurrency = DEFAULT_CONCURRENCY) {
    this.semaphore = new Semaphore(
      Math.max(1, Math.min(DEFAULT_CONCURRENCY, Math.floor(concurrency))),
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

  schedule<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.sealed) return Promise.reject(new Error("Workflow is settling"));
    if (this.signal.aborted)
      return Promise.reject(new Error("Workflow was aborted"));
    if (this.callCount >= MAX_AGENT_CALLS) {
      return Promise.reject(
        new Error(
          `Workflow exceeded the limit of ${MAX_AGENT_CALLS} agent calls`,
        ),
      );
    }
    this.callCount++;

    const running = (async () => {
      await this.semaphore.acquire(this.signal);
      try {
        if (this.signal.aborted) throw new Error("Workflow was aborted");
        return await task(this.signal);
      } finally {
        this.semaphore.release();
      }
    })();
    this.tasks.add(running);
    void running.finally(() => this.tasks.delete(running)).catch(() => {});
    return running;
  }

  abort(_reason = "Workflow was aborted") {
    if (!this.signal.aborted) this.abortController.abort();
    this.semaphore.clear();
  }

  /** Seal the task registry and wait a bounded time for every task to settle. */
  async settle(options: { abort?: boolean; timeoutMs?: number } = {}) {
    this.sealed = true;
    if (options.abort) this.abort();
    const tasks = [...this.tasks];
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
      timer.unref?.();
    });
    const settled = Promise.allSettled(tasks).then(() => true as const);
    const completed = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    this.detachParent();
    return completed;
  }

  private detachParent() {
    if (this.parentAbort) {
      this.parentSignal?.removeEventListener("abort", this.parentAbort);
    }
    this.parentAbort = undefined;
    this.parentSignal = undefined;
  }
}
