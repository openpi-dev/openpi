import type { ProviderUsageAdapter } from "../types.ts";
import { cursorAdapter } from "./cursor.ts";
import { googleAntigravityAdapter } from "./google-antigravity.ts";
import { openaiCodexAdapter } from "./openai-codex.ts";

export const DEFAULT_ADAPTERS: readonly ProviderUsageAdapter[] = [
  cursorAdapter,
  googleAntigravityAdapter,
  openaiCodexAdapter,
];

export class UsageAdapterRegistry {
  private readonly adapters = new Map<string, ProviderUsageAdapter>();

  constructor(adapters: readonly ProviderUsageAdapter[] = DEFAULT_ADAPTERS) {
    for (const adapter of adapters) {
      this.adapters.set(adapter.id, adapter);
    }
  }

  get(id: string): ProviderUsageAdapter | undefined {
    return this.adapters.get(id);
  }

  getAll(): ProviderUsageAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Given an auth store map (e.g. from auth.json), return all matching adapters
   * alongside the stored credential.
   */
  resolveAdaptersWithCredentials(
    authStore: Record<string, unknown>,
  ): Array<{ adapter: ProviderUsageAdapter; credential: unknown }> {
    const pairs: Array<{
      adapter: ProviderUsageAdapter;
      credential: unknown;
    }> = [];

    for (const [providerId, credential] of Object.entries(authStore)) {
      const adapter = this.adapters.get(providerId);
      if (adapter && adapter.supports(credential)) {
        pairs.push({ adapter, credential });
      }
    }

    return pairs;
  }
}

export const globalAdapterRegistry = new UsageAdapterRegistry();
