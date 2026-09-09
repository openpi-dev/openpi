import assert from "node:assert/strict";
import test from "node:test";
import { UsageCache } from "../../../extensions/usage/cache.ts";
import type { ProviderUsageReport } from "../../../extensions/usage/types.ts";

const mockReport: ProviderUsageReport = {
  providerId: "cursor",
  displayName: "Cursor",
  accountIdentifier: "user@example.com",
  planName: "Pro",
  meters: [
    {
      id: "cursor-models",
      name: "Cursor Models",
      usedPercent: 25,
      status: "ok",
    },
  ],
  fetchedAt: 1000,
};

test("UsageCache stores and retrieves unexpired entries", () => {
  const cache = new UsageCache(60_000);
  cache.set("cursor", mockReport, 60_000, 1000);

  assert.equal(cache.size(), 1);
  const fetched = cache.get("cursor", 10_000);
  assert.deepEqual(fetched, mockReport);
});

test("UsageCache expires entries when TTL is exceeded", () => {
  const cache = new UsageCache(5000);
  cache.set("cursor", mockReport, 5000, 1000);

  // Still valid at t=5999
  assert.ok(cache.get("cursor", 5999));
  // Expired at t=6000
  assert.equal(cache.get("cursor", 6000), undefined);
  assert.equal(cache.size(), 0);
});

test("UsageCache getAll purges expired entries and returns fresh ones", () => {
  const cache = new UsageCache(10_000);
  cache.set("cursor", mockReport, 5000, 1000);
  cache.set(
    "codex",
    { ...mockReport, providerId: "openai-codex", displayName: "OpenAI Codex" },
    15_000,
    1000,
  );

  // At t=8000, cursor is expired (1000+5000=6000), codex is still valid (1000+15000=16000)
  const all = cache.getAll(8000);
  assert.equal(all.length, 1);
  assert.equal(all[0].providerId, "openai-codex");
});

test("UsageCache invalidate removes single or all entries", () => {
  const cache = new UsageCache();
  cache.set("p1", mockReport);
  cache.set("p2", mockReport);
  assert.equal(cache.size(), 2);

  cache.invalidate("p1");
  assert.equal(cache.size(), 1);
  assert.equal(cache.get("p1"), undefined);
  assert.ok(cache.get("p2"));

  cache.invalidate();
  assert.equal(cache.size(), 0);
});
