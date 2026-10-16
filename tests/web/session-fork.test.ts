import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { readdirSync, writeFileSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai";
import {
  type AgentSessionRuntime,
  ProjectTrustStore,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { readMessageRerun } from "../../web/protocol/message-rerun.ts";
import {
  readSessionFork,
  WEB_SESSION_FORK,
} from "../../web/protocol/session-fork.ts";
import { formatSourceReference } from "../../web/protocol/session-sources.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import { readSessionWorktreeReceipt } from "../../web/runtime/session-worktree.ts";
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
    cancelSwitch: false,
    gate: undefined as Promise<void> | undefined,
    switchGate: undefined as Promise<void> | undefined,
    onFork: undefined as (() => void) | undefined,
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
      state.onFork?.();
      if (state.gate) await state.gate;
      if (state.cancel) return { cancel: true };
    });
    pi.on("session_before_switch", async (event) => {
      state.events.push({ type: event.type, reason: event.reason });
      if (state.switchGate) await state.switchGate;
      if (state.cancelSwitch) return { cancel: true };
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

function holdNativeStream(owner: AgentSessionRuntime) {
  const entered = deferred();
  const release = deferred();
  const requests: string[][] = [];
  let aborted = 0;
  owner.session.refreshContext();
  owner.session.agent.streamFunction = (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    const first = requests.length === 0;
    requests.push(
      context.messages
        .filter((message) => message.role === "user")
        .map((message) =>
          typeof message.content === "string"
            ? message.content
            : message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n"),
        ),
    );
    void (async () => {
      const identity = {
        api: model.api,
        provider: model.provider,
        model: model.id,
      };
      const partial = {
        ...fauxAssistantMessage("UNPERSISTED streaming text"),
        ...identity,
      };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "UNPERSISTED streaming text",
        partial,
      });
      const onAbort = () => {
        aborted++;
        release.resolve();
      };
      options?.signal?.addEventListener("abort", onAbort, { once: true });
      if (first) {
        entered.resolve();
        await release.promise;
      }
      options?.signal?.removeEventListener("abort", onAbort);
      const message = {
        ...fauxAssistantMessage(
          first ? "Source completed" : "Queued follow-up completed",
        ),
        ...identity,
      };
      stream.push({ type: "done", reason: "stop", message });
    })();
    return stream;
  };
  return {
    entered: entered.promise,
    release: release.resolve,
    requests,
    get aborted() {
      return aborted;
    },
  };
}

function conversation(
  request: { sessionPath: string; sessionId: string },
  commandId = "whole-fork",
) {
  return {
    commandId,
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
    scope: "conversation" as const,
  };
}

async function gitFixture(root: string) {
  const run = promisify(execFile);
  const git = (...args: string[]) =>
    run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: root });
  await git("init", "--quiet");
  await git("config", "core.autocrlf", "false");
  await writeFile(join(root, ".gitignore"), "agent/\n");
  await writeFile(join(root, "tracked.txt"), "committed\n");
  await git("add", ".gitignore", "tracked.txt");
  await git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture source",
  );
  await writeFile(join(root, "tracked.txt"), "dirty source contents\n");
  await writeFile(join(root, "untracked.txt"), "untracked source contents\n");
  return git;
}

function unavailable(error: unknown) {
  return error instanceof WebRuntimeRequestError && error.statusCode === 409;
}

test("editing an older native prompt excludes it and later messages, preserves complete images and file references, and leaves the source unchanged", async (t) => {
  const { root, runtime, request } = await fixture(t);
  const manager = runtime.sessionManager;
  const reference = formatSourceReference(join(root, "attached file.txt"));
  const windowsReference = formatSourceReference(
    String.raw`C:\Users\operator\workspace\attached file.txt`,
  );
  const image = {
    type: "image" as const,
    mimeType: "image/png",
    data: "iVBORw0KGgo=",
    name: "original.png",
  };
  const entryId = manager.appendMessage({
    role: "user",
    content: [
      {
        type: "text",
        text: `Original full question\n\n${reference}\n${windowsReference}`,
      },
      image,
    ],
    timestamp: 4,
  });
  const answer = manager
    .getBranch()
    .find(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
  assert.ok(answer?.type === "message" && answer.message.role === "assistant");
  manager.appendMessage(answer.message);
  const later = manager.appendMessage({
    role: "user",
    content: "Must not enter the edited branch",
    timestamp: 5,
  });
  const original = await readFile(request.sessionPath, "utf8");
  const edit = {
    ...request,
    entryId,
    rerun: { mode: "edit" as const, content: "Revised full question" },
  };
  const result = await runtime.forkSession(edit);
  assert.equal(result.state, "forked");
  assert.deepEqual(result.prompt, {
    content: `Revised full question\n\n${reference}\n${windowsReference}`,
    images: [{ mimeType: "image/png", data: image.data, name: image.name }],
  });
  assert.equal(
    runtime.sessionManager
      .getBranch()
      .some((entry) => entry.id === entryId || entry.id === later),
    false,
  );
  assert.equal(
    runtime.sessionManager.getHeader()?.parentSession,
    request.sessionPath,
  );
  assert.deepEqual(
    readMessageRerun(
      runtime.sessionManager.getBranch(),
      runtime.sessionManager.getHeader()?.parentSession,
    ),
    {
      source: {
        sessionId: request.sessionId,
        sessionPath: request.sessionPath,
        entryId,
      },
      mode: "edit",
    },
  );
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  assert.equal(runtime.isIdle(), true);
  assert.deepEqual(await runtime.forkSession(edit), {
    ...result,
    replayed: true,
  });
  await assert.rejects(
    runtime.forkSession({
      ...edit,
      rerun: { mode: "edit", content: "Different revision" },
    }),
    unavailable,
  );
});

test("regeneration uses the complete original user text and never retains its previous answer", async (t) => {
  const { runtime, request } = await fixture(t);
  const manager = runtime.sessionManager;
  const originalPrompt = manager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(originalPrompt);
  const original = await readFile(request.sessionPath, "utf8");
  const result = await runtime.forkSession({
    ...request,
    entryId: originalPrompt.id,
    rerun: { mode: "regenerate" },
  });
  assert.equal(result.state, "forked");
  assert.deepEqual(result.prompt, { content: "Original question", images: [] });
  assert.equal(
    runtime.sessionManager
      .getBranch()
      .some((entry) => entry.type === "message"),
    false,
  );
  assert.equal(runtime.getThinkingState()?.level, "high");
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
});

test("rerun validates the complete source and retained references before creating a branch", async (t) => {
  const { root, runtime, request, hooks } = await fixture(t);
  await assert.rejects(
    runtime.forkSession({ ...request, rerun: { mode: "regenerate" } }),
    unavailable,
  );
  for (const [index, reference] of [
    join(root, "required.txt"),
    String.raw`C:\Users\operator\workspace\required.txt`,
  ].entries()) {
    const entryId = runtime.sessionManager.appendMessage({
      role: "user",
      content: formatSourceReference(reference),
      timestamp: 4,
    });
    const original = await readFile(request.sessionPath, "utf8");
    await assert.rejects(
      runtime.forkSession({
        ...request,
        commandId: `too-long-edit-${index}`,
        entryId,
        rerun: { mode: "edit", content: "x".repeat(12_000) },
      }),
      unavailable,
    );
    assert.equal(await readFile(request.sessionPath, "utf8"), original);
  }
  const invalidImage = runtime.sessionManager.appendMessage({
    role: "user",
    content: [{ type: "image", data: "not-base64", mimeType: "image/png" }],
    timestamp: 5,
  });
  await assert.rejects(
    runtime.forkSession({
      ...request,
      commandId: "invalid-image",
      entryId: invalidImage,
      rerun: { mode: "regenerate" },
    }),
    unavailable,
  );
  assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
  assert.equal(
    hooks.events.some((event) => event.type === "session_before_fork"),
    false,
  );
});

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

test("rerun receipt byte limits fail before native creation and keep duplicate failures terminal", async (t) => {
  const { runtime, internals, request, hooks } = await fixture(t);
  const entry = runtime.sessionManager
    .getBranch()
    .find((entry) => entry.type === "message" && entry.message.role === "user");
  assert.ok(entry);
  Object.assign(internals, { historyForkPromptBytes: 128 * 1024 * 1024 });
  const rerun = {
    ...request,
    entryId: entry.id,
    rerun: { mode: "regenerate" as const },
  };
  const capacity = (error: unknown) =>
    error instanceof WebRuntimeRequestError &&
    error.code === "SESSION_FORK_CAPACITY";
  await assert.rejects(runtime.forkSession(rerun), capacity);
  assert.equal(
    hooks.events.some((event) => event.type === "session_before_fork"),
    false,
  );
  assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
  Object.assign(internals, { historyForkPromptBytes: 0 });
  await assert.rejects(runtime.forkSession(rerun), capacity);
  assert.equal(
    hooks.events.some((event) => event.type === "session_before_fork"),
    false,
  );
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

test("conversation fork retains trailing native metadata and labels and replays the same snapshot", async (t) => {
  const { runtime, request } = await fixture(t);
  const manager = runtime.sessionManager;
  manager.appendCustomEntry("sidebar-fixture", { complete: true });
  const metadataId = manager.appendSessionInfo("Named conversation");
  manager.appendLabelChange(request.entryId, "Keep this answer");
  const leafId = manager.getLeafId();
  const original = await readFile(request.sessionPath, "utf8");
  const whole = {
    commandId: "whole-fork",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
    scope: "conversation" as const,
  };
  const result = await runtime.forkSession(whole);
  assert.equal(result.state, "forked");
  assert.equal(result.source.entryId, leafId);
  assert.equal(
    runtime.sessionManager.getSessionName(),
    "Named conversation (2)",
  );
  assert.equal(
    runtime.sessionManager.getLabel(request.entryId),
    "Keep this answer",
  );
  assert.ok(
    runtime.sessionManager.getBranch().some((entry) => entry.id === metadataId),
  );
  assert.equal(
    runtime.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message").length,
    3,
  );
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  runtime.sessionManager.appendCustomEntry("later", { unrelated: true });
  assert.deepEqual(await runtime.forkSession(whole), {
    ...result,
    replayed: true,
  });
  await assert.rejects(
    runtime.forkSession({ ...request, commandId: whole.commandId }),
    unavailable,
  );
});

test("running conversation forks freeze the persisted prefix while the selected or retained source drains its native queue", {
  timeout: 15_000,
}, async (t) => {
  const { runtime, internals, request } = await fixture(t);
  const owner = internals.runtime;
  const stream = holdNativeStream(owner);
  try {
    await runtime.sendPrompt("Live source request", {
      commandId: "live-source",
    });
    await stream.entered;
    await runtime.sendPrompt("Queued source request", {
      commandId: "queued-source",
    });
    assert.equal(owner.session.isStreaming, true);
    assert.equal(owner.session.getFollowUpMessages().length, 1);
    const first = await runtime.forkSession(conversation(request));
    assert.equal(first.state, "forked");
    assert.equal(first.sourceStillRunning, true);
    assert.equal(first.snapshot?.interrupted, true);
    assert.equal(runtime.isIdle(), true);
    assert.equal(internals.runtime.session.model?.id, owner.session.model?.id);
    assert.equal(internals.runtime.session.thinkingLevel, "high");
    assert.equal(owner.session.isStreaming, true);
    assert.equal(stream.aborted, 0);
    const child = await readFile(first.sessionPath!, "utf8");
    assert.ok(child.includes("Live source request"));
    assert.ok(!child.includes("UNPERSISTED streaming text"));
    assert.ok(!child.includes("Queued source request"));
    const metadata = readSessionFork(
      runtime.sessionManager.getBranch(),
      first.sessionId!,
      runtime.cwd,
    );
    assert.deepEqual(metadata?.source, first.source);
    assert.equal(metadata?.workspacePath, runtime.cwd);
    const retainedFork = await runtime.forkSession(
      conversation(request, "retained-source-fork"),
    );
    assert.equal(retainedFork.state, "forked");
    assert.equal(retainedFork.sourceStillRunning, true);
    assert.equal(stream.aborted, 0);
    stream.release();
    await owner.session.waitForIdle();
    await Promise.all([...internals.promptOperations]);
    const source = await readFile(request.sessionPath, "utf8");
    assert.ok(source.includes("Source completed"));
    assert.ok(source.includes("Queued follow-up completed"));
    assert.equal(stream.requests.length, 2);
    assert.ok(stream.requests[1]?.includes("Queued source request"));
    assert.equal(await readFile(first.sessionPath!, "utf8"), child);
    assert.equal(runtime.isIdle(), true);
  } finally {
    stream.release();
  }
});

test("a conversation snapshot keeps the native leaf from before the extension hook and excludes later source metadata", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const source = runtime.sessionManager;
  const boundary = source.getLeafId();
  const entered = deferred();
  const release = deferred();
  hooks.onFork = entered.resolve;
  hooks.gate = release.promise;
  const pending = runtime.forkSession(conversation(request));
  try {
    await entered.promise;
    source.appendCustomEntry("after-snapshot", { later: true });
    source.appendSessionInfo("Name after snapshot");
  } finally {
    release.resolve();
  }
  const result = await pending;
  assert.equal(result.state, "forked");
  assert.equal(result.source.entryId, boundary);
  assert.ok(
    !(await readFile(result.sessionPath!, "utf8")).includes("after-snapshot"),
  );
  assert.ok(
    (await readFile(request.sessionPath, "utf8")).includes("after-snapshot"),
  );
  assert.equal(
    runtime.sessionManager.getSessionName(),
    "Original question (2)",
  );
});

test("a loaded conversation forks its selected native branch instead of an abandoned later file tail", async (t) => {
  const { runtime, request } = await fixture(t);
  const source = runtime.sessionManager;
  source.appendCustomEntry("abandoned-file-tail", { mustNotCopy: true });
  source.branch(request.entryId);
  const before = await readFile(request.sessionPath, "utf8");
  assert.notEqual(
    SessionManager.open(request.sessionPath).getLeafId(),
    source.getLeafId(),
  );
  const result = await runtime.forkSession(conversation(request));
  assert.equal(result.state, "forked");
  assert.equal(result.source.entryId, request.entryId);
  const child = await readFile(result.sessionPath!, "utf8");
  assert.ok(child.includes("Original answer"));
  assert.ok(!child.includes("Later question"));
  assert.ok(!child.includes("abandoned-file-tail"));
  assert.equal(await readFile(request.sessionPath, "utf8"), before);
});

test("an unloaded source can fork while a different current conversation streams without interrupting either identity", {
  timeout: 15_000,
}, async (t) => {
  const { runtime, request, internals } = await fixture(t);
  const sourceBytes = await readFile(request.sessionPath, "utf8");
  await runtime.newSession(runtime.cwd, { commandId: "another-current" });
  const current = internals.runtime;
  const stream = holdNativeStream(current);
  try {
    await runtime.sendPrompt("Another conversation's live turn", {
      commandId: "different-owner",
    });
    await stream.entered;
    const currentPath = current.session.sessionManager.getSessionFile()!;
    const result = await runtime.forkSession(conversation(request));
    assert.equal(result.state, "forked");
    assert.equal(result.sourceStillRunning, false);
    assert.equal(current.session.isStreaming, true);
    assert.equal(stream.aborted, 0);
    assert.equal(runtime.isIdle(), true);
    assert.equal(await readFile(request.sessionPath, "utf8"), sourceBytes);
    assert.ok(
      !(await readFile(result.sessionPath!, "utf8")).includes(
        "Another conversation's live turn",
      ),
    );
    stream.release();
    await current.session.waitForIdle();
    assert.ok(
      (await readFile(currentPath, "utf8")).includes("Source completed"),
    );
  } finally {
    stream.release();
  }
});

test("missing tool results are explicitly unknown in the child and never written back to the source", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const source = runtime.sessionManager;
  source.appendMessage({
    ...fauxAssistantMessage(
      [
        {
          type: "toolCall",
          id: "external-operation",
          name: "read",
          arguments: { path: "fixture" },
        },
      ],
      { stopReason: "toolUse" },
    ),
    api: "openai-completions",
    provider: "fork-fixture",
    model: "fixture",
  });
  const before = await readFile(request.sessionPath, "utf8");
  const entered = deferred();
  const release = deferred();
  hooks.onFork = entered.resolve;
  hooks.gate = release.promise;
  const pending = runtime.forkSession(conversation(request));
  await entered.promise;
  source.appendMessage({
    role: "toolResult",
    toolCallId: "external-operation",
    toolName: "read",
    content: [{ type: "text", text: "REAL result after capture" }],
    isError: false,
    timestamp: Date.now(),
  });
  release.resolve();
  const result = await pending;
  assert.equal(result.state, "forked");
  const results = runtime.sessionManager
    .buildSessionContext()
    .messages.filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  assert.equal(results[0]?.isError, true);
  assert.deepEqual(results[0]?.details, {
    openpiForkSnapshot: {
      version: 1,
      source: result.source,
      snapshot: { ...result.snapshot, interrupted: true },
      toolCallId: "external-operation",
    },
  });
  assert.match(
    JSON.stringify(results[0]),
    /outcome and any external side effects.*unknown/u,
  );
  assert.ok(!JSON.stringify(results).includes("REAL result"));
  const after = await readFile(request.sessionPath, "utf8");
  assert.ok(after.startsWith(before));
  assert.ok(after.includes("REAL result after capture"));
  assert.ok(!after.includes("Snapshot boundary"));
});

test("pending conversation cancellation matches exact identity, preserves hook ownership and coalesces replay", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const original = await readFile(request.sessionPath, "utf8");
  const entered = deferred();
  const release = deferred();
  hooks.onFork = entered.resolve;
  hooks.gate = release.promise;
  const whole = conversation(request);
  const first = runtime.forkSession(whole);
  const duplicate = runtime.forkSession(whole);
  await entered.promise;
  await assert.rejects(
    runtime.cancelSessionFork({ ...whole, sessionId: "wrong-session" }),
    unavailable,
  );
  assert.deepEqual(await runtime.cancelSessionFork(whole), {
    state: "requested",
  });
  assert.deepEqual(await runtime.cancelSessionFork(whole), {
    state: "requested",
  });
  assert.deepEqual(
    await runtime.cancelSessionFork({ ...whole, commandId: "unknown" }),
    { state: "not-found" },
  );
  release.resolve();
  const result = await first;
  assert.equal(result.state, "cancelled");
  assert.deepEqual(await duplicate, { ...result, replayed: true });
  assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  assert.deepEqual(await runtime.cancelSessionFork(whole), {
    state: "not-found",
  });
  assert.equal(
    (await SessionManager.listAll(runtime.sessionManager.getSessionDir()))
      .length,
    1,
  );
});

test("cancellation after child creation is too late and an activation failure preserves both the source and the terminal receipt", async (t) => {
  const { runtime, request } = await fixture(t);
  const original = await readFile(request.sessionPath, "utf8");
  const owner = runtime as unknown as {
    activateCandidate: (candidate: AgentSessionRuntime) => Promise<void>;
  };
  const activate = owner.activateCandidate;
  const entered = deferred();
  const release = deferred();
  owner.activateCandidate = async (candidate) => {
    entered.resolve();
    await release.promise;
    await candidate.dispose();
    throw new Error("Fixture activation failure");
  };
  const whole = conversation(request);
  try {
    const pending = runtime.forkSession(whole);
    await entered.promise;
    assert.deepEqual(await runtime.cancelSessionFork(whole), {
      state: "too-late",
    });
    release.resolve();
    const result = await pending;
    assert.equal(result.state, "uncertain");
    assert.match(result.reason!, /Fixture activation failure/u);
    assert.notEqual(result.sessionId, request.sessionId);
    assert.ok(
      (await readFile(result.sessionPath!, "utf8")).includes(WEB_SESSION_FORK),
    );
    assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
    assert.equal(runtime.workspaceSelected, true);
    assert.equal(await readFile(request.sessionPath, "utf8"), original);
    assert.deepEqual(await runtime.forkSession(whole), {
      ...result,
      replayed: true,
    });
    assert.equal(
      (await SessionManager.listAll(runtime.sessionManager.getSessionDir()))
        .length,
      2,
    );
  } finally {
    owner.activateCandidate = activate;
    release.resolve();
  }
});

test("inactive saved conversations fork without selecting or rewriting the source and use unique bounded native titles", async (t) => {
  const { runtime, request, root } = await fixture(t);
  const title = `${"Long title ".repeat(7)}😀`;
  runtime.sessionManager.appendSessionInfo(title);
  const original = await readFile(request.sessionPath, "utf8");
  await runtime.newSession(root, { commandId: "select-other" });
  const first = await runtime.forkSession(
    conversation(request, "inactive-first"),
  );
  assert.equal(first.state, "forked");
  assert.equal(first.sourceStillRunning, false);
  const firstTitle = runtime.sessionManager.getSessionName()!;
  assert.ok(firstTitle.length <= 60);
  assert.ok(firstTitle.endsWith("… (2)"));
  const second = await runtime.forkSession(
    conversation(request, "inactive-second"),
  );
  assert.equal(second.state, "forked");
  assert.equal(
    runtime.sessionManager.getSessionName(),
    `${firstTitle.slice(0, -4)} (3)`,
  );
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  assert.equal(runtime.sessionManager.getHeader()?.cwd, await realpath(root));
});

test("conversation forks fail closed on wrong identity, external paths, links and old native versions without migrating source data", async (t) => {
  const { runtime, request, root } = await fixture(t);
  const original = await readFile(request.sessionPath, "utf8");
  await assert.rejects(
    runtime.forkSession(
      conversation({ ...request, sessionId: "wrong" }, "wrong-id"),
    ),
    unavailable,
  );
  const external = join(root, "outside.jsonl");
  await writeFile(external, original);
  await assert.rejects(
    runtime.forkSession(
      conversation({ ...request, sessionPath: external }, "outside"),
    ),
    unavailable,
  );
  const originalPath = `${request.sessionPath}.original`;
  await rename(request.sessionPath, originalPath);
  try {
    await symlink(originalPath, request.sessionPath);
    await assert.rejects(
      runtime.forkSession(conversation(request, "symlink")),
      unavailable,
    );
    await rm(request.sessionPath);
    await link(originalPath, request.sessionPath);
    await assert.rejects(
      runtime.forkSession(conversation(request, "hardlink")),
      unavailable,
    );
    await rm(request.sessionPath);
  } finally {
    await rename(originalPath, request.sessionPath);
  }
  const lines = original.trimEnd().split("\n");
  const header = JSON.parse(lines[0]!);
  lines[0] = JSON.stringify({ ...header, version: 2 });
  const legacy = `${lines.join("\n")}\n`;
  await writeFile(request.sessionPath, legacy);
  await assert.rejects(
    runtime.forkSession(conversation(request, "legacy")),
    unavailable,
  );
  assert.equal(await readFile(request.sessionPath, "utf8"), legacy);
  await writeFile(request.sessionPath, original);
});

test("fork names use verified native lineage, preserve user numeric suffixes and advance the maximum family number", async (t) => {
  const { runtime, request } = await fixture(t);
  runtime.sessionManager.appendSessionInfo("Release (2026)");
  const first = await runtime.forkSession(conversation(request));
  assert.equal(runtime.sessionManager.getSessionName(), "Release (2026) (2)");
  const second = await runtime.forkSession(
    conversation(
      { sessionId: first.sessionId!, sessionPath: first.sessionPath! },
      "fork-child",
    ),
  );
  assert.equal(runtime.sessionManager.getSessionName(), "Release (2026) (3)");
  runtime.sessionManager.appendSessionInfo("Release (2026) (8)");
  const next = await runtime.forkSession(
    conversation(request, "fork-with-gap"),
  );
  assert.equal(next.state, "forked");
  assert.equal(runtime.sessionManager.getSessionName(), "Release (2026) (9)");
  const renamed = SessionManager.open(second.sessionPath!);
  renamed.appendSessionInfo("Independent title (45)");
  await runtime.forkSession(
    conversation(
      { sessionId: second.sessionId!, sessionPath: second.sessionPath! },
      "fork-renamed",
    ),
  );
  assert.equal(
    runtime.sessionManager.getSessionName(),
    "Independent title (45) (2)",
  );
});

test("an original symlink project path remains the grouping identity while the child executes in its canonical cwd", async (t) => {
  const { root, runtime } = await fixture(t);
  const actual = join(root, "actual-project");
  const alias = join(root, "project-alias");
  await mkdir(actual);
  await symlink(actual, alias);
  const source = SessionManager.create(
    alias,
    runtime.sessionManager.getSessionDir(),
  );
  source.appendMessage({
    role: "user",
    content: "Alias project",
    timestamp: 1,
  });
  source.appendSessionInfo("Alias project");
  const result = await runtime.forkSession(
    conversation({
      sessionId: source.getSessionId(),
      sessionPath: source.getSessionFile()!,
    }),
  );
  assert.equal(result.state, "forked");
  assert.equal(result.workspacePath, alias);
  assert.equal(result.cwd, await realpath(actual));
  const next = await runtime.forkSession(
    conversation(
      { sessionId: result.sessionId!, sessionPath: result.sessionPath! },
      "alias-descendant",
    ),
  );
  assert.equal(next.workspacePath, alias);
  assert.equal(next.cwd, await realpath(actual));
});

test("independent native roots with the same title do not share their fork-family counter", async (t) => {
  const { runtime, request } = await fixture(t);
  runtime.sessionManager.appendSessionInfo("Same title");
  const first = await runtime.forkSession(
    conversation(request, "first-family"),
  );
  assert.equal(first.state, "forked");
  runtime.sessionManager.appendSessionInfo("Same title (90)");
  const other = SessionManager.create(
    runtime.cwd,
    runtime.sessionManager.getSessionDir(),
  );
  other.appendMessage({
    role: "user",
    content: "Independent original",
    timestamp: 1,
  });
  other.appendSessionInfo("Same title");
  const result = await runtime.forkSession(
    conversation(
      { sessionId: other.getSessionId(), sessionPath: other.getSessionFile()! },
      "independent-family",
    ),
  );
  assert.equal(result.state, "forked");
  assert.equal(runtime.sessionManager.getSessionName(), "Same title (2)");
});

test("a worktree conversation fork copies actual dirty files, preserves original grouping across descendants and respects native target trust", {
  timeout: 20_000,
}, async (t) => {
  const { root, runtime, request, internals } = await fixture(t);
  const git = await gitFixture(root);
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(root, ".pi", "settings.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );
  new ProjectTrustStore(join(root, "agent")).set(await realpath(root), false);
  const options = await runtime.sessionForkOptions(request);
  assert.deepEqual(options, { local: true, worktree: true });
  const sourceBytes = await readFile(request.sessionPath, "utf8");
  const index = await readFile(join(root, ".git", "index"));
  const originalCwd = runtime.cwd;
  const result = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  assert.equal(result.state, "forked");
  assert.equal(result.environment, "worktree");
  assert.equal(result.worktree?.branch, undefined);
  assert.equal(result.worktree?.sourceRoot, await realpath(root));
  assert.equal(result.workspacePath, originalCwd);
  assert.notEqual(result.cwd, originalCwd);
  assert.equal(runtime.cwd, result.cwd);
  assert.equal(runtime.sessionManager.getHeader()?.cwd, result.cwd);
  assert.equal(
    internals.runtime.session.settingsManager.isProjectTrusted(),
    false,
  );
  assert.equal(internals.runtime.session.thinkingLevel, "high");
  assert.equal(runtime.isIdle(), true);
  assert.equal(
    await readFile(join(result.cwd!, "tracked.txt"), "utf8"),
    "dirty source contents\n",
  );
  assert.equal(
    await readFile(join(result.cwd!, "untracked.txt"), "utf8"),
    "untracked source contents\n",
  );
  assert.deepEqual(await readFile(join(root, ".git", "index")), index);
  assert.equal(await readFile(request.sessionPath, "utf8"), sourceBytes);
  assert.match(
    (await git("worktree", "list", "--porcelain")).stdout,
    /detached/u,
  );
  const metadata = readSessionFork(
    runtime.sessionManager.getBranch(),
    result.sessionId!,
    result.cwd!,
  );
  assert.deepEqual(metadata?.worktree, result.worktree);
  const child = await runtime.forkSession(
    conversation(
      { sessionId: result.sessionId!, sessionPath: result.sessionPath! },
      "local-worktree-child",
    ),
  );
  assert.equal(child.environment, "local");
  assert.equal(child.workspacePath, originalCwd);
  assert.equal(child.cwd, result.cwd);
  assert.deepEqual(child.worktree, result.worktree);
});

test("a native hook veto cleans up a verified worktree without creating a child and a changed worktree is preserved as uncertain", {
  timeout: 20_000,
}, async (t) => {
  const { root, runtime, request, hooks } = await fixture(t);
  const git = await gitFixture(root);
  hooks.cancel = true;
  const first = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  assert.equal(first.state, "cancelled");
  assert.equal(
    (await git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gmu)
      ?.length,
    1,
  );
  assert.equal(
    (await SessionManager.listAll(runtime.sessionManager.getSessionDir()))
      .length,
    1,
  );
  const entered = deferred();
  const release = deferred();
  hooks.onFork = entered.resolve;
  hooks.gate = release.promise;
  const request2 = {
    ...conversation(request, "preserve-changed-worktree"),
    environment: "worktree" as const,
  };
  const pending = runtime.forkSession(request2);
  try {
    await entered.promise;
    const paths = (await git("worktree", "list", "--porcelain")).stdout
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice(9));
    assert.equal(paths.length, 2);
    await writeFile(
      join(paths[1]!, "user-change.txt"),
      "Must not remove this file\n",
    );
    assert.deepEqual(await runtime.cancelSessionFork(request2), {
      state: "requested",
    });
  } finally {
    release.resolve();
  }
  const preserved = await pending;
  assert.equal(preserved.state, "uncertain");
  assert.ok(preserved.preservedWorktreePath);
  assert.equal(
    await readFile(
      join(preserved.preservedWorktreePath!, "user-change.txt"),
      "utf8",
    ),
    "Must not remove this file\n",
  );
  assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
  assert.equal(
    (await SessionManager.listAll(runtime.sessionManager.getSessionDir()))
      .length,
    1,
  );
  assert.deepEqual(await runtime.forkSession(request2), {
    ...preserved,
    replayed: true,
  });
});

test("runtime disposal cancels pending worktree creation before native child persistence and waits for hook ownership", {
  timeout: 20_000,
}, async (t) => {
  const { root, runtime, request, hooks } = await fixture(t);
  const git = await gitFixture(root);
  const directory = runtime.sessionManager.getSessionDir();
  const entered = deferred();
  const release = deferred();
  hooks.onFork = entered.resolve;
  hooks.gate = release.promise;
  const fork = runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  await entered.promise;
  const disposal = runtime.dispose();
  release.resolve();
  const result = await fork;
  assert.equal(result.state, "cancelled");
  await disposal;
  assert.equal((await SessionManager.listAll(directory)).length, 1);
  assert.equal(
    (await git("worktree", "list", "--porcelain")).stdout.match(/^worktree /gmu)
      ?.length,
    1,
  );
});

test("message forks and reruns from a worktree keep exact child provenance and the original UI project", {
  timeout: 20_000,
}, async (t) => {
  const { root, runtime, request } = await fixture(t);
  await gitFixture(root);
  const fork = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  assert.equal(fork.state, "forked");
  const message = await runtime.forkSession({
    commandId: "worktree-message-fork",
    sessionId: fork.sessionId!,
    sessionPath: fork.sessionPath!,
    entryId: request.entryId,
  });
  assert.equal(message.state, "forked");
  assert.equal(message.cwd, fork.cwd);
  assert.equal(message.workspacePath, fork.workspacePath);
  const metadata = readSessionFork(
    runtime.sessionManager.getBranch(),
    message.sessionId!,
    runtime.cwd,
  );
  assert.equal(metadata?.source.sessionId, fork.sessionId);
  assert.deepEqual(metadata?.worktree, fork.worktree);
  const userId = runtime.sessionManager.appendMessage({
    role: "user",
    content: "Revise within worktree",
    timestamp: 9,
  });
  const edit = await runtime.forkSession({
    commandId: "worktree-edit",
    sessionId: message.sessionId!,
    sessionPath: message.sessionPath!,
    entryId: userId,
    rerun: { mode: "edit", content: "Edited within worktree" },
  });
  assert.equal(edit.state, "forked");
  assert.equal(edit.workspacePath, fork.workspacePath);
  assert.equal(edit.cwd, fork.cwd);
  assert.deepEqual(edit.worktree, fork.worktree);
  assert.equal(
    readSessionFork(
      runtime.sessionManager.getBranch(),
      edit.sessionId!,
      runtime.cwd,
    )?.source.sessionId,
    message.sessionId,
  );
  assert.equal(runtime.isIdle(), true);
});

test("fork metadata validates the exact native child and cwd, ignores inherited records and rejects malformed current provenance", async (t) => {
  const { runtime, request } = await fixture(t);
  const result = await runtime.forkSession(conversation(request));
  const entries = runtime.sessionManager.getBranch();
  const metadata = readSessionFork(entries, result.sessionId!, result.cwd!);
  assert.ok(metadata);
  assert.equal(
    readSessionFork(entries, "another-child", result.cwd!),
    undefined,
  );
  assert.equal(
    readSessionFork(entries, result.sessionId!, "/another-directory"),
    undefined,
  );
  for (const data of [
    { ...metadata, version: 2 },
    { ...metadata, environment: "worktree", worktree: undefined },
    {
      ...metadata,
      snapshot: { kind: "persisted-prefix", capturedAt: -1, interrupted: true },
    },
    {
      ...metadata,
      source: { ...metadata.source, sessionId: result.sessionId },
    },
    {
      ...metadata,
      worktree: {
        path: "/outside",
        sourceRoot: result.cwd,
        baseSha: "f".repeat(40),
      },
    },
  ]) {
    const current = {
      type: "custom" as const,
      id: "malformed",
      parentId: null,
      timestamp: new Date().toISOString(),
      customType: WEB_SESSION_FORK,
      data,
    };
    assert.equal(
      readSessionFork([...entries, current], result.sessionId!, result.cwd!),
      undefined,
    );
  }
});

test("permanent deletion replaces an idle active native Session once and returns to workspace selection", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const deletion = {
    commandId: "delete-current",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  const result = await runtime.deleteSession(deletion);
  assert.deepEqual(result, {
    ...deletion,
    state: "deleted",
    activeSessionChanged: true,
  });
  assert.equal(runtime.workspaceSelected, false);
  assert.notEqual(runtime.sessionManager.getSessionId(), request.sessionId);
  await assert.rejects(readFile(request.sessionPath), { code: "ENOENT" });
  await assert.rejects(runtime.sendPrompt("Must remain a draft"), unavailable);
  const replacementId = runtime.sessionManager.getSessionId();
  assert.deepEqual(await runtime.deleteSession(deletion), {
    ...result,
    replayed: true,
  });
  assert.equal(runtime.sessionManager.getSessionId(), replacementId);
  assert.equal(
    hooks.events.filter((event) => event.type === "session_before_switch")
      .length,
    1,
  );
  await runtime.newSession(runtime.cwd, { commandId: "after-delete" });
  runtime.sessionManager.appendMessage({
    role: "user",
    content: "New native history",
    timestamp: 5,
  });
  assert.equal(runtime.workspaceSelected, true);
  await assert.rejects(readFile(request.sessionPath), { code: "ENOENT" });
});

test("deleting the inactive fork source preserves the independently persisted child", async (t) => {
  const { runtime, request } = await fixture(t);
  const forked = await runtime.forkSession(request);
  assert.equal(forked.state, "forked");
  const child = await readFile(forked.sessionPath!, "utf8");
  const result = await runtime.deleteSession({
    commandId: "delete-source",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  });
  assert.equal(result.state, "deleted");
  assert.equal(result.activeSessionChanged, undefined);
  assert.equal(runtime.workspaceSelected, true);
  assert.equal(runtime.sessionManager.getSessionId(), forked.sessionId);
  assert.equal(await readFile(forked.sessionPath!, "utf8"), child);
  assert.equal(
    SessionManager.open(forked.sessionPath!)
      .getBranch()
      .filter((entry) => entry.type === "message").length,
    2,
  );
});

test("native before-switch cancellation leaves a deletion source intact and permits the same command after cancellation is lifted", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  hooks.cancelSwitch = true;
  const original = await readFile(request.sessionPath, "utf8");
  const deletion = {
    commandId: "cancel-delete",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  const result = await runtime.deleteSession(deletion);
  assert.equal(result.state, "cancelled");
  assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
  assert.equal(runtime.workspaceSelected, true);
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  hooks.cancelSwitch = false;
  assert.equal((await runtime.deleteSession(deletion)).state, "deleted");
  await assert.rejects(readFile(request.sessionPath), { code: "ENOENT" });
});

test("deletion rejects running, queued and admitted work without interrupting it", async (t) => {
  const { runtime, internals, request, hooks } = await fixture(t);
  const owner = internals.runtime;
  const activity = owner.session as unknown as { _isAgentRunActive: boolean };
  const deletion = {
    commandId: "delete-running",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  activity._isAgentRunActive = true;
  await assert.rejects(
    runtime.deleteSession(deletion),
    (error: unknown) =>
      error instanceof WebRuntimeRequestError &&
      error.code === "SESSION_DELETE_BUSY",
  );
  activity._isAgentRunActive = false;
  await owner.session.steer("queued");
  await assert.rejects(
    runtime.deleteSession({ ...deletion, commandId: "delete-queued" }),
    unavailable,
  );
  owner.session.clearQueue();
  internals.inFlightRuntimes.set(owner, 1);
  await assert.rejects(
    runtime.deleteSession({ ...deletion, commandId: "delete-admitted" }),
    unavailable,
  );
  internals.inFlightRuntimes.clear();
  assert.equal(
    hooks.events.some((event) => event.type === "session_before_switch"),
    false,
  );
  assert.ok(await readFile(request.sessionPath, "utf8"));
});

test("a busy deletion can retry the same command after native work is idle", async (t) => {
  const { runtime, internals, request } = await fixture(t);
  const owner = internals.runtime;
  const activity = owner.session as unknown as { _isAgentRunActive: boolean };
  const deletion = {
    commandId: "delete-retry-busy",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  activity._isAgentRunActive = true;
  await assert.rejects(runtime.deleteSession(deletion), unavailable);
  assert.equal(runtime.sessionManager.getSessionId(), request.sessionId);
  activity._isAgentRunActive = false;
  assert.equal((await runtime.deleteSession(deletion)).state, "deleted");
  await assert.rejects(readFile(request.sessionPath), { code: "ENOENT" });
});

test("a retained running Session cannot be deleted from another active Session", async (t) => {
  const { runtime, internals, request } = await fixture(t);
  const background = internals.runtime;
  const activity = background.session as unknown as {
    _isAgentRunActive: boolean;
  };
  activity._isAgentRunActive = true;
  try {
    await runtime.newSession(runtime.cwd, { commandId: "other-active" });
    const selectedId = runtime.sessionManager.getSessionId();
    await assert.rejects(
      runtime.deleteSession({
        commandId: "delete-background",
        sessionId: request.sessionId,
        sessionPath: request.sessionPath,
      }),
      unavailable,
    );
    assert.equal(background.session.isStreaming, true);
    assert.equal(runtime.sessionManager.getSessionId(), selectedId);
    assert.ok(await readFile(request.sessionPath, "utf8"));
  } finally {
    activity._isAgentRunActive = false;
  }
});

test("deletion requires an exact native identity and rejects external files, symlinks and hardlinks", async (t) => {
  const { runtime, request, root } = await fixture(t);
  const deletion = {
    commandId: "wrong-id",
    sessionId: "different",
    sessionPath: request.sessionPath,
  };
  const original = await readFile(request.sessionPath, "utf8");
  await assert.rejects(runtime.deleteSession(deletion), unavailable);
  const external = join(root, request.sessionPath.split(/[\\/]/u).at(-1)!);
  await writeFile(external, original);
  await assert.rejects(
    runtime.deleteSession({
      ...deletion,
      commandId: "external",
      sessionId: request.sessionId,
      sessionPath: external,
    }),
    unavailable,
  );
  const hardlink = join(root, "hardlink.jsonl");
  await link(request.sessionPath, hardlink);
  await assert.rejects(
    runtime.deleteSession({
      ...deletion,
      commandId: "hardlink",
      sessionId: request.sessionId,
    }),
    unavailable,
  );
  await rm(hardlink);
  await rm(request.sessionPath);
  await symlink(external, request.sessionPath);
  await assert.rejects(
    runtime.deleteSession({
      ...deletion,
      commandId: "symlink",
      sessionId: request.sessionId,
    }),
    unavailable,
  );
  assert.equal(await readFile(external, "utf8"), original);
  await rm(request.sessionPath);
  await writeFile(request.sessionPath, original);
});

test("pending deletion blocks new input and mutations and coalesces exact duplicate requests", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const gate = deferred();
  hooks.switchGate = gate.promise;
  const deletion = {
    commandId: "delete-pending",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  const pending = runtime.deleteSession(deletion);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(hooks.events.at(-1)?.type, "session_before_switch");
  const duplicate = runtime.deleteSession(deletion);
  await assert.rejects(runtime.sendPrompt("Keep this draft"), unavailable);
  await assert.rejects(runtime.newSession(runtime.cwd), unavailable);
  await assert.rejects(runtime.forkSession(request), unavailable);
  await assert.rejects(
    runtime.deleteSession({ ...deletion, sessionId: "different" }),
    unavailable,
  );
  gate.resolve();
  const result = await pending;
  assert.equal(result.state, "deleted");
  assert.deepEqual(await duplicate, { ...result, replayed: true });
});

test("deletion waits for pending native shutdown before removing an inactive Session", async (t) => {
  const { runtime, internals, request } = await fixture(t);
  const previous = internals.runtime;
  const dispose = previous.dispose.bind(previous);
  const gate = deferred();
  previous.dispose = async () => {
    await gate.promise;
    previous.session.sessionManager.appendSessionInfo(
      "Written during shutdown",
    );
    await dispose();
  };
  await runtime.newSession(runtime.cwd, { commandId: "release-source" });
  let settled = false;
  const pending = runtime
    .deleteSession({
      commandId: "after-shutdown",
      sessionId: request.sessionId,
      sessionPath: request.sessionPath,
    })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(await readFile(request.sessionPath, "utf8"));
  gate.resolve();
  assert.equal((await pending).state, "deleted");
  await assert.rejects(readFile(request.sessionPath), { code: "ENOENT" });
});

test("file replacement during native switching fails closed and an uncertain delete cannot repeat", async (t) => {
  const { runtime, request, hooks, root } = await fixture(t);
  const gate = deferred();
  hooks.switchGate = gate.promise;
  const original = await readFile(request.sessionPath, "utf8");
  const deletion = {
    commandId: "delete-replaced",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  const pending = runtime.deleteSession(deletion);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await rename(request.sessionPath, join(root, "preserved-source.jsonl"));
  await writeFile(request.sessionPath, original);
  gate.resolve();
  const result = await pending;
  assert.equal(result.state, "uncertain");
  assert.equal(runtime.workspaceSelected, false);
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
  assert.deepEqual(await runtime.deleteSession(deletion), {
    ...result,
    replayed: true,
  });
  assert.equal(await readFile(request.sessionPath, "utf8"), original);
});

test("a native replacement failure preserves the source and keeps deletion terminal", async (t) => {
  const { runtime, internals, request } = await fixture(t);
  const owner = internals.runtime;
  const native = owner.newSession.bind(owner);
  let calls = 0;
  owner.newSession = async (...args) => {
    calls++;
    await native(...args);
    throw new Error("replacement acknowledgement failed");
  };
  const deletion = {
    commandId: "delete-failed-replacement",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  const result = await runtime.deleteSession(deletion);
  assert.equal(result.state, "uncertain");
  assert.equal(runtime.workspaceSelected, false);
  assert.ok(await readFile(request.sessionPath, "utf8"));
  assert.deepEqual(await runtime.deleteSession(deletion), {
    ...result,
    replayed: true,
  });
  assert.equal(calls, 1);
});

test("runtime disposal during deletion prevents a late unlink and drains the native operation", async (t) => {
  const { runtime, request, hooks } = await fixture(t);
  const gate = deferred();
  hooks.switchGate = gate.promise;
  const pending = runtime.deleteSession({
    commandId: "delete-during-dispose",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const disposal = runtime.dispose();
  gate.resolve();
  assert.equal((await pending).state, "uncertain");
  await disposal;
  assert.ok(await readFile(request.sessionPath, "utf8"));
});

test("an event subscriber failure cannot turn a confirmed unlink into an uncertain deletion", async (t) => {
  const { runtime, request } = await fixture(t);
  runtime.subscribe((event) => {
    if (event.type === "session_deleted") throw new Error("UI disconnected");
  });
  const deletion = {
    commandId: "delete-notification-failed",
    sessionId: request.sessionId,
    sessionPath: request.sessionPath,
  };
  const result = await runtime.deleteSession(deletion);
  assert.equal(result.state, "deleted");
  await assert.rejects(readFile(request.sessionPath), { code: "ENOENT" });
  assert.deepEqual(await runtime.deleteSession(deletion), {
    ...result,
    replayed: true,
  });
});

test("explicit release retains shared and replacement cwd owners, then recovers private authority after restart", {
  timeout: 30_000,
}, async (t) => {
  const { root, runtime, request } = await fixture(t);
  const git = await gitFixture(root);
  const fork = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  assert.equal(fork.state, "forked");
  const target = {
    sessionId: fork.sessionId!,
    sessionPath: fork.sessionPath!,
    worktreePath: fork.worktree!.path,
  };
  const release = { ...target, commandId: "release-exact" };
  assert.equal(
    (await runtime.releaseSessionWorktree(release)).state,
    "preserved",
  );
  const descendant = await runtime.forkSession(
    conversation(target, "shared-descendant"),
  );
  assert.equal(descendant.cwd, fork.cwd);
  const deleted = await runtime.deleteSession({
    commandId: "delete-owner",
    sessionId: target.sessionId,
    sessionPath: target.sessionPath,
  });
  assert.ok("worktreeReleaseTarget" in deleted);
  assert.deepEqual(deleted.worktreeReleaseTarget, target);
  assert.equal(
    (
      await runtime.releaseSessionWorktree({
        ...release,
        commandId: "release-shared",
      })
    ).state,
    "preserved",
  );
  await runtime.deleteSession({
    commandId: "delete-descendant",
    sessionId: descendant.sessionId!,
    sessionPath: descendant.sessionPath!,
  });
  assert.equal(runtime.cwd, fork.cwd);
  const replacement = await runtime.releaseSessionWorktree({
    ...release,
    commandId: "release-replacement",
  });
  assert.equal(replacement.state, "preserved");
  assert.match(replacement.reason!, /runtime/u);
  await runtime.newSession(root, { commandId: "leave-worktree" });
  await runtime.dispose();
  const restarted = await PiWebRuntime.create(root);
  t.after(() => restarted.dispose());
  assert.deepEqual((await restarted.listRetainedWorktrees(root)).worktrees, [
    target,
  ]);
  await assert.rejects(
    restarted.releaseSessionWorktree({
      ...release,
      sessionPath: join(root, "outside.jsonl"),
    }),
    /exact/u,
  );
  const first = restarted.releaseSessionWorktree({
    ...release,
    commandId: "release-after-restart",
  });
  const duplicate = restarted.releaseSessionWorktree({
    ...release,
    commandId: "release-after-restart",
  });
  assert.equal((await first).state, "removed");
  assert.equal((await duplicate).replayed, true);
  assert.equal(
    (
      await restarted.releaseSessionWorktree({
        ...release,
        commandId: "release-after-restart",
      })
    ).state,
    "removed",
  );
  assert.equal(
    (await restarted.listRetainedWorktrees(root)).worktrees.length,
    0,
  );
  assert.equal(
    (await git("worktree", "list", "--porcelain")).stdout.includes(
      target.worktreePath,
    ),
    false,
  );
  await restarted.dispose();
});

test("explicit release preserves modified checkout and rejects forged native binding without erasing authority", {
  timeout: 20_000,
}, async (t) => {
  const { root, runtime, request } = await fixture(t);
  await gitFixture(root);
  const fork = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  const target = {
    sessionId: fork.sessionId!,
    sessionPath: fork.sessionPath!,
    worktreePath: fork.worktree!.path,
  };
  await runtime.deleteSession({
    commandId: "delete-dirty",
    sessionId: target.sessionId,
    sessionPath: target.sessionPath,
  });
  await runtime.newSession(root, { commandId: "leave-dirty" });
  const file = join(target.worktreePath, "private.env");
  await writeFile(file, "operator evidence\n");
  const wrong = await runtime.releaseSessionWorktree({
    ...target,
    sessionId: "forged-child",
    commandId: "wrong-binding",
  });
  assert.equal(wrong.state, "preserved");
  assert.match(wrong.reason!, /another native child/u);
  const dirty = await runtime.releaseSessionWorktree({
    ...target,
    commandId: "dirty-release",
  });
  assert.equal(dirty.state, "preserved");
  assert.equal(await readFile(file, "utf8"), "operator evidence\n");
  assert.deepEqual((await runtime.listRetainedWorktrees(root)).worktrees, [
    target,
  ]);
  await rm(file);
  const incomplete = join(runtime.sessionDirectory, "unknown.jsonl");
  await writeFile(incomplete, "unreadable native reference");
  assert.equal(
    (
      await runtime.releaseSessionWorktree({
        ...target,
        commandId: "unknown-reference",
      })
    ).state,
    "preserved",
  );
  await rm(incomplete);
  const disposal = deferred();
  const pending = runtime as unknown as {
    runtimeDisposals: Set<Promise<void>>;
  };
  pending.runtimeDisposals.add(disposal.promise);
  const shuttingDown = await runtime.releaseSessionWorktree({
    ...target,
    commandId: "pending-disposal",
  });
  assert.equal(shuttingDown.state, "preserved");
  assert.match(shuttingDown.reason!, /shutdown is still pending/u);
  pending.runtimeDisposals.delete(disposal.promise);
  disposal.resolve();
  for (const [commandId, holder] of [
    ["host-present", () => true],
    [
      "host-unknown",
      () => {
        throw new Error("unknown holder state");
      },
    ],
  ] as const) {
    const held = await runtime.releaseSessionWorktree(
      { ...target, commandId },
      holder,
    );
    assert.equal(held.state, "preserved");
    assert.ok(await readFile(join(target.worktreePath, "tracked.txt"), "utf8"));
  }
  let holderInspections = 0;
  const acquired = await runtime.releaseSessionWorktree(
    { ...target, commandId: "host-acquired" },
    () => ++holderInspections > 1,
  );
  assert.equal(acquired.state, "preserved");
  assert.equal(holderInspections, 2);
  const removed = await runtime.releaseSessionWorktree({
    ...target,
    commandId: "explicit-retry",
  });
  assert.equal(removed.state, "removed");
  await assert.rejects(
    runtime.releaseSessionWorktree({
      ...target,
      commandId: "explicit-retry",
      sessionId: "different",
    }),
    /another resource/u,
  );
});

test("private native binding persistence failure is uncertain and preserves both child and checkout", {
  timeout: 20_000,
}, async (t) => {
  const { root, runtime, request, hooks } = await fixture(t);
  await gitFixture(root);
  hooks.onFork = () => {
    for (const entry of readdirSync(join(root, ".git", "worktrees")))
      writeFileSync(
        join(root, ".git", "worktrees", entry, "openpi-session-worktree.json"),
        "changed ownership marker",
      );
  };
  const result = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  assert.equal(result.state, "uncertain");
  assert.ok(result.sessionPath);
  assert.ok(result.preservedWorktreePath);
  assert.ok(await readFile(result.sessionPath, "utf8"));
  assert.equal(
    await readFile(join(result.preservedWorktreePath, "tracked.txt"), "utf8"),
    "dirty source contents\n",
  );
  const listing = await runtime.listRetainedWorktrees(root);
  assert.equal(listing.worktrees.length, 0);
  assert.equal(listing.unavailable, 1);
});

test("private resource uncertainty survives changed commands and native Host restart", {
  timeout: 30_000,
}, async (t) => {
  const { root, runtime, request } = await fixture(t);
  await gitFixture(root);
  const fork = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  const target = {
    sessionId: fork.sessionId!,
    sessionPath: fork.sessionPath!,
    worktreePath: fork.worktree!.path,
  };
  await runtime.deleteSession({
    ...target,
    commandId: "delete-terminal-owner",
  });
  await runtime.newSession(root, { commandId: "leave-terminal-resource" });
  const receipt = await readSessionWorktreeReceipt(
    target.worktreePath,
    runtime.sessionDirectory,
  );
  // A Host can stop after claiming this exact original private resource and
  // before atomically replacing its marker. A new Host must honor that claim.
  await writeFile(
    join(receipt.gitDir, "openpi-session-worktree.json.release-lock"),
    JSON.stringify(receipt),
    { flag: "wx", mode: 0o600 },
  );
  for (const commandId of ["uncertain-original", "uncertain-new-command"]) {
    const result = await runtime.releaseSessionWorktree({
      ...target,
      commandId,
    });
    assert.equal(result.state, "uncertain");
    assert.match(result.reason!, /prior release attempt/u);
  }
  assert.equal(
    (
      await runtime.releaseSessionWorktree({
        ...target,
        commandId: "uncertain-original",
      })
    ).replayed,
    true,
  );
  let holderInspected = false;
  assert.equal(
    (
      await runtime.releaseSessionWorktree(
        { ...target, commandId: "uncertain-with-holder" },
        () => {
          holderInspected = true;
          return true;
        },
      )
    ).state,
    "uncertain",
  );
  assert.equal(
    holderInspected,
    false,
    "terminal resource state precedes new holder observations",
  );
  await runtime.dispose();
  const restarted = await PiWebRuntime.create(root);
  try {
    assert.deepEqual((await restarted.listRetainedWorktrees(root)).worktrees, [
      target,
    ]);
    for (const commandId of ["uncertain-original", "restart-new-command"])
      assert.equal(
        (await restarted.releaseSessionWorktree({ ...target, commandId }))
          .state,
        "uncertain",
      );
    assert.ok(await readFile(join(target.worktreePath, "tracked.txt"), "utf8"));
  } finally {
    await restarted.dispose();
  }
});

test("release authority unknowns never downgrade a resource terminal across claim, marker and holder combinations", {
  timeout: 60_000,
}, async (t) => {
  const { root, runtime, request } = await fixture(t);
  await gitFixture(root);
  const fork = await runtime.forkSession({
    ...conversation(request),
    environment: "worktree",
  });
  const target = {
    sessionId: fork.sessionId!,
    sessionPath: fork.sessionPath!,
    worktreePath: fork.worktree!.path,
  };
  await runtime.deleteSession({
    ...target,
    commandId: "delete-projection-owner",
  });
  await runtime.newSession(root, { commandId: "leave-projection-resource" });
  const receipt = await readSessionWorktreeReceipt(
    target.worktreePath,
    runtime.sessionDirectory,
  );
  const markerPath = join(receipt.gitDir, "openpi-session-worktree.json");
  const claimPath = `${markerPath}.release-lock`;
  const originalMarker = await readFile(markerPath, "utf8");
  const originalOpen = fs.promises.open;
  const originalLstat = fs.promises.lstat;
  let command = 0;
  try {
    // Start with the independently reproduced missing-marker + existing-claim
    // case. Every subsequent row changes only one authority projection fact.
    for (const claim of ["present", "absent", "unknown"] as const) {
      await rm(claimPath, { force: true });
      if (claim === "present")
        await writeFile(claimPath, originalMarker, { flag: "wx", mode: 0o600 });
      for (const marker of [
        "missing",
        "malformed",
        "unreadable",
        "unbound",
        "invalid",
        "terminal",
        "clean",
      ] as const) {
        await rm(markerPath, { force: true });
        if (marker !== "missing")
          await writeFile(
            markerPath,
            marker === "malformed"
              ? "not a private receipt"
              : marker === "unbound"
                ? JSON.stringify({ ...receipt, ownerSession: undefined })
                : marker === "invalid"
                  ? JSON.stringify({ ...receipt, releaseState: "invalid" })
                  : marker === "terminal"
                    ? JSON.stringify({ ...receipt, releaseState: "uncertain" })
                    : originalMarker,
          );
        fs.promises.open = async (...args) => {
          if (marker === "unreadable" && String(args[0]) === markerPath)
            throw Object.assign(new Error("injected unreadable marker"), {
              code: "EACCES",
            });
          return originalOpen(...args);
        };
        fs.promises.lstat = ((...args: Parameters<typeof originalLstat>) => {
          if (claim === "unknown" && String(args[0]) === claimPath)
            return Promise.reject(
              Object.assign(new Error("injected unknown claim"), {
                code: "EACCES",
              }),
            );
          return originalLstat(...args);
        }) as typeof originalLstat;
        syncBuiltinESMExports();
        for (const holder of ["none", "present", "unknown"] as const) {
          if (claim === "absent" && marker === "clean" && holder === "none")
            continue; // Successful removal has its separate real-Git fixture.
          let inspected = false;
          const result = await runtime.releaseSessionWorktree(
            { ...target, commandId: `projection-${++command}` },
            () => {
              inspected = true;
              if (holder === "unknown")
                throw new Error("injected unknown holder");
              return holder === "present";
            },
          );
          const terminal = claim !== "absent" || marker !== "clean";
          assert.equal(
            result.state,
            terminal ? "uncertain" : "preserved",
            `${claim}/${marker}/${holder}`,
          );
          assert.equal(
            inspected,
            !terminal,
            `${claim}/${marker}/${holder} authority precedes holder`,
          );
          assert.ok(
            await readFile(join(target.worktreePath, "tracked.txt"), "utf8"),
          );
        }
        if (marker !== "clean" && marker !== "terminal") {
          const listing = await runtime.listRetainedWorktrees(root);
          assert.deepEqual(
            listing.worktrees,
            [],
            "a claim never recreates discovery identity from a bad marker",
          );
          assert.equal(listing.unavailable, 1);
        }
        if (marker === "clean" || marker === "terminal") {
          const wrong = await runtime.releaseSessionWorktree({
            ...target,
            sessionId: "different-native-child",
            commandId: `projection-${++command}`,
          });
          assert.equal(
            wrong.state,
            "preserved",
            "a fully verified different native child grants no authority",
          );
        }
      }
    }
  } finally {
    fs.promises.open = originalOpen;
    fs.promises.lstat = originalLstat;
    syncBuiltinESMExports();
    await writeFile(markerPath, originalMarker);
    await writeFile(claimPath, originalMarker, { mode: 0o600 });
  }
  const gitFile = join(target.worktreePath, ".git");
  const originalGitFile = await readFile(gitFile, "utf8");
  // Git marks this existing file hidden on Windows; opening with w yields EPERM.
  const replaceGitFile = async (contents: string) => {
    const handle = await open(gitFile, "r+");
    try {
      await handle.truncate(0);
      await handle.writeFile(contents);
    } finally {
      await handle.close();
    }
    assert.equal(await readFile(gitFile, "utf8"), contents);
  };
  try {
    await replaceGitFile("gitdir: missing-private-admin\n");
    assert.equal(
      (
        await runtime.releaseSessionWorktree({
          ...target,
          commandId: "canonical-admin-unknown",
        })
      ).state,
      "uncertain",
    );
  } finally {
    await replaceGitFile(originalGitFile);
  }
});

for (const clock of [
  { name: "forward-wall", wall: 120_000, elapsed: 0, expires: false },
  { name: "backward-wall", wall: -120_000, elapsed: 0, expires: false },
  {
    name: "backward-wall-with-budget-left",
    wall: -120_000,
    elapsed: 85_000,
    expires: false,
  },
  {
    name: "backward-wall-with-expired-budget",
    wall: -120_000,
    elapsed: 120_000,
    expires: true,
  },
]) {
  test(`native release header scan uses monotonic budget: ${clock.name}`, {
    timeout: 30_000,
  }, async (t) => {
    const { root, runtime, request } = await fixture(t);
    await gitFixture(root);
    const fork = await runtime.forkSession({
      ...conversation(request),
      environment: "worktree",
    });
    const target = {
      sessionId: fork.sessionId!,
      sessionPath: fork.sessionPath!,
      worktreePath: fork.worktree!.path,
    };
    await runtime.deleteSession({ ...target, commandId: "delete-clock-owner" });
    await runtime.newSession(root, { commandId: "leave-clock-resource" });
    runtime.sessionManager.appendMessage({
      role: "user",
      content: "second persisted native header",
      timestamp: 3,
    });
    const catalogDirectory = await realpath(runtime.sessionDirectory);
    assert.ok(
      (await readdir(catalogDirectory)).filter((file) =>
        file.endsWith(".jsonl"),
      ).length >= 2,
    );
    const originalDateNow = Date.now;
    const originalPerformanceNow = performance.now.bind(performance);
    const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
    const originalLstat = fs.lstatSync;
    let shifted = false;
    fs.lstatSync = ((...args: Parameters<typeof originalLstat>) => {
      const result = originalLstat(...args);
      if (
        !shifted &&
        String(args[0]).endsWith(".jsonl") &&
        [runtime.sessionDirectory, catalogDirectory].includes(
          dirname(String(args[0])),
        )
      ) {
        shifted = true;
        Date.now = () => originalDateNow() + clock.wall;
        Object.defineProperty(performance, "now", {
          configurable: true,
          value: () => originalPerformanceNow() + clock.elapsed,
        });
      }
      return result;
    }) as typeof originalLstat;
    syncBuiltinESMExports();
    try {
      const result = await runtime.releaseSessionWorktree({
        ...target,
        commandId: "clock-release",
      });
      assert.equal(
        shifted,
        true,
        "clock changes after the first real native header inspection begins",
      );
      assert.equal(result.state, clock.expires ? "preserved" : "removed");
      if (clock.expires)
        assert.match(
          result.reason!,
          /reference inspection reached its time limit/u,
        );
    } finally {
      fs.lstatSync = originalLstat;
      Date.now = originalDateNow;
      if (descriptor) Object.defineProperty(performance, "now", descriptor);
      else Reflect.deleteProperty(performance, "now");
      syncBuiltinESMExports();
    }
    if (clock.expires) {
      assert.ok(
        await readFile(join(target.worktreePath, "tracked.txt"), "utf8"),
      );
      assert.equal(
        (
          await runtime.releaseSessionWorktree({
            ...target,
            commandId: "explicit-after-deadline",
          })
        ).state,
        "removed",
      );
    }
  });
}
