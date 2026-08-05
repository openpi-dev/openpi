/**
 * plan-mode: explore read-only, then get explicit approval before writing.
 *
 * `/plan` arms a session flag; while armed, a `tool_call` handler allows only
 * explicitly read-only tools and tells the model to finish planning instead.
 * `bash` is judged per command rather than as a whole (see `bash-policy.ts`),
 * because history and diffs are what a plan is grounded in.
 * `/plan done` (or the model calling nothing at all) presents the plan for
 * approval.
 *
 * SCOPE, deliberately stated: a `tool_call` handler gates only THIS
 * interactive session. It cannot reach a headless subagent's or a workflow
 * child's writes — those run in their own sessions.
 *
 * Delegation is still allowed, because that limitation is answered elsewhere:
 * `subagent_spawn` narrows a child to `PLAN_MODE_CHILD_TOOLS` (see
 * `../shared/plan-mode-state.ts`), and a child tool allowlist is enforced by
 * the harness rather than by prompt. Blocking it outright was the first
 * answer and it was the wrong trade: parallel read-only exploration, kept out
 * of the main context, is one of the most useful things to do while planning.
 * `workflow` stays blocked because `agent_type` is optional and the DSL has
 * no run-wide plan-mode narrowing: an untyped or implementation call may
 * still write. `subagent_send` stays blocked because it resumes a child that
 * may predate the plan and still hold the full tool set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PLAN_MODE_CHANNEL,
  type PlanModeState,
} from "../shared/plan-mode-state.ts";
import { planBashDecision } from "./bash-policy.ts";

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
]);

export const BLOCK_REASON =
  "Plan mode is active: no changes yet. Keep investigating with read-only tools (read, fd, rg, web search, read-only bash like git log/diff/status, and subagent_spawn for parallel exploration — planning children get read-only tools) and present your plan. The user runs `/plan done` to approve it, or `/plan off` to cancel.";

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

export default function planMode(pi: ExtensionAPI) {
  let planning = false;

  /**
   * Publish the stance and reflect it in the footer. Every place `planning`
   * changes goes through here, because a subagent spawned while the broadcast
   * was stale would be a child with write tools during a plan — the one thing
   * this extension exists to prevent.
   */
  const setStatus = (ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, value?: string) => void };
  }) => {
    pi.events.emit(PLAN_MODE_CHANNEL, { planning } satisfies PlanModeState);
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
            `Plan mode is on: investigate and propose a plan, but do not change anything yet. Edits and writes are blocked until the user approves. For files use the read, ls, grep and fd tools; bash is limited to read-only git and gh history commands such as \`git log\`, \`git diff\`, \`git status\`, \`git show\`, \`git blame\` and \`gh pr view\` — one plain command, no pipes or redirects. You can still delegate with \`subagent_spawn\` to explore several parts of the codebase at once: children spawned while planning receive read-only tools, so use them for investigation rather than for work to be done later.${objective ? `\n\nPlan for: ${objective}` : ""}` +
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
    return planToolCallDecision(event.toolName, event.input);
  });

  pi.on("session_start", (_event, ctx) => {
    // Plan mode is a within-session stance; never inherit it across a
    // restart, where the user has no visible reminder it is armed.
    planning = false;
    setStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    planning = false;
    // Broadcast without a ctx: subagents keeps its own copy of the stance, and
    // leaving it armed would restrict children in whatever session comes next.
    pi.events.emit(PLAN_MODE_CHANNEL, { planning } satisfies PlanModeState);
  });
}
