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

test("wait is authoritative and legacy background maps to its inverse", () => {
  assert.deepEqual(resolveWorkflowLaunchPolicy({ wait: true }, true), {
    wait: true,
    detached: false,
  });
  assert.deepEqual(resolveWorkflowLaunchPolicy({ background: true }, true), {
    wait: false,
    detached: true,
  });
  assert.deepEqual(resolveWorkflowLaunchPolicy({ background: false }, true), {
    wait: true,
    detached: false,
  });
});

test("conflicting aliases and unsupported detached delivery fail closed", () => {
  assert.throws(
    () => resolveWorkflowLaunchPolicy({ wait: true, background: true }, true),
    /conflict/,
  );
  assert.throws(
    () => resolveWorkflowLaunchPolicy({ wait: false }, false),
    /cannot deliver/,
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
