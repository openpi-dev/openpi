/**
 * Post-edit policy layer (DDD): pure tool/command gating. Zero I/O.
 */

/** Tools whose success means a file on disk changed. */
const MUTATING_TOOLS = new Set(["write", "edit"]);

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

/** Whether a pending command run may start (drain guard, pure). */
export function shouldRunCommand(
  pendingRuns: number,
  active: boolean,
  command: string,
): boolean {
  return pendingRuns > 0 && !active && command.length > 0;
}
