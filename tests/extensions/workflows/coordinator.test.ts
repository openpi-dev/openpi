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

test("wait is authoritative and legacy background maps to its inverse", () => {
  assert.equal(resolveWorkflowLaunchMode({ wait: true }, true), "inline");
  assert.equal(resolveWorkflowLaunchMode({ wait: false }, true), "detached");
  assert.equal(
    resolveWorkflowLaunchMode({ background: true }, true),
    "detached",
  );
  assert.equal(
    resolveWorkflowLaunchMode({ background: false }, true),
    "inline",
  );
  assert.equal(
    resolveWorkflowLaunchMode({ wait: true, background: false }, true),
    "inline",
  );
  assert.equal(
    resolveWorkflowLaunchMode({ wait: false, background: true }, true),
    "detached",
  );
});

test("conflicting aliases and unsupported detached delivery fail closed", () => {
  assert.throws(
    () => resolveWorkflowLaunchMode({ wait: true, background: true }, true),
    /conflict.*background is the deprecated inverse of wait/i,
  );
  assert.throws(
    () => resolveWorkflowLaunchMode({ wait: false, background: false }, true),
    /conflict.*background is the deprecated inverse of wait/i,
  );
  assert.throws(
    () => resolveWorkflowLaunchMode({ wait: false }, false),
    /cannot deliver/,
  );
  assert.throws(
    () => resolveWorkflowLaunchMode({ background: true }, false),
    /cannot deliver.*wait: true/i,
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
