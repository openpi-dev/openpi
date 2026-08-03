/**
 * plan-mode: explore read-only, then get explicit approval before writing.
 *
 * `/plan` arms a session flag; while armed, a `tool_call` handler allows only
 * explicitly read-only tools and tells the model to finish planning instead.
 * `/plan done` (or the model calling nothing at all) presents the plan for
 * approval.
 *
 * SCOPE, deliberately stated: this gates only THIS interactive session. A
 * tool_call handler cannot reach a headless subagent's or a workflow child's
 * writes — those run in their own sessions — so delegation is blocked rather
 * than pretending to gate what a child does.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fail-closed allow-list for planning. Unknown and newly installed tools are
 * blocked until they are deliberately classified here as observational.
 * `bash` is absent wholesale: deciding whether an arbitrary command is
 * read-only is impossible at this boundary.
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
  // Advisory state reads and an explicit user clarification.
  "tasks_list",
  "get_goal",
  "ask_user",
]);

const BLOCK_REASON =
  "Plan mode is active: no changes yet. Keep investigating with read-only tools (read, fd, rg, web search) and present your plan. The user runs `/plan done` to approve it, or `/plan off` to cancel.";

export function planToolCallDecision(toolName: string) {
  if (PLAN_SAFE_TOOLS.has(toolName)) return;
  return { block: true as const, reason: BLOCK_REASON };
}

export default function planMode(pi: ExtensionAPI) {
  let planning = false;

  const setStatus = (ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, value?: string) => void };
  }) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "plan-mode",
      planning ? "plan mode · read-only" : undefined,
    );
  };

  pi.registerCommand("plan", {
    description:
      "Plan before changing anything: `/plan` blocks edits while you explore, `/plan done` approves, `/plan off` cancels",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase();

      if (action === "off" || action === "cancel") {
        planning = false;
        setStatus(ctx);
        ctx.ui.notify("Plan mode off. No plan was approved.", "info");
        return;
      }

      if (action === "done" || action === "approve") {
        if (!planning) {
          ctx.ui.notify("Plan mode is not active.", "warning");
          return;
        }
        // Two-way only: Pi has no per-edit approval gate to toggle, so an
        // "approve and auto-accept edits" choice would promise nothing real.
        const choice = ctx.hasUI
          ? await ctx.ui.select("Approve the plan and start making changes?", [
              "Approve — start making changes",
              "Keep planning",
            ])
          : "Approve — start making changes";
        if (choice !== "Approve — start making changes") {
          ctx.ui.notify("Still in plan mode.", "info");
          return;
        }
        planning = false;
        setStatus(ctx);
        pi.sendMessage(
          {
            customType: "plan-approved",
            content:
              "The user approved the plan. Plan mode is off — carry it out now, starting with the first step.",
            display: true,
            details: {},
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        return;
      }

      if (planning) {
        ctx.ui.notify(
          "Plan mode is already active. `/plan done` approves, `/plan off` cancels.",
          "info",
        );
        return;
      }

      planning = true;
      setStatus(ctx);
      const objective = rawArgs.trim();
      pi.sendMessage(
        {
          customType: "plan-mode-armed",
          content:
            `Plan mode is on: investigate and propose a plan, but do not change anything yet. Edits, writes, bash, and delegation are blocked until the user approves.${objective ? `\n\nPlan for: ${objective}` : ""}` +
            "\n\nUse read-only tools to ground the plan, then present it concisely and stop. The user will run `/plan done` to approve.",
          display: true,
          details: {},
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  pi.on("tool_call", (event) => {
    if (!planning) return;
    return planToolCallDecision(event.toolName);
  });

  pi.on("session_start", (_event, ctx) => {
    // Plan mode is a within-session stance; never inherit it across a
    // restart, where the user has no visible reminder it is armed.
    planning = false;
    setStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    planning = false;
  });
}
