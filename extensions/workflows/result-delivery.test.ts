import assert from "node:assert/strict";
import test from "node:test";
import { emptyUsage, type WorkflowDetails } from "./model.ts";
import { createWorkflowResultDelivery } from "./result-delivery.ts";

function details(runId: string): WorkflowDetails {
  return {
    runId,
    background: true,
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    phases: [],
    agents: [
      {
        index: 0,
        label: "fixture",
        state: "done",
        startedAt: 1,
        finishedAt: 2,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
    delivery: {
      id: `workflow:${runId}:terminal`,
      state: "none",
      attempts: 0,
      updatedAt: 1,
    },
  };
}

test("failed delivery stays pending and retries with the same per-run id", async () => {
  const run = details("wf_aa");
  const persisted: string[] = [];
  let fail = true;
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: (current) => persisted.push(current.delivery!.state),
    deliver: async (envelopes) => {
      if (fail) throw new Error("session unavailable");
      return envelopes.map((entry) => ({
        deliveryId: entry.deliveryId,
        delivered: true,
      }));
    },
  });

  delivery.defer({
    deliveryId: run.delivery!.id,
    runId: run.runId,
    details: run,
  });
  await delivery.parentSettled();
  assert.equal(delivery.size(), 1);
  assert.equal(run.delivery?.state, "pending");
  assert.equal(run.delivery?.attempts, 1);
  assert.match(run.delivery?.lastError ?? "", /session unavailable/);

  fail = false;
  await delivery.parentSettled();
  assert.equal(delivery.size(), 0);
  assert.equal(run.delivery?.state, "delivered");
  assert.equal(run.delivery?.attempts, 2);
  assert.equal(run.delivery?.id, "workflow:wf_aa:terminal");
  assert.equal("lastError" in run.delivery!, false);
  assert.deepEqual(persisted, ["pending", "pending", "delivered"]);
});

test("partial batch receipts retry only unacknowledged runs", async () => {
  const first = details("wf_a1");
  const second = details("wf_b2");
  const calls: string[][] = [];
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: () => {},
    deliver: async (envelopes) => {
      calls.push(envelopes.map((entry) => entry.deliveryId));
      return envelopes.map((entry, index) => ({
        deliveryId: entry.deliveryId,
        delivered: calls.length > 1 || index === 0,
      }));
    },
  });
  for (const run of [first, second]) {
    delivery.defer({
      deliveryId: run.delivery!.id,
      runId: run.runId,
      details: run,
    });
  }
  await delivery.parentSettled();
  assert.equal(first.delivery?.state, "delivered");
  assert.equal(second.delivery?.state, "pending");
  await delivery.parentSettled();
  assert.equal(second.delivery?.state, "delivered");
  assert.deepEqual(calls, [
    ["workflow:wf_a1:terminal", "workflow:wf_b2:terminal"],
    ["workflow:wf_b2:terminal"],
  ]);
});

test("stale held inline completion restores as pending", () => {
  const run = details("wf_cc");
  run.delivery!.state = "held-for-inline";
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: () => {},
    deliver: async () => [],
  });
  assert.equal(
    delivery.restore({
      deliveryId: run.delivery!.id,
      runId: run.runId,
      details: run,
    }),
    true,
  );
  assert.equal(run.delivery?.state, "pending");
  assert.equal(delivery.size(), 1);
});

test("a receipt persistence failure retains the same delivery for at-least-once recovery", async () => {
  const run = details("wf_receipt");
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: (current) => {
      if (current.delivery?.state === "delivered") {
        throw new Error("disk unavailable");
      }
    },
    deliver: async (envelopes) =>
      envelopes.map((entry) => ({
        deliveryId: entry.deliveryId,
        delivered: true,
      })),
  });
  delivery.defer({
    deliveryId: run.delivery!.id,
    runId: run.runId,
    details: run,
  });
  await delivery.parentSettled();
  assert.equal(delivery.size(), 1);
  assert.equal(run.delivery?.state, "pending");
  assert.equal(run.delivery?.id, "workflow:wf_receipt:terminal");
  assert.match(run.delivery?.lastError ?? "", /receipt persistence failed/i);
});
