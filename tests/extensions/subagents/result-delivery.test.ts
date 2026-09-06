import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentResultDelivery } from "../../../extensions/subagents/src/result-delivery.ts";

interface DeliveredBatch {
  results: readonly { id: string; output?: string }[];
}

function harness(initialIdle: boolean) {
  let idle = initialIdle;
  const deliveries: DeliveredBatch[] = [];
  const delivery = createSubagentResultDelivery<{
    id: string;
    output?: string;
  }>({
    isIdle: () => idle,
    deliver: (results) => deliveries.push({ results }),
  });
  return {
    delivery,
    deliveries,
    setIdle(value: boolean) {
      idle = value;
    },
  };
}

test("a result consumed by a later wait is not delivered", () => {
  const { delivery, deliveries } = harness(false);

  delivery.defer({ id: "sa-1", output: "done" });
  delivery.consume(["sa-1"]);
  delivery.parentSettled();

  assert.deepEqual(deliveries, []);
});

test("an idle child settlement wakes the parent immediately", () => {
  const { delivery, deliveries } = harness(true);

  delivery.defer({ id: "sa-1" });

  assert.deepEqual(deliveries, [{ results: [{ id: "sa-1" }] }]);
});

test("a busy child settlement wakes when the parent settles", () => {
  const { delivery, deliveries, setIdle } = harness(false);

  delivery.defer({ id: "sa-1" });
  assert.deepEqual(deliveries, []);

  setIdle(true);
  delivery.parentSettled();

  assert.deepEqual(deliveries, [{ results: [{ id: "sa-1" }] }]);
});

test("the parent boundary still delivers if another extension started a run", () => {
  const { delivery, deliveries } = harness(false);

  delivery.defer({ id: "sa-1" });
  // Pi has already emitted parent agent_settled, but an earlier extension
  // handler started another run before this extension's handler executes.
  delivery.parentSettled();

  assert.deepEqual(deliveries, [{ results: [{ id: "sa-1" }] }]);
});

test("busy results batch in settlement order into one parent wake-up", () => {
  const { delivery, deliveries } = harness(false);
  const first = { id: "sa-1" };
  const second = { id: "sa-2" };

  delivery.defer(first);
  delivery.defer(second);
  delivery.parentSettled();

  assert.deepEqual(deliveries, [{ results: [first, second] }]);
});

test("the child-settled and parent-settled edges cannot double deliver", () => {
  const { delivery, deliveries, setIdle } = harness(false);

  delivery.defer({ id: "sa-1" });
  setIdle(true);
  delivery.parentSettled();
  delivery.parentSettled();

  assert.deepEqual(deliveries, [{ results: [{ id: "sa-1" }] }]);
});

test("a child settling during the wake turn waits for its boundary", () => {
  const { delivery, deliveries, setIdle } = harness(true);

  delivery.defer({ id: "sa-1" });
  setIdle(false);
  delivery.defer({ id: "sa-2" });
  assert.deepEqual(deliveries, [{ results: [{ id: "sa-1" }] }]);

  delivery.parentSettled();
  assert.deepEqual(deliveries, [
    { results: [{ id: "sa-1" }] },
    { results: [{ id: "sa-2" }] },
  ]);
});

test("a synchronous delivery failure restores the batch in order", () => {
  let attempts = 0;
  const delivered: string[][] = [];
  const delivery = createSubagentResultDelivery<{ id: string }>({
    isIdle: () => false,
    deliver(results) {
      attempts++;
      if (attempts === 1) throw new Error("session switching");
      delivered.push(results.map(({ id }) => id));
    },
  });

  delivery.defer({ id: "sa-1" });
  delivery.defer({ id: "sa-2" });
  assert.throws(() => delivery.parentSettled(), /session switching/);
  delivery.defer({ id: "sa-3" });
  delivery.parentSettled();

  assert.deepEqual(delivered, [["sa-1", "sa-2", "sa-3"]]);
});

test("a completion cannot cross a parent Session switch", () => {
  let sessionId = "session-1";
  const delivered: string[] = [];
  const delivery = createSubagentResultDelivery<{ id: string }>({
    isIdle: () => false,
    owner: () => ({ sessionId, epoch: 0 }),
    deliver: (results) => delivered.push(...results.map((result) => result.id)),
  });

  delivery.defer({ id: "sa-1" });
  sessionId = "session-2";
  delivery.parentSettled();

  assert.deepEqual(delivered, []);
  assert.equal(delivery.inspectDeadLetters()[0]?.failure, "stale-owner");
});
