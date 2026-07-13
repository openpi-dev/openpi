import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AGENT_CALLS, RunController } from "./controller.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("RunController reserves calls synchronously and caps global fanout", async () => {
  const controller = new RunController(undefined, 4);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, index) =>
    controller.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return index;
    }),
  );
  assert.deepEqual(
    await Promise.all(tasks),
    Array.from({ length: 12 }, (_, i) => i),
  );
  assert.equal(peak, 4);
  assert.equal(await controller.settle(), true);
});

test("RunController enforces call budget and aborts queued tasks", async () => {
  const controller = new RunController(undefined, 1);
  const blocker = controller.schedule(
    (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const queued = Array.from({ length: MAX_AGENT_CALLS - 1 }, () =>
    controller.schedule(async () => "queued"),
  );
  await assert.rejects(
    controller.schedule(async () => "too many"),
    /exceeded the limit/,
  );
  controller.abort();
  await blocker;
  const results = await Promise.allSettled(queued);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(await controller.settle({ abort: true }), true);
});
