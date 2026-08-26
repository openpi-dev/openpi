import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkflowLaunchMode,
  waitForWorkflowCompletion,
} from "./coordinator.ts";

test("interactive launch defaults detached while non-delivery hosts wait", () => {
  assert.equal(resolveWorkflowLaunchMode(undefined, true), "detached");
  assert.equal(resolveWorkflowLaunchMode(undefined, false), "inline");
});

test("explicit wait selects inline or detached launch policy", () => {
  assert.equal(resolveWorkflowLaunchMode(true, true), "inline");
  assert.equal(resolveWorkflowLaunchMode(false, true), "detached");
});

test("unsupported detached delivery fails closed", () => {
  assert.throws(
    () => resolveWorkflowLaunchMode(false, false),
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
