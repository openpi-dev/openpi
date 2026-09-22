import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { projectEntry } from "../../web/protocol/types.ts";
import {
  readTurnTiming,
  WEB_TURN_TIMING_ENTRY,
} from "../../web/protocol/turn-timing.ts";
import { PiWebRuntime } from "../../web/runtime/pi-runtime.ts";
import type { WebRuntimeEvent } from "../../web/runtime/types.ts";

function harness(sessionManager = SessionManager.inMemory(process.cwd())) {
  const session = { sessionManager };
  const events: WebRuntimeEvent[] = [];
  const runtime = Object.create(PiWebRuntime.prototype) as {
    runtime: { session: typeof session };
    pendingPromptTraces: unknown[];
    activePromptTrace?: {
      commandId: string;
      sessionId: string;
      startedAt: number;
      started: boolean;
      queued: boolean;
      outcome?: "completed" | "failed" | "cancelled" | "uncertain";
    };
    listeners: Set<(event: WebRuntimeEvent) => void>;
    nextTurnEpoch: number;
    terminalTurnKeys: Set<string>;
    turnSettlementWaiters: Map<string, Set<unknown>>;
    turnAbortOperations: Map<string, Promise<unknown>>;
    getActiveTurn: PiWebRuntime["getActiveTurn"];
    projectEvent: (session: object, event: object) => void;
  };
  Object.assign(runtime, {
    runtime: { session },
    pendingPromptTraces: [],
    listeners: new Set([(event: WebRuntimeEvent) => events.push(event)]),
    nextTurnEpoch: 0,
    terminalTurnKeys: new Set(),
    turnSettlementWaiters: new Map(),
    turnAbortOperations: new Map(),
    activePromptTrace: {
      commandId: "prompt-a",
      sessionId: sessionManager.getSessionId(),
      startedAt: -10000,
      started: false,
      queued: false,
    },
  });
  return {
    runtime,
    sessionManager,
    events,
    emit: (event: object) => runtime.projectEvent(session, event),
  };
}

test("Pi execution timing excludes queue time, survives clock rollback and persists once at agent_settled", (t) => {
  let monotonic = 1000;
  let wall = 200000;
  t.mock.method(performance, "now", () => monotonic);
  t.mock.method(Date, "now", () => wall);
  const { runtime, sessionManager, emit, events } = harness();
  sessionManager.appendMessage({
    role: "user",
    content: "hello",
    timestamp: wall,
  });
  emit({ type: "agent_start" });
  assert.equal(runtime.getActiveTurn()?.elapsedMs, 0);
  assert.equal(runtime.getActiveTurn()?.startedAt, 200000);
  assert.equal(
    runtime.getActiveTurn()?.sessionPath,
    `current:${sessionManager.getSessionId()}`,
  );
  monotonic = 158000;
  wall = 100000;
  assert.equal(runtime.getActiveTurn()?.elapsedMs, 157000);
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
    },
  });
  assert.equal(
    sessionManager.getEntries().filter((entry) => entry.type === "custom")
      .length,
    0,
  );
  emit({ type: "agent_settled" });
  emit({ type: "agent_settled" });
  const records = sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom");
  assert.equal(records.length, 1);
  const record = records[0]!;
  assert.equal(record.customType, WEB_TURN_TIMING_ENTRY);
  const timing = readTurnTiming(record.data);
  assert.equal(timing?.elapsedMs, 157000);
  assert.equal(timing?.outcome, "completed");
  assert.equal(timing?.finishedAt, 100000);
  const projection = projectEntry(record);
  assert.deepEqual(
    "turnTiming" in projection ? projection.turnTiming : undefined,
    timing,
  );
  assert.equal(sessionManager.buildSessionContext().messages.length, 1);
  assert.equal(
    events.filter((event) => event.type === "turn_settled").length,
    1,
  );
});

for (const outcome of ["failed", "cancelled", "uncertain"] as const) {
  test(`timing preserves ${outcome} without changing the terminal outcome`, () => {
    const { runtime, sessionManager, emit, events } = harness();
    emit({ type: "agent_start" });
    runtime.activePromptTrace!.outcome = outcome;
    emit({ type: "agent_settled" });
    const record = sessionManager
      .getEntries()
      .find((entry) => entry.type === "custom");
    assert.equal(record && readTurnTiming(record.data)?.outcome, outcome);
    assert.equal(
      events.find((event) => event.type === "turn_settled")?.detail?.outcome,
      outcome,
    );
  });
}

test("an optional timing write failure cannot suppress Pi's terminal event", (t) => {
  const { runtime, sessionManager, emit, events } = harness();
  t.mock.method(sessionManager, "appendCustomEntry", () => {
    throw new Error("fixture disk failure");
  });
  emit({ type: "agent_start" });
  runtime.activePromptTrace!.outcome = "cancelled";
  assert.doesNotThrow(() => emit({ type: "agent_settled" }));
  assert.equal(
    events.find((event) => event.type === "turn_settled")?.detail?.outcome,
    "cancelled",
  );
  assert.equal(runtime.getActiveTurn(), undefined);
});

test("settled timing survives reopening the native Session file without entering model context", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "openpi-turn-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  const { runtime, emit } = harness(manager);
  manager.appendMessage({
    role: "user",
    content: "hello",
    timestamp: Date.now(),
  });
  emit({ type: "agent_start" });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });
  runtime.activePromptTrace!.outcome = "completed";
  emit({ type: "agent_settled" });
  const reopened = SessionManager.open(manager.getSessionFile()!);
  const timings = reopened
    .getBranch()
    .map((entry) => projectEntry(entry))
    .filter((entry) => "turnTiming" in entry);
  assert.equal(timings.length, 1);
  assert.equal(timings[0]?.turnTiming?.commandId, "prompt-a");
  assert.equal(reopened.buildSessionContext().messages.length, 2);
});

test("unrecognized custom entries and malformed timing do not become duration evidence", () => {
  const timing = {
    version: 1,
    sessionId: "s",
    commandId: "c",
    epoch: 1,
    startedAt: 1000,
    finishedAt: 2000,
    elapsedMs: 1000,
    outcome: "completed",
  };
  assert.equal(readTurnTiming({ ...timing, elapsedMs: -1 }), undefined);
  assert.equal(readTurnTiming({ ...timing, outcome: "looks-done" }), undefined);
  const session = SessionManager.inMemory(process.cwd());
  session.appendCustomEntry("unrelated", timing);
  assert.equal("turnTiming" in projectEntry(session.getEntries()[0]!), false);
});
