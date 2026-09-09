export type UsageStatus = "ok" | "warning" | "exhausted" | "unknown";

export interface QuotaMeter {
  id: string;
  name: string;
  usedPercent: number;
  usedText?: string;
  limitText?: string;
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
}

export interface UsageFetchContext {
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface ProviderUsageAdapter {
  readonly id: string;
  readonly displayName: string;

  /**
   * Determine whether this adapter can fetch usage given the raw credential
   * object stored in auth.json for this provider.
   */
  supports(credential: unknown): boolean;

  /**
   * Fetch usage quota information and convert it into a normalized report.
   */
  fetchUsage(
    credential: unknown,
    ctx: UsageFetchContext,
  ): Promise<ProviderUsageReport>;
}
