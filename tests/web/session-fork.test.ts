import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import {
  WebRuntimeRequestError,
  type WebSessionForkResult,
} from "../../web/runtime/types.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openpi-native-fork-"));
  const agent = join(root, "agent");
  await mkdir(join(agent, "extensions"), { recursive: true });
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  const key = `openpi-fork-test-${root}`;
  const hooks = {
    events: [] as Array<{ type: string; reason?: string; started?: boolean }>,
    cancel: false,
    gate: undefined as Promise<void> | undefined,
  };
  Object.assign(globalThis, { [key]: hooks });
  await writeFile(
    join(agent, "extensions", "fork-hooks.ts"),
    `export default function(pi) {
    const state = globalThis[${JSON.stringify(key)}];
    let started = false;
    pi.on("session_start", (event) => { started = true; state.events.push({ type: event.type, reason: event.reason }); });
    pi.on("session_before_fork", async (event) => {
      state.events.push({ type: event.type, started });
      if (state.gate) await state.gate;
      if (state.cancel) return { cancel: true };
    });
    pi.on("session_shutdown", (event) => { state.events.push({ type: event.type, reason: event.reason }); });
  }`,
  );
  await writeFile(
    join(agent, "settings.json"),
    JSON.stringify({
      defaultProvider: "fork-fixture",
      defaultModel: "fixture",
      defaultThinkingLevel: "high",
    }),
  );
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "fork-fixture": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "fixture-key",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: true,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  let runtime: PiWebRuntime | undefined;
  t.after(async () => {
    await runtime?.dispose();
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
    Reflect.deleteProperty(globalThis, key);
    await rm(root, { recursive: true, force: true });
  });
  runtime = await PiWebRuntime.create(root);
  const manager = runtime.sessionManager;
  manager.appendModelChange("fork-fixture", "fixture");
  manager.appendThinkingLevelChange("high");
  manager.appendMessage({
    role: "user",
    content: "Original question",
    timestamp: 1,
  });
  const entryId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Original answer" }],
    api: "openai-completions",
    provider: "fork-fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: 2,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  manager.appendMessage({
    role: "user",
    content: "Later question",
    timestamp: 3,
  });
  const request = {
    commandId: "fork-1",
    sessionId: manager.getSessionId(),
    sessionPath: manager.getSessionFile()!,
    entryId,
  };
  const internals = runtime as unknown as {
    runtime: AgentSessionRuntime;
    inFlightRuntimes: Map<AgentSessionRuntime, number>;
    promptOperations: Set<Promise<void>>;
    historyForkReceipts: Map<
      string,
      { request: typeof request; result: Promise<WebSessionForkResult> }
    >;
  };
  return { root, runtime, internals, request, hooks };
}

function unavailable(error: unknown) {
  return error instanceof WebRuntimeRequestError && error.statusCode === 409;
}

test("native fork retains source history, lineage, model and thinking without a model turn, and replays once", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const original = await readFile(request.sessionPath, "utf8");
  const result = await runtime.forkSession(request);
  assert.equal(result.state, "forked");
  assert.notEqual(result.sessionId, request.sessionId);
  assert.notEqual(result.sessionPath, request.sessionPath);
  assert.equal(
    runtime.sessionManager.getHeader()?.parentSession,
    request.sessionPath,
  );
  assert.equal(runtime.sessionManager.getLeafId(), request.entryId);
  assert.equal(
    runtime.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message").length,
    2,
  );
  assert.equal(
    runtime.listModels().find((model) => model.current)?.id,
    "fixture",
  );
  assert.equal(runtime.getThinkingState()?.level, "high");
  assert.equal(runtime.isIdle(), true);
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  assert.deepEqual(hooks.events.slice(-3), [
    { type: "session_before_fork", started: true },
    { type: "session_shutdown", reason: "fork" },
    { type: "session_start", reason: "fork" },
  ]);
  const replay = await runtime.forkSession(request);
  assert.deepEqual(replay, { ...result, replayed: true });
  assert.equal(
    hooks.events.filter((event) => event.type === "session_before_fork").length,
    1,
  );
  await assert.rejects(
    runtime.forkSession({ ...request, entryId: "another" }),
    unavailable,
  );
});

test("the initialized source extension can veto native fork without replacing or rewriting its Session", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  hooks.cancel = true;
  const original = await readFile(request.sessionPath, "utf8");
  const result = await runtime.forkSession(request);
  assert.equal(result.state, "cancelled");
  assert.equal(runtime.sessionManager.getSessionFile(), request.sessionPath);
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  assert.deepEqual(hooks.events.at(-1), {
    type: "session_before_fork",
    started: true,
  });
  assert.deepEqual(await runtime.forkSession(request), {
    ...result,
    replayed: true,
  });
});

test("fork fails closed for running, queued, admission, copied identity and off-branch targets", async (t) => {
  const { runtime, internals, request, hooks } = await fixture(t);
  const owner = internals.runtime;
  const activity = owner.session as unknown as { _isAgentRunActive: boolean };
  activity._isAgentRunActive = true;
  await assert.rejects(runtime.forkSession(request), unavailable);
  activity._isAgentRunActive = false;
  await owner.session.steer("queued");
  await assert.rejects(
    runtime.forkSession({ ...request, commandId: "fork-2" }),
    unavailable,
  );
  owner.session.clearQueue();
  internals.inFlightRuntimes.set(owner, 1);
  await assert.rejects(
    runtime.forkSession({ ...request, commandId: "fork-3" }),
    unavailable,
  );
  internals.inFlightRuntimes.clear();
  await assert.rejects(
    runtime.forkSession({
      ...request,
      sessionPath: join(runtime.sessionDirectory, "copy.jsonl"),
      commandId: "fork-4",
    }),
    unavailable,
  );
  await assert.rejects(
    runtime.forkSession({
      ...request,
      entryId: "missing",
      commandId: "fork-5",
    }),
    unavailable,
  );
  const firstUser = runtime.sessionManager
    .getBranch()
    .find(
      (entry) => entry.type === "message" && entry.message.role === "user",
    )!;
  runtime.sessionManager.branch(firstUser.id);
  await assert.rejects(
    runtime.forkSession({ ...request, commandId: "fork-6" }),
    unavailable,
  );
  assert.equal(
    hooks.events.filter((event) => event.type === "session_before_fork").length,
    0,
  );
});

test("pending fork rejects late prompts and mutations, while its duplicate waits for the same receipt", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const gate = deferred();
  hooks.gate = gate.promise;
  const first = runtime.forkSession(request);
  const replay = runtime.forkSession(request);
  await assert.rejects(
    runtime.sendPrompt("Keep this draft", {
      expectedSessionId: request.sessionId,
      expectedSessionPath: request.sessionPath,
    }),
    unavailable,
  );
  await assert.rejects(
    runtime.newSession(runtime.cwd, { commandId: "late-create" }),
    unavailable,
  );
  gate.resolve();
  const result = await first;
  assert.equal(result.state, "forked");
  assert.deepEqual(await replay, { ...result, replayed: true });
  assert.equal(
    hooks.events.filter((event) => event.type === "session_before_fork").length,
    1,
  );
});

test("failure after native creation stays uncertain and cannot duplicate or accept a new prompt", async (t) => {
  const { runtime, internals, request } = await fixture(t);
  const owner = internals.runtime;
  const native = owner.fork.bind(owner);
  let calls = 0;
  owner.fork = async (...args) => {
    calls += 1;
    await native(...args);
    throw new Error("receipt boundary failed");
  };
  const result = await runtime.forkSession(request);
  assert.equal(result.state, "uncertain");
  const count = (await readdir(runtime.sessionDirectory)).length;
  assert.deepEqual(await runtime.forkSession(request), {
    ...result,
    replayed: true,
  });
  assert.equal((await readdir(runtime.sessionDirectory)).length, count);
  assert.equal(calls, 1);
  assert.equal(runtime.workspaceSelected, false);
  await assert.rejects(runtime.sendPrompt("Draft survives"), unavailable);
});

test("disposal during native before-fork prevents late activation and drains the owned runtime operation", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const gate = deferred();
  hooks.gate = gate.promise;
  const pending = runtime.forkSession(request);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(hooks.events.at(-1)?.type, "session_before_fork");
  const disposal = runtime.dispose();
  gate.resolve();
  assert.equal((await pending).state, "uncertain");
  await disposal;
});

test("an idle active Session can fork while another retained Session runs, without aborting its work", async (t) => {
  const { runtime, internals } = await fixture(t);
  const background = internals.runtime;
  const activity = background.session as unknown as {
    _isAgentRunActive: boolean;
  };
  activity._isAgentRunActive = true;
  let aborts = 0;
  const abort = background.session.abort.bind(background.session);
  background.session.abort = async () => {
    aborts += 1;
    await abort();
  };
  try {
    await runtime.newSession(runtime.cwd, { commandId: "active-idle" });
    const manager = runtime.sessionManager;
    let entryId = "";
    for (const entry of background.session.sessionManager.getBranch()) {
      if (
        entry.type !== "message" ||
        (entry.message.role !== "user" && entry.message.role !== "assistant")
      )
        continue;
      const appended = manager.appendMessage(entry.message);
      if (entry.message.role === "assistant") entryId = appended;
    }
    internals.inFlightRuntimes.set(background, 1);
    internals.promptOperations.add(Promise.resolve());
    Object.assign(internals, {
      compactionQueues: new Map([
        [background, { items: [], draining: false, blocked: false }],
      ]),
    });
    const result = await runtime.forkSession({
      commandId: "fork-active-idle",
      sessionId: manager.getSessionId(),
      sessionPath: manager.getSessionFile()!,
      entryId,
    });
    assert.equal(result.state, "forked");
    assert.equal(aborts, 0);
    assert.equal(background.session.isStreaming, true);
    const retained = internals as unknown as {
      retainedRuntimes: Set<AgentSessionRuntime>;
    };
    assert.equal(retained.retainedRuntimes.has(background), true);
  } finally {
    activity._isAgentRunActive = false;
    internals.inFlightRuntimes.delete(background);
    internals.promptOperations.clear();
    background.session.abort = abort;
  }
});

test("fork requires saved native evidence and bounds command identities and replay receipts", async (t) => {
  const { runtime, internals, request } = await fixture(t);
  await assert.rejects(
    runtime.forkSession({ ...request, commandId: "x".repeat(129) }),
    (error: unknown) =>
      error instanceof WebRuntimeRequestError && error.statusCode === 400,
  );
  const result = await runtime.forkSession(request);
  assert.equal(result.state, "forked");
  for (let index = 0; index < 1023; index++) {
    internals.historyForkReceipts.set(`capacity-${index}`, {
      request,
      result: Promise.resolve(result),
    });
  }
  assert.deepEqual(await runtime.forkSession(request), {
    ...result,
    replayed: true,
  });
  await assert.rejects(
    runtime.forkSession({ ...request, commandId: "over-capacity" }),
    (error: unknown) =>
      error instanceof WebRuntimeRequestError &&
      error.code === "SESSION_FORK_CAPACITY",
  );
  internals.historyForkReceipts.clear();
  const manager = runtime.sessionManager;
  manager.newSession();
  const entryId = manager.appendMessage({
    role: "user",
    content: "Saved message whose backing file is unavailable",
    timestamp: 4,
  });
  // Pi 0.99 persists the first user message. Remove its backing file to
  // exercise the same missing-native-evidence guard explicitly.
  await rm(manager.getSessionFile()!);
  await assert.rejects(
    runtime.forkSession({
      commandId: "not-saved",
      sessionId: manager.getSessionId(),
      sessionPath: manager.getSessionFile()!,
      entryId,
    }),
    unavailable,
  );
});
