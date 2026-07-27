import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPivotSummary,
  estimateContextTokens,
  MIN_CONTEXT_PIVOT_TOKENS,
} from "./index.ts";

test("estimates context from exact tokens or percentage", () => {
  assert.equal(estimateContextTokens({ tokens: 42_000 }), 42_000);
  assert.equal(
    estimateContextTokens({ percent: 25, contextWindow: 200_000 }),
    50_000,
  );
  assert.equal(estimateContextTokens({ percent: 25 }), null);
  assert.equal(estimateContextTokens({ tokens: -1 }), null);
});

test("builds a clean pivot summary without notebook or handoff coupling", () => {
  const summary = buildPivotSummary("Implement the API and run tests.");
  assert.match(summary, /Context Pivot/);
  assert.match(summary, /Implement the API and run tests/);
  assert.doesNotMatch(summary, /notebook/i);
  assert.doesNotMatch(summary, /handoff/i);
  assert.equal(MIN_CONTEXT_PIVOT_TOKENS, 30_000);
});
