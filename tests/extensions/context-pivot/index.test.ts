import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import contextPivot, {
  buildPivotSummary,
  estimateContextTokens,
  MIN_CONTEXT_PIVOT_TOKENS,
} from "../../../extensions/context-pivot/index.ts";

test("context_pivot is visible only when the next run starts above its threshold", () => {
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
  for (const handler of handlers.get("session_start") ?? []) {
    handler({}, {} as ExtensionContext);
  }
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
