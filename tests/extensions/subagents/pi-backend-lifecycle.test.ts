import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type {
  SubagentCleanupReceipt,
  SubagentBackend,
  SubagentSession,
} from "../../../extensions/subagents/src/backend.ts";
import { BackendRegistry } from "../../../extensions/subagents/src/backend.ts";
import {
  makePiBackend,
  type PiAgentSessionFactory,
} from "../../../extensions/subagents/src/backends/pi.ts";
import type {
  BackendName,
  SpawnTask,
  SubagentEvent,
} from "../../../extensions/subagents/src/domain.ts";
import {
  makeSubagentManagerLayer,
  SubagentManager,
} from "../../../extensions/subagents/src/manager.ts";
import {
  createPiAgentSessionHarness,
  type PiAgentSessionHarness,
  type PiAgentSessionHarnessOptions,
} from "../../support/pi-agent-session-harness.ts";

const FIXTURE_MODEL = {
  provider: "fixture",
  id: "fixture-model",
  name: "Fixture Model",
  api: "openai-completions",
  baseUrl: "http://127.0.0.1:1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const MODEL_REGISTRY = {
  find: (provider: string, id: string) =>
    provider === FIXTURE_MODEL.provider && id === FIXTURE_MODEL.id
      ? FIXTURE_MODEL
      : undefined,
  getAll: () => [FIXTURE_MODEL],
} as unknown as ModelRegistry;

type SessionCreationOptions = NonNullable<CreateAgentSessionOptions>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

function task(prompt: string, overrides: Partial<SpawnTask> = {}): SpawnTask {
  return {
    prompt,
    title: "lifecycle fixture",
    cwd: process.cwd(),
    model: `${FIXTURE_MODEL.provider}/${FIXTURE_MODEL.id}`,
    reasoningEffort: "high",
    tools: ["read", "subagent_spawn"],
    parent: {
      parentCwd: process.cwd(),
      projectTrusted: false,
      inheritedModel: {
        provider: FIXTURE_MODEL.provider,
        id: FIXTURE_MODEL.id,
      },
      inheritedThinkingLevel: "medium",
      modelRegistry: MODEL_REGISTRY,
    },
    ...overrides,
  };
}

function harnessFactory(
  configure: (
    options: SessionCreationOptions,
    index: number,
  ) => PiAgentSessionHarnessOptions = () => ({}),
) {
  const creations: SessionCreationOptions[] = [];
  const harnesses: PiAgentSessionHarness[] = [];
  const factory: PiAgentSessionFactory = async (options) => {
    assert.ok(options);
    const index = creations.length;
    creations.push(options);
    const harness = createPiAgentSessionHarness({
      model: options.model,
      activeTools: options.tools,
      ...configure(options, index),
    });
    harnesses.push(harness);
    return { session: harness.session };
  };
  return { factory, creations, harnesses };
}

function createManagerRuntime(
  backend: SubagentBackend,
  firstResponseTimeoutMs = 500,
) {
  const registry = Layer.succeed(
    BackendRegistry,
    new Map<BackendName, SubagentBackend>([["pi", backend]]),
  );
  return ManagedRuntime.make(
    makeSubagentManagerLayer({ firstResponseTimeoutMs }).pipe(
      Layer.provide(registry),
    ),
  );
}

async function spawnDirect(
  backend: SubagentBackend,
  spawnTask: SpawnTask,
  drive: (session: SubagentSession) => void,
) {
  const events: SubagentEvent[] = [];
  const firstSettlement = deferred<void>();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* backend.spawn(spawnTask);
        yield* Effect.forkScoped(
          Stream.runForEach(session.events, (event) =>
            Effect.sync(() => {
              events.push(event);
              if (event._tag === "RunSettled") firstSettlement.resolve();
            }),
          ),
        );
        drive(session);
        yield* Effect.promise(() => firstSettlement.promise);
      }),
    ),
  );
  return events;
}

test("the production Pi adapter bridges startup, first response, tools, usage, and one settlement", async () => {
  const fixtures = harnessFactory();
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });

  const events = await spawnDirect(
    backend,
    task("inspect the repository"),
    () => {
      const harness = fixtures.harnesses[0];
      assert.ok(harness);
      harness.setStreaming(true);
      harness.emit({ type: "agent_start" });
      harness.emitUser("inspect the repository");
      harness.emitTextDelta("Looking");
      harness.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
      });
      harness.emit({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
        partialResult: { content: [{ type: "text", text: "partial\nrest" }] },
      });
      harness.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: [{ type: "text", text: "complete\nrest" }] },
        isError: false,
      });
      harness.setContextUsage({ tokens: 321, contextWindow: 8_192 });
      harness.emitAssistant("Repository inspected");
      harness.setStreaming(false);
      harness.emit({ type: "agent_settled" });
      harness.resolvePrompt();
      harness.emit({ type: "agent_settled" });
    },
  );

  const creation = fixtures.creations[0];
  const harness = fixtures.harnesses[0];
  assert.ok(creation);
  assert.ok(harness);
  assert.equal(creation.cwd, process.cwd());
  assert.equal(creation.model, FIXTURE_MODEL);
  assert.equal(creation.thinkingLevel, "high");
  assert.deepEqual(creation.tools, ["read"]);
  assert.ok(creation.excludeTools?.includes("subagent_spawn"));
  assert.ok(creation.resourceLoader);
  assert.ok(creation.settingsManager);
  assert.ok(creation.sessionManager);
  assert.deepEqual(harness.activeTools(), ["read"]);
  assert.deepEqual(harness.calls.bindings, [{ mode: "print" }]);
  assert.deepEqual(harness.calls.prompts, ["inspect the repository"]);
  assert.deepEqual(harness.calls.sessionNames, ["subagent: lifecycle fixture"]);

  assert.ok(events.some((event) => event._tag === "AssistantDelta"));
  assert.ok(events.some((event) => event._tag === "ToolStart"));
  assert.ok(events.some((event) => event._tag === "ToolUpdate"));
  assert.ok(events.some((event) => event._tag === "ToolEnd"));
  assert.ok(
    events.some(
      (event) =>
        event._tag === "UsageChanged" &&
        event.tokens === 321 &&
        event.contextWindow === 8_192,
    ),
  );
  assert.ok(
    events.some(
      (event) =>
        event._tag === "MetaChanged" &&
        event.meta.modelLabel === "fixture/fixture-model",
    ),
  );
  assert.deepEqual(
    events
      .filter((event) => event._tag === "RunSettled")
      .map((event) => event.outcome),
    [{ _tag: "Completed", finalText: "Repository inspected" }],
  );
  assert.equal(harness.calls.clearQueues, 1);
  assert.equal(harness.calls.aborts, 1);
  assert.equal(harness.calls.disposals, 1);
});

test("prompt rejection wins over an earlier agent_settled event", async () => {
  const prompt = deferred<void>();
  const fixtures = harnessFactory(() => ({
    prompt: () => prompt.promise,
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend, 10_000);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("settled event before prompt rejection")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("partial provider output");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get(spawned.id)?.status, "running");

    prompt.reject(new Error("provider rejected after settlement event"));
    await waitFor(
      () => manager.view.get(spawned.id)?.status === "error",
      "prompt rejection to settle",
    );
    assert.equal(
      manager.view.get(spawned.id)?.errorText,
      "provider rejected after settlement event",
    );
  } finally {
    prompt.resolve();
    await runtime.dispose();
  }
});

test("a prompt that resolves without lifecycle events fails explicitly", async () => {
  const fixtures = harnessFactory(() => ({ prompt: async () => {} }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend, 10_000);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("extension handled prompt")),
    );
    await waitFor(
      () => manager.view.get(spawned.id)?.status === "error",
      "prompt without lifecycle to fail",
    );
    assert.match(
      manager.view.get(spawned.id)?.errorText ?? "",
      /prompt completed without lifecycle events/i,
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("late lifecycle output");
    harness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get(spawned.id)?.finalText, "");
  } finally {
    await runtime.dispose();
  }
});

test("a non-quiescent prompt preserves its worktree and exposes cleanup uncertainty", async () => {
  const stuckPreflight = deferred<void>();
  let cleanupCalls = 0;
  const fixtures = harnessFactory(() => ({
    preflight: () => stuckPreflight.promise,
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 25,
    worktreeCleanup: async () => {
      cleanupCalls++;
      throw new Error("worktree cleanup should not run");
    },
  });
  let cleanupReceipt: (() => SubagentCleanupReceipt | undefined) | undefined;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* backend.spawn(
          task("stuck preflight worktree", {
            worktree: {
              path: "C:/fixture-worktree",
              branch: "pi/fixture-worktree",
              repoCwd: process.cwd(),
            },
          }),
        );
        cleanupReceipt = session.cleanupReceipt;
      }),
    ),
  );
  assert.equal(cleanupCalls, 0);
  assert.match(cleanupReceipt?.()?.message ?? "", /prompt did not quiesce/i);
  stuckPreflight.resolve();
});

test("streaming send steers while idle send starts a distinct run", async () => {
  const fixtures = harnessFactory();
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const settlements: string[] = [];
    manager.view.setOnSettled((snapshot) =>
      settlements.push(`${snapshot.id}:${snapshot.finalText}`),
    );

    const first = await runtime.runPromise(
      manager.spawn("pi", task("first turn")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitTextDelta("first response");

    await runtime.runPromise(manager.send(first.id, "steer the active run"));
    assert.deepEqual(harness.calls.steers, ["steer the active run"]);
    assert.deepEqual(harness.calls.prompts, ["first turn"]);

    harness.emitAssistant("first result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await runtime.runPromise(manager.waitFor([first.id]));
    assert.equal(manager.view.get(first.id)?.finalText, "first result");

    await runtime.runPromise(manager.send(first.id, "second turn"));
    assert.deepEqual(harness.calls.prompts, ["first turn", "second turn"]);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitTextDelta("second response");
    harness.emitAssistant("second result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await runtime.runPromise(manager.waitFor([first.id]));

    const afterRestart = manager.view.get(first.id);
    assert.equal(afterRestart?.status, "done");
    assert.equal(afterRestart?.finalText, "second result");
    assert.equal(settlements.length, 2);
    assert.deepEqual(
      settlements.map((entry) => entry.split(":", 1)[0]),
      [first.id, first.id],
    );

    harness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settlements.length, 2);
  } finally {
    await runtime.dispose();
  }
});

test("cancelled active run restarts only after the old prompt is quiescent", async () => {
  const fixtures = harnessFactory();
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    let settlements = 0;
    manager.view.setOnSettled(() => settlements++);

    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("cancelled turn")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });

    const cancellation = runtime.runPromise(manager.cancel([spawned.id]));
    await waitFor(() => harness.calls.aborts === 1, "active run abort");
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    const report = await cancellation;
    assert.equal(report[0]?.cancelled, true);
    assert.equal(settlements, 1);

    await runtime.runPromise(manager.send(spawned.id, "restarted turn"));
    assert.deepEqual(harness.calls.prompts, [
      "cancelled turn",
      "restarted turn",
    ]);
    await waitFor(
      () => manager.view.get(spawned.id)?.status === "running",
      "restarted run to reach the manager",
    );
    assert.equal(manager.view.get(spawned.id)?.status, "running");
    assert.equal(manager.view.get(spawned.id)?.finalText, "");
    assert.equal(settlements, 1);

    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("fresh restarted result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await runtime.runPromise(manager.waitFor([spawned.id]));
    assert.equal(manager.view.get(spawned.id)?.status, "done");
    assert.equal(
      manager.view.get(spawned.id)?.finalText,
      "fresh restarted result",
    );
    assert.equal(settlements, 2);
  } finally {
    await runtime.dispose();
  }
});

test("preflight cancellation stays single-flight until the exact prompt settles", async () => {
  const firstPrompt = deferred<void>();
  const secondPrompt = deferred<void>();
  let promptIndex = 0;
  let concurrentPrompts = 0;
  let maxConcurrentPrompts = 0;
  const fixtures = harnessFactory(() => ({
    prompt: async () => {
      const index = promptIndex++;
      concurrentPrompts++;
      maxConcurrentPrompts = Math.max(maxConcurrentPrompts, concurrentPrompts);
      try {
        await (index === 0 ? firstPrompt.promise : secondPrompt.promise);
      } finally {
        concurrentPrompts--;
      }
    },
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    let settlements = 0;
    manager.view.setOnSettled(() => settlements++);

    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("cancel during preflight")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    assert.deepEqual(harness.calls.prompts, ["cancel during preflight"]);
    await assert.rejects(
      runtime.runPromise(
        manager.send(spawned.id, "must not overlap preflight"),
      ),
      /prompt is still starting/,
    );
    assert.deepEqual(harness.calls.prompts, ["cancel during preflight"]);

    let cancelFinished = false;
    const cancellation = runtime
      .runPromise(manager.cancel([spawned.id]))
      .then((result) => {
        cancelFinished = true;
        return result;
      });
    await waitFor(() => harness.calls.aborts === 1, "initial preflight abort");
    await assert.rejects(
      runtime.runPromise(manager.send(spawned.id, "must not overlap cancel")),
      /cancellation is still in progress/,
    );
    assert.deepEqual(harness.calls.prompts, ["cancel during preflight"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancelFinished, false);
    assert.equal(settlements, 0);

    // A cancelled Pi preflight can resume after abort() returned, then enter
    // the agent lifecycle. These events still belong to prompt #1.
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    await waitFor(
      () => harness.calls.aborts === 2,
      "late preflight agent_start to be aborted again",
    );
    harness.emitTextDelta("stale delta");
    harness.emit({
      type: "tool_execution_start",
      toolCallId: "stale-tool",
      toolName: "read",
      args: { path: "stale.txt" },
    });
    harness.emitAssistant("stale cancelled result");
    harness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancelFinished, false);
    assert.equal(settlements, 0);

    firstPrompt.resolve();
    const report = await cancellation;
    assert.equal(report[0]?.cancelled, true);
    assert.equal(settlements, 1);
    assert.equal(manager.view.get(spawned.id)?.finalText, "");
    assert.equal(manager.view.get(spawned.id)?.transcript.length, 0);

    await runtime.runPromise(manager.send(spawned.id, "fresh restart"));
    assert.deepEqual(harness.calls.prompts, [
      "cancel during preflight",
      "fresh restart",
    ]);
    assert.equal(maxConcurrentPrompts, 1);

    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitTextDelta("fresh delta");
    harness.emitAssistant("fresh result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    secondPrompt.resolve();
    await runtime.runPromise(manager.waitFor([spawned.id]));

    const restarted = manager.view.get(spawned.id);
    assert.equal(restarted?.status, "done");
    assert.equal(restarted?.finalText, "fresh result");
    assert.equal(settlements, 2);
    assert.equal(
      restarted?.transcript.some((item) =>
        JSON.stringify(item).includes("stale"),
      ),
      false,
    );
  } finally {
    firstPrompt.resolve();
    secondPrompt.resolve();
    await runtime.dispose();
  }
});

test("settled restart waits for the previous prompt Promise microtask boundary", async () => {
  const firstPrompt = deferred<void>();
  const secondPrompt = deferred<void>();
  let promptIndex = 0;
  let concurrentPrompts = 0;
  let maxConcurrentPrompts = 0;
  const fixtures = harnessFactory(() => ({
    prompt: async () => {
      const index = promptIndex++;
      concurrentPrompts++;
      maxConcurrentPrompts = Math.max(maxConcurrentPrompts, concurrentPrompts);
      try {
        await (index === 0 ? firstPrompt.promise : secondPrompt.promise);
      } finally {
        concurrentPrompts--;
      }
    },
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("first prompt")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("first result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get(spawned.id)?.status, "running");

    let restartAccepted = false;
    const restart = runtime
      .runPromise(manager.send(spawned.id, "second prompt"))
      .then(() => {
        restartAccepted = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(restartAccepted, false);
    assert.deepEqual(harness.calls.prompts, ["first prompt"]);

    firstPrompt.resolve();
    await restart;
    assert.deepEqual(harness.calls.prompts, ["first prompt", "second prompt"]);
    assert.equal(maxConcurrentPrompts, 1);

    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("second result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    secondPrompt.resolve();
    await runtime.runPromise(manager.waitFor([spawned.id]));
    assert.equal(manager.view.get(spawned.id)?.finalText, "second result");
  } finally {
    firstPrompt.resolve();
    secondPrompt.resolve();
    await runtime.dispose();
  }
});

test("cancel invalidates a restart waiting on the previous prompt Promise", async () => {
  const firstPrompt = deferred<void>();
  const secondPrompt = deferred<void>();
  let promptIndex = 0;
  const fixtures = harnessFactory(() => ({
    prompt: () =>
      promptIndex++ === 0 ? firstPrompt.promise : secondPrompt.promise,
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    let settlements = 0;
    manager.view.setOnSettled(() => settlements++);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("completed but prompt still unwinding")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("first result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get(spawned.id)?.status, "running");

    const restart = runtime.runPromise(
      manager.send(spawned.id, "restart that will be cancelled"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.calls.prompts, [
      "completed but prompt still unwinding",
    ]);

    const cancellation = runtime.runPromise(manager.cancel([spawned.id]));
    await waitFor(
      () => harness.calls.aborts === 1,
      "pending restart cancellation",
    );
    firstPrompt.resolve();
    await restart;
    const report = await cancellation;

    assert.equal(report[0]?.cancelled, true);
    assert.deepEqual(harness.calls.prompts, [
      "completed but prompt still unwinding",
    ]);
    assert.equal(manager.view.get(spawned.id)?.status, "error");
    assert.equal(manager.view.get(spawned.id)?.finalText, "");
    assert.equal(settlements, 1);
  } finally {
    firstPrompt.resolve();
    secondPrompt.resolve();
    await runtime.dispose();
  }
});

test("an aborted send cannot start its deferred restart later", async () => {
  const firstPrompt = deferred<void>();
  const secondPrompt = deferred<void>();
  let promptIndex = 0;
  const fixtures = harnessFactory(() => ({
    prompt: () =>
      promptIndex++ === 0 ? firstPrompt.promise : secondPrompt.promise,
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("completed before aborted send")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("stable prior result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.view.get(spawned.id)?.status, "running");

    const controller = new AbortController();
    const send = runtime.runPromise(
      manager.send(spawned.id, "must never start"),
      { signal: controller.signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(send);

    firstPrompt.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(harness.calls.prompts, ["completed before aborted send"]);
    assert.equal(manager.view.get(spawned.id)?.status, "done");
    assert.equal(
      manager.view.get(spawned.id)?.finalText,
      "stable prior result",
    );
  } finally {
    firstPrompt.resolve();
    secondPrompt.resolve();
    await runtime.dispose();
  }
});

test("run-local terminal evidence survives preflight and post-run compaction", async () => {
  const initialMessages = Array.from({ length: 64 }, (_, index) => ({
    role: "user" as const,
    content: `old context ${index}`,
    timestamp: index,
  })) as AgentSession["messages"];
  const fixtures = harnessFactory(() => ({ initialMessages }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("complete after compaction")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);

    // Pi may replace the entire message array during prompt preflight.
    harness.messages.splice(0, harness.messages.length, {
      role: "user",
      content: "compacted context",
      timestamp: Date.now(),
    });
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("fresh completed result");
    // Post-run compaction can replace it again before agent_settled.
    harness.messages.splice(0, harness.messages.length);
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await runtime.runPromise(manager.waitFor([spawned.id]));
    assert.equal(
      manager.view.get(spawned.id)?.finalText,
      "fresh completed result",
    );

    await runtime.runPromise(manager.send(spawned.id, "fail after compaction"));
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("fresh failed partial", {
      stopReason: "error",
      errorMessage: "fresh provider failure",
    });
    harness.messages.splice(0, harness.messages.length);
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await runtime.runPromise(manager.waitFor([spawned.id]));
    assert.equal(manager.view.get(spawned.id)?.status, "error");
    assert.equal(
      manager.view.get(spawned.id)?.errorText,
      "fresh provider failure",
    );
    assert.equal(
      manager.view.get(spawned.id)?.finalText,
      "fresh failed partial",
    );

    await runtime.runPromise(
      manager.send(spawned.id, "interrupt after compaction"),
    );
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitTextDelta("fresh interrupted partial");
    harness.messages.splice(0, harness.messages.length);
    const cancellation = runtime.runPromise(manager.cancel([spawned.id]));
    await waitFor(() => harness.calls.aborts === 1, "compacted run abort");
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await cancellation;
    assert.equal(manager.view.get(spawned.id)?.status, "error");
    assert.equal(
      manager.view.get(spawned.id)?.finalText,
      "fresh interrupted partial",
    );
  } finally {
    await runtime.dispose();
  }
});

test("cancelled restart preflight never reuses the previous run output", async () => {
  const restartPreflight = deferred<void>();
  let preflightIndex = 0;
  const fixtures = harnessFactory(() => ({
    preflight: () =>
      preflightIndex++ === 0 ? Promise.resolve() : restartPreflight.promise,
  }));
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn("pi", task("successful first run")),
    );
    const harness = fixtures.harnesses[0];
    assert.ok(harness);
    harness.setStreaming(true);
    harness.emit({ type: "agent_start" });
    harness.emitAssistant("previous successful result");
    harness.setStreaming(false);
    harness.emit({ type: "agent_settled" });
    harness.resolvePrompt();
    await runtime.runPromise(manager.waitFor([spawned.id]));
    assert.equal(
      manager.view.get(spawned.id)?.finalText,
      "previous successful result",
    );

    await runtime.runPromise(manager.send(spawned.id, "cancel this preflight"));
    await waitFor(
      () => harness.calls.prompts.length === 2,
      "restart preflight to begin",
    );
    const cancellation = runtime.runPromise(manager.cancel([spawned.id]));
    await waitFor(() => harness.calls.aborts === 1, "restart preflight abort");
    restartPreflight.resolve();
    const report = await cancellation;

    assert.equal(report[0]?.cancelled, true);
    assert.equal(manager.view.get(spawned.id)?.status, "error");
    assert.equal(manager.view.get(spawned.id)?.finalText, "");
  } finally {
    restartPreflight.resolve();
    await runtime.dispose();
  }
});

test("a preflight that ignores abort is force-closed without reopening the session", async () => {
  const stuckPreflight = deferred<void>();
  let providerRuns = 0;
  let cleanupCalls = 0;
  const fixtures = harnessFactory((_options, index) =>
    index === 0
      ? {
          preflight: () => stuckPreflight.promise,
          prompt: async () => {
            providerRuns++;
          },
        }
      : {},
  );
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
    worktreeCleanup: async () => {
      cleanupCalls++;
      throw new Error("unsafe worktree cleanup should not run");
    },
  });
  const runtime = createManagerRuntime(backend, 10_000);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    const spawned = await runtime.runPromise(
      manager.spawn(
        "pi",
        task("never-ending preflight", {
          worktree: {
            path: "C:/fixture-worktree",
            branch: "pi/fixture-worktree",
            repoCwd: process.cwd(),
          },
        }),
      ),
    );
    const startedAt = Date.now();
    const report = await runtime.runPromise(manager.cancel([spawned.id]));
    assert.ok(Date.now() - startedAt >= 4_500);
    assert.equal(report[0]?.cancelled, true);
    assert.match(
      manager.view.get(spawned.id)?.errorText ?? "",
      /Abort deadline exceeded/,
    );
    assert.match(
      manager.view.get(spawned.id)?.errorText ?? "",
      /worktree cleanup skipped; checkout preserved at C:\/fixture-worktree/,
    );
    assert.equal(cleanupCalls, 0);
    await waitFor(
      () => fixtures.harnesses[0]?.calls.disposals === 1,
      "stuck preflight session disposal",
    );
    await assert.rejects(
      runtime.runPromise(manager.send(spawned.id, "must stay closed")),
      /session is closed/,
    );
    assert.deepEqual(fixtures.harnesses[0]?.calls.prompts, [
      "never-ending preflight",
    ]);
    stuckPreflight.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(providerRuns, 0);

    const fresh = await runtime.runPromise(
      manager.spawn("pi", task("fresh after forced close")),
    );
    assert.equal(fresh.status, "running");
    const freshCancellation = runtime.runPromise(manager.cancel([fresh.id]));
    const freshHarness = fixtures.harnesses[1];
    assert.ok(freshHarness);
    await waitFor(() => freshHarness.calls.aborts === 1, "fresh run abort");
    freshHarness.emit({ type: "agent_settled" });
    freshHarness.resolvePrompt();
    await freshCancellation;
  } finally {
    stuckPreflight.resolve();
    await runtime.dispose();
  }
});

test("prompt and tool cancellation ignore late completion and free capacity", async () => {
  const latePrompt = deferred<void>();
  const fixtures = harnessFactory((_options, index) =>
    index === 0 ? { prompt: () => latePrompt.promise } : {},
  );
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 50,
  });
  const runtime = createManagerRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    let settlements = 0;
    manager.view.setOnSettled(() => settlements++);
    const spawned = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        runtime.runPromise(manager.spawn("pi", task(`cancel ${index}`))),
      ),
    );
    for (const harness of fixtures.harnesses) harness.setStreaming(true);
    for (const harness of fixtures.harnesses.slice(2)) {
      harness.emit({ type: "agent_start" });
      harness.emitTextDelta("tool run started");
      harness.emit({
        type: "tool_execution_start",
        toolCallId: `tool-${fixtures.harnesses.indexOf(harness)}`,
        toolName: "read",
        args: { path: "README.md" },
      });
    }
    await waitFor(
      () =>
        spawned
          .slice(2)
          .every(
            (snapshot) => manager.view.get(snapshot.id)?.liveTools.length === 1,
          ),
      "tool starts to reach the manager",
    );

    let cancellationFinished = false;
    const cancellation = runtime
      .runPromise(manager.cancel(spawned.map((snapshot) => snapshot.id)))
      .then((result) => {
        cancellationFinished = true;
        return result;
      });
    await waitFor(
      () => fixtures.harnesses.every((harness) => harness.calls.aborts === 1),
      "all prompt and tool aborts",
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancellationFinished, false);
    latePrompt.reject(new Error("late prompt rejection"));
    for (const harness of fixtures.harnesses.slice(1)) {
      harness.emit({ type: "agent_settled" });
      harness.resolvePrompt();
    }
    const report = await cancellation;
    assert.ok(report.every((result) => result.cancelled));
    assert.ok(
      spawned.every(
        (snapshot) =>
          manager.view.get(snapshot.id)?.errorText === "Run was aborted",
      ),
    );
    assert.equal(settlements, 4);

    const promptHarness = fixtures.harnesses[0];
    const toolHarness = fixtures.harnesses[2];
    assert.ok(promptHarness);
    assert.ok(toolHarness);
    promptHarness.emit({ type: "agent_start" });
    promptHarness.emitAssistant("late prompt completion");
    promptHarness.emit({ type: "agent_settled" });
    toolHarness.emit({
      type: "tool_execution_end",
      toolCallId: "tool-2",
      toolName: "read",
      result: { content: [{ type: "text", text: "late tool result" }] },
      isError: false,
    });
    toolHarness.emitAssistant("late tool completion");
    toolHarness.emit({ type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settlements, 4);
    assert.equal(manager.view.get(spawned[0]!.id)?.finalText, "");
    assert.equal(
      manager.view.get(spawned[2]!.id)?.finalText,
      "tool run started",
    );

    const afterCancellation = await runtime.runPromise(
      manager.spawn("pi", task("capacity was released")),
    );
    assert.equal(afterCancellation.status, "running");
    const afterCancellationStop = runtime.runPromise(
      manager.cancel([afterCancellation.id]),
    );
    const afterCancellationHarness = fixtures.harnesses[4];
    assert.ok(afterCancellationHarness);
    await waitFor(
      () => afterCancellationHarness.calls.aborts === 1,
      "replacement run abort",
    );
    afterCancellationHarness.emit({ type: "agent_settled" });
    afterCancellationHarness.resolvePrompt();
    await afterCancellationStop;
  } finally {
    await runtime.dispose();
  }
});

test("a silent provider is terminalized once, disposed, and releases all slots", async () => {
  const never = new Promise<void>(() => {});
  const fixtures = harnessFactory((_options, index) => {
    if (index >= 4) return {};
    if (index % 2 === 0) return { shutdown: () => never };
    return {
      shutdown: async () => {
        throw new Error("shutdown fixture failed");
      },
      dispose: () => {
        throw new Error("dispose fixture failed");
      },
    };
  });
  const backend = makePiBackend({
    sessionFactory: fixtures.factory,
    shutdownTimeoutMs: 30,
  });
  const runtime = createManagerRuntime(backend, 40);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    let settlements = 0;
    manager.view.setOnSettled(() => settlements++);
    const stalled = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        runtime.runPromise(manager.spawn("pi", task(`silent ${index}`))),
      ),
    );

    await assert.rejects(
      runtime.runPromise(manager.spawn("pi", task("over capacity"))),
      /Max 4 subagent sessions/,
    );
    await runtime.runPromise(
      manager.waitFor(stalled.map((snapshot) => snapshot.id)),
    );
    for (const snapshot of stalled) {
      const failed = manager.view.get(snapshot.id);
      assert.equal(failed?.status, "error");
      assert.match(failed?.errorText ?? "", /no assistant response event/);
    }
    assert.equal(settlements, 4);
    await waitFor(
      () =>
        fixtures.harnesses.every((harness) => harness.calls.disposals === 1),
      "silent sessions to be disposed despite cleanup failures",
    );

    const late = fixtures.harnesses[0];
    assert.ok(late);
    late.emitAssistant("late provider completion");
    late.emit({ type: "agent_settled" });
    late.resolvePrompt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settlements, 4);
    assert.equal(manager.view.get(stalled[0]!.id)?.finalText, "");

    const fresh = await runtime.runPromise(
      manager.spawn("pi", task("fresh after watchdog")),
    );
    assert.equal(fresh.status, "running");
    const freshCancellation = runtime.runPromise(manager.cancel([fresh.id]));
    const freshHarness = fixtures.harnesses[4];
    assert.ok(freshHarness);
    await waitFor(() => freshHarness.calls.aborts === 1, "fresh run abort");
    freshHarness.emit({ type: "agent_settled" });
    freshHarness.resolvePrompt();
    await freshCancellation;
  } finally {
    await runtime.dispose();
  }
});

test("adapter scope cleanup is bounded across shutdown timeouts and failures", async () => {
  const never = new Promise<void>(() => {});
  const timedOutFixtures = harnessFactory(() => ({
    prompt: async () => {},
    shutdown: () => never,
  }));
  const timedOutBackend = makePiBackend({
    sessionFactory: timedOutFixtures.factory,
    shutdownTimeoutMs: 25,
  });
  const timeoutStartedAt = Date.now();
  await Effect.runPromise(
    Effect.scoped(timedOutBackend.spawn(task("timeout cleanup"))),
  );
  assert.ok(Date.now() - timeoutStartedAt < 500);
  const timedOutHarness = timedOutFixtures.harnesses[0];
  assert.ok(timedOutHarness);
  assert.equal(timedOutHarness.calls.shutdowns, 1);
  assert.equal(timedOutHarness.calls.disposals, 1);

  const failedFixtures = harnessFactory(() => ({
    prompt: async () => {},
    shutdown: async () => {
      throw new Error("shutdown fixture failed");
    },
    dispose: () => {
      throw new Error("dispose fixture failed");
    },
  }));
  const failedBackend = makePiBackend({
    sessionFactory: failedFixtures.factory,
    shutdownTimeoutMs: 25,
  });
  await Effect.runPromise(
    Effect.scoped(failedBackend.spawn(task("failed cleanup"))),
  );
  const failedHarness = failedFixtures.harnesses[0];
  assert.ok(failedHarness);
  assert.equal(failedHarness.calls.shutdowns, 1);
  assert.equal(failedHarness.calls.disposals, 1);
});
