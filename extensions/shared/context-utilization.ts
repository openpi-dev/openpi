/** Compact, defensive context-window utilization formatting for child agents. */

import type { SubagentSpend } from "../subagents/src/domain.ts";

export interface ContextUtilization {
  /** Current conversation context occupancy; null while it is unknown after compaction. */
  tokens?: number | null;
  /** Capacity of the model currently serving the conversation. */
  contextWindow?: number | null;
}

function usableTokens(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function usableCapacity(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function contextPercent(usage: ContextUtilization) {
  const tokens = usableTokens(usage.tokens);
  const capacity = usableCapacity(usage.contextWindow);
  if (tokens === undefined || capacity === undefined) return undefined;
  return Math.round(Math.min(100, Math.max(0, (tokens / capacity) * 100)));
}

export function formatCompactTokens(count: number) {
  if (count < 1000) return Math.round(count).toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Render `%/capacity`. If occupancy is temporarily unknown (notably directly
 * after compaction), retain the useful model capacity as `?%/capacity`. If no
 * valid capacity is available, omit the statistic because no percentage can
 * be computed.
 */
export function formatContextUtilization(usage: ContextUtilization) {
  const capacity = usableCapacity(usage.contextWindow);
  if (capacity === undefined) return "";
  const percent = contextPercent(usage);
  return `${percent === undefined ? "?" : percent}%/${formatCompactTokens(capacity)}`;
}

/**
 * Render cumulative spend as `"<in> in (<cached> cached) · <out> out"` with an
 * optional `" · $<cost>"` tail (4 decimals below $1, 2 decimals otherwise).
 * Returns `undefined` when spend is absent or all token fields are zero, so
 * callers can omit the statistic entirely.
 */
export function formatSubagentSpend(spend?: SubagentSpend) {
  if (!spend) return undefined;
  const { input, output, cacheRead, cacheWrite, cost } = spend;
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0)
    return undefined;
  const inTokens = input + cacheRead + cacheWrite;
  const cachedPart =
    cacheRead > 0 ? ` (${formatCompactTokens(cacheRead)} cached)` : "";
  let text = `${formatCompactTokens(inTokens)} in${cachedPart} · ${formatCompactTokens(output)} out`;
  if (cost > 0) text += ` · $${cost < 1 ? cost.toFixed(4) : cost.toFixed(2)}`;
  return text;
}
