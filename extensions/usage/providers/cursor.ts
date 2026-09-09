import type {
  ProviderUsageAdapter,
  ProviderUsageReport,
  QuotaMeter,
  UsageFetchContext,
} from "../types.ts";
import {
  computeUsageStatus,
  decodeJwtPayload,
  parseTimestamp,
} from "./utils.ts";

export function extractCursorUserId(token: string): string | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload.sub !== "string") return undefined;
  const parts = payload.sub.split("|");
  return (parts.length > 1 ? parts.at(-1) : payload.sub)?.trim() || undefined;
}

export const cursorAdapter: ProviderUsageAdapter = {
  id: "cursor",
  displayName: "Cursor",

  supports(credential: unknown): boolean {
    if (typeof credential !== "object" || credential === null) return false;
    const cred = credential as Record<string, unknown>;
    return Boolean(cred.access || cred.accessToken || cred.key);
  },

  async fetchUsage(
    credential: unknown,
    ctx: UsageFetchContext,
  ): Promise<ProviderUsageReport> {
    const cred = credential as Record<string, unknown>;
    const token = (cred.access ?? cred.accessToken ?? cred.key) as string;
    const fetchedAt = Date.now();

    const userId = extractCursorUserId(token);
    if (!userId) {
      return {
        providerId: "cursor",
        displayName: "Cursor",
        meters: [],
        fetchedAt,
        error: "Unable to parse user ID from Cursor access token.",
      };
    }

    const sessionCookie = `WorkosCursorSessionToken=${encodeURIComponent(`${userId}::${token}`)}`;
    const headers = {
      Accept: "application/json",
      Cookie: sessionCookie,
      "User-Agent": "Mozilla/5.0",
    };

    let summaryPayload: Record<string, unknown> | null = null;
    let email: string | undefined;

    try {
      const [summaryRes, meRes] = await Promise.allSettled([
        ctx.fetch("https://cursor.com/api/usage-summary", {
          headers,
          signal: ctx.signal,
        }),
        ctx.fetch("https://cursor.com/api/auth/me", {
          headers,
          signal: ctx.signal,
        }),
      ]);

      if (summaryRes.status === "fulfilled" && summaryRes.value.ok) {
        summaryPayload = (await summaryRes.value.json()) as Record<
          string,
          unknown
        >;
      }

      if (meRes.status === "fulfilled" && meRes.value.ok) {
        try {
          const meData = (await meRes.value.json()) as Record<string, unknown>;
          if (typeof meData.email === "string") {
            email = meData.email;
          }
        } catch {
          // me failure should not discard a successful summary
        }
      }
    } catch (err) {
      return {
        providerId: "cursor",
        displayName: "Cursor",
        meters: [],
        fetchedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (!summaryPayload) {
      return {
        providerId: "cursor",
        displayName: "Cursor",
        accountIdentifier: email,
        meters: [],
        fetchedAt,
        error: "Failed to fetch usage summary from cursor.com",
      };
    }

    // Determine reset time
    let resetsAt: number | undefined;
    for (const key of [
      "billingCycleEnd",
      "endOfMonth",
      "nextReset",
      "resetsAt",
    ]) {
      const parsed = parseTimestamp(summaryPayload[key]);
      if (parsed !== undefined) {
        resetsAt = parsed;
        break;
      }
    }

    const meters: QuotaMeter[] = [];
    const indUsage = summaryPayload.individualUsage as
      | Record<string, unknown>
      | undefined;
    const plan = indUsage?.plan as Record<string, unknown> | undefined;
    const overall = indUsage?.overall as Record<string, unknown> | undefined;
    const onDemand = indUsage?.onDemand as Record<string, unknown> | undefined;

    if (plan && plan.enabled !== false) {
      const autoPct =
        typeof plan.autoPercentUsed === "number"
          ? plan.autoPercentUsed
          : undefined;
      const apiPct =
        typeof plan.apiPercentUsed === "number"
          ? plan.apiPercentUsed
          : undefined;

      if (autoPct !== undefined) {
        meters.push({
          id: "cursor-models",
          name: "Cursor Models",
          usedPercent: Math.max(0, autoPct),
          resetsAt,
          status: computeUsageStatus(autoPct),
        });
      }

      if (apiPct !== undefined) {
        meters.push({
          id: "other-models",
          name: "Other Models",
          usedPercent: Math.max(0, apiPct),
          resetsAt,
          status: computeUsageStatus(apiPct),
        });
      }

      if (autoPct === undefined && apiPct === undefined) {
        const totalPct =
          typeof plan.totalPercentUsed === "number"
            ? plan.totalPercentUsed
            : undefined;
        if (totalPct !== undefined) {
          meters.push({
            id: "plan-total",
            name: "Included Quota",
            usedPercent: Math.max(0, totalPct),
            resetsAt,
            status: computeUsageStatus(totalPct),
          });
        }
      }
    } else if (overall && overall.enabled !== false) {
      const used = Number(overall.used);
      const limit = Number(overall.limit);
      if (!Number.isNaN(used) && !Number.isNaN(limit) && limit > 0) {
        const pct = (used / limit) * 100;
        meters.push({
          id: "overall-usage",
          name: "Personal Usage",
          usedPercent: pct,
          usedText: `$${(used / 100).toFixed(2)}`,
          limitText: `$${(limit / 100).toFixed(2)}`,
          resetsAt,
          status: computeUsageStatus(pct),
        });
      }
    }

    if (onDemand && onDemand.enabled !== false) {
      const used = Number(onDemand.used);
      const limit = Number(onDemand.limit);
      if (!Number.isNaN(used) && !Number.isNaN(limit) && limit > 0) {
        const pct = (used / limit) * 100;
        meters.push({
          id: "on-demand",
          name: "On-Demand (Over)",
          usedPercent: pct,
          usedText: `$${(used / 100).toFixed(2)}`,
          limitText: `$${(limit / 100).toFixed(2)}`,
          resetsAt,
          status: computeUsageStatus(pct),
        });
      }
    }

    return {
      providerId: "cursor",
      displayName: "Cursor",
      accountIdentifier: email,
      meters,
      fetchedAt,
    };
  },
};
