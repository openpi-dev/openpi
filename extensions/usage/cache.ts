import type { ProviderUsageReport } from "./types.ts";

interface CacheEntry {
  identity: string;
  report: ProviderUsageReport;
  expiresAt: number;
}

/** One entry per provider, scoped to one extension runtime and resolved identity. */
export class UsageCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(providerId: string, identity: string, now = Date.now()) {
    const entry = this.entries.get(providerId);
    if (!entry) return undefined;
    if (entry.identity !== identity || now >= entry.expiresAt) {
      this.entries.delete(providerId);
      return undefined;
    }
    return entry.report;
  }

  set(
    providerId: string,
    identity: string,
    report: ProviderUsageReport,
    now = Date.now(),
  ) {
    if (report.error || report.warning || report.meters.length === 0) return;
    this.entries.set(providerId, { identity, report, expiresAt: now + 60_000 });
  }

  invalidate(providerId?: string) {
    if (providerId) this.entries.delete(providerId);
    else this.entries.clear();
  }
}
