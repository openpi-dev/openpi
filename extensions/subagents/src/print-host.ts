/**
 * Print / RPC hosts cannot re-invoke the parent after agent_settled.
 * Workflows already wait on non-delivery hosts; subagent spawn text still
 * tells the model it may end the turn.
 */

export function canDeliverLaterFromHost(host: {
  hasUI?: boolean;
  mode?: string;
}): boolean {
  return host.hasUI === true && host.mode === "tui";
}

export function printHostNeedsFollowUp(
  canDeliverLater: boolean,
  runningDirectCount: number,
): boolean {
  return !canDeliverLater && runningDirectCount > 0;
}

export function buildPrintHostPendingFollowUp(ids: readonly string[]): string {
  const listed = ids.join(", ");
  return (
    `This is a single-invocation non-interactive host. Subagents still running: ${listed}. ` +
    `You MUST call subagent_wait(ids: ${JSON.stringify(ids)}) now. ` +
    `Ending the turn loses their results; there is no automatic re-invoke.`
  );
}

export function buildNonInteractiveSpawnContinuation(id: string): string {
  return (
    `This host cannot re-invoke you after you end the turn. ` +
    `You MUST call subagent_wait(ids: ["${id}"]) before ending. ` +
    `Do not end the turn while this child is running.`
  );
}
