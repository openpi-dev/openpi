import assert from "node:assert/strict";
import test from "node:test";
import {
  allocateResultBudgets,
  type ResultBudgetPolicy,
} from "../shared/result-budget.ts";

const policy: ResultBudgetPolicy = {
  maxBatchBytes: 48 * 1024,
  maxResultBytes: 24 * 1024,
  minResultBytes: 2 * 1024,
  headroomShare: 0.5,
  estimatedBytesPerToken: 4,
};

test("unknown context usage falls back to the deterministic static caps", () => {
  const allocation = allocateResultBudgets(
    [40 * 1024, 40 * 1024],
    undefined,
    policy,
  );

  assert.deepEqual(allocation, {
    budgets: [24 * 1024, 24 * 1024],
    batchBytes: 48 * 1024,
    source: "static",
  });
});

test("valid parent headroom dynamically shrinks a result batch", () => {
  const allocation = allocateResultBudgets(
    [40 * 1024, 40 * 1024],
    { tokens: 98_000, contextWindow: 100_000 },
    policy,
  );

  assert.deepEqual(allocation, {
    budgets: [2 * 1024, 2 * 1024],
    batchBytes: 4 * 1024,
    source: "dynamic",
  });
});

test("dynamic headroom includes fixed wrapper metadata", () => {
  const allocation = allocateResultBudgets(
    [40 * 1024, 40 * 1024],
    { tokens: 96_000, contextWindow: 100_000 },
    { ...policy, fixedBytes: 4 * 1024 },
  );

  assert.deepEqual(allocation.budgets, [2048, 2048]);
  assert.equal(allocation.batchBytes, 4096);
  assert.equal(allocation.source, "dynamic");
});

test("short results yield their unused share to longer siblings", () => {
  const allocation = allocateResultBudgets(
    [1024, 40 * 1024, 40 * 1024],
    undefined,
    policy,
  );

  assert.deepEqual(allocation.budgets, [1024, 24_064, 24_064]);
  assert.equal(
    allocation.budgets.reduce((sum, budget) => sum + budget, 0),
    48 * 1024,
  );
});

test("dynamic batches preserve a readable floor for every result", () => {
  const allocation = allocateResultBudgets(
    [40 * 1024, 40 * 1024, 40 * 1024, 40 * 1024],
    { tokens: 100_000, contextWindow: 100_000 },
    policy,
  );

  assert.deepEqual(allocation.budgets, [2048, 2048, 2048, 2048]);
  assert.equal(allocation.batchBytes, 8192);
  assert.equal(allocation.source, "dynamic");
});

test("invalid or stale-looking usage never narrows the static fallback", () => {
  for (const usage of [
    { tokens: null, contextWindow: 100_000 },
    { tokens: Number.NaN, contextWindow: 100_000 },
    { tokens: 1_000, contextWindow: 0 },
  ]) {
    assert.equal(
      allocateResultBudgets([40 * 1024], usage, policy).source,
      "static",
    );
  }
});

test("empty batches allocate nothing", () => {
  assert.deepEqual(allocateResultBudgets([], undefined, policy), {
    budgets: [],
    batchBytes: 0,
    source: "static",
  });
});

test("large batches keep their readable floors inside the static batch cap", () => {
  const allocation = allocateResultBudgets(
    Array.from({ length: 64 }, () => 40 * 1024),
    { tokens: 100_000, contextWindow: 100_000 },
    policy,
  );

  assert.equal(allocation.batchBytes, 48 * 1024);
  assert.equal(
    allocation.budgets.reduce((sum, budget) => sum + budget, 0),
    48 * 1024,
  );
});
