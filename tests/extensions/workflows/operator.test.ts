import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  normalizeWorkflowOperatorKey,
  WorkflowOperatorRegistry,
} from "../../../extensions/workflows/operator.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("reuses one in-memory SessionManager for an operator identity", async () => {
  const registry = new WorkflowOperatorRegistry();
  const cwd = resolve("/tmp/openpi-operator");
  const managers: SessionManager[] = [];
  const identity = {
    key: "reviewer:1",
    fingerprint: "sha256:execution-a",
    cwd,
  };

  assert.equal(
    await registry.activate(identity, (sessionManager) => {
      managers.push(sessionManager);
      return "first";
    }),
    "first",
  );
  assert.equal(
    await registry.activate(identity, (sessionManager) => {
      managers.push(sessionManager);
      return "second";
    }),
    "second",
  );

  assert.equal(managers.length, 2);
  assert.equal(managers[0], managers[1]);
  assert.equal(managers[0]?.getCwd(), cwd);
  assert.equal(managers[0]?.isPersisted(), false);
  await registry.close();
});

test("serializes concurrent activations of the same key", async () => {
  const registry = new WorkflowOperatorRegistry();
  const identity = {
    key: "serial",
    fingerprint: "execution-a",
    cwd: "/repo",
  };
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const order: string[] = [];

  const first = registry.activate(identity, async () => {
    order.push("first:start");
    firstStarted.resolve();
    await releaseFirst.promise;
    order.push("first:end");
  });
  await firstStarted.promise;
  const second = registry.activate(identity, () => {
    order.push("second");
  });
  await Promise.resolve();

  assert.deepEqual(order, ["first:start"]);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  await registry.close();
});

test("cancels queued work before invoking it", async () => {
  const registry = new WorkflowOperatorRegistry();
  const identity = {
    key: "cancelable",
    fingerprint: "execution-a",
    cwd: "/repo",
  };
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const first = registry.activate(identity, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
  });
  await firstStarted.promise;

  const cancellation = new AbortController();
  let invoked = false;
  const queued = registry.activate(
    { ...identity, signal: cancellation.signal },
    () => {
      invoked = true;
    },
  );
  let cancellationObserved = false;
  void queued.catch(() => {
    cancellationObserved = true;
  });
  cancellation.abort(new Error("queued activation cancelled"));
  await Promise.resolve();
  const cancelledBeforeRelease = cancellationObserved;
  releaseFirst.resolve();
  await first;

  await assert.rejects(queued, /queued activation cancelled/);
  assert.equal(cancelledBeforeRelease, true);
  assert.equal(invoked, false);
  assert.equal(await registry.activate(identity, () => "next"), "next");
  await registry.close();
});

test("continues an operator queue after a rejected activation", async () => {
  const registry = new WorkflowOperatorRegistry();
  const identity = {
    key: "recoverable",
    fingerprint: "execution-a",
    cwd: "/repo",
  };

  await assert.rejects(
    registry.activate(identity, async () => {
      throw new Error("activation failed");
    }),
    /activation failed/,
  );
  assert.equal(
    await registry.activate(identity, () => "recovered"),
    "recovered",
  );
  await registry.close();
});

test("allows different operator keys to activate concurrently", async () => {
  const registry = new WorkflowOperatorRegistry();
  const releaseFirst = deferred();
  const firstStarted = deferred();
  const order: string[] = [];

  const first = registry.activate(
    { key: "alpha", fingerprint: "execution-a", cwd: "/repo" },
    async () => {
      order.push("alpha");
      firstStarted.resolve();
      await releaseFirst.promise;
    },
  );
  await firstStarted.promise;
  const second = registry.activate(
    { key: "beta", fingerprint: "execution-b", cwd: "/repo" },
    () => {
      order.push("beta");
    },
  );
  await Promise.resolve();
  const beforeRelease = [...order];

  releaseFirst.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(beforeRelease, ["alpha", "beta"]);
  await registry.close();
});

test("close rejects new work and waits for accepted queues", async () => {
  const registry = new WorkflowOperatorRegistry();
  const identity = {
    key: "closing",
    fingerprint: "execution-a",
    cwd: "/repo",
  };
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const completed: string[] = [];
  const first = registry.activate(identity, async () => {
    firstStarted.resolve();
    await releaseFirst.promise;
    completed.push("first");
  });
  await firstStarted.promise;
  const second = registry.activate(identity, () => {
    completed.push("second");
  });

  let closeResolved = false;
  const closing = registry.close().then(() => {
    closeResolved = true;
  });
  await Promise.resolve();
  const resolvedBeforeRelease = closeResolved;
  await assert.rejects(
    registry.activate(
      { key: "late", fingerprint: "execution-b", cwd: "/repo" },
      () => undefined,
    ),
    /registry is closed/i,
  );

  releaseFirst.resolve();
  await Promise.all([first, second, closing]);
  assert.equal(resolvedBeforeRelease, false);
  assert.deepEqual(completed, ["first", "second"]);
});

test("freezes each key to its first execution fingerprint and cwd", async () => {
  const registry = new WorkflowOperatorRegistry();
  const identity = {
    key: "planner",
    fingerprint: "execution-a",
    cwd: "/repo/a",
  };
  await registry.activate(identity, () => undefined);

  for (const mismatch of [
    { ...identity, fingerprint: "execution-b" },
    { ...identity, cwd: "/repo/b" },
  ]) {
    let invoked = false;
    await assert.rejects(
      registry.activate(mismatch, () => {
        invoked = true;
      }),
      /operator.*identity/i,
    );
    assert.equal(invoked, false);
  }

  assert.equal(await registry.activate(identity, () => "same"), "same");
  await registry.close();
});

test("normalizes valid operator keys without changing their identity", () => {
  const key = `${"A".repeat(73)}._:-z09`;

  assert.equal(key.length, 80);
  assert.equal(normalizeWorkflowOperatorKey(key), key);
});

test("rejects unsafe operator keys", () => {
  for (const key of [
    "",
    "a".repeat(81),
    "has space",
    " padded",
    "line\nbreak",
    "control\u0000",
    "path/name",
    "unicode-雪",
  ]) {
    assert.throws(
      () => normalizeWorkflowOperatorKey(key),
      /operator key/i,
      JSON.stringify(key),
    );
  }
  assert.throws(
    () => normalizeWorkflowOperatorKey(undefined as unknown as string),
    /operator key/i,
  );
});
