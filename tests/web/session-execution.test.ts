import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import { PiWebAdapter } from "../../web/adapter/pi-adapter.ts";
import type { WebRuntimeEvent } from "../../web/runtime/types.ts";
import { WEB_TURN_TIMING_ENTRY } from "../../web/protocol/turn-timing.ts";

function gate() {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    released: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "openpi-session-execution-"));
  const gates = [gate(), gate()];
  const makeRuntime = async (name: string) => {
    const cwd = join(directory, name);
    const agentDir = join(cwd, "agent");
    await mkdir(agentDir, { recursive: true });
    const provider = `execution-fixture-${name}`;
    const faux = fauxProvider({
      api: provider,
      provider,
      models: [{ id: "fixture", name: "Fixture", reasoning: false }],
    });
    faux.setResponses(
      name === "A"
        ? [
            fauxAssistantMessage(
              fauxToolCall("hold_fixture", { phase: 0 }, { id: "hold-a-0" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage(
              fauxToolCall("hold_fixture", { phase: 1 }, { id: "hold-a-1" }),
              { stopReason: "toolUse" },
            ),
            fauxAssistantMessage("A finished"),
            fauxAssistantMessage("A follow-up finished"),
            fauxAssistantMessage("A final follow-up finished"),
          ]
        : [fauxAssistantMessage("B finished")],
    );
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider);
    await modelRuntime.setRuntimeApiKey(provider, "fixture-key");
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noThemes: true,
      noPromptTemplates: true,
      noContextFiles: true,
    });
    await loader.reload();
    const services = {
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoader: loader,
      diagnostics: [],
    };
    const create: CreateAgentSessionRuntimeFactory = async (options) => {
      const result = await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        model: faux.getModel(),
        tools: ["read", "hold_fixture"],
        customTools: [
          {
            name: "hold_fixture",
            label: "Hold fixture",
            description: "Wait for an explicit test gate",
            parameters: Type.Object({ phase: Type.Number() }),
            async execute(_id, args, signal, onUpdate) {
              if (
                !args ||
                typeof args !== "object" ||
                !("phase" in args) ||
                typeof args.phase !== "number"
              )
                throw new Error("Invalid fixture phase");
              const current = gates[args.phase];
              if (!current) throw new Error("Unknown fixture phase");
              current.enter();
              if (args.phase === 1)
                for (let index = 0; index < 100; index++)
                  onUpdate?.({
                    content: [{ type: "text", text: `Partial ${index}` }],
                    details: {},
                  });
              await Promise.race([
                current.released,
                new Promise<void>((resolve) => {
                  if (signal?.aborted) resolve();
                  else
                    signal?.addEventListener("abort", () => resolve(), {
                      once: true,
                    });
                }),
              ]);
              return {
                content: [{ type: "text", text: "Gate released" }],
                details: {},
              };
            },
          },
        ],
      });
      return { ...result, services, diagnostics: [] };
    };
    return createAgentSessionRuntime(create, {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, join(directory, "sessions")),
    });
  };
  const a = await makeRuntime("A");
  const b = await makeRuntime("B");
  const web = Reflect.construct(PiWebRuntime, [
    a,
    join(directory, "sessions"),
    { timeoutMs: 10000, release: async () => {} },
    { release: async () => {} },
    true,
  ]) as PiWebRuntime;
  const internal = web as unknown as {
    startRuntimeSession(): Promise<void>;
    replaceRuntime(runtime: AgentSessionRuntime): Promise<void>;
  };
  await internal.startRuntimeSession();
  let bOwned = false;
  t.after(async () => {
    for (const item of gates) item.release();
    await web.dispose();
    if (!bOwned) await b.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const events: WebRuntimeEvent[] = [];
  web.subscribe((event) => events.push(event));
  return {
    web,
    a,
    b,
    gates,
    events,
    async switchToB() {
      await internal.replaceRuntime(b);
      bOwned = true;
    },
  };
}

test("a real Pi Session continues tool progress and queued follow-ups after another Session becomes current", {
  timeout: 10000,
}, async (t) => {
  const { web, a, b, gates, events, switchToB } = await fixture(t);
  const sid = a.session.sessionManager.getSessionId();
  const path = a.session.sessionManager.getSessionFile()!;
  await web.sendPrompt("Run the fixture", {
    commandId: "run-a",
    expectedSessionId: sid,
  });
  await gates[0]!.entered;
  await web.sendPrompt("Follow up one", {
    commandId: "follow-up-1",
    expectedSessionId: sid,
  });
  await web.sendPrompt("Follow up two", {
    commandId: "follow-up-2",
    expectedSessionId: sid,
  });
  assert.equal(web.getSessionExecution(sid, path).pendingFollowUps, 2);
  assert.deepEqual(web.getSessionExecution(sid, path).queuedMessages, [
    "Follow up one",
    "Follow up two",
  ]);
  await switchToB();
  const since = events.length;
  gates[0]!.release();
  await gates[1]!.entered;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(a.session.isStreaming, true);
  assert.equal(
    web.sessionManager.getSessionId(),
    b.session.sessionManager.getSessionId(),
  );
  assert.ok(
    events
      .slice(since)
      .some(
        (event) =>
          event.type === "session_progress" && event.detail?.sessionId === sid,
      ),
    "background native tool boundaries must report progress before the run settles",
  );
  assert.equal(
    events.slice(since).filter((event) => event.type === "session_progress")
      .length,
    1,
    "partial tool output and model tokens must not trigger snapshot storms",
  );
  assert.equal(
    events.slice(since).some((event) => event.type === "message_update"),
    false,
  );
  const execution = web.getSessionExecution(sid, path);
  assert.equal(
    web.getSessionManagerForRead(sid, path),
    a.session.sessionManager,
  );
  assert.equal(execution.status, "running");
  assert.equal(
    execution.pendingFollowUps,
    a.session.getFollowUpMessages().length,
  );
  assert.deepEqual(execution.queuedMessages, [
    "Follow up one",
    "Follow up two",
  ]);
  assert.deepEqual(
    execution.liveTools.map((item) => item.call.id),
    ["hold-a-1"],
  );
  assert.equal(execution.activeTurn?.commandId, "run-a");
  const snapshot = await new PiWebAdapter(web).getSnapshot(path);
  assert.equal(
    snapshot.currentSessionId,
    b.session.sessionManager.getSessionId(),
  );
  assert.equal(snapshot.runtime.status, "idle");
  assert.deepEqual(
    snapshot.sessions.find(
      (session) => session.id === sid && session.path === path,
    )?.execution,
    {
      status: "running",
      pendingFollowUps: 2,
    },
  );
  assert.deepEqual(
    snapshot.sessions.find(
      (session) => session.path === b.session.sessionManager.getSessionFile(),
    )?.execution,
    {
      status: "idle",
      pendingFollowUps: 0,
    },
  );
  assert.equal(snapshot.selectedExecution?.sessionId, sid);
  assert.equal(snapshot.selectedExecution?.sessionPath, path);
  assert.equal(snapshot.selectedExecution?.status, "running");
  assert.equal(
    snapshot.selectedExecution?.pendingFollowUps,
    a.session.getFollowUpMessages().length,
  );
  assert.deepEqual(snapshot.selectedExecution?.queuedMessages, [
    "Follow up one",
    "Follow up two",
  ]);
  assert.equal(
    web.getSessionExecution(sid, b.session.sessionManager.getSessionFile()!)
      .status,
    "unknown",
  );
  assert.equal(
    web.getSessionManagerForRead(
      sid,
      b.session.sessionManager.getSessionFile()!,
    ),
    undefined,
  );
  assert.equal(
    web.getSessionExecution(sid, b.session.sessionManager.getSessionFile()!)
      .pendingFollowUps,
    undefined,
  );
  const current = web.getSessionExecution(
    b.session.sessionManager.getSessionId(),
    b.session.sessionManager.getSessionFile()!,
  );
  assert.equal(current.status, "idle");
  assert.equal(current.pendingFollowUps, 0);
  assert.deepEqual(current.queuedMessages, []);
  assert.deepEqual(current.liveTools, []);
  assert.equal(
    events.slice(since).some((event) => event.type === "tool_execution_start"),
    false,
    "background events must not replace the current Session's live tool channel",
  );
});

test("returning to a real running Pi Session preserves the original cancel identity", {
  timeout: 10000,
}, async (t) => {
  const { web, a, gates, switchToB } = await fixture(t);
  const sid = a.session.sessionManager.getSessionId();
  await web.sendPrompt("Run fixture", {
    commandId: "run-a",
    expectedSessionId: sid,
  });
  await gates[0]!.entered;
  const original = web.getActiveTurn()!;
  await switchToB();
  await web.switchSession(a.session.sessionManager.getSessionFile()!);
  assert.equal(web.getActiveTurn()?.commandId, original.commandId);
  assert.equal(web.getActiveTurn()?.epoch, original.epoch);
  assert.equal(web.getActiveTurn()?.startedAt, original.startedAt);
  const nativeAbort = a.session.abort.bind(a.session);
  let aborts = 0;
  t.mock.method(a.session, "abort", async () => {
    aborts++;
    return nativeAbort();
  });
  const cancelled = await web.cancelTurn(original);
  assert.equal(
    aborts,
    1,
    "the restored identity must reach the owning native abort",
  );
  assert.equal(a.session.isIdle, true);
  // The faux provider reports the aborted stream as an error. Preserve the
  // actual terminal classification instead of treating abort() as evidence.
  assert.equal(cancelled.state, "failed");
  assert.match(cancelled.error ?? "", /active turn failed/);
});

test("background settlement records timing in the owning Pi Session, never the currently selected one", {
  timeout: 10000,
}, async (t) => {
  const { web, a, b, gates, events, switchToB } = await fixture(t);
  await web.sendPrompt("Run fixture", {
    commandId: "run-a",
    expectedSessionId: a.session.sessionManager.getSessionId(),
  });
  await gates[0]!.entered;
  await switchToB();
  const since = events.length;
  for (const item of gates) item.release();
  await a.session.waitForIdle();
  const timing = a.session.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY,
    );
  assert.equal(timing.length, 1);
  assert.equal(
    b.session.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY,
      ),
    false,
  );
  assert.equal(
    events.slice(since).some((event) => event.type === "turn_settled"),
    false,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    web.getSessionManagerForRead(
      a.session.sessionManager.getSessionId(),
      a.session.sessionManager.getSessionFile()!,
    ),
    undefined,
  );
  const snapshot = await new PiWebAdapter(web).getSnapshot();
  assert.equal(
    snapshot.sessions.find(
      (session) => session.path === a.session.sessionManager.getSessionFile(),
    )?.execution,
    undefined,
  );
});

test("promoting a background Session cancels its scheduled progress notification", {
  timeout: 10000,
}, async (t) => {
  const { web, a, gates, events, switchToB } = await fixture(t);
  const sid = a.session.sessionManager.getSessionId();
  await web.sendPrompt("Run fixture", {
    commandId: "run-a",
    expectedSessionId: sid,
  });
  await gates[0]!.entered;
  await switchToB();
  gates[0]!.release();
  await gates[1]!.entered;
  await web.switchSession(a.session.sessionManager.getSessionFile()!);
  const since = events.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(
    events
      .slice(since)
      .some(
        (event) =>
          event.type === "session_progress" && event.detail?.sessionId === sid,
      ),
    false,
  );
  assert.equal(web.getActiveTurn()?.commandId, "run-a");
});
