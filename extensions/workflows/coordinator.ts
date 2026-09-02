export interface WorkflowLaunchPolicyInput {
  wait?: boolean;
}

/** Resolve the caller's launch preference to one positive runtime mode. */
export function resolveWorkflowLaunchMode(
  input: WorkflowLaunchPolicyInput,
  canDeliverLater: boolean,
) {
  const wait = input.wait ?? !canDeliverLater;
  if (!wait && !canDeliverLater) {
    throw new Error(
      "This host cannot deliver a workflow result later; use wait: true",
    );
  }
  return wait ? "inline" : "detached";
}

/**
 * Arbitrate an inline wait against caller cancellation without transferring
 * ownership of the workflow run to the wait signal.
 */
export async function waitForWorkflowCompletion(
  completion: Promise<unknown>,
  signal?: AbortSignal,
): Promise<"terminal" | "aborted"> {
  if (!signal) {
    await completion.catch(() => {});
    return "terminal";
  }
  if (signal.aborted) return "aborted";

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const terminal = completion.then(
    () => "terminal" as const,
    () => "terminal" as const,
  );
  try {
    return await Promise.race([terminal, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
