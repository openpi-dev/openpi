import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import {
  type WebRuntimeEvent,
  WebRuntimeRequestError,
} from "../../web/runtime/types.ts";
import { acquireWebHostLease } from "../../web/runtime/web-host-lease.ts";

type Trace = {
  commandId: string;
  sessionId: string;
  startedAt: number;
  started: boolean;
  queued: boolean;
};

type RuntimeHarness = {
  runtime: { session: object; dispose?: () => Promise<void> };
  activePromptTrace?: Trace;
  pendingPromptTraces: Trace[];
  liveMessageSequence: number;
  liveMessageKey?: string;
  listeners: Set<(event: WebRuntimeEvent) => void>;
};

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (error?: unknown) => void = () => undefined;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type PromptOptions = {
  preflightResult?: (accepted: boolean) => void;
};

function promptSession(sessionId: string) {
  const calls: Array<{
    content: string;
    options: PromptOptions;
    run: ReturnType<typeof deferred>;
  }> = [];
  return {
    isStreaming: false,
    pendingMessageCount: 0,
    sessionManager: { getSessionId: () => sessionId },
    abort: async (): Promise<void> => undefined,
    subscribe() {
      return () => undefined;
    },
    prompt(content: string, options: PromptOptions) {
      const run = deferred();
      calls.push({ content, options, run });
      return run.promise;
    },
    calls,
  };
}

type PromptSession = ReturnType<typeof promptSession>;
type FakeAgentRuntime = {
  session: PromptSession;
  dispose: () => Promise<void>;
};
type PromptRuntimeHarness = {
  runtime: FakeAgentRuntime;
  listeners: Set<(event: WebRuntimeEvent) => void>;
  retainedRuntimes: Set<FakeAgentRuntime>;
  retainedSubscriptions: Map<FakeAgentRuntime, () => void>;
  inFlightRuntimes: Map<FakeAgentRuntime, number>;
  promptOperations: Set<Promise<void>>;
  runtimeOperations: Set<Promise<void>>;
  candidateRuntimes: Set<FakeAgentRuntime>;
  runtimeDisposals: Set<Promise<void>>;
  runtimeDisposalFailure?: unknown;
  runtimeDisposalPromises: WeakMap<FakeAgentRuntime, Promise<void>>;
  promptAdmission: Promise<void>;
  pendingPromptTraces: Trace[];
  disposed: boolean;
  hasSelectedWorkspace: boolean;
  dispatcherLease: { release: () => Promise<void> };
  webHostLease: { release: () => Promise<void> };
  sendPrompt: PiWebRuntime["sendPrompt"];
  subscribe: PiWebRuntime["subscribe"];
  dispose: PiWebRuntime["dispose"];
};

type LifecycleSession = {
  isStreaming: boolean;
  sessionManager: { getSessionId: () => string };
  bindExtensions: () => Promise<void>;
  abort: () => Promise<void>;
  subscribe: (listener: (event: { type: string }) => void) => () => void;
  binds: number;
  subscriptions: number;
  unsubscribes: number;
  aborts: number;
};

type LifecycleRuntime = {
  session: LifecycleSession;
  cwd: string;
  setRebindSession: (
    listener: (replacement: LifecycleSession) => Promise<void>,
  ) => void;
  rebindSession?: (replacement: LifecycleSession) => Promise<void>;
  dispose: () => Promise<void>;
  disposals: number;
};

type LifecycleHarness = {
  runtime: LifecycleRuntime;
  unsubscribeSession?: () => void;
  listeners: Set<(event: WebRuntimeEvent) => void>;
  retainedRuntimes: Set<LifecycleRuntime>;
  retainedSubscriptions: Map<LifecycleRuntime, () => void>;
  inFlightRuntimes: Map<LifecycleRuntime, number>;
  runtimeDisposalPromises: WeakMap<LifecycleRuntime, Promise<void>>;
  runtimeDisposals: Set<Promise<void>>;
  promptOperations: Set<Promise<void>>;
  runtimeOperations: Set<Promise<void>>;
  candidateRuntimes: Set<LifecycleRuntime>;
  pendingPromptTraces: Trace[];
  activePromptTrace?: Trace;
  liveMessageSequence: number;
  disposed: boolean;
  dispatcherLease: { release: () => Promise<void> };
  webHostLease: { release: () => Promise<void> };
  webSessionDirectory: string;
  dispose: PiWebRuntime["dispose"];
  newSession: PiWebRuntime["newSession"];
  switchSession: PiWebRuntime["switchSession"];
};

function lifecycleSession(
  sessionId: string,
  isStreaming: boolean,
  initialBinds = 1,
) {
  const session: LifecycleSession = {
    isStreaming,
    sessionManager: { getSessionId: () => sessionId },
    binds: initialBinds,
    subscriptions: 0,
    unsubscribes: 0,
    aborts: 0,
    async bindExtensions() {
      session.binds += 1;
    },
    async abort() {
      session.aborts += 1;
    },
    subscribe() {
      session.subscriptions += 1;
      return () => {
        session.unsubscribes += 1;
      };
    },
  };
  return session;
}

function lifecycleRuntime(session: LifecycleSession) {
  const runtime: LifecycleRuntime = {
    session,
    cwd: "/workspace",
    setRebindSession(listener) {
      runtime.rebindSession = listener;
    },
    disposals: 0,
    async dispose() {
      runtime.disposals += 1;
    },
  };
  return runtime;
}

function lifecycleHarness(runtime: LifecycleRuntime) {
  const harness = Object.create(
    PiWebRuntime.prototype,
  ) as unknown as LifecycleHarness;
  harness.runtime = runtime;
  harness.listeners = new Set();
  harness.retainedRuntimes = new Set();
  harness.retainedSubscriptions = new Map();
  harness.inFlightRuntimes = new Map();
  harness.runtimeDisposalPromises = new WeakMap();
  harness.runtimeDisposals = new Set();
  harness.promptOperations = new Set();
  harness.runtimeOperations = new Set();
  harness.candidateRuntimes = new Set();
  harness.pendingPromptTraces = [];
  harness.liveMessageSequence = 0;
  harness.disposed = false;
  harness.dispatcherLease = { release: async () => undefined };
  harness.webHostLease = { release: async () => undefined };
  harness.webSessionDirectory = "/tmp/openpi-test-sessions";
  return harness;
}

test("an unbound runtime rejects prompts before touching its bootstrap Session", async () => {
  const session = promptSession("bootstrap-session");
  const runtime = promptHarness(session);
  runtime.hasSelectedWorkspace = false;

  await assert.rejects(
    runtime.sendPrompt("must not run"),
    (error: unknown) =>
      error instanceof WebRuntimeRequestError &&
      error.code === "WORKSPACE_REQUIRED" &&
      error.statusCode === 409,
  );
  assert.equal(session.calls.length, 0);
});

function promptHarness(session: ReturnType<typeof promptSession>) {
  const harness = Object.create(
    PiWebRuntime.prototype,
  ) as unknown as PromptRuntimeHarness;
  harness.runtime = { session, dispose: async () => undefined };
  harness.listeners = new Set();
  harness.retainedRuntimes = new Set();
  harness.retainedSubscriptions = new Map();
  harness.inFlightRuntimes = new Map();
  harness.promptOperations = new Set();
  harness.runtimeOperations = new Set();
  harness.candidateRuntimes = new Set();
  harness.runtimeDisposals = new Set();
  harness.runtimeDisposalPromises = new WeakMap();
  harness.promptAdmission = Promise.resolve();
  harness.pendingPromptTraces = [];
  harness.disposed = false;
  harness.hasSelectedWorkspace = true;
  harness.dispatcherLease = { release: async () => undefined };
  harness.webHostLease = { release: async () => undefined };
  return harness;
}

test("prompt admission waits for Pi preflight acceptance", async () => {
  const session = promptSession("session-a");
  const runtime = promptHarness(session);
  let settled = false;

  const admission = runtime
    .sendPrompt("hello", {
      commandId: "command-a",
      expectedSessionId: "session-a",
    })
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  assert.equal(session.calls.length, 1);
  assert.equal(settled, false);

  session.calls[0].options.preflightResult?.(true);
  await admission;
  assert.equal(settled, true);

  session.calls[0].run.resolve();
  await Promise.resolve();
});

test("prompt preflight rejection is a typed non-admission", async () => {
  const session = promptSession("session-a");
  const runtime = promptHarness(session);
  const admission = runtime.sendPrompt("hello", {
    commandId: "command-a",
    expectedSessionId: "session-a",
  });
  await Promise.resolve();

  session.calls[0].options.preflightResult?.(false);
  const outcome = await Promise.race([
    admission.then(
      () => "resolved" as const,
      (error: unknown) => error,
    ),
    new Promise<"pending">((resolve) => setImmediate(() => resolve("pending"))),
  ]);
  session.calls[0].run.reject(new Error("no model selected"));
  await Promise.resolve();
  assert.ok(outcome instanceof WebRuntimeRequestError);
  assert.equal(outcome.code, "PROMPT_REJECTED");
  assert.equal(outcome.statusCode, 422);
});

test("prompt completion without a Pi preflight result fails closed", async () => {
  const session = promptSession("session-a");
  const runtime = promptHarness(session);
  const admission = runtime.sendPrompt("hello", {
    expectedSessionId: "session-a",
  });
  await Promise.resolve();

  session.calls[0].run.resolve();
  await assert.rejects(admission, (error: unknown) => {
    assert.ok(error instanceof WebRuntimeRequestError);
    assert.equal(error.code, "PROMPT_REJECTED");
    return true;
  });
});

test("queued prompts stay bound to the Session captured at submission", async () => {
  const sessionA = promptSession("session-a");
  const sessionB = promptSession("session-b");
  const runtime = promptHarness(sessionA);

  const first = runtime.sendPrompt("first", { expectedSessionId: "session-a" });
  await Promise.resolve();
  const second = runtime.sendPrompt("belongs-to-a", {
    expectedSessionId: "session-a",
  });
  runtime.runtime = { session: sessionB, dispose: async () => undefined };

  sessionA.calls[0].options.preflightResult?.(true);
  await first;
  await Promise.resolve();
  assert.deepEqual(
    sessionA.calls.map((call) => call.content),
    ["first", "belongs-to-a"],
  );
  assert.equal(sessionB.calls.length, 0);

  sessionA.calls[1].options.preflightResult?.(true);
  await second;
  for (const call of sessionA.calls) call.run.resolve();
  await Promise.resolve();
});

test("stale expected Session fails before prompt dispatch", async () => {
  const session = promptSession("session-a");
  const runtime = promptHarness(session);

  await assert.rejects(
    runtime.sendPrompt("wrong target", { expectedSessionId: "session-b" }),
    (error: unknown) => {
      assert.ok(error instanceof WebRuntimeRequestError);
      assert.equal(error.code, "SESSION_CONFLICT");
      assert.equal(error.statusCode, 409);
      return true;
    },
  );
  assert.equal(session.calls.length, 0);
});

test("model selection and Session activation are serialized", async () => {
  const applied = deferred();
  const model = { provider: "fixture", id: "model-a", name: "Model A" };
  const sessionA = {
    isStreaming: false,
    model: undefined as typeof model | undefined,
    subscribe: () => () => undefined,
    async setModel(selected: typeof model) {
      await applied.promise;
      sessionA.model = selected;
    },
  };
  const modelRuntime = {
    getModel: () => model,
    getAvailableSnapshot: () => [model],
  };
  const runtimeA = { session: sessionA, services: { modelRuntime } };
  const runtimeB = {
    session: { model: undefined },
    services: { modelRuntime },
  };
  const harness = Object.create(PiWebRuntime.prototype) as {
    runtime: typeof runtimeA | typeof runtimeB;
    listeners: Set<(event: WebRuntimeEvent) => void>;
    retainedRuntimes: Set<typeof runtimeA>;
    retainedSubscriptions: Map<typeof runtimeA, () => void>;
    inFlightRuntimes: Map<typeof runtimeA, number>;
    runtimeOperations: Set<Promise<void>>;
    runtimeDisposals: Set<Promise<void>>;
    runtimeDisposalPromises: WeakMap<typeof runtimeA, Promise<void>>;
    controllerMutation: Promise<void>;
    disposed: boolean;
    hasSelectedWorkspace: boolean;
    setModel: PiWebRuntime["setModel"];
    switchSession: PiWebRuntime["switchSession"];
    switchActiveSession: (path: string) => Promise<{ cancelled: false }>;
  };
  harness.runtime = runtimeA;
  harness.listeners = new Set();
  harness.retainedRuntimes = new Set();
  harness.retainedSubscriptions = new Map();
  harness.inFlightRuntimes = new Map();
  harness.runtimeOperations = new Set();
  harness.runtimeDisposals = new Set();
  harness.runtimeDisposalPromises = new WeakMap();
  harness.controllerMutation = Promise.resolve();
  harness.disposed = false;
  harness.hasSelectedWorkspace = true;
  harness.switchActiveSession = async () => {
    harness.runtime = runtimeB;
    return { cancelled: false };
  };
  const events: WebRuntimeEvent[] = [];
  harness.listeners.add((event) => events.push(event));

  const selection = harness.setModel("fixture", "model-a");
  await Promise.resolve();
  const switching = harness.switchSession("session-b");
  await Promise.resolve();
  assert.equal(harness.runtime, runtimeA);
  applied.resolve();

  assert.deepEqual(await selection, {
    provider: "fixture",
    id: "model-a",
    name: "Model A",
    label: "Model A",
    current: true,
  });
  await switching;
  assert.equal(harness.runtime, runtimeB);
  assert.deepEqual(events, [
    {
      type: "model_select",
      detail: { provider: "fixture", modelId: "model-a" },
    },
  ]);
});

test("a delayed model selection cannot target a newly activated Session", async () => {
  const switchStarted = deferred();
  const allowSwitch = deferred();
  const model = { provider: "fixture", id: "model-a", name: "Model A" };
  const modelRuntime = {
    getModel: () => model,
    getAvailableSnapshot: () => [model],
  };
  const runtimeA = {
    session: {
      sessionManager: { getSessionId: () => "session-a" },
      model: undefined as typeof model | undefined,
      async setModel() {
        throw new Error("Session A should not be selected after switching");
      },
    },
    services: { modelRuntime },
  };
  let sessionBModelWrites = 0;
  const runtimeB = {
    session: {
      sessionManager: { getSessionId: () => "session-b" },
      model: undefined as typeof model | undefined,
      async setModel(selected: typeof model) {
        sessionBModelWrites += 1;
        runtimeB.session.model = selected;
      },
    },
    services: { modelRuntime },
  };
  const harness = Object.create(PiWebRuntime.prototype) as {
    runtime: typeof runtimeA | typeof runtimeB;
    runtimeOperations: Set<Promise<void>>;
    controllerMutation: Promise<void>;
    disposed: boolean;
    hasSelectedWorkspace: boolean;
    setModel: PiWebRuntime["setModel"];
    switchSession: PiWebRuntime["switchSession"];
    switchActiveSession: (path: string) => Promise<{ cancelled: false }>;
  };
  harness.runtime = runtimeA;
  harness.runtimeOperations = new Set();
  harness.controllerMutation = Promise.resolve();
  harness.disposed = false;
  harness.hasSelectedWorkspace = true;
  harness.switchActiveSession = async () => {
    switchStarted.resolve();
    await allowSwitch.promise;
    harness.runtime = runtimeB;
    return { cancelled: false };
  };

  const switching = harness.switchSession("session-b");
  await switchStarted.promise;
  const selection = harness.setModel("fixture", "model-a", {
    expectedSessionId: "session-a",
  });
  allowSwitch.resolve();
  await switching;

  await assert.rejects(selection, (error: unknown) => {
    assert.ok(error instanceof WebRuntimeRequestError);
    assert.equal(error.code, "SESSION_CONFLICT");
    assert.equal(error.statusCode, 409);
    return true;
  });
  assert.equal(sessionBModelWrites, 0);
});

test("handled prompt emits a correlated settlement without agent events", async () => {
  const session = promptSession("session-a");
  const runtime = promptHarness(session);
  const events: WebRuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));

  const admission = runtime.sendPrompt("handled", {
    commandId: "command-a",
    expectedSessionId: "session-a",
  });
  await Promise.resolve();
  session.calls[0].options.preflightResult?.(true);
  await admission;
  session.calls[0].run.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(events, [
    {
      type: "prompt_settled",
      detail: {
        commandId: "command-a",
        sessionId: "session-a",
        outcome: "handled",
      },
    },
  ]);
});

test("later prompt failures retain their command and Session correlation", async () => {
  const session = promptSession("session-a");
  const runtime = promptHarness(session);
  const failure = new Promise<WebRuntimeEvent>((resolve) => {
    runtime.subscribe((event) => {
      if (event.type === "prompt_failed") resolve(event);
    });
  });

  const admission = runtime.sendPrompt("hello", {
    commandId: "command-a",
    expectedSessionId: "session-a",
  });
  await Promise.resolve();
  session.calls[0].options.preflightResult?.(true);
  await admission;
  session.calls[0].run.reject(new Error("provider failed"));

  assert.deepEqual(await failure, {
    type: "prompt_failed",
    detail: {
      commandId: "command-a",
      sessionId: "session-a",
      error: "provider failed",
    },
  });
});

test("retained Session cleanup waits for all of its prompt operations", async () => {
  const sessionA = promptSession("session-a");
  const sessionB = promptSession("session-b");
  let disposals = 0;
  const runtime = promptHarness(sessionA);
  runtime.runtime.dispose = async () => {
    disposals += 1;
  };
  const retainedRuntime = runtime.runtime;

  const first = runtime.sendPrompt("first", { expectedSessionId: "session-a" });
  await Promise.resolve();
  const second = runtime.sendPrompt("second", {
    expectedSessionId: "session-a",
  });
  runtime.runtime = {
    session: sessionB,
    dispose: async () => undefined,
  };
  runtime.retainedRuntimes.add(retainedRuntime);
  runtime.retainedSubscriptions.set(retainedRuntime, () => undefined);

  sessionA.calls[0].options.preflightResult?.(true);
  await first;
  await Promise.resolve();
  sessionA.calls[1].options.preflightResult?.(true);
  await second;

  sessionA.calls[0].run.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposals, 0);

  sessionA.calls[1].run.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(disposals, 1);
});

test("concurrent dispose calls await the same runtime cleanup", async () => {
  const cleanup = deferred();
  let aborts = 0;
  let disposals = 0;
  let dispatcherReleases = 0;
  let hostLeaseReleases = 0;
  const session = promptSession("session-a");
  session.abort = async () => {
    aborts += 1;
  };
  const runtime = promptHarness(session);
  runtime.runtime = {
    session,
    dispose: async () => {
      disposals += 1;
      await cleanup.promise;
    },
  };
  runtime.dispatcherLease = {
    release: async () => {
      dispatcherReleases += 1;
    },
  };
  runtime.webHostLease = {
    release: async () => {
      hostLeaseReleases += 1;
    },
  };

  let secondSettled = false;
  const first = runtime.dispose();
  const second = runtime.dispose().finally(() => {
    secondSettled = true;
  });
  await Promise.resolve();
  assert.equal(secondSettled, false);

  cleanup.resolve();
  await Promise.all([first, second]);
  assert.equal(aborts, 1);
  assert.equal(disposals, 1);
  assert.equal(dispatcherReleases, 1);
  assert.equal(hostLeaseReleases, 1);
});

test("promoting a retained runtime reattaches events without restarting extensions", async () => {
  const current = lifecycleRuntime(lifecycleSession("session-b", true));
  const retained = lifecycleRuntime(lifecycleSession("session-a", true));
  const harness = lifecycleHarness(current);
  harness.retainedRuntimes.add(retained);
  harness.retainedSubscriptions.set(retained, () => undefined);
  harness.unsubscribeSession = () => undefined;

  const promoteRetainedRuntime = (
    PiWebRuntime.prototype as unknown as {
      promoteRetainedRuntime(
        this: LifecycleHarness,
        runtime: LifecycleRuntime,
      ): Promise<void>;
    }
  ).promoteRetainedRuntime;
  await promoteRetainedRuntime.call(harness, retained);

  assert.equal(retained.session.binds, 1);
  assert.equal(harness.runtime, retained);
});

test("a retained runtime rebind cannot replace the active Session subscription", async () => {
  const sessionA = lifecycleSession("session-a", true, 0);
  const runtimeA = lifecycleRuntime(sessionA);
  const harness = lifecycleHarness(runtimeA);
  const startRuntimeSession = (
    PiWebRuntime.prototype as unknown as {
      startRuntimeSession(this: LifecycleHarness): Promise<void>;
    }
  ).startRuntimeSession;
  const replaceRuntime = (
    PiWebRuntime.prototype as unknown as {
      replaceRuntime(
        this: LifecycleHarness,
        runtime: LifecycleRuntime,
      ): Promise<void>;
    }
  ).replaceRuntime;
  await startRuntimeSession.call(harness);

  const sessionB = lifecycleSession("session-b", true, 0);
  const runtimeB = lifecycleRuntime(sessionB);
  await replaceRuntime.call(harness, runtimeB);
  const activeUnsubscribe = harness.unsubscribeSession;
  const activeUnsubscribes = sessionB.unsubscribes;
  const replacementA = lifecycleSession("session-a2", false, 0);

  assert.ok(runtimeA.rebindSession);
  runtimeA.session = replacementA;
  await assert.rejects(
    runtimeA.rebindSession(replacementA),
    /retained Web runtime cannot replace its Session/,
  );
  assert.equal(replacementA.binds, 0);
  assert.equal(harness.unsubscribeSession, activeUnsubscribe);
  assert.equal(sessionB.unsubscribes, activeUnsubscribes);
  assert.equal(harness.retainedRuntimes.has(runtimeA), false);
});

test("failed replacement activation restores the previous runtime without rebinding it", async () => {
  const previousSession = lifecycleSession("session-a", false, 1);
  const previous = lifecycleRuntime(previousSession);
  const harness = lifecycleHarness(previous);
  harness.unsubscribeSession = previousSession.subscribe(() => undefined);
  const replacementSession = lifecycleSession("session-b", false, 0);
  replacementSession.bindExtensions = async () => {
    replacementSession.binds += 1;
    throw new Error("session_start failed");
  };
  const replacement = lifecycleRuntime(replacementSession);
  const replaceRuntime = (
    PiWebRuntime.prototype as unknown as {
      replaceRuntime(
        this: LifecycleHarness,
        runtime: LifecycleRuntime,
      ): Promise<void>;
    }
  ).replaceRuntime;

  await assert.rejects(
    replaceRuntime.call(harness, replacement),
    /session_start failed/,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(harness.runtime, previous);
  assert.equal(previousSession.binds, 1);
  assert.equal(previousSession.subscriptions, 1);
  assert.equal(previousSession.unsubscribes, 0);
  assert.equal(previous.disposals, 0);
  assert.equal(replacement.disposals, 1);
  assert.equal(harness.retainedRuntimes.has(previous), false);
  assert.ok(harness.unsubscribeSession);
});

test("dispose waits for pending candidate creation and cleans it before releasing the dispatcher", async () => {
  const active = lifecycleRuntime(lifecycleSession("session-a", false));
  const candidate = lifecycleRuntime(lifecycleSession("session-b", false, 0));
  const harness = lifecycleHarness(active);
  const createEntered = deferred();
  const allowCreate = deferred();
  let dispatcherReleases = 0;
  harness.dispatcherLease = {
    release: async () => {
      dispatcherReleases += 1;
    },
  };
  const runtimeConstructor = PiWebRuntime as unknown as {
    createRuntime: () => Promise<{
      runtime: LifecycleRuntime;
      dispatcherLease: typeof harness.dispatcherLease;
    }>;
  };
  const originalCreateRuntime = runtimeConstructor.createRuntime;
  runtimeConstructor.createRuntime = async () => {
    createEntered.resolve();
    await allowCreate.promise;
    return { runtime: candidate, dispatcherLease: harness.dispatcherLease };
  };

  try {
    const sessionChange = harness.newSession("/tmp");
    await createEntered.promise;
    const disposal = harness.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dispatcherReleases, 0);

    allowCreate.resolve();
    await assert.rejects(sessionChange, /Web runtime is stopped/);
    await disposal;

    assert.equal(active.disposals, 1);
    assert.equal(candidate.disposals, 1);
    assert.equal(dispatcherReleases, 1);
  } finally {
    runtimeConstructor.createRuntime = originalCreateRuntime;
  }
});

test("new session projects its command id and activated session path", async () => {
  const active = lifecycleRuntime(lifecycleSession("session-a", false));
  const candidateSession = lifecycleSession("session-b", false, 0);
  Object.assign(candidateSession.sessionManager, {
    getSessionFile: () => "/tmp/session-b.jsonl",
  });
  const candidate = lifecycleRuntime(candidateSession);
  const harness = lifecycleHarness(active) as LifecycleHarness & {
    activateCandidate(runtime: LifecycleRuntime): Promise<void>;
  };
  harness.activateCandidate = async (runtime) => {
    harness.runtime = runtime;
  };
  const events: WebRuntimeEvent[] = [];
  harness.listeners.add((event) => events.push(event));
  const runtimeConstructor = PiWebRuntime as unknown as {
    createRuntime: () => Promise<{
      runtime: LifecycleRuntime;
      dispatcherLease: typeof harness.dispatcherLease;
    }>;
  };
  const originalCreateRuntime = runtimeConstructor.createRuntime;
  runtimeConstructor.createRuntime = async () => ({
    runtime: candidate,
    dispatcherLease: harness.dispatcherLease,
  });

  try {
    const result = await harness.newSession("/tmp", {
      commandId: "create-command",
    });

    assert.deepEqual(result, {
      cancelled: false,
      commandId: "create-command",
      sessionPath: "/tmp/session-b.jsonl",
    });
    assert.deepEqual(events.at(-1), {
      type: "session_switched",
      detail: {
        commandId: "create-command",
        sessionPath: "/tmp/session-b.jsonl",
      },
    });
  } finally {
    runtimeConstructor.createRuntime = originalCreateRuntime;
  }
});

test("dispose also waits for a pending switched-session candidate", async () => {
  const active = lifecycleRuntime(lifecycleSession("session-a", false));
  Object.assign(active.session.sessionManager, {
    getSessionFile: () => "/tmp/session-a.jsonl",
  });
  const candidate = lifecycleRuntime(lifecycleSession("session-b", false, 0));
  const harness = lifecycleHarness(active);
  const createEntered = deferred();
  const allowCreate = deferred();
  let dispatcherReleases = 0;
  harness.dispatcherLease = {
    release: async () => {
      dispatcherReleases += 1;
    },
  };
  const runtimeConstructor = PiWebRuntime as unknown as {
    createRuntime: () => Promise<{
      runtime: LifecycleRuntime;
      dispatcherLease: typeof harness.dispatcherLease;
    }>;
  };
  const originalCreateRuntime = runtimeConstructor.createRuntime;
  const originalOpen = SessionManager.open;
  SessionManager.open = (() => ({
    getCwd: () => "/tmp",
  })) as unknown as typeof SessionManager.open;
  runtimeConstructor.createRuntime = async () => {
    createEntered.resolve();
    await allowCreate.promise;
    return { runtime: candidate, dispatcherLease: harness.dispatcherLease };
  };

  try {
    const sessionChange = harness.switchSession("/tmp/session-b.jsonl");
    await createEntered.promise;
    const disposal = harness.dispose();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dispatcherReleases, 0);

    allowCreate.resolve();
    await assert.rejects(sessionChange, /Web runtime is stopped/);
    await disposal;

    assert.equal(active.disposals, 1);
    assert.equal(candidate.disposals, 1);
    assert.equal(dispatcherReleases, 1);
  } finally {
    runtimeConstructor.createRuntime = originalCreateRuntime;
    SessionManager.open = originalOpen;
  }
});

test("runtime creation failure releases the Web Host lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-runtime-create-failure-"));
  const agentDirectory = join(root, "agent");
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR;
  const runtimeConstructor = PiWebRuntime as unknown as {
    createRuntime: () => Promise<never>;
  };
  const originalCreateRuntime = runtimeConstructor.createRuntime;
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  runtimeConstructor.createRuntime = async () => {
    throw new Error("runtime startup failed");
  };

  try {
    await assert.rejects(PiWebRuntime.create(root), /runtime startup failed/);
    const lease = await acquireWebHostLease(
      join(agentDirectory, "web-sessions"),
    );
    await lease.release();
  } finally {
    runtimeConstructor.createRuntime = originalCreateRuntime;
    if (previousAgentDirectory === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousAgentDirectory;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt traces advance with queued user messages", () => {
  const session = {};
  const harness = Object.create(PiWebRuntime.prototype) as RuntimeHarness;
  harness.runtime = { session };
  harness.pendingPromptTraces = [];
  harness.liveMessageSequence = 0;
  harness.listeners = new Set();
  harness.activePromptTrace = {
    commandId: "first",
    sessionId: "session",
    startedAt: 1,
    started: false,
    queued: false,
  };
  harness.pendingPromptTraces.push({
    commandId: "second",
    sessionId: "session",
    startedAt: 2,
    started: false,
    queued: true,
  });

  const projectEvent = (
    PiWebRuntime.prototype as unknown as {
      projectEvent(this: RuntimeHarness, session: object, event: object): void;
    }
  ).projectEvent;
  const userMessage = (text: string) => ({
    type: "message_start",
    message: { role: "user", content: [{ type: "text", text }] },
  });

  projectEvent.call(harness, session, userMessage("first"));
  assert.equal(harness.activePromptTrace?.commandId, "first");
  assert.equal(harness.activePromptTrace?.started, true);

  projectEvent.call(harness, session, userMessage("second"));
  assert.equal(harness.activePromptTrace?.commandId, "second");
  assert.equal(harness.activePromptTrace?.started, true);
  assert.equal(harness.pendingPromptTraces.length, 0);
});
