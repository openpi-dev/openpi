import type { ModelAuth } from "@earendil-works/pi-ai";

export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface QuotaMeter {
  id: string;
  name: string;
  usedPercent?: number;
  usedText?: string;
  limitText?: string;
  remainingText?: string;
  resetsAt?: number;
  status: UsageStatus;
}

export interface ProviderUsageReport {
  providerId: string;
  displayName: string;
  accountIdentifier?: string;
  planName?: string;
  meters: QuotaMeter[];
  fetchedAt: number;
  error?: string;
  warning?: string;
}

export interface UsageFetchContext {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface ProviderUsageAdapter {
  readonly id: string;
  readonly displayName: string;
  /** Request auth resolved by Pi; adapters never read or refresh stored credentials. */
  fetchUsage(
    auth: ModelAuth,
    ctx: UsageFetchContext,
  ): Promise<ProviderUsageReport>;
}
