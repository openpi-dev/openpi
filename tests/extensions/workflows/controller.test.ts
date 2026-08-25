import assert from "node:assert/strict";
import { test } from "node:test";
import { RunController } from "../../../extensions/workflows/controller.ts";
import { shutdownActiveWorkflowRuns } from "../../../extensions/workflows/index.ts";

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

test("RunController propagates invocation cancellation without aborting the run", async () => {
  const controller = new RunController(undefined, 1);
  const invocation = new AbortController();
  const pending = controller.schedule(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        });
      }),
    invocation.signal,
  );

  invocation.abort(new Error("Workflow agent request was cancelled"));
  await assert.rejects(pending, /request was cancelled/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await controller.schedule(async () => "recovered"), "recovered");
  assert.equal(await controller.settle(), true);
});

test("RunController enforces call budget and aborts queued tasks", async () => {
  const maxAgentCalls = 7;
  const controller = new RunController(undefined, 1, maxAgentCalls);
  const blocker = controller.schedule(
    (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const queued = Array.from({ length: maxAgentCalls - 1 }, () =>
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

test("RunController double cancel and settle share one terminal result", async () => {
  const controller = new RunController();
  let aborts = 0;
  const pending = controller.schedule(
    (signal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            aborts++;
            resolve();
          },
          { once: true },
        );
      }),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort("first");
  controller.abort("second");
  const first = controller.settle({ abort: true, timeoutMs: 100 });
  const second = controller.settle({ abort: true, timeoutMs: 1 });
  assert.equal(first, second);
  assert.equal(await first, true);
  await pending;
  assert.equal(aborts, 1);
});

test("session shutdown aborts active child controllers and bounds completions", async () => {
  let aborts = 0;
  let settles = 0;
  const forced: string[] = [];
  const runs = [1, 2].map((index) => ({
    details: {
      runId: `wf_${index}`,
      background: true,
      status: "running" as const,
      startedAt: 0,
      phases: [],
      agents: [],
    },
    controller: {
      abort() {
        aborts++;
      },
      settle() {
        settles++;
        return new Promise<boolean>(() => {});
      },
    },
    completion: new Promise<void>(() => {}),
    forceSettle(error: string) {
      forced.push(error);
    },
  }));

  const shutdown = shutdownActiveWorkflowRuns(runs, 10);
  assert.equal(await shutdown, false);
  assert.equal(await shutdown, false, "one shutdown promise has one result");
  assert.equal(aborts, 2);
  assert.equal(settles, 2);
  assert.deepEqual(forced, [
    "Session shutdown deadline exceeded",
    "Session shutdown deadline exceeded",
  ]);
});

test("RunController cleanup timeout is bounded and remains terminal after late completion", async () => {
  const controller = new RunController();
  let finish: (() => void) | undefined;
  const pending = controller.schedule(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await controller.settle({ abort: true, timeoutMs: 10 }), false);
  finish?.();
  await pending;
  assert.equal(await controller.settle(), false);
  await assert.rejects(
    controller.schedule(async () => "late"),
    /settling/,
  );
});
