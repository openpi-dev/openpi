import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { GoalSnapshot } from "./state.ts";

export interface GoalToolDetails {
  goal?: GoalSnapshot;
  message: string;
}

export function formatTokensCompact(value: number) {
  const safe = Math.max(0, value);
  if (safe === 0) return "0";
  if (safe < 1_000) return Math.floor(safe).toString();
  const [divisor, suffix] =
    safe >= 1_000_000_000_000
      ? [1_000_000_000_000, "T"]
      : safe >= 1_000_000_000
        ? [1_000_000_000, "B"]
        : safe >= 1_000_000
          ? [1_000_000, "M"]
          : [1_000, "K"];
  const scaled = safe / divisor;
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  const fixed = scaled.toFixed(decimals);
  const formatted = fixed.includes(".")
    ? fixed.replace(/0+$/u, "").replace(/\.$/u, "")
    : fixed;
  return `${formatted}${suffix}`;
}

export function formatGoalElapsedSeconds(value: number) {
  const seconds = Math.max(0, Math.floor(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h ${remainingMinutes}m`;
  }
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}

export function goalFooterText(goal: GoalSnapshot) {
  switch (goal.status) {
    case "active":
      return goal.tokenBudget === undefined
        ? `Pursuing goal (${formatGoalElapsedSeconds(goal.timeUsedSeconds)})`
        : `Pursuing goal (${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)})`;
    case "paused":
      return "Goal paused (/goal resume)";
    case "blocked":
      return "Goal blocked (/goal resume)";
    case "usage_limited":
      return "Goal hit usage limits (/goal resume)";
    case "budget_limited":
      return goal.tokenBudget === undefined
        ? "Goal abandoned"
        : `Goal unmet (${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)} tokens)`;
    case "complete": {
      if (goal.completionAcknowledged) return "";
      const usage =
        goal.tokenBudget === undefined
          ? formatGoalElapsedSeconds(goal.timeUsedSeconds)
          : `${formatTokensCompact(goal.tokensUsed)} tokens`;
      return `Goal achieved (${usage})`;
    }
    case "cleared":
      return "";
  }
}

export function truncateGoalObjective(objective: string, width = 44) {
  return truncateToWidth(objective.replace(/\s+/gu, " "), width, "…");
}

export function goalContinuationLabel(details: unknown) {
  if (!isRecord(details)) return "↻ Goal continuation";
  if (details.kind === "objective_updated") return "↻ Goal objective updated";
  if (details.kind === "budget_limit") return "↻ Goal budget reached";
  return "↻ Goal continuation";
}

export function renderGoalTool(
  details: GoalToolDetails | undefined,
  expanded: boolean,
  theme: Theme,
  background?: (text: string) => string,
) {
  if (!details?.goal) {
    return new Text(
      theme.fg("dim", details?.message ?? "No goal is currently set."),
      0,
      0,
    );
  }
  const goal = details.goal;
  const usage = goal.tokenBudget
    ? `${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.tokenBudget)} tokens`
    : `${formatGoalElapsedSeconds(goal.timeUsedSeconds)} · ${formatTokensCompact(goal.tokensUsed)} tokens`;
  const lines = [
    `${theme.fg("accent", theme.bold("Goal"))} ${theme.fg(statusColor(goal), statusLabel(goal.status))}`,
    theme.fg(
      "text",
      expanded ? goal.objective : truncateGoalObjective(goal.objective, 70),
    ),
    theme.fg("dim", usage),
  ];
  if (expanded && goal.reason) {
    lines.push(theme.fg("dim", `Reason: ${goal.reason}`));
  }
  // ToolExecutionComponent normally paints the enclosing Box, but terminals
  // can expose an unpainted suffix when a styled child line resets its own
  // attributes. Painting each Goal result row as well makes the full-width
  // status background deterministic; the enclosing Box still owns padding.
  return new Text(lines.join("\n"), 0, 0, background);
}

export function statusColor(goal: GoalSnapshot) {
  if (goal.status === "active") return "accent" as const;
  if (goal.status === "complete") return "success" as const;
  if (
    goal.status === "blocked" ||
    goal.status === "usage_limited" ||
    goal.status === "budget_limited"
  ) {
    return "warning" as const;
  }
  return "muted" as const;
}

export function statusLabel(status: GoalSnapshot["status"]) {
  switch (status) {
    case "usage_limited":
      return "usage limited";
    case "budget_limited":
      return "limited by budget";
    default:
      return status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
