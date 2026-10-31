import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import {
  ChildExecutionAdmission,
  ChildExecutionAdmissionAbortedError,
  ChildExecutionAdmissionQueueFullError,
  getSessionChildExecutionAdmission,
  sessionChildExecutionAdmission,
} from "../../../extensions/shared/child-execution-admission.ts";

test("native Web imports and Pi-loaded extensions share exact Session lease ownership", async () => {
  const extension = await createJiti(import.meta.url).import<
    typeof import("../../../extensions/shared/child-execution-admission.ts")
  >("../../../extensions/shared/child-execution-admission.ts");
  const owner = {};
  assert.equal(getSessionChildExecutionAdmission(owner), undefined);
  const admission = extension.sessionChildExecutionAdmission(owner, {
    maxActive: 2,
  });
  assert.equal(getSessionChildExecutionAdmission(owner), admission);
  const lease = await admission.acquire("direct");
  assert.equal(getSessionChildExecutionAdmission(owner)?.snapshot().held, 1);
  lease.release();
});

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

test("FAIL: Pi-loaded extensions share one admission per Session and a fresh one after reload", async () => {
  // Pi evaluates each extension with `moduleCache: false`, so Workflows and
  // Subagents import separate copies of the admission module. Load two
  // fixtures through Pi's real loader instead of one ESM test process.
  const directory = await mkdtemp(path.join(tmpdir(), "pi-admission-"));
  const sink = Symbol.for("@tt-a1i/openpi/test/admission-loader-sink");
  const moduleUrl = pathToFileURL(
    path.resolve("extensions/shared/child-execution-admission.ts"),
  ).href;
  const fixture = (origin: string) =>
    [
      `import { sessionChildExecutionAdmission } from ${JSON.stringify(moduleUrl)};`,
      "export default function () {",
      `  globalThis[Symbol.for(${JSON.stringify(sink.description)})].${origin} = (owner) =>`,
      "    sessionChildExecutionAdmission(owner, { maxActive: 1 });",
      "}",
    ].join("\n");
  const factories: Record<
    "workflow" | "direct",
    (owner: object) => ChildExecutionAdmission
  > = Object.create(null);
  Reflect.set(globalThis, sink, factories);
  try {
    await writeFile(path.join(directory, "workflows.ts"), fixture("workflow"));
    await writeFile(path.join(directory, "subagents.ts"), fixture("direct"));
    const loaded = await discoverAndLoadExtensions(
      [
        path.join(directory, "workflows.ts"),
        path.join(directory, "subagents.ts"),
      ],
      directory,
      path.join(directory, "agent"),
    );
    assert.deepEqual(loaded.errors, []);

    const session = {};
    const workflow = factories.workflow(session);
    const direct = factories.direct(session);
    assert.equal(workflow, direct);

    const directLease = await direct.acquire("direct");
    const queued = workflow.acquire("workflow");
    assert.deepEqual(workflow.snapshot().heldByOrigin, {
      workflow: 0,
      direct: 1,
      btw: 0,
    });
    assert.equal(workflow.snapshot().queued, 1);
    directLease.release();
    (await queued).release();

    const otherSession = factories.direct({});
    assert.notEqual(otherSession, workflow);

    // Pi's reload shuts the old extension runtime down and then starts the
    // new one with the same SessionManager.
    workflow.shutdown();
    const reloaded = factories.direct(session);
    assert.notEqual(reloaded, workflow);
    assert.equal(factories.workflow(session), reloaded);
    const lateLease = await reloaded.acquire("workflow");
    reloaded.shutdown();
    const blocked = factories.direct(session);
    assert.equal(
      getSessionChildExecutionAdmission(session)?.snapshot().held,
      1,
    );
    await assert.rejects(
      blocked.acquire("direct"),
      /parent Session is shutting down/,
    );
    assert.equal(factories.workflow(session), blocked);

    lateLease.release();
    assert.equal(
      getSessionChildExecutionAdmission(session)?.snapshot().held,
      0,
    );
    const recovered = factories.workflow(session);
    assert.equal(factories.direct(session), recovered);
    const recoveredLease = await recovered.acquire("direct");
    lateLease.release();
    assert.equal(recovered.snapshot().held, 1);
    recoveredLease.release();
  } finally {
    Reflect.deleteProperty(globalThis, sink);
    await rm(directory, { recursive: true, force: true });
  }
});
