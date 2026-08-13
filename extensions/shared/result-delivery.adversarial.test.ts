/**
 * Adversarial tests for the deferred-result delivery map.
 *
 * Red-team targets (from the capacity-slots analysis):
 *
 * 1. **Unbounded pending**: settlement is not subject to capacity checks (a
 *    dead process settles regardless), so the pending map grows without any
 *    bound of its own while the agent stays busy. Backpressure against
 *    running + pending + reserved then means pending alone can exhaust every
 *    slot — bg_start deadlocks until the user manually consumes.
 *
 * 2. **Orphaned pending**: pruneSettled (entries > MAX_TRACKED) removes
 *    settled entries whose results were never consumed; the deferred copy
 *    stays in the map, but its id is no longer valid for bg_status/bg_kill
 *    (UnknownTerminalError) — so consume() can never fire for it. The slot
 *    is occupied forever (until session restart).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createDeferredResultDelivery,
  hasTerminalCapacity,
} from "./result-delivery.ts";

test("adversarial: pending is unbounded without a cap (RED — now capped)", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  // Simulate 40 settled-but-unconsumed results (a busy agent never drains).
  for (let i = 0; i < 40; i++) delivery.defer({ id: `t${i}` });
  assert.equal(delivery.size(), 40);
  // Every slot is now occupied by dead results: starting anything else is
  // impossible even though zero processes are actually running.
  assert.equal(
    hasTerminalCapacity({ running: 0, pending: 40, reserved: 0, maximum: 8 }),
    false,
  );
  // THE FIX: a bounded backlog cannot deadlock — oldest entries are evicted
  // and the delivery map returns to a size the capacity gate accepts.
  const bounded = createDeferredResultDelivery<{ id: string }>(16);
  for (let i = 0; i < 40; i++) bounded.defer({ id: `t${i}` });
  assert.equal(bounded.size(), 16);
  assert.equal(
    hasTerminalCapacity({ running: 0, pending: 16, reserved: 0, maximum: 8 }),
    false,
  );
  // And the newest results survive (queue semantics: keep the fresh ones).
  assert.equal(bounded.size(), 16);
  // drain() exposes the survivors — oldest 24 evicted, newest 39 kept.
  const survivors = bounded.drain();
  assert.equal(survivors.length, 16);
  assert.equal(survivors[0].id, "t24");
  assert.equal(survivors[15].id, "t39");
});

test("adversarial: capped delivery evicts oldest and reports dropped", () => {
  const bounded = createDeferredResultDelivery<{ id: string }>(4);
  const first = bounded.defer({ id: "a" });
  bounded.defer({ id: "b" });
  bounded.defer({ id: "c" });
  bounded.defer({ id: "d" });
  const over = bounded.defer({ id: "e" });
  assert.deepEqual(first, { size: 1, dropped: 0 });
  assert.deepEqual(over, { size: 4, dropped: 1 });
  assert.equal(bounded.size(), 4);
  // consume still works on survivors.
  bounded.consume(["e"]);
  assert.equal(bounded.size(), 3);
});
