export interface WorkflowLaunchPolicyInput {
  wait?: boolean;
  background?: boolean;
}

export interface WorkflowLaunchPolicy {
  wait: boolean;
  detached: boolean;
}

/** Resolve legacy/background and host capability without silently changing semantics. */
export function resolveWorkflowLaunchPolicy(
  input: WorkflowLaunchPolicyInput,
  canDeliverLater: boolean,
): WorkflowLaunchPolicy {
  if (
    input.wait !== undefined &&
    input.background !== undefined &&
    input.wait === input.background
  ) {
    throw new Error(
      "wait and background conflict: background is the deprecated inverse of wait",
    );
  }
  const wait =
    input.wait ??
    (input.background !== undefined ? !input.background : !canDeliverLater);
  if (!wait && !canDeliverLater) {
    throw new Error(
      "This host cannot deliver a workflow result later; use wait: true",
    );
  }
  return { wait, detached: !wait };
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
