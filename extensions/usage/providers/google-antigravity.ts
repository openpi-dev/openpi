import type {
  ProviderUsageAdapter,
  ProviderUsageReport,
  QuotaMeter,
  UsageFetchContext,
} from "../types.ts";
import { computeUsageStatus, parseTimestamp } from "./utils.ts";

const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];

interface QuotaBucket {
  bucketId?: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface QuotaGroup {
  displayName?: string;
  buckets?: QuotaBucket[];
}

export const googleAntigravityAdapter: ProviderUsageAdapter = {
  id: "google-antigravity",
  displayName: "Google Antigravity",

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
    const projectId = (cred.projectId as string | undefined) ?? "";
    const email = cred.email as string | undefined;
    const fetchedAt = Date.now();

    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "GoogleCloudCode/1.0",
    };
    const body = JSON.stringify({ project: projectId });

    let summaryData: { groups?: QuotaGroup[]; buckets?: QuotaBucket[] } | null =
      null;
    let lastError: string | undefined;

    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      try {
        const res = await ctx.fetch(
          `${endpoint}/v1internal:retrieveUserQuotaSummary`,
          {
            method: "POST",
            headers,
            body,
            signal: ctx.signal,
          },
        );
        if (res.ok) {
          summaryData = (await res.json()) as {
            groups?: QuotaGroup[];
            buckets?: QuotaBucket[];
          };
          break;
        }
        lastError = `HTTP ${res.status} ${res.statusText}`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!summaryData) {
      return {
        providerId: "google-antigravity",
        displayName: "Google Antigravity",
        accountIdentifier:
          email || (projectId ? `proj:${projectId}` : undefined),
        meters: [],
        fetchedAt,
        error: lastError ?? "Failed to retrieve quota from Google Cloud Code",
      };
    }

    const meters: QuotaMeter[] = [];

    // Format groups (e.g. Gemini Models, Claude and GPT models)
    if (Array.isArray(summaryData.groups)) {
      for (const group of summaryData.groups) {
        const groupName = group.displayName ?? "Model Quota";
        for (const bucket of group.buckets ?? []) {
          if (bucket.remainingFraction === undefined) continue;
          const remaining = Math.max(
            0,
            Math.min(1, Number(bucket.remainingFraction)),
          );
          const usedPercent = Math.round((1 - remaining) * 100);
          const resetsAt = parseTimestamp(bucket.resetTime);

          // Clean window label
          let windowLabel = bucket.window ?? "quota";
          if (
            bucket.displayName &&
            bucket.displayName.toLowerCase().includes("five hour")
          ) {
            windowLabel = "5-Hour";
          } else if (
            bucket.displayName &&
            bucket.displayName.toLowerCase().includes("weekly")
          ) {
            windowLabel = "Weekly";
          }

          meters.push({
            id: bucket.bucketId ?? `${groupName}-${windowLabel}`,
            name: `${groupName} (${windowLabel})`,
            usedPercent,
            resetsAt,
            status: computeUsageStatus(usedPercent),
          });
        }
      }
    } else if (Array.isArray(summaryData.buckets)) {
      for (const bucket of summaryData.buckets) {
        if (bucket.remainingFraction === undefined) continue;
        const remaining = Math.max(
          0,
          Math.min(1, Number(bucket.remainingFraction)),
        );
        const usedPercent = Math.round((1 - remaining) * 100);
        const resetsAt = parseTimestamp(bucket.resetTime);
        meters.push({
          id: bucket.bucketId ?? "quota",
          name: bucket.displayName ?? "Quota Window",
          usedPercent,
          resetsAt,
          status: computeUsageStatus(usedPercent),
        });
      }
    }

    return {
      providerId: "google-antigravity",
      displayName: "Google Antigravity",
      accountIdentifier: email || (projectId ? `proj:${projectId}` : undefined),
      planName: "Cloud Code Assist",
      meters,
      fetchedAt,
    };
  },
};
