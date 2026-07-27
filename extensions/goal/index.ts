import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GOAL_CONTINUATION_TYPE, GoalController } from "./controller.ts";
import {
  GOAL_DEFAULTS,
  GOAL_LIMITS,
  createGoalSnapshot,
  isGoalUnfinished,
  type GoalInput,
  type GoalSnapshot,
} from "./state.ts";
import {
  compactGoal,
  renderGoalTool,
  statusColor,
  type GoalToolDetails,
} from "./ui.ts";

const TOOL_STATUSES = ["status"] as const;

export function parseGoalCommand(args: string) {
  const trimmed = args.trim();
  if (!trimmed) return { action: "status" as const };
  if (["status", "pause", "resume", "clear"].includes(trimmed)) {
    return { action: trimmed as "status" | "pause" | "resume" | "clear" };
  }
  return { action: "set" as const, objective: trimmed };
}

export function statusText(goal: GoalSnapshot | undefined, problem?: string) {
  if (problem) return `Session Goal locked: ${problem}`;
  if (!goal) return "No session goal is set.";
  return [
    `Session Goal [${goal.status}] ${goal.objective}`,
    `Success: ${goal.condition}`,
    `Turns: ${goal.iterations}/${goal.maxTurns}; no-progress: ${goal.noProgressCount}/${goal.noProgressCap}; active limit: ${goal.wallClockMinutes}m`,
    `Tokens: ${goal.parentTokens}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""} parent + ${goal.evaluatorTokens} evaluator (evaluator tokens are reported separately and do not consume the optional parent-run budget).`,
    ...(goal.reason ? [`Reason: ${goal.reason}`] : []),
  ].join("\n");
}

export default function sessionGoal(pi: ExtensionAPI) {
  const controller = new GoalController(pi);
  let lastContext: ExtensionContext | undefined;

  const updateUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const goal = controller.snapshot();
    if (!goal || !["active", "waiting"].includes(goal.status)) {
      ctx.ui.setStatus("session-goal", undefined);
      ctx.ui.setWidget("session-goal", undefined);
      return;
    }
    const evaluating = controller.isEvaluating();
    const label = compactGoal(goal, evaluating);
    ctx.ui.setStatus(
      "session-goal",
      ctx.ui.theme.fg(statusColor(goal, evaluating), `Goal: ${label}`),
    );
    ctx.ui.setWidget("session-goal", [
      ctx.ui.theme.fg(
        statusColor(goal, evaluating),
        `${evaluating ? "◌" : goal.status === "waiting" ? "◷" : "●"} Goal ${label}`,
      ),
    ]);
  };

  const notify = (
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  const setGoal = (input: GoalInput) => {
    const current = controller.snapshot();
    if (current && isGoalUnfinished(current)) {
      throw new Error(
        `An unfinished session goal already exists (${current.status}). Clear it with /goal clear before setting another.`,
      );
    }
    const goal = createGoalSnapshot(
      input,
      current?.revision ?? 0,
      Date.now(),
      controller.createId(),
    );
    controller.replace(goal);
    if (lastContext) updateUi(lastContext);
    return goal;
  };

  pi.registerTool({
    name: "goal_set",
    label: "Set Session Goal",
    description:
      "Set one persistent, bounded autonomous session goal. Use ONLY when the user explicitly requests an autonomous goal or autonomous continuation; never use for ordinary tasks, inferred intent, or as a worker completion signal. An unfinished goal must be cleared by the user before replacement.",
    promptSnippet:
      "Set a bounded persistent goal only after an explicit user request for autonomous continuation",
    promptGuidelines: [
      "Use goal_set only when the user explicitly asks to create an autonomous session goal; never infer one from an ordinary task.",
      "Neither goal_set nor goal_status can mark a goal complete; completion is decided by the external evaluator and hard limits.",
    ],
    parameters: Type.Object({
      objective: Type.String({
        minLength: 1,
        maxLength: GOAL_LIMITS.textChars,
      }),
      condition: Type.String({
        minLength: 1,
        maxLength: GOAL_LIMITS.textChars,
        description: "Observable success condition.",
      }),
      maxTurns: Type.Optional(
        Type.Integer({ minimum: 1, maximum: GOAL_LIMITS.maxTurns }),
      ),
      noProgressCap: Type.Optional(
        Type.Integer({ minimum: 1, maximum: GOAL_LIMITS.noProgressCap }),
      ),
      wallClockMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
      tokenBudget: Type.Optional(Type.Integer({ minimum: 1_000 })),
    }),
    execute(_id, params) {
      const goal = setGoal(params);
      return Promise.resolve({
        content: [
          {
            type: "text" as const,
            text: `Session goal set and active: ${goal.objective}`,
          },
        ],
        details: { goal, message: "Goal set." } satisfies GoalToolDetails,
      });
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("goal_set"))} ${theme.fg("muted", args.objective)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderGoalTool(
        result.details as GoalToolDetails | undefined,
        options.expanded,
        theme,
      );
    },
  });

  pi.registerTool({
    name: "goal_status",
    label: "Session Goal Status",
    description:
      "Read the persistent session goal, counters, budgets, and latest judge reason. This tool is read-only and cannot complete, pause, resume, clear, or replace the goal.",
    promptSnippet: "Read the current persistent session goal status",
    parameters: Type.Object({
      action: Type.Optional(StringEnum(TOOL_STATUSES)),
    }),
    execute() {
      const goal = controller.snapshot();
      const text = statusText(goal, controller.problem());
      return Promise.resolve({
        content: [{ type: "text" as const, text }],
        details: { goal, message: text } satisfies GoalToolDetails,
      });
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("goal_status")), 0, 0);
    },
    renderResult(result, options, theme) {
      return renderGoalTool(
        result.details as GoalToolDetails | undefined,
        options.expanded,
        theme,
      );
    },
  });

  pi.registerCommand("goal", {
    description:
      "Inspect or control the persistent bounded session goal: status | <objective> | pause | resume | clear",
    handler: async (args, ctx) => {
      lastContext = ctx;
      const parsed = parseGoalCommand(args);
      try {
        if (parsed.action === "status") {
          notify(ctx, statusText(controller.snapshot(), controller.problem()));
        } else if (parsed.action === "pause") {
          controller.pause();
          notify(ctx, "Session goal paused.");
        } else if (parsed.action === "resume") {
          controller.resume();
          notify(
            ctx,
            "Session goal resumed. Send the next prompt to provide fresh evidence and restart bounded continuation.",
          );
        } else if (parsed.action === "clear") {
          controller.clear();
          notify(ctx, "Session goal cleared.");
        } else {
          const condition =
            ctx.mode === "tui"
              ? await ctx.ui.input(
                  "Session goal success condition",
                  "Observable evidence that proves this objective is achieved",
                )
              : undefined;
          if (!condition) {
            notify(
              ctx,
              "Use goal_set with an explicit success condition outside TUI mode.",
              "warning",
            );
            return;
          }
          const objective = parsed.objective;
          if (!objective) return;
          const goal = setGoal({
            objective,
            condition,
            maxTurns: GOAL_DEFAULTS.maxTurns,
            noProgressCap: GOAL_DEFAULTS.noProgressCap,
            wallClockMinutes: GOAL_DEFAULTS.wallClockMinutes,
          });
          notify(ctx, `Session goal active: ${goal.objective}`);
        }
      } catch (error) {
        notify(
          ctx,
          error instanceof Error ? error.message : String(error),
          "warning",
        );
      } finally {
        updateUi(ctx);
      }
    },
  });

  pi.registerMessageRenderer(
    GOAL_CONTINUATION_TYPE,
    (message, _options, theme) =>
      new Text(
        theme.fg(
          "accent",
          `↻ Goal continuation · ${typeof message.content === "string" ? message.content : "autonomous turn"}`,
        ),
        0,
        0,
      ),
  );

  pi.on("session_start", (_event, ctx) => {
    lastContext = ctx;
    controller.restore(ctx, true);
    if (controller.problem()) {
      notify(
        ctx,
        `Session goal locked: ${controller.problem()}. Navigate to a clean branch or start a new session.`,
        "warning",
      );
    }
    updateUi(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    lastContext = ctx;
    controller.restore(ctx, true);
    updateUi(ctx);
  });

  // agent_start fires for both user prompts and extension-triggered
  // continuations; before_agent_start only covers the former.
  pi.on("agent_start", (_event, ctx) => {
    lastContext = ctx;
    controller.beforeAgentStart(ctx);
    updateUi(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    lastContext = ctx;
    updateUi(ctx);
    await controller.settled(ctx);
    updateUi(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown();
    if (ctx.hasUI) {
      ctx.ui.setStatus("session-goal", undefined);
      ctx.ui.setWidget("session-goal", undefined);
    }
  });
}
