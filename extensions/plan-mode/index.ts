/**
 * plan-mode: explore read-only, then get explicit approval before writing.
 *
 * `/plan` arms a session flag; while armed, a `tool_call` handler blocks the
 * mutating tools and tells the model to finish planning instead. `/plan done`
 * (or the model calling nothing at all) presents the plan for approval.
 *
 * SCOPE, deliberately stated: this gates only THIS interactive session. A
 * tool_call handler cannot reach a headless subagent's or a workflow child's
 * writes — those run in their own sessions — so plan mode also blocks the
 * tools that would spawn them rather than pretending to gate what they do.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Tools blocked while planning. `bash` is blocked wholesale: its input is an
 * arbitrary command string, so "is this read-only?" is undecidable, and a
 * leaky gate is worse than an explicit one. Read/grep/find/ls/fd/rg stay
 * available — a planner that cannot investigate is useless.
 */
export const BLOCKED_TOOLS = new Set([
  "edit",
  "write",
  "bash",
  // Delegation would escape the gate entirely: a child session's writes are
  // not visible to this handler.
  "subagent_spawn",
  "subagent_send",
  "workflow",
  "bg_start",
  // Destructive control of work already in flight is not "planning" either.
  "bg_kill",
  "subagent_cancel",
  "workflow_stop",
  // A durable, cross-session write to the package config on disk.
  "configure_my_pi_setup",
  // Compacting away the context being planned in is itself irreversible.
  "context_pivot",
]);

const BLOCK_REASON =
  "Plan mode is active: no changes yet. Keep investigating with read-only tools (read, grep, find, ls, fd, rg) and present your plan. The user runs `/plan done` to approve it, or `/plan off` to cancel.";

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
    if (!BLOCKED_TOOLS.has(event.toolName)) return;
    return { block: true, reason: BLOCK_REASON };
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
