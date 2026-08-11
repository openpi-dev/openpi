import { SessionManager } from "@earendil-works/pi-coding-agent";

export interface WorkflowOperatorActivation {
  key: string;
  fingerprint: string;
  cwd: string;
  signal?: AbortSignal;
}

type OperatorEntry = {
  fingerprint: string;
  cwd: string;
  sessionManager: SessionManager;
  tail: Promise<void>;
};

export function normalizeWorkflowOperatorKey(key: string) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._:-]{1,80}$/.test(key)) {
    throw new Error(
      "Workflow operator key must be 1-80 ASCII letters, digits, or ._:- characters",
    );
  }
  return key;
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Workflow operator activation was aborted");
  error.name = "AbortError";
  return error;
}

function invokeAfter<T>(
  turn: Promise<void>,
  signal: AbortSignal | undefined,
  invoke: () => T | PromiseLike<T>,
) {
  if (!signal) return turn.then(invoke);
  if (signal.aborted) return Promise.reject(abortError(signal));

  return new Promise<T>((resolve, reject) => {
    let waiting = true;
    const onAbort = () => {
      if (!waiting) return;
      waiting = false;
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void turn.then(
      () => {
        if (!waiting) return;
        if (signal.aborted) {
          onAbort();
          return;
        }
        waiting = false;
        signal.removeEventListener("abort", onAbort);
        try {
          Promise.resolve(invoke()).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      },
      (error) => {
        if (!waiting) return;
        waiting = false;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Per-run, in-process operator sessions. Nothing in this registry is persisted
 * or shared with another process.
 */
export class WorkflowOperatorRegistry {
  private readonly operators = new Map<string, OperatorEntry>();
  private closed = false;
  private closePromise?: Promise<void>;

  activate<T>(
    activation: WorkflowOperatorActivation,
    invoke: (sessionManager: SessionManager) => T | PromiseLike<T>,
  ) {
    if (this.closed) {
      return Promise.reject(new Error("Workflow operator registry is closed"));
    }

    const key = normalizeWorkflowOperatorKey(activation.key);
    let operator = this.operators.get(key);
    if (!operator) {
      operator = {
        fingerprint: activation.fingerprint,
        cwd: activation.cwd,
        sessionManager: SessionManager.inMemory(activation.cwd),
        tail: Promise.resolve(),
      };
      this.operators.set(key, operator);
    } else if (
      operator.fingerprint !== activation.fingerprint ||
      operator.cwd !== activation.cwd
    ) {
      return Promise.reject(
        new Error(`Workflow operator identity mismatch for "${key}"`),
      );
    }
    const previous = operator.tail;
    const result = invokeAfter(previous, activation.signal, () =>
      invoke(operator.sessionManager),
    );
    operator.tail = Promise.allSettled([previous, result]).then(
      () => undefined,
    );
    return result;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const queues = [...this.operators.values()].map(
      (operator) => operator.tail,
    );
    this.closePromise = Promise.allSettled(queues).then(() => {
      this.operators.clear();
    });
    return this.closePromise;
  }
}
