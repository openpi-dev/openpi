import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SETUP_APPLY_CHANNEL = "openpi:setup-apply";
interface ApplyRequest {
  readonly tasks: Promise<void>[];
}

/** Pi owns subscription lifetime; errors travel through explicit receipts. */
export function onSetupApply(
  pi: Pick<ExtensionAPI, "events">,
  apply: () => void | Promise<void>,
) {
  return pi.events.on(SETUP_APPLY_CHANNEL, (value) => {
    const request = value as ApplyRequest;
    try {
      request.tasks.push(Promise.resolve(apply()));
    } catch (error) {
      request.tasks.push(Promise.reject(error));
    }
  });
}

export async function applySetupConfiguration(
  pi: Pick<ExtensionAPI, "events">,
) {
  const request: ApplyRequest = { tasks: [] };
  pi.events.emit(SETUP_APPLY_CHANNEL, request);
  const results = await Promise.allSettled(request.tasks);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Configuration consumer failed");
}
