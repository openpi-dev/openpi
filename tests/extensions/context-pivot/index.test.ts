import assert from "node:assert/strict";
import { toolExecutionContext } from "../../support/extension-tool-context.ts";
import test from "node:test";
import type {
  CompactOptions,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import contextPivot, {
  buildPivotSummary,
  estimateContextTokens,
  MIN_CONTEXT_PIVOT_TOKENS,
} from "../../../extensions/context-pivot/index.ts";

test("context_pivot visibility follows session and run context usage", () => {
  let active = ["read", "third_party_tool"];
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: ExtensionContext) => void>
  >();
  const pi = {
    registerTool(tool: { name: string }) {
      active = [...active.filter((name) => name !== tool.name), tool.name];
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => void,
    ) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  contextPivot(pi);
  const emitSessionStart = (tokens: number | null) => {
    const ctx = {
      getContextUsage: () => ({
        tokens,
        contextWindow: 200_000,
        percent: tokens === null ? null : (tokens / 200_000) * 100,
      }),
    } as unknown as ExtensionContext;
    for (const handler of handlers.get("session_start") ?? []) {
      handler({}, ctx);
    }
  };

  emitSessionStart(null);
  assert.deepEqual(active, ["read", "third_party_tool"]);

  const emitAgentStart = (tokens: number | null) => {
    const ctx = {
      getContextUsage: () => ({
        tokens,
        contextWindow: 200_000,
        percent: tokens === null ? null : (tokens / 200_000) * 100,
      }),
    } as unknown as ExtensionContext;
    for (const handler of handlers.get("agent_start") ?? []) {
      handler({}, ctx);
    }
  };

  emitAgentStart(29_999);
  assert.deepEqual(active, ["read", "third_party_tool"]);
  emitSessionStart(30_000);
  assert.deepEqual(active, ["read", "third_party_tool", "context_pivot"]);
  emitAgentStart(30_000);
  assert.deepEqual(active, ["read", "third_party_tool", "context_pivot"]);
  emitAgentStart(2_000);
  assert.deepEqual(active, ["read", "third_party_tool"]);
});

test("estimates context from exact tokens or percentage", () => {
  assert.equal(estimateContextTokens({ tokens: 42_000 }), 42_000);
  assert.equal(
    estimateContextTokens({ percent: 25, contextWindow: 200_000 }),
    50_000,
  );
  assert.equal(estimateContextTokens({ percent: 25 }), null);
  assert.equal(estimateContextTokens({ tokens: -1 }), null);
});

test("builds a clean pivot summary without notebook or handoff coupling", () => {
  const summary = buildPivotSummary("Implement the API and run tests.");
  assert.match(summary, /Context Pivot/);
  assert.match(summary, /Implement the API and run tests/);
  assert.doesNotMatch(summary, /notebook/i);
  assert.doesNotMatch(summary, /handoff/i);
  assert.equal(MIN_CONTEXT_PIVOT_TOKENS, 30_000);
});

test("translates native no-history failures and clears the pivot state", async () => {
  let tool: ToolDefinition | undefined;
  let compactOptions: CompactOptions | undefined;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<string | undefined> = [];
  const sentMessages: string[] = [];
  const pi = {
    registerTool(candidate: ToolDefinition) {
      tool = candidate;
    },
    getActiveTools: () => [],
    setActiveTools() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand() {},
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  contextPivot(pi);
  assert.ok(tool);

  const ctx = {
    hasUI: true,
    getContextUsage: () => ({
      tokens: MIN_CONTEXT_PIVOT_TOKENS,
      contextWindow: 200_000,
      percent: 15,
    }),
    compact(options: CompactOptions) {
      compactOptions = options;
    },
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      setStatus(_key: string, value: string | undefined) {
        statuses.push(value);
      },
      theme: { fg: (_color: string, text: string) => text },
    },
  } as unknown as ExtensionContext;

  await tool.execute(
    "context-pivot-test",
    { brief: "Continue with the next phase." },
    undefined,
    undefined,
    toolExecutionContext(ctx),
  );
  assert.ok(compactOptions?.onError);
  compactOptions.onError(new Error("Nothing to compact (session too small)"));

  assert.equal(
    notifications.at(-1)?.message,
    "Context pivot could not run: this session has no discardable history to compact. Continue in the current session, or use /sessions to choose another session; to begin cleanly, start a new Session in Pi.",
  );
  assert.equal(notifications.at(-1)?.level, "error");
  assert.equal(statuses.at(-1), undefined);
  assert.deepEqual(sentMessages, []);
  assert.equal(handlers.get("session_before_compact")?.({}), undefined);

  await tool.execute(
    "context-pivot-test-2",
    { brief: "Continue with the next phase." },
    undefined,
    undefined,
    toolExecutionContext(ctx),
  );
  assert.ok(compactOptions?.onError);
  compactOptions.onError(new Error("provider unavailable"));
  assert.equal(
    notifications.at(-1)?.message,
    "Context pivot failed: provider unavailable",
  );
});

test("reports native no-history failures without a UI", async () => {
  let tool: ToolDefinition | undefined;
  let compactOptions: CompactOptions | undefined;
  const pi = {
    registerTool(candidate: ToolDefinition) {
      tool = candidate;
    },
    getActiveTools: () => [],
    setActiveTools() {},
    on() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;

  contextPivot(pi);
  assert.ok(tool);

  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: unknown) => errors.push(String(message));
  try {
    const ctx = {
      hasUI: false,
      getContextUsage: () => ({
        tokens: MIN_CONTEXT_PIVOT_TOKENS,
        contextWindow: 200_000,
        percent: 15,
      }),
      compact(options: CompactOptions) {
        compactOptions = options;
      },
    } as unknown as ExtensionContext;

    await tool.execute(
      "context-pivot-headless-test",
      { brief: "Continue with the next phase." },
      undefined,
      undefined,
      toolExecutionContext(ctx),
    );
    assert.ok(compactOptions?.onError);
    compactOptions.onError(new Error("Nothing to compact (session too small)"));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(errors, [
    "Context pivot could not run: this session has no discardable history to compact. Continue in the current session, or use /sessions to choose another session; to begin cleanly, start a new Session in Pi.",
  ]);
});

test("a new session can start a pivot while the previous session is pending", async () => {
  let tool: ToolDefinition | undefined;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    registerTool(candidate: ToolDefinition) {
      tool = candidate;
    },
    getActiveTools: () => [],
    setActiveTools() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    hasUI: false,
    getContextUsage: () => ({
      tokens: MIN_CONTEXT_PIVOT_TOKENS,
      contextWindow: 200_000,
      percent: 15,
    }),
    compact() {},
  } as unknown as ExtensionContext;

  contextPivot(pi);
  assert.ok(tool);
  await tool.execute(
    "first-session-pivot",
    { brief: "First session pivot." },
    undefined,
    undefined,
    toolExecutionContext(ctx),
  );

  handlers.get("session_start")?.({}, ctx);

  await assert.doesNotReject(
    tool.execute(
      "second-session-pivot",
      { brief: "Second session pivot." },
      undefined,
      undefined,
      toolExecutionContext(ctx),
    ),
  );
});

for (const hasUI of [true, false]) {
  test(`replacement isolates stale pivot callbacks from the ${hasUI ? "UI" : "headless"} Session`, async () => {
    let tool: ToolDefinition | undefined;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const callbacks: CompactOptions[] = [];
    const notifications: Array<{ message: string; level: string }> = [];
    const statuses: Array<string | undefined> = [];
    const sent: string[] = [];
    const errors: string[] = [];
    const pi = {
      registerTool(candidate: ToolDefinition) {
        tool = candidate;
      },
      getActiveTools: () => [],
      setActiveTools() {},
      on(event: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(event, handler);
      },
      registerCommand() {},
      sendUserMessage(message: string) {
        sent.push(message);
      },
    } as unknown as ExtensionAPI;
    const ctx = {
      hasUI,
      getContextUsage: () => ({ tokens: MIN_CONTEXT_PIVOT_TOKENS }),
      compact(options: CompactOptions) {
        callbacks.push(options);
      },
      ui: {
        notify(message: string, level: string) {
          notifications.push({ message, level });
        },
        setStatus(_key: string, value: string | undefined) {
          statuses.push(value);
        },
        theme: { fg: (_color: string, text: string) => text },
      },
    } as unknown as ExtensionContext;
    contextPivot(pi);
    assert.ok(tool);
    const pivotTool = tool;
    const execute = (brief: string) =>
      pivotTool.execute(
        brief,
        { brief },
        undefined,
        undefined,
        toolExecutionContext(ctx),
      );
    const originalError = console.error;
    console.error = (message: unknown) => errors.push(String(message));
    try {
      await execute("Old Session A");
      if (hasUI) assert.match(statuses.at(-1)!, /pivoting/);
      handlers.get("session_start")?.({}, ctx);
      if (hasUI) assert.equal(statuses.at(-1), undefined);
      await execute("New Session B");
      const currentStatusCount = statuses.length;
      const compactionResult = {
        summary: "Native compaction result",
        firstKeptEntryId: "entry",
        tokensBefore: MIN_CONTEXT_PIVOT_TOKENS,
      };
      callbacks[0]?.onComplete?.(compactionResult);
      callbacks[0]?.onError?.(new Error("stale old provider failure"));
      assert.deepEqual(sent, []);
      assert.equal(notifications.length, 0);
      assert.deepEqual(errors, []);
      assert.equal(statuses.length, currentStatusCount);
      await assert.rejects(execute("Concurrent pivot"), /already in progress/);
      const compacted = handlers.get("session_before_compact")?.({
        branchEntries: [],
        preparation: { tokensBefore: MIN_CONTEXT_PIVOT_TOKENS },
      }) as { compaction: { summary: string } };
      assert.equal(
        compacted.compaction.summary,
        buildPivotSummary("New Session B"),
      );
      callbacks[1]?.onComplete?.(compactionResult);
      assert.deepEqual(sent, ["Continue with the next phase now."]);
      if (hasUI) {
        assert.equal(statuses.at(-1), undefined);
        assert.equal(notifications.at(-1)?.level, "info");
      }
      await execute("Current failure");
      callbacks[2]?.onError?.(new Error("current provider failure"));
      if (hasUI) {
        assert.equal(statuses.at(-1), undefined);
        assert.deepEqual(notifications.at(-1), {
          message: "Context pivot failed: current provider failure",
          level: "error",
        });
      } else {
        assert.deepEqual(errors, [
          "Context pivot failed: current provider failure",
        ]);
      }
      await assert.doesNotReject(execute("Retry after current failure"));
    } finally {
      console.error = originalError;
    }
  });
}
