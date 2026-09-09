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

export const openaiCodexAdapter: ProviderUsageAdapter = {
  id: "openai-codex",
  displayName: "OpenAI Codex",
  async fetchUsage(auth, ctx) {
    const token = auth.apiKey ?? "";
    const payload = decodeJwtPayload(token);
    const claim = asRecord(payload?.["https://api.openai.com/auth"]);
    const profile = asRecord(payload?.["https://api.openai.com/profile"]);
    const accountHeader = Object.entries(auth.headers ?? {}).find(
      ([key]) => key.toLowerCase() === "chatgpt-account-id",
    )?.[1];
    const accountId =
      typeof accountHeader === "string"
        ? accountHeader
        : claim?.chatgpt_account_id;
    const email =
      typeof profile?.email === "string" ? profile.email : undefined;
    const report: ProviderUsageReport = {
      providerId: "openai-codex",
      displayName: "OpenAI Codex",
      accountIdentifier:
        email ?? (typeof accountId === "string" ? accountId : undefined),
      meters: [],
      fetchedAt: Date.now(),
    };
    if (!token)
      return {
        ...report,
        error: "No usable Codex access token. Use /login openai-codex.",
      };
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (typeof accountId === "string" && accountId)
      headers["ChatGPT-Account-Id"] = accountId;
    let data: Record<string, unknown>;
    try {
      data = await fetchUsageJson(
        "https://chatgpt.com/backend-api/wham/usage",
        { headers },
        ctx,
      );
    } catch (error) {
      return { ...report, error: safeUsageError(error, ctx.signal) };
    }
    report.fetchedAt = Date.now();
    if (typeof data.plan_type === "string")
      report.planName = `ChatGPT ${data.plan_type}`;

    const pools: Array<{ id: string; name: string; limit: unknown }> = [
      { id: "codex", name: "Codex", limit: data.rate_limit },
    ];
    let incomplete = false;
    if (
      data.additional_rate_limits != null &&
      !Array.isArray(data.additional_rate_limits)
    )
      incomplete = true;
    if (Array.isArray(data.additional_rate_limits)) {
      for (const [index, value] of data.additional_rate_limits.entries()) {
        const extra = asRecord(value);
        if (!extra) {
          incomplete = true;
          continue;
        }
        const feature =
          typeof extra.metered_feature === "string"
            ? extra.metered_feature
            : `extra-${index}`;
        const name =
          typeof extra.limit_name === "string"
            ? extra.limit_name
            : feature.includes("bengalfox")
              ? "Spark (Fast)"
              : feature;
        pools.push({ id: feature, name, limit: extra.rate_limit });
      }
    }
    for (const pool of pools) {
      const limit = asRecord(pool.limit);
      if (!limit) {
        incomplete = true;
        continue;
      }
      if (limit.allowed === false || limit.limit_reached === true) {
        report.warning =
          "Provider reports a reached quota limit; inspect all windows before continuing.";
      }
      let foundWindow = false;
      for (const key of ["primary", "secondary"] as const) {
        const raw = limit[`${key}_window`];
        if (raw == null) continue;
        foundWindow = true;
        const window = asRecord(raw);
        const pct = finiteNumber(window?.used_percent);
        const seconds = finiteNumber(window?.limit_window_seconds);
        let label = key === "primary" ? "Primary Window" : "Secondary Window";
        if (seconds !== undefined && seconds > 0) {
          label =
            seconds % 86400 === 0
              ? `${seconds / 86400}d`
              : seconds % 3600 === 0
                ? `${seconds / 3600}h`
                : `${seconds / 60}m`;
        }
        const meter: QuotaMeter = {
          id: `${pool.id}-${key}`,
          name: `${pool.name} (${label})`,
          resetsAt: parseTimestamp(window?.reset_at),
          status: "unknown",
        };
        if (pct !== undefined && pct >= 0) {
          meter.usedPercent = pct;
          meter.status = computeUsageStatus(pct);
        } else incomplete = true;
        report.meters.push(meter);
      }
      if (!foundWindow) incomplete = true;
    }
    if (incomplete || report.meters.length === 0) {
      report.warning = [
        report.warning,
        "Some quota data is unavailable or unrecognized; availability cannot be determined from this snapshot.",
      ]
        .filter(Boolean)
        .join(" ");
    }
    return report;
  },
};
