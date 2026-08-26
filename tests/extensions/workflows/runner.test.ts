import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  agentFailureMessage,
  createFirstResponseWatchdog,
  guardWorkflowChildTools,
  observeAssistantSettlement,
  recordToolExecutionTiming,
  runAgent,
  type ToolExecutionTiming,
  transcriptFromMessages,
  type WorkflowAgentSessionFactory,
  workflowChildTools,
} from "../../../extensions/workflows/runner.ts";

async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "workflow-preflight-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settleWithin<T>(operation: Promise<T>, timeoutMs = 250) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(new Error(`Operation did not settle within ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function runnerHarness(options: {
  bind?: () => Promise<void>;
  prompt?: () => Promise<void>;
  abort?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}) {
  const listeners = new Set<AgentSessionEventListener>();
  const messages: AgentSession["messages"] = [];
  const firstDisposal = deferred<void>();
  let bindings = 0;
  let prompts = 0;
  let aborts = 0;
  let disposals = 0;
  const session = {
    messages,
    model: undefined,
    extensionRunner: {
      hasHandlers: () => options.shutdown !== undefined,
      emit: async () => options.shutdown?.(),
    },
    async bindExtensions() {
      bindings++;
      await options.bind?.();
    },
    subscribe(listener: AgentSessionEventListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt() {
      prompts++;
      await options.prompt?.();
    },
    async abort() {
      aborts++;
      await options.abort?.();
    },
    dispose() {
      disposals++;
      firstDisposal.resolve();
    },
    getContextUsage: () => undefined,
    getAllTools: () => [],
    getToolDefinition: () => undefined,
  } as unknown as AgentSession;
  const factory: WorkflowAgentSessionFactory = async () => ({ session });
  return {
    factory,
    session,
    messages,
    emit: (event: AgentSessionEvent) => {
      for (const listener of listeners) listener(event);
    },
    bindings: () => bindings,
    prompts: () => prompts,
    aborts: () => aborts,
    disposals: () => disposals,
    firstDisposal: firstDisposal.promise,
  };
}

function runHarnessAgent(
  harness: ReturnType<typeof runnerHarness>,
  overrides: Partial<Parameters<typeof runAgent>[0]> = {},
) {
  return runAgent({
    prompt: "fixture",
    cwd: process.cwd(),
    loader: {} as Parameters<typeof runAgent>[0]["loader"],
    settingsManager: {} as Parameters<typeof runAgent>[0]["settingsManager"],
    modelRegistry: { find: () => undefined } as unknown as Parameters<
      typeof runAgent
    >[0]["modelRegistry"],
    sessionFactory: harness.factory,
    ...overrides,
  });
}

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistantTextMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage,
    stopReason: "stop" as const,
    timestamp: 1_000,
  } satisfies AgentSession["messages"][number];
}

function parallelToolMessages(): AgentSession["messages"] {
  return [
    { role: "user", content: "run both", timestamp: 900 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-a",
          name: "first",
          arguments: { value: 1 },
        },
        {
          type: "toolCall",
          id: "call-b",
          name: "second",
          arguments: { value: 2 },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 950,
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "first",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1_040,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "second",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1_041,
    },
  ];
}

test("runAgent uses a caller-supplied in-memory session manager", async () => {
  const harness = runnerHarness({});
  const sessionManager = SessionManager.inMemory(process.cwd());
  let observed: unknown;
  const factory: WorkflowAgentSessionFactory = async (options) => {
    observed = options?.sessionManager;
    return harness.factory(options);
  };

  await runHarnessAgent(harness, {
    sessionManager,
    sessionFactory: factory,
  });

  assert.equal(observed, sessionManager);
});

test("completed parallel tool calls pair lifecycle timings with calls and results", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    1_000,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "second",
      args: { value: 2 },
    },
    1_002,
  );
  // Parallel calls can finish in a different order than their result messages.
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "second",
      result: { content: [{ type: "text", text: "second result" }] },
      isError: false,
    },
    1_012,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "first",
      result: { content: [{ type: "text", text: "first result" }] },
      isError: false,
    },
    1_030,
  );

  const transcript = transcriptFromMessages(parallelToolMessages(), timings);
  const toolEntries = transcript.filter((entry) => entry.role === "tool");
  const resultEntries = transcript.filter(
    (entry) => entry.role === "toolResult",
  );

  for (const entries of [toolEntries, resultEntries]) {
    assert.deepEqual(
      entries.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
        toolCallId,
        startedAt,
        finishedAt,
        durationMs,
      })),
      [
        {
          toolCallId: "call-a",
          startedAt: 1_000,
          finishedAt: 1_030,
          durationMs: 30,
        },
        {
          toolCallId: "call-b",
          startedAt: 1_002,
          finishedAt: 1_012,
          durationMs: 10,
        },
      ],
    );
  }
});

test("in-flight aborted tool calls retain start timing without completion", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    2_000,
  );

  const transcript = transcriptFromMessages(
    parallelToolMessages().slice(0, 2),
    timings,
  );
  const first = transcript.find((entry) => entry.toolCallId === "call-a");

  assert.equal(first?.startedAt, 2_000);
  assert.equal(first?.finishedAt, undefined);
  assert.equal(first?.durationMs, undefined);
  assert.equal(
    transcript.some((entry) => entry.role === "toolResult"),
    false,
  );
});

test("assistant settlement survives failed compaction and clears after recovery", () => {
  const overflow = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: zeroUsage,
    stopReason: "error",
    errorMessage: "input exceeds the context window",
    timestamp: 1_000,
  } satisfies AgentSession["messages"][number];
  const recovered = {
    ...overflow,
    content: [
      {
        type: "toolCall" as const,
        id: "structured-result",
        name: "structured_output",
        arguments: { ok: true },
      },
    ],
    stopReason: "toolUse" as const,
    errorMessage: undefined,
    timestamp: 2_000,
  };

  let settlement = observeAssistantSettlement(undefined, overflow);
  assert.deepEqual(settlement, {
    stopReason: "error",
    errorMessage: "input exceeds the context window",
  });
  assert.equal(
    agentFailureMessage(settlement),
    "input exceeds the context window",
  );

  // Pi removes the overflow assistant from active messages before compacting.
  // A failed compaction emits no newer assistant, so the observed error stays.
  settlement = observeAssistantSettlement(settlement, undefined);
  assert.equal(
    agentFailureMessage(settlement),
    "input exceeds the context window",
  );

  // A successful compact-and-retry emits a newer assistant and supersedes it.
  settlement = observeAssistantSettlement(settlement, recovered);
  assert.deepEqual(settlement, {
    stopReason: "toolUse",
    errorMessage: undefined,
  });
  assert.equal(agentFailureMessage(settlement), undefined);
  assert.equal(
    agentFailureMessage(settlement, "prompt rejected"),
    "prompt rejected",
    "a thrown prompt error must remain independent from assistant recovery",
  );
});

test("schema-less agents fail when prompt resolves without an assistant response", async () => {
  const harness = runnerHarness({});

  const outcome = await runHarnessAgent(harness);

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.output, "");
  assert.equal(outcome.error, "Agent finished without an assistant response.");
  assert.equal(harness.aborts(), 0);
  assert.equal(harness.disposals(), 1);
});

test("schema-less agents accept an empty assistant message_end", async () => {
  let respond = () => {};
  const harness = runnerHarness({ prompt: async () => respond() });
  respond = () => {
    const message = assistantTextMessage("");
    harness.messages.push(message);
    harness.emit({ type: "message_end", message });
  };

  const outcome = await runHarnessAgent(harness);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.aborted, false);
  assert.equal(outcome.output, "");
  assert.equal(outcome.error, undefined);
  assert.equal(harness.disposals(), 1);
});

test("a pre-aborted startup does not create or bind a child session", async () => {
  const harness = runnerHarness({});
  const controller = new AbortController();
  let factoryCalls = 0;
  const factory: WorkflowAgentSessionFactory = async (options) => {
    factoryCalls++;
    return harness.factory(options);
  };
  controller.abort(new Error("cancel before startup"));

  const outcome = await settleWithin(
    runHarnessAgent(harness, {
      signal: controller.signal,
      sessionFactory: factory,
    }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal(factoryCalls, 0);
  assert.equal(harness.bindings(), 0);
  assert.equal(harness.prompts(), 0);
  assert.equal(harness.disposals(), 0);
});

test("cancel during session creation returns before a late session is disposed", async () => {
  const harness = runnerHarness({});
  const creationStarted = deferred<void>();
  const creation = deferred<{ session: AgentSession }>();
  const controller = new AbortController();
  const outcomePromise = runHarnessAgent(harness, {
    signal: controller.signal,
    sessionFactory: () => {
      creationStarted.resolve();
      return creation.promise;
    },
  });
  await creationStarted.promise;

  controller.abort(new Error("cancel during creation"));
  let outcome;
  try {
    outcome = await settleWithin(outcomePromise);
  } finally {
    creation.resolve({ session: harness.session });
  }

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal(harness.bindings(), 0);
  assert.equal(harness.prompts(), 0);
  await settleWithin(harness.firstDisposal);
  assert.equal(harness.aborts(), 1);
  assert.equal(harness.disposals(), 1);
});

test("cancel during session creation observes a late factory failure", async () => {
  const harness = runnerHarness({});
  const creationStarted = deferred<void>();
  const creation = deferred<{ session: AgentSession }>();
  const controller = new AbortController();
  const outcomePromise = runHarnessAgent(harness, {
    signal: controller.signal,
    sessionFactory: () => {
      creationStarted.resolve();
      return creation.promise;
    },
  });
  await creationStarted.promise;

  controller.abort(new Error("cancel before factory failure"));
  let outcome;
  try {
    outcome = await settleWithin(outcomePromise);
  } finally {
    creation.reject(new Error("late factory failure"));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal(harness.bindings(), 0);
  assert.equal(harness.prompts(), 0);
  assert.equal(harness.aborts(), 0);
  assert.equal(harness.disposals(), 0);
});

test("cancel during extension binding owns the session and observes a late failure", async () => {
  const bindingStarted = deferred<void>();
  const binding = deferred<void>();
  const harness = runnerHarness({
    bind: () => {
      bindingStarted.resolve();
      return binding.promise;
    },
  });
  const controller = new AbortController();
  const outcomePromise = runHarnessAgent(harness, {
    signal: controller.signal,
  });
  await bindingStarted.promise;

  controller.abort(new Error("cancel during binding"));
  let outcome;
  try {
    outcome = await settleWithin(outcomePromise);
  } finally {
    binding.reject(new Error("late binding failure"));
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.equal(harness.bindings(), 1);
  assert.equal(harness.prompts(), 0);
  assert.equal(harness.aborts(), 1);
  assert.equal(harness.disposals(), 1);
});

test("cancel during prompt owns the session and returns after bounded disposal", async () => {
  const prompt = deferred<void>();
  const abort = deferred<void>();
  const harness = runnerHarness({
    prompt: () => prompt.promise,
    abort: () => abort.promise,
  });
  const controller = new AbortController();
  const outcomePromise = runHarnessAgent(harness, {
    signal: controller.signal,
    shutdownTimeoutMs: 10,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error("cancel fixture"));
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.aborted, true);
  assert.match(outcome.error ?? "", /aborted.*abort timed out/i);
  assert.equal(harness.aborts(), 1);
  assert.equal(harness.disposals(), 1);
  prompt.resolve();
  abort.resolve();
});

test("cancel during a hanging tool ignores late events and progress writers", async () => {
  const prompt = deferred<void>();
  const harness = runnerHarness({ prompt: () => prompt.promise });
  const controller = new AbortController();
  let progress = 0;
  const outcomePromise = runHarnessAgent(harness, {
    signal: controller.signal,
    shutdownTimeoutMs: 20,
    onProgress: () => progress++,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  harness.emit({
    type: "tool_execution_start",
    toolCallId: "hanging",
    toolName: "fixture",
    args: {},
  });
  controller.abort();
  const outcome = await outcomePromise;
  const settledProgress = progress;
  harness.emit({
    type: "tool_execution_end",
    toolCallId: "hanging",
    toolName: "fixture",
    result: { content: [{ type: "text", text: "late" }] },
    isError: false,
  });
  assert.equal(progress, settledProgress);
  assert.equal(outcome.aborted, true);
  assert.equal(
    outcome.transcript.some((entry) => entry.finishedAt !== undefined),
    false,
  );
  prompt.resolve();
});

test("late prompt completion after first-response timeout cannot become success", async () => {
  const prompt = deferred<void>();
  const harness = runnerHarness({ prompt: () => prompt.promise });
  const outcome = await runHarnessAgent(harness, {
    firstResponseTimeoutMs: 5,
    shutdownTimeoutMs: 20,
  });
  prompt.resolve();
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /no assistant response event/i);
  assert.equal(harness.aborts(), 1);
  assert.equal(harness.disposals(), 1);
});

test("cleanup timeout is surfaced instead of reporting agent success", async () => {
  const harness = runnerHarness({ shutdown: () => new Promise(() => {}) });
  const outcome = await runHarnessAgent(harness, { shutdownTimeoutMs: 5 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error ?? "", /cleanup failed.*shutdown timed out/i);
  assert.equal(harness.disposals(), 1);
});

test("first-response watchdog aborts a silent provider request", async () => {
  let aborted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /no assistant response event for fixture-model within 10 ms.*stalled/i,
  );
  assert.equal(aborted, true);
});

test("first assistant response disarms the watchdog without limiting the run", async () => {
  const watchdog = createFirstResponseWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("explicit watchdog cancellation disarms a pending operation", async () => {
  let timedOut = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      timedOut = true;
    },
    { timeoutMs: 5 },
  );
  void watchdog.waitFor(new Promise<never>(() => {}));
  watchdog.cancel();

  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(timedOut, false);
});

test("structured role children keep their terminating tool without widening capabilities", () => {
  assert.deepEqual(workflowChildTools(["read", "rg"], true), [
    "read",
    "rg",
    "structured_output",
  ]);
  assert.deepEqual(workflowChildTools(["read"], false), ["read"]);
  assert.equal(
    workflowChildTools(undefined, true),
    undefined,
    "an untyped child must retain its normal inherited tool set",
  );
});

test("workflow agents reject a missing declared tool before prompting", async () => {
  await withTempDir(async (cwd) => {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: path.join(cwd, "agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "available_fixture_tool",
            label: "Available fixture tool",
            description: "fixture",
            parameters: Type.Object({}),
            async execute() {
              return {
                content: [{ type: "text", text: "ok" }],
                details: {},
              };
            },
          });
        },
      ],
    });
    await loader.reload();
    const model = {
      provider: "fixture",
      id: "fixture-model",
      name: "Fixture Model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 1_024,
    } as NonNullable<Parameters<typeof runAgent>[0]["model"]>;
    const outcome = await runAgent({
      prompt: "must never reach the provider",
      model,
      cwd,
      loader,
      settingsManager,
      modelRegistry: {
        find: () => undefined,
      } as unknown as Parameters<typeof runAgent>[0]["modelRegistry"],
      tools: ["read", "available_fixture_tool", "missing_fixture_tool"],
    });

    assert.equal(outcome.ok, false);
    assert.match(
      outcome.error ?? "",
      /Failed to create agent session: Child tool preflight failed: requested tool "missing_fixture_tool" is unavailable after child extensions initialized/,
    );
    assert.deepEqual(outcome.transcript, []);
    assert.equal(outcome.usage.turns, 0);
  });
});

test("workflow child guards enforce the replay filesystem boundary", async () => {
  await withTempDir(async (cwd) => {
    let observations = 0;
    let violations = 0;
    const read = {
      name: "read",
      label: "read",
      description: "fixture",
      parameters: Type.Object({ path: Type.String() }),
      async execute(_toolCallId: string, _params: { path: string }) {
        observations++;
        return {
          content: [{ type: "text" as const, text: "observed" }],
          details: {},
        };
      },
    } satisfies ToolDefinition;
    const session = {
      getAllTools: () => [
        {
          name: "read",
          sourceInfo: {
            path: "<builtin:read>",
            source: "builtin",
            origin: "top-level",
          },
        },
      ],
      getToolDefinition: () => read,
      subscribe: () => () => {},
    };
    const unsubscribe = guardWorkflowChildTools(session, 1_000, {
      repositoryRoot: cwd,
      cwd,
      onViolation: () => {
        violations++;
      },
    });

    assert.equal(
      (await read.execute("local", { path: "." })).content[0]?.text,
      "observed",
    );
    await assert.rejects(
      read.execute("external", { path: path.dirname(cwd) }),
      /Replay filesystem boundary blocked/,
    );
    assert.equal(observations, 1);
    assert.equal(violations, 1);
    unsubscribe();
  });
});

test("workflow children guard structured, normal, and dynamically registered tools", async () => {
  const structuredResult = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };
  const structured = {
    name: "structured_output",
    label: "Structured Output",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return structuredResult;
    },
  } satisfies ToolDefinition;
  const definitions = new Map<string, ToolDefinition>([
    [structured.name, structured],
  ]);
  let listener: AgentSessionEventListener | undefined;
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe(next: AgentSessionEventListener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  const unsubscribe = guardWorkflowChildTools(session, 10);
  assert.equal(await structured.execute(), structuredResult);

  let dynamicSignal: AbortSignal | undefined;
  const dynamic = {
    name: "dynamic_fixture",
    label: "Dynamic Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ) {
      dynamicSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  const originalDynamicExecute = dynamic.execute;
  definitions.set(dynamic.name, dynamic);
  listener?.({ type: "agent_start" });
  assert.notEqual(dynamic.execute, originalDynamicExecute);

  await assert.rejects(
    dynamic.execute("fixture", {}, undefined),
    /Tool call "dynamic_fixture" timed out after 10 ms\./,
  );
  assert.equal(dynamicSignal?.aborted, true);
  unsubscribe();
});
