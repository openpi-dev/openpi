import assert from "node:assert/strict";
import test from "node:test";
import {
  emptyUsage,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";
import { createWorkflowResultDelivery } from "../../../extensions/workflows/result-delivery.ts";
import { projectWorkflowDetails } from "../../../extensions/workflows/retention.ts";

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

test("bigint and cyclic results remain deliverable through a bounded projection", async () => {
  const run = details("wf_non_json_delivery");
  const cyclic: Record<string, unknown> = { count: 1n };
  cyclic.self = cyclic;
  run.result = cyclic;

  const projection = projectWorkflowDetails(run, 128 * 1024);
  assert.ok(projection);
  const delivered: WorkflowDetails[] = [];
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: () => {},
    deliver: async (envelopes) => {
      delivered.push(...envelopes.map((envelope) => envelope.details));
      return envelopes.map((envelope) => ({
        deliveryId: envelope.deliveryId,
        delivered: true,
      }));
    },
  });

  delivery.defer({
    deliveryId: projection.delivery!.id,
    runId: projection.runId,
    details: projection,
  });
  await delivery.parentSettled();

  assert.equal(delivery.size(), 0);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.result, "[result omitted from memory]");
  assert.equal(delivered[0]?.delivery?.state, "delivered");
});

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

test("initial persistence failure retains a detached envelope for retry", async () => {
  const run = details("wf_initial_persist");
  let failPersistence = true;
  const calls: string[][] = [];
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: () => {
      if (failPersistence) throw new Error("disk unavailable");
    },
    deliver: async (envelopes) => {
      calls.push(envelopes.map((entry) => entry.deliveryId));
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
  assert.equal(delivery.size(), 1);
  assert.equal(run.delivery?.state, "pending");
  assert.match(
    run.delivery?.lastError ?? "",
    /initial delivery persistence failed/i,
  );

  failPersistence = false;
  await delivery.parentSettled();
  assert.equal(delivery.size(), 0);
  assert.equal(run.delivery?.state, "delivered");
  assert.deepEqual(calls, [["workflow:wf_initial_persist:terminal"]]);
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

test("a completion queued during a failed flush is drained without another lifecycle event", async () => {
  const first = details("wf_during_flush_a");
  const second = details("wf_during_flush_b");
  let idle = false;
  let releaseFirstAttempt!: () => void;
  let markFirstAttemptStarted!: () => void;
  const firstAttemptStarted = new Promise<void>((resolve) => {
    markFirstAttemptStarted = resolve;
  });
  const calls: string[][] = [];
  const delivery = createWorkflowResultDelivery({
    isIdle: () => idle,
    persist: () => {},
    deliver: async (envelopes) => {
      calls.push(envelopes.map((entry) => entry.deliveryId));
      if (calls.length === 1) {
        markFirstAttemptStarted();
        await new Promise<void>((resolve) => {
          releaseFirstAttempt = resolve;
        });
        throw new Error("session unavailable");
      }
      return envelopes.map((entry) => ({
        deliveryId: entry.deliveryId,
        delivered: true,
      }));
    },
  });

  delivery.defer({
    deliveryId: first.delivery!.id,
    runId: first.runId,
    details: first,
  });
  idle = true;
  const flushing = delivery.parentSettled();
  await firstAttemptStarted;
  delivery.defer({
    deliveryId: second.delivery!.id,
    runId: second.runId,
    details: second,
  });
  releaseFirstAttempt();
  await flushing;

  assert.equal(delivery.size(), 0);
  assert.equal(first.delivery?.state, "delivered");
  assert.equal(second.delivery?.state, "delivered");
  assert.deepEqual(calls, [
    ["workflow:wf_during_flush_a:terminal"],
    [
      "workflow:wf_during_flush_b:terminal",
      "workflow:wf_during_flush_a:terminal",
    ],
  ]);
});

test("a persistence exception cannot drop later envelopes from a failed batch", async () => {
  const first = details("wf_persist_a");
  const second = details("wf_persist_b");
  let failPersistence = false;
  let failTransport = true;
  const persistedAfterFailure: string[] = [];
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: (current) => {
      if (!failPersistence) return;
      persistedAfterFailure.push(current.runId);
      if (current.runId === first.runId) throw new Error("disk unavailable");
    },
    deliver: async (envelopes) => {
      if (failTransport) throw new Error("session unavailable");
      return envelopes.map((entry) => ({
        deliveryId: entry.deliveryId,
        delivered: true,
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
  failPersistence = true;
  await delivery.parentSettled();

  assert.equal(delivery.size(), 2);
  assert.deepEqual(persistedAfterFailure, [first.runId, second.runId]);
  assert.equal(first.delivery?.state, "pending");
  assert.equal(second.delivery?.state, "pending");

  failPersistence = false;
  failTransport = false;
  await delivery.parentSettled();
  assert.equal(delivery.size(), 0);
  assert.equal(first.delivery?.state, "delivered");
  assert.equal(second.delivery?.state, "delivered");
});

test("a persistence exception cannot drop later unacknowledged receipts", async () => {
  const first = details("wf_unack_a");
  const second = details("wf_unack_b");
  let failPersistence = false;
  let acknowledge = false;
  const persistedAfterFailure: string[] = [];
  const delivery = createWorkflowResultDelivery({
    isIdle: () => false,
    persist: (current) => {
      if (!failPersistence) return;
      persistedAfterFailure.push(current.runId);
      if (current.runId === first.runId) throw new Error("disk unavailable");
    },
    deliver: async (envelopes) =>
      envelopes.map((entry) => ({
        deliveryId: entry.deliveryId,
        delivered: acknowledge,
      })),
  });

  for (const run of [first, second]) {
    delivery.defer({
      deliveryId: run.delivery!.id,
      runId: run.runId,
      details: run,
    });
  }
  failPersistence = true;
  await delivery.parentSettled();

  assert.equal(delivery.size(), 2);
  assert.deepEqual(persistedAfterFailure, [first.runId, second.runId]);
  assert.equal(first.delivery?.state, "pending");
  assert.equal(second.delivery?.state, "pending");

  failPersistence = false;
  acknowledge = true;
  await delivery.parentSettled();
  assert.equal(delivery.size(), 0);
  assert.equal(first.delivery?.state, "delivered");
  assert.equal(second.delivery?.state, "delivered");
});

test("a held-inline restore persistence failure does not block the final idle flush", async () => {
  const first = details("wf_restore_a");
  const second = details("wf_restore_b");
  first.delivery!.state = "held-for-inline";
  second.delivery!.state = "pending";
  let failPersistence = true;
  const delivery = createWorkflowResultDelivery({
    isIdle: () => true,
    persist: (current) => {
      if (failPersistence && current.runId === first.runId) {
        throw new Error("disk unavailable");
      }
    },
    deliver: async (envelopes) =>
      envelopes.map((entry) => ({
        deliveryId: entry.deliveryId,
        delivered: true,
      })),
  });

  assert.equal(
    delivery.restore({
      deliveryId: first.delivery!.id,
      runId: first.runId,
      details: first,
    }),
    true,
  );
  assert.equal(
    delivery.restore({
      deliveryId: second.delivery!.id,
      runId: second.runId,
      details: second,
    }),
    true,
  );
  assert.equal(delivery.size(), 2);
  assert.equal(first.delivery?.state, "pending");
  assert.match(first.delivery?.lastError ?? "", /persistence failed/i);

  failPersistence = false;
  await delivery.flushIfIdle();
  assert.equal(delivery.size(), 0);
  assert.equal(first.delivery?.state, "delivered");
  assert.equal(second.delivery?.state, "delivered");
});
