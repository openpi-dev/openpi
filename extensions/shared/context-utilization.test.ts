import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextPercent,
  formatContextUtilization,
} from "./context-utilization.ts";

test("formats current context occupancy against model capacity", () => {
  assert.equal(
    formatContextUtilization({ tokens: 26_040, contextWindow: 372_000 }),
    "7%/372k",
  );
});

test("formats the latest post-compaction usage rather than prior cumulative usage", () => {
  const latestUsage = { tokens: 18_000, contextWindow: 200_000 };
  assert.equal(formatContextUtilization(latestUsage), "9%/200k");
});

test("clamps over-capacity and nonsensical token values", () => {
  assert.equal(
    contextPercent({ tokens: 500_000, contextWindow: 200_000 }),
    100,
  );
  assert.equal(
    formatContextUtilization({
      tokens: Number.POSITIVE_INFINITY,
      contextWindow: 200_000,
    }),
    "?%/200k",
  );
  assert.equal(
    formatContextUtilization({ tokens: -1, contextWindow: 200_000 }),
    "?%/200k",
  );
});

test("handles missing usage or capacity without NaN or Infinity", () => {
  assert.equal(
    formatContextUtilization({ tokens: null, contextWindow: 372_000 }),
    "?%/372k",
  );
  assert.equal(formatContextUtilization({ tokens: 12_000 }), "");
  assert.equal(
    formatContextUtilization({ tokens: 12_000, contextWindow: 0 }),
    "",
  );
});
