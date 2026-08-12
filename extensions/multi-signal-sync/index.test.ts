import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import multiSignalSync from "./index.ts";

/**
 * Wiring-layer test: the event → pure-function mapping chain. The detection
 * logic itself is covered in ../shared/signal-detection.test.ts; here we
 * verify that tool_result / context / agent_settled events actually reach it.
 */

function harness() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  let attachment: string | undefined;
  const pi = {
    on: (event: string, handler: (event: any, ctx: any) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as unknown as ExtensionAPI;
  multiSignalSync(pi);
  const ctx = { mode: "tui", hasUI: true };
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
    readAttachment: () => attachment,
    setAttachment: (value: string | undefined) => {
      attachment = value;
    },
  };
}

// The extension imports setTaskWidgetAttachment from shared; stub it via the
// module's real behavior by reading through the widget channel is complex, so
// we instead verify the wiring contract: signals accumulate and the context
// hook injects the reminder.
test("tool_result bash commit → context injection carries the reminder", async () => {
  const h = harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    isError: false,
    input: { command: "git commit -m x" },
  });
  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "continue" }],
  });
  assert.ok(result);
  const text = JSON.stringify(result.messages);
  assert.match(text, /<multi-signal-sync>/);
  assert.match(text, /完成信号（commit）/);
});

test("failed or non-bash tool results produce no signal", async () => {
  const h = harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    isError: true,
    input: { command: "git commit -m x" },
  });
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "read",
    isError: false,
    input: { path: "git commit in a path" },
  });
  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "continue" }],
  });
  assert.equal(result, undefined);
});

test("authorization phrase in the last user message triggers the signal", async () => {
  const h = harness();
  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "裁定：继续推进 T11" }],
  });
  assert.ok(result);
  assert.match(JSON.stringify(result.messages), /业主授权/);
});

test("signals reset on session_start", async () => {
  const h = harness();
  await h.emit("tool_result", {
    type: "tool_result",
    toolName: "bash",
    isError: false,
    input: { command: "git commit -m x" },
  });
  await h.emit("session_start", { type: "session_start" });
  const result = await h.emit("context", {
    type: "context",
    messages: [{ role: "user", content: "continue" }],
  });
  assert.equal(result, undefined);
});
