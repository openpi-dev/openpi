import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contextPercent,
  formatContextUtilization,
  formatSubagentSpend,
} from "../../../extensions/shared/context-utilization.ts";

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

test("spend is absent or all-zero stays unrendered", () => {
  assert.equal(formatSubagentSpend(undefined), undefined);
  assert.equal(
    formatSubagentSpend({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }),
    undefined,
  );
});

test("spend compacts token counts and groups cache reads into input", () => {
  assert.equal(
    formatSubagentSpend({
      input: 1_200,
      output: 340,
      cacheRead: 800,
      cacheWrite: 100,
      cost: 0,
    }),
    "2.1k in (800 cached) · 340 out",
  );
  assert.equal(
    formatSubagentSpend({
      input: 50_000,
      output: 1_250_000,
      cacheRead: 0,
      cacheWrite: 4_000,
      cost: 0,
    }),
    "54k in · 1.3M out",
  );
});

test("spend omits the cached part and the cost when each is zero", () => {
  assert.equal(
    formatSubagentSpend({
      input: 2_000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }),
    "2.0k in · 500 out",
  );
});

test("spend renders cost with four decimals below one dollar, two otherwise", () => {
  assert.equal(
    formatSubagentSpend({
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.01234,
    }),
    "10 in · 10 out · $0.0123",
  );
  assert.equal(
    formatSubagentSpend({
      input: 10,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 1.234,
    }),
    "10 in · 10 out · $1.23",
  );
});
