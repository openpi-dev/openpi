import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWorkflowLaunchMode,
  waitForWorkflowCompletion,
} from "../../../extensions/workflows/coordinator.ts";

test("interactive launch defaults detached while non-delivery hosts wait", () => {
  assert.equal(resolveWorkflowLaunchMode({}, true), "detached");
  assert.equal(resolveWorkflowLaunchMode({}, false), "inline");
});

test("wait selects inline or detached execution", () => {
  assert.equal(resolveWorkflowLaunchMode({ wait: true }, true), "inline");
  assert.equal(resolveWorkflowLaunchMode({ wait: false }, true), "detached");
});

test("unsupported detached delivery fails closed", () => {
  assert.throws(
    () => resolveWorkflowLaunchMode({ wait: false }, false),
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
