import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeferredResultDelivery,
  createIdleResultBatcher,
  hasTerminalCapacity,
  resultDeliveryOptions,
} from "./src/result-delivery.ts";

test("start capacity counts running, retractable results, and concurrent reservations", () => {
  assert.equal(
    hasTerminalCapacity({ running: 3, pending: 3, reserved: 1, maximum: 8 }),
    true,
  );
  assert.equal(
    hasTerminalCapacity({ running: 3, pending: 3, reserved: 2, maximum: 8 }),
    false,
  );
});

test("a result consumed by a kill/status is not delivered", () => {
  const delivery = createDeferredResultDelivery<{
    id: string;
    output: string;
  }>();

  delivery.defer({ id: "bt-1", output: "done" });
  delivery.consume(["bt-1"]);

  assert.deepEqual(delivery.drain(), []);
});

test("defer reports pending cardinality without evicting identities", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  assert.equal(delivery.defer({ id: "bt-1" }), 1);
  assert.equal(delivery.defer({ id: "bt-2" }), 2);
  assert.equal(delivery.defer({ id: "bt-3" }), 3);

  assert.deepEqual(delivery.drain(), [
    { id: "bt-1" },
    { id: "bt-2" },
    { id: "bt-3" },
  ]);
});

test("unconsumed results are delivered once in settlement order", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const first = { id: "bt-1" };
  const second = { id: "bt-2" };

  delivery.defer(first);
  delivery.defer(second);

  assert.deepEqual(delivery.drain(), [first, second]);
  assert.deepEqual(delivery.drain(), []);
});

test("bounded drains keep overflow retractable and preserve retry order", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  for (let index = 1; index <= 10; index++) {
    delivery.defer({ id: `bt-${index}` });
  }

  const first = delivery.drain(8);
  assert.equal(first.length, 8);
  assert.equal(delivery.size(), 2);
  delivery.consume(["bt-9"]);
  assert.deepEqual(delivery.drain(8), [{ id: "bt-10" }]);

  delivery.defer({ id: "bt-11" });
  delivery.restore(first);
  assert.deepEqual(delivery.drain(20), [...first, { id: "bt-11" }]);
});

test("re-deferring the same id replaces rather than duplicates", () => {
  const delivery = createDeferredResultDelivery<{ id: string; n: number }>();
  delivery.defer({ id: "bt-1", n: 1 });
  delivery.defer({ id: "bt-1", n: 2 });
  assert.deepEqual(delivery.drain(), [{ id: "bt-1", n: 2 }]);
});

test("a drained result can be retained for retry after delivery fails", () => {
  const delivery = createDeferredResultDelivery<{ id: string }>();
  const result = { id: "bt-1" };
  delivery.defer(result);

  const drained = delivery.drain();
  delivery.restore(drained);

  assert.deepEqual(delivery.drain(), [result]);
});

test("idle result batching uses one fixed bounded window", () => {
  let callback: (() => void) | undefined;
  let scheduled = 0;
  let idle = true;
  const flushes: boolean[] = [];
  const batcher = createIdleResultBatcher({
    delayMs: 200,
    isIdle: () => idle,
    flush: (wake) => flushes.push(wake),
    startTimer(next, delayMs) {
      assert.equal(delayMs, 200);
      scheduled++;
      callback = next;
      return scheduled;
    },
    clearTimer() {},
  });

  batcher.schedule();
  const firstCallback = callback;
  batcher.schedule();
  assert.equal(scheduled, 1);
  assert.equal(callback, firstCallback);

  callback?.();
  assert.deepEqual(flushes, [true]);

  batcher.schedule();
  assert.equal(scheduled, 2);
});

test("a full pending batch flushes immediately with the current wake policy", () => {
  let callback: (() => void) | undefined;
  let idle = true;
  let cleared = 0;
  const flushes: boolean[] = [];
  const batcher = createIdleResultBatcher({
    delayMs: 200,
    isIdle: () => idle,
    flush: (wake) => flushes.push(wake),
    startTimer(next) {
      callback = next;
      return 1;
    },
    clearTimer() {
      cleared++;
    },
  });

  batcher.schedule();
  batcher.flushNow();
  assert.equal(cleared, 1);
  assert.deepEqual(flushes, [true]);
  callback?.();
  assert.deepEqual(flushes, [true]);

  idle = false;
  batcher.flushNow();
  assert.deepEqual(flushes, [true, false]);
});

test("a busy race retains the batch for a later quiet flush", () => {
  let callback: (() => void) | undefined;
  let idle = true;
  let cleared = 0;
  const flushes: boolean[] = [];
  const batcher = createIdleResultBatcher({
    delayMs: 200,
    isIdle: () => idle,
    flush: (wake) => flushes.push(wake),
    startTimer(next) {
      callback = next;
      return 1;
    },
    clearTimer() {
      cleared++;
    },
  });

  batcher.schedule();
  idle = false;
  callback?.();
  assert.deepEqual(flushes, []);

  batcher.schedule();
  batcher.flushWithoutWake();
  assert.equal(cleared, 1);
  assert.deepEqual(flushes, [false]);
});

test("clearing an idle result batch prevents a post-shutdown flush", () => {
  let callback: (() => void) | undefined;
  let cleared = 0;
  const flushes: boolean[] = [];
  const batcher = createIdleResultBatcher({
    delayMs: 200,
    isIdle: () => true,
    flush: (wake) => flushes.push(wake),
    startTimer(next) {
      callback = next;
      return 1;
    },
    clearTimer() {
      cleared++;
    },
  });

  batcher.schedule();
  batcher.clear();
  assert.equal(cleared, 1);
  callback?.();
  assert.deepEqual(flushes, []);
});

test("only a result the model is waiting for costs it a turn", () => {
  // Idle model with work outstanding: this is the result it is waiting on.
  assert.deepEqual(resultDeliveryOptions(true), {
    deliverAs: "followUp",
    triggerTurn: true,
  });

  // A backlog that settled while the model worked on something else must not
  // force a turn per stale process — that is the notification spam a long
  // session drowns in. It still reaches context via nextTurn.
  const quiet = resultDeliveryOptions(false);
  assert.equal(quiet.deliverAs, "nextTurn");
  assert.equal("triggerTurn" in quiet, false);
});
