import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { GoalSnapshot } from "./state.ts";

export interface GoalToolDetails {
  goal?: GoalSnapshot;
  message: string;
}

export function compactGoal(goal: GoalSnapshot, evaluating = false) {
  const status = evaluating ? "evaluating" : goal.status;
  const budget = goal.tokenBudget
    ? ` · ${goal.parentTokens}/${goal.tokenBudget} tok`
    : "";
  return `${status} · ${goal.iterations}/${goal.maxTurns} turns${budget} · ${truncateGoalObjective(goal.objective)}`;
}

export function truncateGoalObjective(objective: string, width = 44) {
  return truncateToWidth(objective, width, "…");
}

export function goalContinuationLabel(details: unknown) {
  if (!isRecord(details)) return "↻ Goal continuation";
  const iteration = details.iteration;
  const maxTurns = details.maxTurns;
  if (
    !Number.isSafeInteger(iteration) ||
    (iteration as number) < 1 ||
    !Number.isSafeInteger(maxTurns) ||
    (maxTurns as number) < 1
  ) {
    return "↻ Goal continuation";
  }
  return `↻ Goal continuation · turn ${iteration as number}/${maxTurns as number}`;
}

export function renderGoalTool(
  details: GoalToolDetails | undefined,
  expanded: boolean,
  theme: Theme,
) {
  if (!details?.goal)
    return new Text(
      theme.fg("dim", details?.message ?? "No session goal."),
      0,
      0,
    );
  const goal = details.goal;
  const lines = [
    `${theme.fg("accent", theme.bold("Session Goal"))} ${theme.fg(goal.status === "achieved" ? "success" : goal.status === "active" ? "accent" : "muted", goal.status)}`,
    theme.fg(
      "text",
      expanded ? goal.objective : truncateGoalObjective(goal.objective, 70),
    ),
    theme.fg(
      "dim",
      `${goal.iterations}/${goal.maxTurns} turns · ${goal.noProgressCount}/${goal.noProgressCap} no-progress · ${goal.parentTokens}${goal.tokenBudget ? `/${goal.tokenBudget}` : ""} parent tokens`,
    ),
  ];
  if (expanded) {
    lines.splice(2, 0, theme.fg("muted", `Success: ${goal.condition}`));
    if (goal.reason) lines.push(theme.fg("dim", `Reason: ${goal.reason}`));
  }
  return new Text(lines.join("\n"), 0, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function statusColor(goal: GoalSnapshot, evaluating: boolean) {
  if (evaluating || goal.status === "active") return "accent" as const;
  if (goal.status === "waiting") return "warning" as const;
  if (goal.status === "achieved") return "success" as const;
  return "muted" as const;
}
