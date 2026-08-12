import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import commitTaskSync from "./index.ts";

function harness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const notifications: string[] = [];
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as unknown as ExtensionAPI;
  commitTaskSync(pi);
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: { notify: (m: string) => notifications.push(m) },
  };
  return {
    emit: async (event: string, payload: unknown = { type: event }) => {
      for (const handler of handlers.get(event) ?? []) {
        const result = await handler(payload, ctx);
        if (result && typeof result === "object" && "messages" in result) {
          return result as { messages: unknown[] };
        }
      }
      return undefined;
    },
    notifications,
  };
}

test("bash git commit → agent_settled notify + context injection", async () => {
  const h = harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    isError: false,
    input: { command: "git commit -m 'fix: x'" },
  });
  await h.emit("agent_settled", { type: "agent_settled" });
  assert.ok(h.notifications.some((n) => n.includes("git commit 检测到")));

  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "go" }],
  });
  assert.ok(result);
  assert.match(JSON.stringify(result.messages), /<commit-task-sync>/);
});

test("commit injection is one-shot; verify-only commands do not trigger it", async () => {
  const h = harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    isError: false,
    input: { command: "npx tsc --noEmit" },
  });
  const first = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "go" }],
  });
  assert.equal(first, undefined);

  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    isError: false,
    input: { command: "git commit -m x" },
  });
  const injected = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "go" }],
  });
  assert.ok(injected);
  // Second context event without a new commit does not re-inject.
  const again = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "go" }],
  });
  assert.equal(again, undefined);
});
