import assert from "node:assert/strict";
import test from "node:test";
import {
  ChildExecutionAdmission,
  ChildExecutionAdmissionAbortedError,
  ChildExecutionAdmissionQueueFullError,
  sessionChildExecutionAdmission,
} from "../../../extensions/shared/child-execution-admission.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("FAIL: admission never oversells a same-tick shared limit", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 2 });
  const requests = Array.from({ length: 20 }, () =>
    admission.acquire("workflow"),
  );
  const leases = await Promise.all(requests.slice(0, 2));

  assert.equal(admission.snapshot().held, 2);
  assert.equal(admission.snapshot().queued, 18);

  leases[0]!.release();
  leases[1]!.release();
  await Promise.resolve();
  assert.equal(admission.snapshot().held, 2);

  for (const lease of leases) lease.release();
  for (const request of requests.slice(2)) (await request).release();
  assert.equal(admission.snapshot().held, 0);
  assert.equal(admission.snapshot().queued, 0);
});

test("FAIL: each top-level Session owner gets an independent admission pool", async () => {
  const firstOwner = {};
  const secondOwner = {};
  const first = sessionChildExecutionAdmission(firstOwner, { maxActive: 1 });
  const sameFirst = sessionChildExecutionAdmission(firstOwner, {
    maxActive: 4,
  });
  const second = sessionChildExecutionAdmission(secondOwner, { maxActive: 1 });

  assert.equal(first, sameFirst);
  assert.notEqual(first, second);
  const firstLease = await first.acquire("workflow");
  const secondLease = await second.acquire("workflow");
  assert.equal(first.snapshot().held, 1);
  assert.equal(second.snapshot().held, 1);
  firstLease.release();
  secondLease.release();
});

test("FAIL: queued acquires are FIFO across workflow, direct, and BTW", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 1 });
  const first = await admission.acquire("workflow");
  const order: string[] = [];
  const direct = admission.acquire("direct").then((lease) => {
    order.push("direct");
    return lease;
  });
  const btw = admission.acquire("btw").then((lease) => {
    order.push("btw");
    return lease;
  });

  first.release();
  const directLease = await direct;
  assert.deepEqual(order, ["direct"]);
  directLease.release();
  const btwLease = await btw;
  assert.deepEqual(order, ["direct", "btw"]);
  btwLease.release();
});

test("FAIL: a cancelled queued acquire cannot start work after a release", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 1 });
  const held = await admission.acquire("workflow");
  const abort = new AbortController();
  const pending = admission.acquire("direct", abort.signal);
  abort.abort(new Error("caller cancelled"));

  await assert.rejects(pending, ChildExecutionAdmissionAbortedError);
  assert.equal(admission.snapshot().queued, 0);
  held.release();
  assert.equal(admission.snapshot().held, 0);
});

test("FAIL: acquire observes an already-aborted signal without claiming", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 1 });
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(
    admission.acquire("workflow", abort.signal),
    ChildExecutionAdmissionAbortedError,
  );
  assert.equal(admission.snapshot().held, 0);
});

test("FAIL: a bounded queue rejects before consuming a slot", async () => {
  const admission = new ChildExecutionAdmission({
    maxActive: 1,
    maxQueued: 1,
  });
  const held = await admission.acquire("workflow");
  const pending = admission.acquire("direct");

  await assert.rejects(
    admission.acquire("btw"),
    ChildExecutionAdmissionQueueFullError,
  );
  assert.deepEqual(admission.snapshot(), {
    enabled: true,
    limit: 1,
    held: 1,
    queued: 1,
    heldByOrigin: { workflow: 1, direct: 0, btw: 0 },
    queuedByOrigin: { workflow: 0, direct: 1, btw: 0 },
    blockedReason:
      "Waiting for a shared child execution slot (1 active / 1 limit).",
  });

  held.release();
  (await pending).release();
});

test("FAIL: release is idempotent and attempt-scoped", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 1 });
  const first = await admission.acquire("workflow");
  first.release();
  const second = await admission.acquire("workflow");

  first.release();
  assert.equal(admission.snapshot().held, 1);
  second.release();
  assert.equal(admission.snapshot().held, 0);
});

test("FAIL: shutdown rejects waiters but does not pretend active children stopped", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 1 });
  const held = await admission.acquire("workflow");
  const pending = admission.acquire("btw");

  admission.shutdown();
  await assert.rejects(pending, ChildExecutionAdmissionAbortedError);
  assert.equal(admission.snapshot().held, 1);
  held.release();
  assert.equal(admission.snapshot().held, 0);
});

test("FAIL: a live configuration cannot shrink below truthful held state", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 2 });
  const first = await admission.acquire("workflow");
  const second = await admission.acquire("direct");

  assert.throws(() => admission.configure({ maxActive: 1 }), /2 active/);
  assert.equal(admission.snapshot().limit, 2);
  second.release();
  admission.configure({ maxActive: 1 });
  assert.equal(admission.snapshot().limit, 1);
  first.release();
});

test("FAIL: enabling a limit accounts for children started while disabled", async () => {
  const admission = new ChildExecutionAdmission();
  const first = await admission.acquire("workflow");
  const second = await admission.acquire("direct");

  assert.equal(admission.snapshot().enabled, false);
  assert.equal(admission.snapshot().held, 2);
  assert.throws(() => admission.configure({ maxActive: 1 }));
  assert.doesNotThrow(() => admission.configure({ maxActive: 2 }));

  first.release();
  second.release();
});

test("FAIL: a grant racing cancellation leaves no leaked lease", async () => {
  const admission = new ChildExecutionAdmission({ maxActive: 1 });
  const held = await admission.acquire("workflow");
  const abort = new AbortController();
  const gate = deferred<void>();
  const pending = admission.acquire("btw", abort.signal).then(async (lease) => {
    await gate.promise;
    if (abort.signal.aborted) lease.release();
    return lease;
  });

  held.release();
  abort.abort();
  gate.resolve();
  const lease = await pending;
  lease.release();
  assert.equal(admission.snapshot().held, 0);
});
