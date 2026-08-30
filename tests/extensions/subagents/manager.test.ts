/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry is test-only: the
 * scripted stub stands in for pi, whose own preconditions are covered in
 * pi-backend.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  BackendRegistry,
  type SubagentBackend,
} from "../../../extensions/subagents/src/backend.ts";
import { makeStubBackend } from "../../support/subagents-stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentStatus,
} from "../../../extensions/subagents/src/domain.ts";
import {
  makeSubagentManagerLayer,
  MAX_RUNNING,
  MAX_RUNNING_BTW,
  SubagentManager,
  type SubagentManagerConfig,
  type SubagentManagerShape,
} from "../../../extensions/subagents/src/manager.ts";
import { runTool } from "../../../extensions/subagents/src/runtime.ts";

const STATUS_WAIT_TIMEOUT_MS = 5_000;

interface StatusWaitOptions {
  readonly agentId: string;
  readonly target: string;
  readonly read: () => SubagentStatus | undefined;
  readonly subscribe: (listener: () => void) => () => void;
  readonly matches: (status: SubagentStatus | undefined) => boolean;
  readonly timeoutMs?: number;
}

async function waitForStatus({
  agentId,
  target,
  read,
  subscribe,
  matches,
  timeoutMs = STATUS_WAIT_TIMEOUT_MS,
}: StatusWaitOptions) {
  let lastObserved = read();
  if (matches(lastObserved)) return lastObserved;

  await new Promise<void>((resolve, reject) => {
    let finished = false;
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      unsubscribe();
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms waiting for subagent ${agentId} to ${target}; last observed status: ${lastObserved ?? "missing"}`,
        ),
      );
    }, timeoutMs);
    const observe = () => {
      if (finished) return;
      lastObserved = read();
      if (!matches(lastObserved)) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    };

    unsubscribe = subscribe(observe);
    if (finished) unsubscribe();
    else observe();
  });

  return lastObserved;
}

function waitForManagerStatus(
  manager: SubagentManagerShape,
  agentId: string,
  target: string,
  matches: (status: SubagentStatus | undefined) => boolean,
) {
  return waitForStatus({
    agentId,
    target,
    read: () => manager.view.get(agentId)?.status,
    subscribe: (listener) => manager.view.subscribeTo(agentId, listener),
    matches,
  });
}

const isSettledStatus = (status: SubagentStatus | undefined) =>
  status === "done" || status === "error";

const TestRegistryLive = Layer.sync(BackendRegistry, () => {
  const backends: SubagentBackend[] = [
    makeStubBackend({
      backend: "pi",
      defaultModelLabel: "stub/sonnet",
      contextWindow: 200_000,
      toolName: "Bash",
      cadenceMs: 40,
    }),
  ];
  return new Map<BackendName, SubagentBackend>(
    backends.map((backend) => [backend.name, backend]),
  );
});

const createTestRuntime = (managerConfig?: SubagentManagerConfig) =>
  ManagedRuntime.make(
    makeSubagentManagerLayer(managerConfig).pipe(
      Layer.provide(TestRegistryLive),
    ),
  );

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
  managerConfig?: SubagentManagerConfig,
) {
  const runtime = createTestRuntime(managerConfig);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("status waits fail within their own deadline with diagnostic state", async () => {
  let unsubscribed = false;

  await assert.rejects(
    waitForStatus({
      agentId: "sa-stuck",
      target: "leave running",
      read: () => "running",
      subscribe: () => () => {
        unsubscribed = true;
      },
      matches: isSettledStatus,
      timeoutMs: 10,
    }),
    /Timed out after 10ms waiting for subagent sa-stuck to leave running; last observed status: running/,
  );
  assert.equal(unsubscribed, true);
});

test("stub subagent completes and delivers a final result", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "pi");
    assert.ok(snap.meta.sessionFilePath);

    await runTool(runtime, manager.waitFor([snap.id]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.equal(done.outcome, "completed");
    assert.match(
      done.finalText,
      /\[stub:pi\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    // The waitFor marked the settle as consumed.
    assert.deepEqual(settled, [{ id: snap.id, consumed: true }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("FAIL: blow up please")),
    );
    // Observe without wait-interest so the settle is delivered unconsumed.
    await waitForManagerStatus(
      manager,
      snap.id,
      "settle after the failed run",
      isSettledStatus,
    );
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.equal(failed?.outcome, "failed");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", {
        ...task("Long running task"),
        worktree: {
          path: "/repo/.git/pi-worktrees/impl-1",
          branch: "pi/impl-1",
          repoCwd: "/repo",
        },
      }),
    );
    assert.equal(snap.worktreeBranch, "pi/impl-1");
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
    assert.equal(manager.view.get(snap.id)?.outcome, "interrupted");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("pi", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("pi", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model.id, btw.id]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("restored session counters continue both id sequences without reuse", async () => {
  await withManager(
    async (manager, runtime) => {
      const model = await runTool(
        runtime,
        manager.spawn("pi", task("model task")),
      );
      const btw = await runTool(
        runtime,
        manager.spawn("pi", { ...task("side question"), origin: "btw" }),
      );

      assert.equal(model.id, "sa-42");
      assert.equal(btw.id, "btw-8");
    },
    { initialModelCounter: 41, initialBtwCounter: 7 },
  );
});

test("by-the-way sessions run in their own pool, separate from the model pool", async () => {
  await withManager(async (manager, runtime) => {
    // Fill the entire btw pool.
    const btwTasks: SpawnTask[] = Array.from(
      { length: MAX_RUNNING_BTW },
      () => ({
        ...task("side question"),
        origin: "btw" as const,
      }),
    );
    const btwSpawns = await runTool(
      runtime,
      Effect.forEach(btwTasks, (spawnTask) => manager.spawn("pi", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(btwSpawns.length, MAX_RUNNING_BTW);

    // A full btw pool must NOT starve the model pool: the model can still spawn
    // its full quota. This is the regression guard for the phantom-slot bug.
    const modelTasks: SpawnTask[] = Array.from(
      { length: MAX_RUNNING },
      (_, n) => task(`Task ${n + 1}`),
    );
    const modelSpawns = await runTool(
      runtime,
      Effect.forEach(
        modelTasks,
        (spawnTask) => manager.spawn("pi", spawnTask),
        {
          concurrency: "unbounded",
        },
      ),
    );
    assert.equal(modelSpawns.length, MAX_RUNNING);

    // An extra btw aside is rejected against the btw cap, naming that pool.
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("pi", { ...task("another aside"), origin: "btw" }),
      ),
      /Max 2 by-the-way sessions/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("Task 5"))),
      /Max 4 subagent sessions/,
    );
  });
});

test("a refused spawn releases its concurrency reservation", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("SPAWNFAIL: refuse me"))),
      /refused to spawn/,
    );
    // The failed spawn must release its concurrency reservation.
    const snap = await runTool(runtime, manager.spawn("pi", task("ok")));
    assert.equal(snap.backend, "pi");
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("pi", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled.id]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagent sessions/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("restarting a settled subagent settles again so its result re-delivers", async () => {
  // subagent_send relies on this: the restart must re-fire onSettled with
  // consumed=false, which is what re-delivers the new result to the parent.
  await withManager(async (manager, runtime) => {
    const settles: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settles.push({ id: snap.id, consumed }),
    );
    const snap = await runTool(runtime, manager.spawn("pi", task("First")));
    // Let the first run settle on its own (unconsumed, as after a spawn).
    await waitForManagerStatus(
      manager,
      snap.id,
      "settle after the first run",
      isSettledStatus,
    );
    assert.equal(settles.length, 1);
    assert.equal(settles[0]?.consumed, false);

    await runTool(runtime, manager.send(snap.id, "Second"));
    await waitForManagerStatus(
      manager,
      snap.id,
      "start the restarted run",
      (status) => status === "running",
    );
    await waitForManagerStatus(
      manager,
      snap.id,
      "settle after the restarted run",
      isSettledStatus,
    );
    assert.equal(settles.length, 2);
    assert.equal(settles[1]?.id, snap.id);
    assert.equal(settles[1]?.consumed, false);
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    await waitForManagerStatus(
      manager,
      snap.id,
      "start the second turn",
      (status) => status === "running",
    );
    await runTool(runtime, manager.waitFor([snap.id]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("cancel issued in the restart window stops the new run", () => {
  return withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn("pi", task("First")));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second"));
    const report = await runTool(runtime, manager.cancel([snap.id]));
    assert.deepEqual(report, [
      { id: snap.id, title: "test", status: "error", cancelled: true },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
  });
});

test("a wait issued alongside a restart does not return the stale run", () => {
  // pi executes same-message tool calls in parallel, so subagent_send and
  // subagent_wait can start together. The restart occupies the slot before
  // RunStarted flips status, so waitFor must honor `restarting` or it returns
  // the previous run's output as the answer to the message just sent.
  return withManager(async (manager, runtime) => {
    const snap = await runTool(runtime, manager.spawn("pi", task("First")));
    await runTool(runtime, manager.waitFor([snap.id]));
    assert.equal(manager.view.get(snap.id)?.status, "done");

    await runTool(runtime, manager.send(snap.id, "Second"));
    // Without the fix this resolves immediately against the settled run.
    await runTool(runtime, manager.waitFor([snap.id]));
    const after = manager.view.get(snap.id);
    assert.equal(after?.status, "done");
    assert.match(after?.finalText ?? "", /Second/);
  });
});

test("a run with no first response is settled by the watchdog and frees its slot", async () => {
  await withManager(
    async (manager, runtime) => {
      const settled: Array<{ id: string; status: string; consumed: boolean }> =
        [];
      manager.view.setOnSettled((snap, consumed) =>
        settled.push({ id: snap.id, status: snap.status, consumed }),
      );

      // Fill every model slot with runs that accept the prompt but never
      // emit a first assistant event (stalled provider requests).
      const hung = await runTool(
        runtime,
        Effect.forEach(
          [1, 2, 3, 4],
          (n) => manager.spawn("pi", task(`HANG: stall ${n}`)),
          { concurrency: "unbounded" },
        ),
      );
      await assert.rejects(
        runTool(runtime, manager.spawn("pi", task("Task 5"))),
        /Max 4 subagent sessions/,
      );

      // The watchdog settles each hung run as an explicit error through the
      // normal settle path (so waits and result delivery observe it).
      await runTool(runtime, manager.waitFor(hung.map((snap) => snap.id)));
      for (const snap of hung) {
        const failed = manager.view.get(snap.id);
        assert.equal(failed?.status, "error");
        assert.match(
          failed?.errorText ?? "",
          /no assistant response event.*provider request may be stalled/,
        );
      }
      assert.deepEqual(
        settled.sort((a, b) => a.id.localeCompare(b.id)),
        hung
          .map((snap) => ({
            id: snap.id,
            status: "error",
            consumed: true,
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );

      // The freed slots accept new spawns again.
      const fresh = await runTool(
        runtime,
        manager.spawn("pi", task("ok after the stall")),
      );
      assert.equal(fresh.status, "running");
      await runTool(runtime, manager.waitFor([fresh.id]));
      assert.equal(manager.view.get(fresh.id)?.status, "done");
    },
    { firstResponseTimeoutMs: 150 },
  );
});

test("a first response clears the watchdog so slower runs are not killed", async () => {
  await withManager(
    async (manager, runtime) => {
      // The stub streams its first assistant delta within one cadence
      // (~40ms) but needs well over the watchdog budget to finish the whole
      // turn; without clearing on first response it would be killed mid-run.
      const snap = await runTool(
        runtime,
        manager.spawn("pi", task("Slow but responsive")),
      );
      await runTool(runtime, manager.waitFor([snap.id]));
      const done = manager.view.get(snap.id);
      assert.equal(done?.status, "done");
      assert.match(
        done?.finalText ?? "",
        /\[stub:pi\] completed: Slow but responsive/,
      );
      assert.equal(done?.errorText, undefined);
    },
    { firstResponseTimeoutMs: 250 },
  );
});

test("a restart whose run never starts is settled by the watchdog", async () => {
  await withManager(
    async (manager, runtime) => {
      const snap = await runTool(runtime, manager.spawn("pi", task("First")));
      await runTool(runtime, manager.waitFor([snap.id]));
      assert.equal(manager.view.get(snap.id)?.status, "done");

      // The backend accepts the send but the new run never emits RunStarted,
      // so the restarting entry holds its slot with nothing to clear it.
      await runTool(runtime, manager.send(snap.id, "HANG: stalled restart"));
      await runTool(runtime, manager.waitFor([snap.id]));
      const after = manager.view.get(snap.id);
      assert.equal(after?.status, "error");
      assert.match(
        after?.errorText ?? "",
        /no assistant response event.*provider request may be stalled/,
      );

      // The freed slot accepts a fresh spawn again.
      const fresh = await runTool(
        runtime,
        manager.spawn("pi", task("ok after the stalled restart")),
      );
      await runTool(runtime, manager.waitFor([fresh.id]));
      assert.equal(manager.view.get(fresh.id)?.status, "done");
    },
    { firstResponseTimeoutMs: 150 },
  );
});
