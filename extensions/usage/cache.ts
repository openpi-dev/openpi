import type { ProviderUsageReport } from "./types.ts";

interface CacheEntry {
  report: ProviderUsageReport;
  expiresAt: number;
}

export class UsageCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;

  constructor(defaultTtlMs = 60_000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get(providerId: string, now = Date.now()): ProviderUsageReport | undefined {
    const entry = this.entries.get(providerId);
    if (!entry) return undefined;
    if (now >= entry.expiresAt) {
      this.entries.delete(providerId);
      return undefined;
    }
    return entry.report;
  }

  set(
    providerId: string,
    report: ProviderUsageReport,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
  ): void {
    this.entries.set(providerId, {
      report,
      expiresAt: now + ttlMs,
    });
  }

  getAll(now = Date.now()): ProviderUsageReport[] {
    const results: ProviderUsageReport[] = [];
    for (const [id, entry] of this.entries.entries()) {
      if (now >= entry.expiresAt) {
        this.entries.delete(id);
      } else {
        results.push(entry.report);
      }
    }
    return results;
  }

  invalidate(providerId?: string): void {
    if (providerId) {
      this.entries.delete(providerId);
    } else {
      this.entries.clear();
    }
  }

  size(): number {
    return this.entries.size;
  }
}

export const globalUsageCache = new UsageCache();
