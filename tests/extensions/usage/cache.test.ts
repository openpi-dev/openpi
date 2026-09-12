import assert from "node:assert/strict";
import test from "node:test";
import { UsageCache } from "../../../extensions/usage/cache.ts";
import type { ProviderUsageReport } from "../../../extensions/usage/types.ts";

const report: ProviderUsageReport = {
  providerId: "cursor",
  displayName: "Cursor",
  meters: [{ id: "a", name: "Quota", usedPercent: 25, status: "ok" }],
  fetchedAt: 1000,
};

test("cache expires at 60s and evicts results when the resolved identity changes", () => {
  const cache = new UsageCache();
  cache.set("cursor", "account-a", report, 1000);
  assert.equal(cache.get("cursor", "account-a", 60999), report);
  assert.equal(cache.get("cursor", "account-a", 61000), undefined);
  cache.set("cursor", "account-a", report, 1000);
  assert.equal(cache.get("cursor", "account-b", 2000), undefined);
  assert.equal(cache.get("cursor", "account-a", 2000), undefined);
});

test("cache never stores failures, incomplete responses or empty reports", () => {
  const cache = new UsageCache();
  for (const invalid of [
    { ...report, error: "failed" },
    { ...report, warning: "partial" },
    { ...report, meters: [] },
  ]) {
    cache.set("cursor", "account-a", invalid);
    assert.equal(cache.get("cursor", "account-a"), undefined);
  }
});

test("cache invalidation is isolated by provider or clears the runtime", () => {
  const cache = new UsageCache();
  cache.set("cursor", "a", report);
  cache.set("codex", "b", report);
  cache.invalidate("cursor");
  assert.equal(cache.get("cursor", "a"), undefined);
  assert.equal(cache.get("codex", "b"), report);
  cache.invalidate();
  assert.equal(cache.get("codex", "b"), undefined);
});
