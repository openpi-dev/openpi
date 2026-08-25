export interface WorkflowLaunchPolicyInput {
  wait?: boolean;
  background?: boolean;
}

export interface WorkflowLaunchPolicy {
  wait: boolean;
  detached: boolean;
  migrationWarning?: string;
}

function backgroundMigrationWarning(background: boolean) {
  return `Deprecated Workflow parameter "background": replace background: ${background} with wait: ${!background}. "background" will be removed in the next breaking release.`;
}

/** Resolve the caller's launch policy and warn on the legacy inverse alias. */
export function resolveWorkflowLaunchPolicy(
  input: WorkflowLaunchPolicyInput,
  canDeliverLater: boolean,
): WorkflowLaunchPolicy {
  const migrationWarning =
    input.background === undefined
      ? undefined
      : backgroundMigrationWarning(input.background);
  if (
    input.wait !== undefined &&
    input.background !== undefined &&
    input.wait === input.background
  ) {
    throw new Error(
      `${migrationWarning} wait and background conflict because background is the inverse of wait; remove background and provide only wait.`,
    );
  }
  const wait =
    input.wait ??
    (input.background !== undefined ? !input.background : !canDeliverLater);
  if (!wait && !canDeliverLater) {
    throw new Error(
      `${migrationWarning ? `${migrationWarning} ` : ""}This host cannot deliver a workflow result later; use wait: true.`,
    );
  }
  return {
    wait,
    detached: !wait,
    ...(migrationWarning ? { migrationWarning } : {}),
  };
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
