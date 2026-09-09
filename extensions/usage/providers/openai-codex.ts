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

export const openaiCodexAdapter: ProviderUsageAdapter = {
  id: "openai-codex",
  displayName: "OpenAI Codex",

  supports(credential: unknown): boolean {
    if (typeof credential !== "object" || credential === null) return false;
    const cred = credential as Record<string, unknown>;
    return Boolean(cred.access || cred.accessToken);
  },

  async fetchUsage(
    credential: unknown,
    ctx: UsageFetchContext,
  ): Promise<ProviderUsageReport> {
    const cred = credential as Record<string, unknown>;
    const token = (cred.access ?? cred.accessToken) as string;
    const fetchedAt = Date.now();

    // Parse JWT to extract accountId and email if not explicitly in credentials
    const jwtPayload = decodeJwtPayload(token);
    const authClaim = jwtPayload?.["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    const profileClaim = jwtPayload?.["https://api.openai.com/profile"] as
      | Record<string, unknown>
      | undefined;

    const accountId =
      (cred.accountId as string | undefined) ??
      (authClaim?.chatgpt_account_id as string | undefined);
    const email =
      (cred.email as string | undefined) ??
      (profileClaim?.email as string | undefined);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
    };
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      const res = await ctx.fetch(
        "https://chatgpt.com/backend-api/wham/usage",
        {
          headers,
          signal: ctx.signal,
        },
      );
      if (res.ok) {
        payload = (await res.json()) as Record<string, unknown>;
      } else {
        return {
          providerId: "openai-codex",
          displayName: "OpenAI Codex",
          accountIdentifier: email,
          meters: [],
          fetchedAt,
          error: `HTTP ${res.status} ${res.statusText}`,
        };
      }
    } catch (err) {
      return {
        providerId: "openai-codex",
        displayName: "OpenAI Codex",
        accountIdentifier: email,
        meters: [],
        fetchedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const planType =
      typeof payload.plan_type === "string" ? payload.plan_type : undefined;
    const planDisplay = planType
      ? `ChatGPT ${planType.charAt(0).toUpperCase() + planType.slice(1)}`
      : "ChatGPT";

    const meters: QuotaMeter[] = [];
    const rateLimit = payload.rate_limit as Record<string, unknown> | undefined;

    if (rateLimit) {
      const primary = rateLimit.primary_window as
        | Record<string, unknown>
        | undefined;
      const secondary = rateLimit.secondary_window as
        | Record<string, unknown>
        | undefined;

      if (primary && typeof primary.used_percent === "number") {
        const pct = Math.max(0, primary.used_percent);
        // reset_at is in seconds!
        const resetAtMs = parseTimestamp(primary.reset_at);
        meters.push({
          id: "codex-primary",
          name: "Primary Window",
          usedPercent: pct,
          resetsAt: resetAtMs,
          status: computeUsageStatus(pct),
        });
      }

      if (secondary && typeof secondary.used_percent === "number") {
        const pct = Math.max(0, secondary.used_percent);
        const resetAtMs = parseTimestamp(secondary.reset_at);
        meters.push({
          id: "codex-secondary",
          name: "Weekly Window",
          usedPercent: pct,
          resetsAt: resetAtMs,
          status: computeUsageStatus(pct),
        });
      }
    }

    // Process additional rate limits (e.g. Spark / Bengalfox)
    if (Array.isArray(payload.additional_rate_limits)) {
      for (const extra of payload.additional_rate_limits) {
        const extraLimit = extra.rate_limit as
          | Record<string, unknown>
          | undefined;
        const extraPrimary = extraLimit?.primary_window as
          | Record<string, unknown>
          | undefined;
        if (extraPrimary && typeof extraPrimary.used_percent === "number") {
          const featureName =
            (extra.limit_name as string) ||
            (extra.metered_feature as string) ||
            "Spark";
          const displayName = featureName.includes("bengalfox")
            ? "Spark (Fast)"
            : featureName;
          const pct = Math.max(0, extraPrimary.used_percent);
          const resetAtMs = parseTimestamp(extraPrimary.reset_at);
          meters.push({
            id: `codex-extra-${featureName}`,
            name: displayName,
            usedPercent: pct,
            resetsAt: resetAtMs,
            status: computeUsageStatus(pct),
          });
        }
      }
    }

    return {
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      accountIdentifier: email,
      planName: planDisplay,
      meters,
      fetchedAt,
    };
  },
};
