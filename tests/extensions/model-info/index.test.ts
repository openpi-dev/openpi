import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import modelInfo from "../../../extensions/model-info/index.ts";
import {
  CACHE_DIAGNOSTICS_CHANNEL,
  type CacheTurnObservation,
} from "../../../extensions/model-info/cache-diagnostics.ts";
import {
  MODEL_INFO_CHANNEL,
  REFRESH_CHANNEL,
  type ModelInfoState,
} from "../../../extensions/shared/dashboard-state.ts";

const timestamp = "2026-08-27T00:00:00.000Z";
type MessageEntry = Extract<SessionEntry, { type: "message" }>;

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
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
    ...overrides,
  };
}

function assistant(
  id: string,
  parentId: string | null,
  messageUsage: Usage,
): MessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "test",
      usage: messageUsage,
      stopReason: "stop",
      timestamp: 0,
    },
  };
}

function user(id: string, parentId: string | null): MessageEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: [], timestamp: 0 },
  };
}

function compaction(
  id: string,
  parentId: string | null,
  entryUsage: Usage,
): SessionEntry {
  return {
    type: "compaction",
    id,
    parentId,
    timestamp,
    summary: "summary",
    firstKeptEntryId: "kept",
    tokensBefore: 0,
    usage: entryUsage,
  };
}

class InstrumentedSessionManager {
  readonly entries = new Map<string, SessionEntry>();
  readonly visits = new Map<string, number>();
  branchReads = 0;
  leafId: string | null = null;

  constructor(entries: SessionEntry[]) {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }

  getSessionId() {
    return "session-a";
  }

  getLeafId() {
    return this.leafId;
  }

  getEntry(id: string) {
    this.visits.set(id, (this.visits.get(id) ?? 0) + 1);
    return this.entries.get(id);
  }

  // The real SessionManager still exposes this method. Returning an empty
  // branch makes a future full-branch scan observable without faking metrics.
  getBranch() {
    this.branchReads += 1;
    return [];
  }

  append(entry: SessionEntry) {
    this.entries.set(entry.id, entry);
    this.leafId = entry.id;
  }

  visitCount() {
    return [...this.visits.values()].reduce((total, count) => total + count, 0);
  }
}

class ModelInfoHarness {
  readonly handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  readonly listeners = new Map<string, Set<(value: unknown) => void>>();
  readonly publications: ModelInfoState[] = [];
  readonly cacheObservations: CacheTurnObservation[] = [];
  readonly manager: InstrumentedSessionManager;
  contextTokens = 100;
  private model = {
    provider: "openai",
    id: "test-model",
    name: "Test model",
    contextWindow: 1_000,
    reasoning: false,
  };
  private readonly context: ExtensionContext;

  constructor(entries: SessionEntry[]) {
    this.manager = new InstrumentedSessionManager(entries);
    this.manager.leafId = entries.at(-1)?.id ?? null;
    const thisHarness = this;
    this.context = {
      sessionManager: this.manager,
      get model() {
        return thisHarness.model;
      },
      getContextUsage: () => ({
        tokens: this.contextTokens,
        contextWindow: 1_000,
        percent: this.contextTokens / 10,
      }),
    } as unknown as ExtensionContext;

    const api = {
      getThinkingLevel: () => "low",
      events: {
        on: (channel: string, handler: (value: unknown) => void) => {
          const handlers = this.listeners.get(channel) ?? new Set();
          handlers.add(handler);
          this.listeners.set(channel, handlers);
          return () => handlers.delete(handler);
        },
        emit: (channel: string, value: unknown) => {
          if (channel === MODEL_INFO_CHANNEL) {
            this.publications.push(value as ModelInfoState);
          }
          if (channel === CACHE_DIAGNOSTICS_CHANNEL) {
            this.cacheObservations.push(value as CacheTurnObservation);
          }
          for (const listener of this.listeners.get(channel) ?? []) {
            listener(value);
          }
        },
      },
      on: (
        event: string,
        handler: (event: unknown, ctx: ExtensionContext) => unknown,
      ) => this.handlers.set(event, handler),
    } as unknown as ExtensionAPI;

    modelInfo(api);
  }

  get state() {
    const state = this.publications.at(-1);
    assert.ok(state, "model info should have been published");
    return state;
  }

  async emit(event: string, payload: unknown = {}) {
    await this.handlers.get(event)?.(payload, this.context);
  }

  refresh() {
    for (const listener of this.listeners.get(REFRESH_CHANNEL) ?? []) {
      listener(undefined);
    }
  }

  async selectModel(model: typeof this.model) {
    this.model = model;
    await this.emit("model_select", { model });
  }
}

test("emits per-turn cache observations without adding them to dashboard state", async () => {
  const harness = new ModelInfoHarness([]);
  await harness.emit("session_start");
  await harness.emit("before_agent_start", {
    systemPrompt: "system",
    systemPromptOptions: { cwd: "/repo", selectedTools: ["read"] },
  });
  await harness.emit("turn_end", {
    turnIndex: 0,
    message: assistant("assistant", null, usage({ input: 120 })).message,
    toolResults: [],
  });

  assert.equal(harness.cacheObservations.length, 1);
  assert.equal(harness.cacheObservations[0]?.kind, "first-turn");
  assert.equal("cacheDiagnostic" in harness.state, false);
});

test("synchronizes initial history and waits for turn_end before counting an assistant message", async () => {
  const initialUsage = usage({
    input: 10,
    cacheRead: 5,
    cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
  });
  const persistedUsage = usage({
    input: 20,
    cacheRead: 10,
    cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
  });
  const harness = new ModelInfoHarness([
    user("user", null),
    assistant("initial", "user", initialUsage),
  ]);

  await harness.emit("session_start");
  assert.equal(harness.state.cost, 1);
  assert.equal(harness.state.cachePercent, (5 / 15) * 100);
  const visitsAfterStart = harness.manager.visitCount();
  assert.ok(visitsAfterStart > 0);
  assert.equal(harness.manager.branchReads, 0);

  await harness.emit("message_end", {
    message: assistant("pending", "initial", persistedUsage).message,
  });
  assert.equal(harness.state.cost, 1);
  assert.equal(harness.manager.visitCount(), visitsAfterStart);

  harness.manager.append(assistant("pending", "initial", persistedUsage));
  await harness.emit("turn_end");
  assert.equal(harness.state.cost, 4);
  assert.equal(harness.manager.visitCount(), visitsAfterStart + 1);
  assert.equal(harness.manager.branchReads, 0);
});

test("repeated ordinary events publish live state without traversing history", async () => {
  const harness = new ModelInfoHarness([
    user("user", null),
    assistant("assistant", "user", usage({ input: 10 })),
  ]);
  await harness.emit("session_start");
  const visitsAfterStart = harness.manager.visitCount();

  harness.contextTokens = 250;
  harness.refresh();
  assert.equal(harness.state.contextTokens, 250);

  harness.contextTokens = 375;
  harness.refresh();
  assert.equal(harness.state.contextTokens, 375);

  harness.contextTokens = 500;
  await harness.selectModel({
    provider: "anthropic",
    id: "new-model",
    name: "New model",
    contextWindow: 2_000,
    reasoning: true,
  });
  assert.equal(harness.state.contextTokens, 500);
  assert.equal(harness.state.provider, "anthropic");
  assert.equal(harness.state.modelId, "new-model");
  assert.equal(harness.state.modelName, "New model");
  assert.equal(harness.state.thinking, "low");

  harness.contextTokens = 625;
  await harness.emit("agent_start");
  assert.equal(harness.state.contextTokens, 625);
  assert.equal(harness.state.generating, true);

  harness.contextTokens = 750;
  await harness.emit("agent_start");
  assert.equal(harness.state.contextTokens, 750);
  assert.equal(harness.state.generating, true);

  harness.contextTokens = 875;
  await harness.emit("agent_settled");
  assert.equal(harness.state.contextTokens, 875);
  assert.equal(harness.state.generating, false);

  harness.contextTokens = 950;
  await harness.emit("agent_settled");
  assert.equal(harness.state.contextTokens, 950);
  assert.equal(harness.state.generating, false);
  assert.equal(harness.manager.visitCount(), visitsAfterStart);
  assert.equal(harness.manager.branchReads, 0);
});

test("tree and compaction events synchronize the active leaf before publishing", async () => {
  const harness = new ModelInfoHarness([
    user("user", null),
    assistant(
      "first",
      "user",
      usage({
        cost: { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
      }),
    ),
  ]);
  await harness.emit("session_start");

  harness.manager.append(
    assistant(
      "tree-leaf",
      "first",
      usage({
        cost: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
      }),
    ),
  );
  await harness.emit("session_tree");
  assert.equal(harness.state.cost, 5);

  harness.manager.append(
    compaction(
      "compact",
      "tree-leaf",
      usage({
        cost: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0, total: 5 },
      }),
    ),
  );
  await harness.emit("session_compact");
  assert.equal(harness.state.cost, 10);
  assert.equal(harness.manager.branchReads, 0);
});

test("shutdown removes refresh work and clears the current context", async () => {
  const harness = new ModelInfoHarness([
    user("user", null),
    assistant("assistant", "user", usage({ input: 10 })),
  ]);
  await harness.emit("session_start");
  const publicationsBeforeShutdown = harness.publications.length;
  const visitsBeforeShutdown = harness.manager.visitCount();

  await harness.emit("session_shutdown");
  harness.contextTokens = 500;
  harness.refresh();

  assert.equal(harness.publications.length, publicationsBeforeShutdown);
  assert.equal(harness.manager.visitCount(), visitsBeforeShutdown);
});

test("shutdown drops a pending cache identity so a late turn_end cannot observe", async () => {
  const harness = new ModelInfoHarness([]);
  await harness.emit("session_start");
  await harness.emit("before_agent_start", {
    systemPrompt: "system",
    systemPromptOptions: { cwd: "/repo", selectedTools: ["read"] },
  });
  await harness.emit("session_shutdown");
  await harness.emit("turn_end", {
    turnIndex: 0,
    message: assistant("late", null, usage({ input: 120 })).message,
    toolResults: [],
  });

  assert.equal(harness.cacheObservations.length, 0);
});

for (const stopReason of ["error", "aborted"] as const) {
  test(`${stopReason} responses preserve the last valid cache baseline`, async () => {
    const harness = new ModelInfoHarness([]);
    await harness.emit("session_start");
    await harness.selectModel({
      provider: "anthropic",
      id: "fixture",
      name: "Fixture",
      contextWindow: 200_000,
      reasoning: false,
    });
    await harness.emit("before_agent_start", {
      systemPrompt: "system",
      systemPromptOptions: { cwd: "/repo", selectedTools: ["read"] },
    });
    await harness.emit("turn_end", {
      turnIndex: 0,
      message: assistant("warm", null, usage({ cacheRead: 4_096 })).message,
      toolResults: [],
    });
    await harness.emit("session_compact");
    await harness.emit("turn_end", {
      turnIndex: 1,
      message: {
        ...assistant("failed", null, usage()).message,
        stopReason,
      },
      toolResults: [],
    });
    assert.equal(harness.cacheObservations.length, 1);
    await harness.emit("turn_end", {
      turnIndex: 2,
      message: assistant("cold", null, usage({ input: 4_400 })).message,
      toolResults: [],
    });
    const observation = harness.cacheObservations.at(-1);
    assert.equal(observation?.kind, "miss-after-warm-prefix");
    assert.equal(observation?.previousCacheRead, 4_096);
    assert.deepEqual(observation?.correlations, ["compaction"]);
  });
}
