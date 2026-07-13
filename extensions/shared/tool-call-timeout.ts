import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const CHILD_TOOL_CALL_TIMEOUT_MS = 3 * 60 * 1_000;

interface ToolRegistry {
  getAllTools(): Array<{ name: string }>;
  getToolDefinition(name: string): ToolDefinition | undefined;
}

function formatTimeout(timeoutMs: number) {
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  if (timeoutMs % 1_000 === 0) {
    const seconds = timeoutMs / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${timeoutMs} ms`;
}

export class ToolCallTimeoutError extends Error {
  constructor(toolName: string, timeoutMs: number) {
    super(
      `Tool call "${toolName}" timed out after ${formatTimeout(timeoutMs)}.`,
    );
    this.name = "ToolCallTimeoutError";
  }
}

export async function runWithToolCallTimeout<T>(
  toolName: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  execute: (signal: AbortSignal) => Promise<T>,
) {
  const timeoutController = new AbortController();
  const executionSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;
  const timeoutError = new ToolCallTimeoutError(toolName, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(timeoutError);
      timeoutController.abort(timeoutError);
    }, timeoutMs);
  });

  let removeAbortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    const onAbort = () => {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error(`Tool call "${toolName}" was aborted.`),
      );
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([execute(executionSignal), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

/**
 * Wrap every currently registered child tool with an independent execution
 * timeout. Calling apply() again is safe and picks up tools registered later.
 */
export function createToolCallTimeoutGuard(
  timeoutMs = CHILD_TOOL_CALL_TIMEOUT_MS,
) {
  const wrapped = new WeakSet<ToolDefinition>();

  const wrap = (definition: ToolDefinition) => {
    if (wrapped.has(definition)) return;
    wrapped.add(definition);

    const execute = definition.execute;
    definition.execute = async (toolCallId, params, signal, onUpdate, ctx) =>
      runWithToolCallTimeout(definition.name, timeoutMs, signal, (signal) =>
        execute.call(definition, toolCallId, params, signal, onUpdate, ctx),
      );
  };

  return {
    apply(session: ToolRegistry) {
      for (const { name } of session.getAllTools()) {
        const definition = session.getToolDefinition(name);
        if (definition) wrap(definition);
      }
    },
  };
}
