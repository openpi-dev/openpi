import { decodeApiKey } from "../../ai-providers/antigravity/credentials.ts";
import { getAntigravityUserAgent } from "../../ai-providers/antigravity/oauth.ts";
import type {
  ProviderUsageAdapter,
  ProviderUsageReport,
  QuotaMeter,
} from "../types.ts";
import {
  asRecord,
  fetchUsageJson,
  finiteNumber,
  parseTimestamp,
  safeUsageError,
  UsageRequestError,
} from "./utils.ts";

const ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

export const googleAntigravityAdapter: ProviderUsageAdapter = {
  id: "google-antigravity",
  displayName: "Google Antigravity",
  async fetchUsage(auth, ctx) {
    const { token, projectId } = decodeApiKey(auth.apiKey ?? "");
    const report: ProviderUsageReport = {
      providerId: "google-antigravity",
      displayName: "Google Antigravity",
      accountIdentifier: projectId ? `proj:${projectId}` : undefined,
      meters: [],
      fetchedAt: Date.now(),
    };
    if (!token || !projectId)
      return {
        ...report,
        error:
          "Antigravity token or project is unavailable. Use /login google-antigravity.",
      };
    let data: Record<string, unknown> | undefined;
    let lastError: unknown;
    for (const endpoint of ENDPOINTS) {
      try {
        data = await fetchUsageJson(
          `${endpoint}/v1internal:retrieveUserQuotaSummary`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": getAntigravityUserAgent(),
            },
            body: JSON.stringify({ project: projectId }),
          },
          ctx,
        );
        break;
      } catch (error) {
        lastError = error;
        if (ctx.signal?.aborted) break;
        // Do not retry invalid credentials against another host.
        if (
          error instanceof UsageRequestError &&
          error.status !== 404 &&
          error.status !== 429 &&
          error.status < 500
        )
          break;
      }
    }
    if (!data)
      return { ...report, error: safeUsageError(lastError, ctx.signal) };
    report.fetchedAt = Date.now();
    const groups = Array.isArray(data.groups) ? data.groups : [];
    const grouped = groups.some((value) => {
      const group = asRecord(value);
      return Array.isArray(group?.buckets) && group.buckets.length > 0;
    });
    const sources = grouped ? groups : [{ buckets: data.buckets }];
    let incomplete = false;
    for (const source of sources) {
      const group = asRecord(source);
      if (!group || !Array.isArray(group.buckets)) {
        incomplete = true;
        continue;
      }
      for (const value of group.buckets) {
        const bucket = asRecord(value);
        if (!bucket) {
          incomplete = true;
          continue;
        }
        if (bucket.disabled === true) continue;
        const name =
          typeof bucket.displayName === "string"
            ? bucket.displayName
            : typeof bucket.window === "string"
              ? bucket.window
              : "Quota Window";
        const groupName =
          typeof group.displayName === "string" ? group.displayName : undefined;
        const meter: QuotaMeter = {
          id:
            typeof bucket.bucketId === "string"
              ? bucket.bucketId
              : `quota-${report.meters.length}`,
          name: groupName ? `${groupName} (${name})` : name,
          resetsAt: parseTimestamp(bucket.resetTime),
          status: "unknown",
        };
        const fraction = finiteNumber(bucket.remainingFraction);
        const remaining = finiteNumber(bucket.remainingAmount);
        if (fraction !== undefined && fraction >= 0 && fraction <= 1) {
          meter.usedPercent = (1 - fraction) * 100;
          // Status follows the source fraction, never display rounding.
          meter.status =
            fraction === 0 ? "exhausted" : fraction <= 0.2 ? "warning" : "ok";
        } else if (remaining !== undefined && remaining >= 0) {
          meter.remainingText = `${remaining} (unit not supplied)`;
          meter.status = remaining === 0 ? "exhausted" : "unknown";
        } else incomplete = true;
        report.meters.push(meter);
      }
    }
    if (incomplete || report.meters.length === 0)
      report.warning =
        "Some quota data is unavailable or unrecognized; availability cannot be determined from this snapshot.";
    return report;
  },
};
