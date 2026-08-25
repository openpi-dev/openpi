import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkflowLaunchPolicy,
  waitForWorkflowCompletion,
} from "./coordinator.ts";

test("interactive launch defaults detached while non-delivery hosts wait", () => {
  assert.deepEqual(resolveWorkflowLaunchPolicy({}, true), {
    wait: false,
    detached: true,
  });
  assert.deepEqual(resolveWorkflowLaunchPolicy({}, false), {
    wait: true,
    detached: false,
  });
});

test("explicit wait selects inline or detached launch policy", () => {
  assert.deepEqual(resolveWorkflowLaunchPolicy({ wait: true }, true), {
    wait: true,
    detached: false,
  });
  assert.deepEqual(resolveWorkflowLaunchPolicy({ wait: false }, true), {
    wait: false,
    detached: true,
  });
});

test("legacy background maps to wait and returns an actionable warning", () => {
  const detached = resolveWorkflowLaunchPolicy({ background: true }, true);
  assert.deepEqual(
    { wait: detached.wait, detached: detached.detached },
    { wait: false, detached: true },
  );
  assert.match(
    detached.migrationWarning ?? "",
    /replace background: true with wait: false.*next breaking release/i,
  );

  const inline = resolveWorkflowLaunchPolicy({ background: false }, true);
  assert.deepEqual(
    { wait: inline.wait, detached: inline.detached },
    { wait: true, detached: false },
  );
  assert.match(
    inline.migrationWarning ?? "",
    /replace background: false with wait: true.*next breaking release/i,
  );
});

test("consistent aliases warn while conflicts fail with migration guidance", () => {
  const consistent = resolveWorkflowLaunchPolicy(
    { wait: true, background: false },
    true,
  );
  assert.equal(consistent.wait, true);
  assert.match(consistent.migrationWarning ?? "", /remove|replace/i);

  assert.throws(
    () => resolveWorkflowLaunchPolicy({ wait: true, background: true }, true),
    /replace background: true with wait: false.*conflict.*remove background/is,
  );
});

test("unsupported detached delivery fails closed with alias guidance", () => {
  assert.throws(
    () => resolveWorkflowLaunchPolicy({ wait: false }, false),
    /cannot deliver/,
  );
  assert.throws(
    () => resolveWorkflowLaunchPolicy({ background: true }, false),
    /replace background: true with wait: false.*cannot deliver.*wait: true/is,
  );
});

test("wait cancellation does not cancel the underlying completion", async () => {
  let settle!: () => void;
  let settled = false;
  const completion = new Promise<void>((resolve) => {
    settle = () => {
      settled = true;
      resolve();
    };
  });
  const controller = new AbortController();
  const result = waitForWorkflowCompletion(completion, controller.signal);
  controller.abort();
  assert.equal(await result, "aborted");
  assert.equal(settled, false);
  settle();
  await completion;
  assert.equal(settled, true);
});

test("terminal completion wins when it settles before abort", async () => {
  const controller = new AbortController();
  const result = waitForWorkflowCompletion(
    Promise.resolve(),
    controller.signal,
  );
  assert.equal(await result, "terminal");
  controller.abort();
});
