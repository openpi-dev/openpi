import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateAgentSessionOptions,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import type {
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

    const report = await runtime.runPromise(
      manager.cancel(spawned.map((snapshot) => snapshot.id)),
    );
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
    latePrompt.reject(new Error("late prompt rejection"));
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
    assert.equal(manager.view.get(spawned[2]!.id)?.finalText, "");

    const afterCancellation = await runtime.runPromise(
      manager.spawn("pi", task("capacity was released")),
    );
    assert.equal(afterCancellation.status, "running");
    await runtime.runPromise(manager.cancel([afterCancellation.id]));
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
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settlements, 4);
    assert.equal(manager.view.get(stalled[0]!.id)?.finalText, "");

    const fresh = await runtime.runPromise(
      manager.spawn("pi", task("fresh after watchdog")),
    );
    assert.equal(fresh.status, "running");
    await runtime.runPromise(manager.cancel([fresh.id]));
  } finally {
    await runtime.dispose();
  }
});

test("adapter scope cleanup is bounded across shutdown timeouts and failures", async () => {
  const never = new Promise<void>(() => {});
  const timedOutFixtures = harnessFactory(() => ({
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
