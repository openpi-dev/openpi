/**
 * Context-pivot policy layer (DDD): pure context estimation and pivot
 * gating. Zero I/O — usage comes from the caller.
 */

export const MIN_CONTEXT_PIVOT_TOKENS = 30_000;
interface ContextUsage {
  tokens?: number | null;
  percent?: number | null;
  contextWindow?: number | null;
}

export function estimateContextTokens(
  usage: ContextUsage | null | undefined,
): number | null {
  if (!usage) return null;
  if (typeof usage.tokens === "number") {
    return Number.isFinite(usage.tokens) && usage.tokens >= 0
      ? usage.tokens
      : null;
  }
  if (
    typeof usage.percent !== "number" ||
    !Number.isFinite(usage.percent) ||
    usage.percent < 0 ||
    typeof usage.contextWindow !== "number" ||
    !Number.isFinite(usage.contextWindow) ||
    usage.contextWindow <= 0
  ) {
    return null;
  }
  return (usage.contextWindow * usage.percent) / 100;
}

export function buildPivotSummary(brief: string): string {
  return [
    "## Context Pivot — Continue in a Clean Context",
    "",
    "The previous phase was deliberately compressed. Continue from this brief instead of reconstructing discarded mechanics.",
    "",
    "## Next Phase",
    "",
    brief.trim(),
  ].join("\n");
}

/** Pure pivot gate: is the current context large enough to pivot? */
export function shouldPivot(
  tokens: number | null,
  minimum = MIN_CONTEXT_PIVOT_TOKENS,
) {
  return tokens !== null && tokens >= minimum;
}
