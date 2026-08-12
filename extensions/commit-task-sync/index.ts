/**
 * commit-task-sync: detect successful `git commit` → remind agent to sync tasks.
 *
 * **Problem**: openpi tasks are session-scoped intent tracking with no auto-sync.
 * When an agent commits + pushes (real progress) but forgets `tasks_update`,
 * tasks drift from reality (e.g., T4 blocked→done by owner authorization,
 * but task still shows blocked).
 *
 * **Pattern**: post-edit extension (`pi.on("tool_result")` + `pi.on("agent_settled")`).
 * - `tool_result` handler: hot path, only flips a boolean flag (no await/exec).
 * - `agent_settled`: debounces a turn's commit burst into ONE reminder.
 * - Fire-and-forget: `ctx.ui.notify` is best-effort, never blocks the pipeline.
 *
 * **Trust surface**: detect `git commit` string in bash command + `!event.isError`.
 * Does NOT execute commands, does NOT auto-modify tasks (agent decides).
 *
 * **Limitation**: `ui.notify` is advisory (agent may miss it). A stronger version
 * would inject a system-prompt or context hint on the next turn, but that requires
 * the context-injection hook (see injectTaskProjection in tasks/index.ts).
 * This first version uses notify — minimal, safe, non-blocking.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Bash commands that indicate a commit happened. */
const COMMIT_PATTERNS = [
  /\bgit\s+commit\b/,
];

export default function commitTaskSync(pi: ExtensionAPI) {
  let committedThisTurn = false;
  let generation = 0;

  /**
   * tool_result: hot path. Only flip a boolean.
   * Detects bash tool success with `git commit` in the command.
   */
  pi.on(
    "tool_result",
    (event: { toolName: string; isError?: boolean; input?: unknown; params?: unknown }) => {
      if (event.isError) return;
      if (event.toolName !== "bash") return;

      // Extract command string from event (field name varies by pi version;
      // try common shapes: input.command, params.command, params, input as string)
      const command = extractCommand(event);
      if (!command) return;

      if (COMMIT_PATTERNS.some((pattern) => pattern.test(command))) {
        committedThisTurn = true;
      }
    },
  );

  /**
   * agent_settled: turn ended. If committed this turn, remind agent to sync tasks.
   * Debounces multiple commits in one turn into a single reminder.
   */
  pi.on("agent_settled", (_event: unknown, ctx: ExtensionContext) => {
    if (!committedThisTurn) return;
    committedThisTurn = false;

    // Only in interactive TUI (not headless RPC, like post-edit).
    if (ctx.mode !== "tui" || !ctx.hasUI) return;

    try {
      ctx.ui.notify(
        "⚠️ git commit 检测到 — 请检查 tasks 状态同步（如有完成项，tasks_update done 带 commit SHA）",
        "warning",
      );
    } catch {
      // Session may have ended; best-effort notification.
    }
  });

  /** Reset on session lifecycle. */
  pi.on("session_start", () => {
    generation++;
    committedThisTurn = false;
  });

  pi.on("session_shutdown", () => {
    generation++;
    committedThisTurn = false;
  });
}

/**
 * Extract the bash command string from a tool_result event.
 * Pi's event shape may vary; try common field names.
 */
function extractCommand(event: {
  input?: unknown;
  params?: unknown;
}): string | null {
  // Try input.command (object with command field)
  const fromInput =
    typeof event.input === "object" && event.input !== null
      ? (event.input as Record<string, unknown>).command
      : undefined;
  if (typeof fromInput === "string") return fromInput;

  // Try params.command
  const fromParams =
    typeof event.params === "object" && event.params !== null
      ? (event.params as Record<string, unknown>).command
      : undefined;
  if (typeof fromParams === "string") return fromParams;

  // Try input as string directly
  if (typeof event.input === "string") return event.input;

  // Try params as string directly
  if (typeof event.params === "string") return event.params;

  return null;
}
