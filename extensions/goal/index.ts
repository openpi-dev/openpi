import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { GOAL_CONTINUATION_TYPE, GoalController } from "./controller.ts";
import { vetGoalContract } from "./evaluator.ts";
import {
  GOAL_DEFAULTS,
  GOAL_LIMITS,
  createGoalSnapshot,
  isGoalUnfinished,
  normalizeGoalContract,
  type GoalInput,
  type GoalSnapshot,
} from "./state.ts";
import {
  compactGoal,
  goalContinuationLabel,
  renderGoalTool,
  statusColor,
  truncateGoalObjective,
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

export function goalConditionRequiredMessage(mode: ExtensionContext["mode"]) {
  return mode === "tui"
    ? "Goal not set: a finite, observable success condition is required."
    : "Use goal_set with an explicit success condition outside TUI mode.";
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

export async function admitGoalInput(
  input: GoalInput,
  ctx: ExtensionContext,
  signal: AbortSignal,
  vet: typeof vetGoalContract = vetGoalContract,
) {
  const contract = normalizeGoalContract(input.objective, input.condition);
  let review: Awaited<ReturnType<typeof vetGoalContract>>;
  try {
    review = await vet({ ctx, ...contract, signal });
  } catch (error) {
    throw new Error(
      `Goal not set because its success condition could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!review.verifiable) throw new Error(`Goal not set: ${review.reason}`);
  return { ...input, ...contract };
}

export interface SessionGoalOptions {
  vet?: typeof vetGoalContract;
}

export default function sessionGoal(
  pi: ExtensionAPI,
  options: SessionGoalOptions = {},
) {
  const controller = new GoalController(pi);

  const updateUi = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const goal = controller.snapshot();
    if (!goal || !["active", "waiting"].includes(goal.status)) {
      ctx.ui.setStatus("session-goal", undefined);
      return;
    }
    const evaluating = controller.isEvaluating();
    const label = compactGoal(goal, evaluating);
    ctx.ui.setStatus(
      "session-goal",
      ctx.ui.theme.fg(statusColor(goal, evaluating), `Goal: ${label}`),
    );
  };

  const notify = (
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" = "info",
  ) => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  };

  const assertGoalCanBeSet = () => {
    const problem = controller.problem();
    if (problem) throw new Error(`Session goal is locked: ${problem}`);
    const current = controller.snapshot();
    if (current && isGoalUnfinished(current)) {
      throw new Error(
        `An unfinished session goal already exists (${current.status}). Clear it with /goal clear before setting another.`,
      );
    }
    return current;
  };

  const setGoal = async (
    input: GoalInput,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ) => {
    assertGoalCanBeSet();
    const admitted = await admitGoalInput(input, ctx, signal, options.vet);

    // The contract review is asynchronous. Re-check ownership before persisting
    // so concurrent goal_set calls cannot replace each other.
    const current = assertGoalCanBeSet();
    const goal = createGoalSnapshot(
      admitted,
      current?.revision ?? 0,
      Date.now(),
      controller.createId(),
    );
    controller.replace(goal);
    const started = controller.kickoff(ctx);
    const currentGoal = controller.snapshot() ?? goal;
    updateUi(ctx);
    return { goal: currentGoal, started };
  };

  pi.registerTool({
    name: "goal_set",
    label: "Set Session Goal",
    description:
      "Set and immediately start one persistent, bounded autonomous completion goal. Use ONLY when the user explicitly requests autonomous continuation. The success condition must describe a finite end state and concrete observable evidence; never use manual-stop, perpetual, activity-only, or objective-restating conditions. An unfinished goal must be cleared by the user before replacement.",
    promptSnippet:
      "Set a bounded persistent goal only after an explicit user request for autonomous continuation",
    promptGuidelines: [
      "Use goal_set only when the user explicitly asks to create an autonomous session goal; never infer one from an ordinary task.",
      "Do not call goal_set for run-until-stopped, perpetual research, or other goals without a finite observable completion contract.",
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
        description:
          "Finite end state plus concrete evidence observable from session output.",
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
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { goal, started } = await setGoal(
        params,
        ctx,
        signal ?? ctx.signal ?? new AbortController().signal,
      );
      const message = started
        ? `Session goal set and autonomous work started: ${goal.objective}`
        : `Session goal set, but autonomous kickoff is disabled in ${ctx.mode} mode.`;
      return {
        content: [{ type: "text" as const, text: message }],
        details: { goal, message } satisfies GoalToolDetails,
      };
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("goal_set"))} ${theme.fg("muted", truncateGoalObjective(args.objective, 60))}`,
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
      const parsed = parseGoalCommand(args);
      try {
        if (parsed.action === "status") {
          notify(ctx, statusText(controller.snapshot(), controller.problem()));
        } else if (parsed.action === "pause") {
          controller.pause();
          notify(ctx, "Session goal paused.");
        } else if (parsed.action === "resume") {
          if (ctx.mode === "print" || ctx.mode === "json") {
            throw new Error(
              `Session goal automation is disabled in ${ctx.mode} mode.`,
            );
          }
          const paused = controller.snapshot();
          if (!paused) throw new Error("No session goal is set.");
          if (paused.status !== "paused") {
            throw new Error(`Goal cannot resume from ${paused.status}.`);
          }
          await admitGoalInput(
            { objective: paused.objective, condition: paused.condition },
            ctx,
            ctx.signal ?? new AbortController().signal,
            options.vet,
          );
          const current = controller.snapshot();
          if (
            current?.id !== paused.id ||
            current.revision !== paused.revision
          ) {
            throw new Error(
              "Session goal changed while its contract was reviewed.",
            );
          }
          controller.resume();
          const started = controller.kickoff(ctx);
          const goal = controller.snapshot();
          notify(
            ctx,
            started
              ? `Session goal resumed; continuing autonomously (${goal?.iterations ?? 0}/${goal?.maxTurns ?? 0} turns used).`
              : `Session goal did not resume autonomously: ${goal?.status ?? "unavailable"}${goal?.reason ? ` — ${goal.reason}` : ""}.`,
            started ? "info" : "warning",
          );
        } else if (parsed.action === "clear") {
          controller.clear();
          notify(ctx, "Session goal cleared.");
        } else {
          assertGoalCanBeSet();
          if (ctx.mode !== "tui") {
            notify(ctx, goalConditionRequiredMessage(ctx.mode), "warning");
            return;
          }
          const condition = await ctx.ui.input(
            "Session goal success condition",
            "Finite, observable evidence that proves this objective is achieved",
          );
          if (!condition) {
            notify(ctx, goalConditionRequiredMessage(ctx.mode), "warning");
            return;
          }
          const objective = parsed.objective;
          if (!objective) return;
          const { goal, started } = await setGoal(
            {
              objective,
              condition,
              maxTurns: GOAL_DEFAULTS.maxTurns,
              noProgressCap: GOAL_DEFAULTS.noProgressCap,
              wallClockMinutes: GOAL_DEFAULTS.wallClockMinutes,
            },
            ctx,
            ctx.signal ?? new AbortController().signal,
          );
          notify(
            ctx,
            started
              ? `Session goal active; autonomous work started: ${truncateGoalObjective(goal.objective, 60)}`
              : `Session goal saved, but autonomous kickoff is unavailable in ${ctx.mode} mode.`,
            started ? "info" : "warning",
          );
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
        theme.fg("accent", goalContinuationLabel(message.details)),
        0,
        0,
      ),
  );

  pi.on("session_start", (_event, ctx) => {
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
    controller.restore(ctx, true);
    updateUi(ctx);
  });

  // agent_start fires for both user prompts and extension-triggered
  // continuations; before_agent_start only covers the former.
  pi.on("agent_start", (_event, ctx) => {
    controller.beforeAgentStart(ctx);
    updateUi(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    updateUi(ctx);
    await controller.settled(ctx);
    updateUi(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    controller.shutdown();
    if (ctx.hasUI) ctx.ui.setStatus("session-goal", undefined);
  });
}
