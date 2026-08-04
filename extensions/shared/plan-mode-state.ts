/**
 * The read-only stance `/plan` puts a session in, shared between the extension
 * that owns it (plan-mode) and the extensions that must honour it (subagents).
 *
 * Why a shared module rather than a check inside plan-mode: a `tool_call`
 * handler only sees THIS session, and a subagent runs in its own. Blocking
 * delegation outright was the first answer and it was wrong — exploring a
 * codebase across several subsystems in parallel, without dragging the noise
 * into the main context, is one of the most useful things to do while
 * planning. What makes it safe is that the child tool allowlist is enforced by
 * the harness, not by prompt: a child spawned with these tools has no `write`,
 * `edit`, or `bash` to call, so it cannot break the promise that nothing
 * changes before the user approves.
 */

/**
 * Tools a child may keep while the parent is planning. Investigation only:
 * anything that mutates a file, runs a command, or reaches the network is
 * absent, and unknown tools (including a third party's) are excluded by the
 * allowlist being an allowlist.
 *
 * `bash` is absent even though plan mode admits read-only commands in the
 * parent: that gate reads the command string, and nothing here can inspect
 * what a child would run before it runs it.
 */
export const PLAN_MODE_CHILD_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "fd",
  "rg",
];

/** Broadcast when the session's planning stance changes. */
export const PLAN_MODE_CHANNEL = "my-pi-setup:plan-mode";

export interface PlanModeState {
  /** True while `/plan` is armed and nothing may change yet. */
  readonly planning: boolean;
}

/**
 * Narrow an agent type's allowlist to what planning permits.
 *
 * Intersects rather than replaces, so a type that already restricts itself
 * further keeps its own limit: planning may only ever REMOVE capability, never
 * hand a child something its type withheld.
 */
export function planModeChildTools(
  requested: readonly string[] | undefined,
): readonly string[] {
  if (!requested) return [...PLAN_MODE_CHILD_TOOLS];
  return requested.filter((tool) => PLAN_MODE_CHILD_TOOLS.includes(tool));
}
