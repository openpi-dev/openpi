/**
 * Plan-mode domain layer (DDD): pure decision functions and fail-closed
 * allow-lists. Zero I/O, zero ui — every branch here is unit-testable.
 * `planToolCallDecision` answers "may this tool call proceed while planning?";
 * `restorePlanModeState` fails closed on malformed persisted state.
 */

import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { planBashDecision } from "./bash-policy.ts";

export const MAX_READY_PLAN_CHARS = 50_000;
export const MAX_READY_PLAN_UTF8_BYTES = 48_000;
export const PLAN_MODE_STATE_ENTRY = "my-pi-setup-plan-mode-state";

export type PersistedPlanModeState =
  | { version: 1; status: "inactive" | "planning" }
  | { version: 1; status: "ready"; plan: string };

export interface RestoredPlanModeState {
  planning: boolean;
  readyPlan?: string;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedReadyPlan(value: unknown): value is string {
  return (
    typeof value === "string" &&
    sanitizeTerminalText(value) === value &&
    value.trim().length > 0 &&
    value.length <= MAX_READY_PLAN_CHARS &&
    new TextEncoder().encode(value.trim()).byteLength <=
      MAX_READY_PLAN_UTF8_BYTES
  );
}

function decodePlanModeState(data: unknown): RestoredPlanModeState | undefined {
  if (
    !isRecord(data) ||
    data.version !== 1 ||
    typeof data.status !== "string"
  ) {
    return;
  }
  const keys = Object.keys(data).sort().join(",");
  if (data.status === "inactive" || data.status === "planning") {
    if (keys !== "status,version") return;
    return { planning: data.status === "planning" };
  }
  if (data.status === "ready" && keys === "plan,status,version") {
    if (!isBoundedReadyPlan(data.plan)) return;
    return { planning: true, readyPlan: data.plan.trim() };
  }
}

export function latestAssistantToolCallCount(entries: readonly unknown[]) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "message") continue;
    const message = entry.message;
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) return 0;
    return message.content.filter(
      (part) => isRecord(part) && part.type === "toolCall",
    ).length;
  }
  return 0;
}

export function planReadyBatchDecision(toolName: string, callCount: number) {
  if (toolName !== "plan_ready" || callCount === 1) return;
  return {
    block: true as const,
    reason:
      "plan_ready must be the only tool call in its assistant message so Pi can terminate planning deterministically. Retry it alone after the other tool results return.",
  };
}

/** Restore only the newest branch-local state; malformed state fails closed. */
export function restorePlanModeState(
  entries: readonly unknown[],
): RestoredPlanModeState {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (
      !isRecord(entry) ||
      entry.type !== "custom" ||
      entry.customType !== PLAN_MODE_STATE_ENTRY
    ) {
      continue;
    }
    return (
      decodePlanModeState(entry.data) ?? {
        planning: true,
        error:
          "The latest persisted Plan Mode state is malformed; writes remain blocked. Use `/plan off` to clear it explicitly.",
      }
    );
  }
  return { planning: false };
}

export const PLAN_READY_ACTIONS = {
  continue: "Continue planning",
  current: "Implement in this session",
  fresh: "Start a fresh session",
} as const;

export function buildPlanImplementationPrompt(plan: string) {
  return [
    "Implement the approved plan below. Re-check the repository state before editing, follow the project instructions, and verify the finished change.",
    "",
    "--- APPROVED PLAN ---",
    plan,
    "--- END APPROVED PLAN ---",
  ].join("\n");
}

/**
 * Fail-closed allow-list for planning. Unknown and newly installed tools are
 * blocked until they are deliberately classified here as observational.
 * `bash` is absent from this set on purpose but is NOT blocked outright:
 * whether an arbitrary command is read-only cannot be decided by tool name, so
 * it is decided one level down, per command, by `planBashDecision`.
 */
export const PLAN_SAFE_TOOLS = new Set([
  // Local repository investigation.
  "read",
  "grep",
  "find",
  "ls",
  "fd",
  "rg",
  // Web research without write actions.
  "web_search",
  "source_check",
  "fetch_content",
  "get_search_content",
  // Read-only inspection of work already in flight.
  "bg_status",
  "bg_list",
  "bg_watch",
  "subagent_check",
  "subagent_list",
  "subagent_wait",
  "workflow_status",
  // Delegated investigation. Exploring several subsystems in parallel without
  // dragging the noise into the main context is one of the most useful things
  // to do while planning, so spawning is allowed — but only because the
  // child's tool allowlist is enforced by the harness. See
  // `plan-mode-state.ts`: subagents narrows a planning child to
  // PLAN_MODE_CHILD_TOOLS, which has no write, edit, or bash in it. A
  // tool_call handler could never gate a child's writes itself, since the
  // child runs in its own session.
  //
  // `subagent_send` is NOT here for the same reason: it resumes an existing
  // child's session, and one started before `/plan` was armed still holds the
  // full tool set. Narrowing applies at spawn, so only spawning is safe.
  "subagent_spawn",
  // Advisory state reads and an explicit user clarification.
  "tasks_list",
  "get_goal",
  "ask_user",
  // The model's explicit, terminating transition from planning to ready.
  "plan_ready",
]);

export const BLOCK_REASON =
  "Plan mode is active: no changes yet. Keep investigating with read-only tools (read, fd, rg, web search, read-only bash like git log/diff/status, and subagent_spawn for parallel exploration — planning children get read-only tools). When the plan is decision-complete, call plan_ready alone with the complete Markdown plan; the user then chooses the next action with `/plan`, or cancels with `/plan off`.";

export function planToolCallDecision(
  toolName: string,
  input?: Record<string, unknown>,
) {
  // Creating a worktree changes Git metadata before the child even starts;
  // delegation is safe in plan mode only in the existing checkout.
  if (toolName === "subagent_spawn" && input?.isolation === "worktree") {
    return {
      block: true as const,
      reason: `Plan mode cannot create an isolated worktree. Omit isolation for read-only delegation. ${BLOCK_REASON}`,
    };
  }
  if (PLAN_SAFE_TOOLS.has(toolName)) return;
  // bash is decided per command, not per tool: the read-only investigation a
  // plan is built on (history, diffs, PR state) lives behind it.
  if (toolName === "bash") {
    const decision = planBashDecision(input?.command);
    if (decision.allowed) return;
    return {
      block: true as const,
      reason: `${decision.reason ?? "plan mode could not verify this command is read-only"}. ${BLOCK_REASON}`,
    };
  }
  return { block: true as const, reason: BLOCK_REASON };
}
