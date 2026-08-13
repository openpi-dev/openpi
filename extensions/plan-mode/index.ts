/**
 * plan-mode: explore read-only, then get explicit approval before writing.
 *
 * `/plan` arms a session flag; while armed, a `tool_call` handler allows only
 * explicitly read-only tools and tells the model to finish planning instead.
 * `bash` is judged per command rather than as a whole (see `bash-policy.ts`),
 * because history and diffs are what a plan is grounded in.
 * `/plan done` asks the model to finalize through `plan_ready`; that explicit
 * terminating tool records the complete plan while keeping the write gate
 * closed. A later `/plan` lets the user continue planning or prefill an
 * implementation prompt in this session or a fresh linked session.
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

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  PLAN_MODE_CHANNEL,
  type PlanModeState,
} from "../shared/plan-mode-state.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { planBashDecision } from "./bash-policy.ts";

import {
  BLOCK_REASON,
  MAX_READY_PLAN_CHARS,
  MAX_READY_PLAN_UTF8_BYTES,
  PLAN_MODE_STATE_ENTRY,
  PLAN_READY_ACTIONS,
  PLAN_SAFE_TOOLS,
  buildPlanImplementationPrompt,
  latestAssistantToolCallCount,
  planReadyBatchDecision,
  planToolCallDecision,
  restorePlanModeState,
  type PersistedPlanModeState,
  type RestoredPlanModeState,
} from "./state.ts";
export {
  BLOCK_REASON,
  MAX_READY_PLAN_CHARS,
  MAX_READY_PLAN_UTF8_BYTES,
  PLAN_MODE_STATE_ENTRY,
  PLAN_READY_ACTIONS,
  PLAN_SAFE_TOOLS,
  buildPlanImplementationPrompt,
  latestAssistantToolCallCount,
  planReadyBatchDecision,
  planToolCallDecision,
  restorePlanModeState,
} from "./state.ts";
export type { PersistedPlanModeState, RestoredPlanModeState } from "./state.ts";
export default function planMode(pi: ExtensionAPI) {
  let planning = false;
  let readyPlan: string | undefined;

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
      readyPlan
        ? "plan mode · ready"
        : planning
          ? "plan mode · read-only"
          : undefined,
    );
  };

  const commitPlanState = (
    state: PersistedPlanModeState,
    ctx: {
      hasUI: boolean;
      ui: { setStatus: (key: string, value?: string) => void };
    },
  ) => {
    // Persist before mutating memory: a failed append must never open the gate
    // or discard a ready plan only in RAM.
    pi.appendEntry(PLAN_MODE_STATE_ENTRY, state);
    planning = state.status !== "inactive";
    readyPlan = state.status === "ready" ? state.plan : undefined;
    setStatus(ctx);
  };

  const clearPlan = (ctx: {
    hasUI: boolean;
    ui: { setStatus: (key: string, value?: string) => void };
  }) => {
    commitPlanState({ version: 1, status: "inactive" }, ctx);
  };

  const continuePlanning = (ctx: ExtensionCommandContext) => {
    commitPlanState({ version: 1, status: "planning" }, ctx);
    ctx.ui.notify(
      "Still in plan mode. Enter the revision you want; writes remain blocked.",
      "info",
    );
  };

  const implementHere = (ctx: ExtensionCommandContext) => {
    if (!readyPlan) {
      ctx.ui.notify("No ready plan is available.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Implementing a ready plan requires an interactive editor.",
        "warning",
      );
      return;
    }
    const prompt = buildPlanImplementationPrompt(readyPlan);
    ctx.ui.setEditorText(prompt);
    clearPlan(ctx);
    ctx.ui.notify(
      "Plan mode is off. Review the implementation prompt, then submit it when ready.",
      "info",
    );
  };

  const implementFresh = async (ctx: ExtensionCommandContext) => {
    if (!readyPlan) {
      ctx.ui.notify("No ready plan is available.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Starting a fresh implementation requires an interactive editor.",
        "warning",
      );
      return;
    }
    const prompt = buildPlanImplementationPrompt(readyPlan);
    const parentSession = ctx.sessionManager.getSessionFile();
    await ctx.waitForIdle();
    const result = await ctx.newSession({
      ...(parentSession ? { parentSession } : {}),
      withSession: async (nextCtx) => {
        nextCtx.ui.setEditorText(prompt);
        nextCtx.ui.notify(
          "Fresh implementation session ready. Review the prompt, then submit it when ready.",
          "info",
        );
      },
    });
    if (result.cancelled) {
      ctx.ui.notify(
        "Fresh session cancelled; the plan is still ready.",
        "info",
      );
    }
  };

  const showReadyActions = async (ctx: ExtensionCommandContext) => {
    if (!readyPlan) {
      ctx.ui.notify("No ready plan is available.", "warning");
      return;
    }
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Use `/plan implement`, `/plan fresh`, or `/plan off` in a UI session.",
        "warning",
      );
      return;
    }
    const choice = await ctx.ui.select(
      "Plan Ready — choose what happens next",
      Object.values(PLAN_READY_ACTIONS),
    );
    if (choice === PLAN_READY_ACTIONS.continue) {
      continuePlanning(ctx);
    } else if (choice === PLAN_READY_ACTIONS.current) {
      implementHere(ctx);
    } else if (choice === PLAN_READY_ACTIONS.fresh) {
      await implementFresh(ctx);
    }
  };

  pi.registerTool({
    name: "plan_ready",
    label: "Plan Ready",
    description:
      "Finish an active Plan Mode workflow with the complete implementation-ready Markdown plan; call it alone, only after research and material decisions are complete.",
    promptSnippet:
      "Complete active Plan Mode with one explicit implementation-ready plan",
    promptGuidelines: [
      "When Plan Mode is active and the plan is decision-complete, call plan_ready alone as the final action with the complete Markdown plan; do not infer approval or begin implementation.",
    ],
    parameters: Type.Object({
      plan: Type.String({
        minLength: 1,
        maxLength: MAX_READY_PLAN_CHARS,
        description: "The complete implementation-ready Markdown plan",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return {
          content: [
            { type: "text" as const, text: "Plan completion cancelled." },
          ],
          details: { status: "cancelled" as const },
          terminate: true,
        };
      }
      if (!planning) {
        throw new Error("plan_ready requires active Plan Mode.");
      }
      const plan = sanitizeTerminalText(params.plan).trim();
      if (!plan) throw new Error("plan_ready requires a non-empty plan.");
      if (
        new TextEncoder().encode(plan).byteLength > MAX_READY_PLAN_UTF8_BYTES
      ) {
        throw new Error(
          `plan_ready plans must be at most ${MAX_READY_PLAN_UTF8_BYTES} UTF-8 bytes.`,
        );
      }
      commitPlanState({ version: 1, status: "ready", plan }, ctx);
      ctx.ui.notify(
        "Plan ready. Run `/plan` to continue planning or prepare implementation.",
        "info",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Plan ready for explicit user action. No implementation has started.\n\n${plan}`,
          },
        ],
        details: { status: "ready" as const, plan },
        terminate: true,
      };
    },
  });

  pi.registerCommand("plan", {
    description:
      "Plan read-only, then use an explicit Plan Ready action: `/plan`, `/plan done`, `/plan implement`, `/plan fresh`, `/plan off`",
    handler: async (rawArgs, ctx) => {
      const action = rawArgs.trim().toLowerCase();

      if (action === "off" || action === "cancel") {
        clearPlan(ctx);
        ctx.ui.notify("Plan mode off. No implementation was started.", "info");
        return;
      }

      if (action === "implement" || action === "current") {
        implementHere(ctx);
        return;
      }

      if (action === "fresh") {
        await implementFresh(ctx);
        return;
      }

      if (action === "done" || action === "approve") {
        if (readyPlan) {
          await showReadyActions(ctx);
          return;
        }
        if (!planning) {
          ctx.ui.notify("Plan mode is not active.", "warning");
          return;
        }
        pi.sendMessage(
          {
            customType: "plan-finalize-requested",
            content:
              "Finalize the plan now. Resolve any remaining material ambiguity with ask_user; otherwise call plan_ready alone with the complete implementation-ready Markdown plan. Do not implement it.",
            display: true,
            details: {},
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        return;
      }

      if (readyPlan && !action) {
        await showReadyActions(ctx);
        return;
      }

      if (planning) {
        ctx.ui.notify(
          "Plan mode is already active. `/plan done` requests completion; `/plan off` cancels.",
          "info",
        );
        return;
      }

      commitPlanState({ version: 1, status: "planning" }, ctx);
      const objective = rawArgs.trim();
      pi.sendMessage(
        {
          customType: "plan-mode-armed",
          content:
            `Plan mode is on: investigate and propose a plan, but do not change anything yet. Edits and writes are blocked until the user explicitly chooses an implementation action. For files use the read, ls, grep and fd tools; bash is limited to read-only git and gh history commands such as \`git log\`, \`git diff\`, \`git status\`, \`git show\`, \`git blame\` and \`gh pr view\` — one plain command, no pipes or redirects. You can still delegate with \`subagent_spawn\` to explore several parts of the codebase at once: children spawned while planning receive read-only tools, so use them for investigation rather than for work to be done later.${objective ? `\n\nPlan for: ${objective}` : ""}` +
            "\n\nUse read-only tools to ground the plan. When it is decision-complete, call `plan_ready` alone with the complete Markdown plan. That records the plan but does not start implementation; the user chooses the next action with `/plan`.",
          display: true,
          details: {},
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    },
  });

  pi.on("tool_call", (event, ctx) => {
    if (!planning) return;
    if (readyPlan) {
      return {
        block: true as const,
        reason:
          "The plan is ready and the write gate remains closed. Wait for the user to choose the next action with `/plan`; do not call more tools.",
      };
    }
    const batchDecision =
      event.toolName === "plan_ready"
        ? planReadyBatchDecision(
            event.toolName,
            latestAssistantToolCallCount(ctx.sessionManager.getBranch()),
          )
        : undefined;
    if (batchDecision) return batchDecision;
    return planToolCallDecision(event.toolName, event.input);
  });

  const restoreRuntimeState = (ctx: ExtensionContext) => {
    const restored = restorePlanModeState(ctx.sessionManager.getBranch());
    planning = restored.planning;
    readyPlan = restored.readyPlan;
    setStatus(ctx);
    if (restored.error) ctx.ui.notify(restored.error, "error");
  };

  pi.on("session_start", (_event, ctx) => {
    restoreRuntimeState(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreRuntimeState(ctx);
  });

  pi.on("session_shutdown", () => {
    planning = false;
    readyPlan = undefined;
    // Broadcast without a ctx: subagents keeps its own copy of the stance, and
    // leaving it armed would restrict children in whatever session comes next.
    pi.events.emit(PLAN_MODE_CHANNEL, { planning } satisfies PlanModeState);
  });
}
