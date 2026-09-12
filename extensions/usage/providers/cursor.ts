import type {
  ProviderUsageAdapter,
  ProviderUsageReport,
  QuotaMeter,
} from "../types.ts";
import {
  asRecord,
  computeUsageStatus,
  decodeJwtPayload,
  fetchUsageJson,
  finiteNumber,
  parseTimestamp,
  safeUsageError,
} from "./utils.ts";

export function extractCursorUserId(token: string) {
  const payload = decodeJwtPayload(token);
  return typeof payload?.sub === "string"
    ? payload.sub.split("|").at(-1)?.trim() || undefined
    : undefined;
}

export const cursorAdapter: ProviderUsageAdapter = {
  id: "cursor",
  displayName: "Cursor",
  async fetchUsage(auth, ctx) {
    const token = auth.apiKey ?? "";
    const userId = extractCursorUserId(token);
    const report: ProviderUsageReport = {
      providerId: "cursor",
      displayName: "Cursor",
      accountIdentifier: userId,
      meters: [],
      fetchedAt: Date.now(),
    };
    if (!userId)
      return {
        ...report,
        error: "Unable to identify the Cursor account. Use /login cursor.",
      };
    const headers = {
      Accept: "application/json",
      Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`,
      "User-Agent": "Mozilla/5.0",
    };
    const [summary, me] = await Promise.allSettled([
      fetchUsageJson("https://cursor.com/api/usage-summary", { headers }, ctx),
      fetchUsageJson("https://cursor.com/api/auth/me", { headers }, ctx),
    ]);
    if (me.status === "fulfilled" && typeof me.value.email === "string")
      report.accountIdentifier = me.value.email;
    if (summary.status === "rejected")
      return { ...report, error: safeUsageError(summary.reason, ctx.signal) };
    report.fetchedAt = Date.now();
    const data = summary.value;
    let resetsAt: number | undefined;
    for (const key of [
      "billingCycleEnd",
      "endOfMonth",
      "nextReset",
      "resetsAt",
    ]) {
      resetsAt = parseTimestamp(data[key]);
      if (resetsAt !== undefined) break;
    }
    const individual = asRecord(data.individualUsage);
    const plan = asRecord(individual?.plan);
    let incomplete = false;
    if (plan && plan.enabled !== false) {
      // Cursor's own percentages are authoritative; cents have a different denominator.
      for (const [field, id, name] of [
        ["autoPercentUsed", "cursor-models", "Cursor Models"],
        ["apiPercentUsed", "other-models", "Other Models"],
      ]) {
        if (plan[field] === undefined) continue;
        const value = finiteNumber(plan[field]);
        const pct = value !== undefined && value >= 0 ? value : undefined;
        if (pct === undefined) incomplete = true;
        report.meters.push({
          id,
          name,
          usedPercent: pct,
          resetsAt,
          status: computeUsageStatus(pct),
        });
      }
      if (report.meters.length === 0) {
        const value = finiteNumber(plan.totalPercentUsed);
        if (value !== undefined && value >= 0)
          report.meters.push({
            id: "plan-total",
            name: "Included Quota",
            usedPercent: value,
            resetsAt,
            status: computeUsageStatus(value),
          });
        else incomplete = true;
      }
    }
    const moneyPools =
      report.meters.length === 0
        ? [
            ["overall", "Personal Usage"],
            ["onDemand", "On-Demand"],
          ]
        : [["onDemand", "On-Demand"]];
    for (const [key, name] of moneyPools) {
      const pool = asRecord(individual?.[key]);
      if (!pool || pool.enabled === false) continue;
      const used = finiteNumber(pool.used);
      const limit = finiteNumber(pool.limit);
      if (used === undefined || used < 0) {
        incomplete = true;
        continue;
      }
      const pct =
        limit !== undefined && limit > 0 ? (used / limit) * 100 : undefined;
      const meter: QuotaMeter = {
        id: key === "onDemand" ? "on-demand" : "overall-usage",
        name,
        usedPercent: pct,
        usedText: `$${(used / 100).toFixed(2)}`,
        limitText:
          limit !== undefined && limit > 0
            ? `$${(limit / 100).toFixed(2)}`
            : undefined,
        remainingText:
          limit !== undefined && limit > 0
            ? `$${(Math.max(0, limit - used) / 100).toFixed(2)}`
            : undefined,
        resetsAt,
        status: computeUsageStatus(pct),
      };
      report.meters.push(meter);
    }
    if (incomplete || report.meters.length === 0)
      report.warning =
        "Some quota data is unavailable or unrecognized; availability cannot be determined from this snapshot.";
    return report;
  },
};
