import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import {
  type ContextWithSystemEvent,
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createContextObservation } from "../../web/runtime/context-observation.ts";

test("observer replays Pi system/tool deltas and invalidates numerical snapshots across native lifecycle events", async () => {
  const handlers = new Map<
    string,
    (event: unknown, ctx: ExtensionContext) => unknown
  >();
  const pi = {
    on(
      event: string,
      handler: (event: unknown, ctx: ExtensionContext) => unknown,
    ) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  } as unknown as ExtensionAPI;
  const observer = createContextObservation();
  await observer.extension.factory(pi);
  const manager = SessionManager.inMemory();
  const ctx = {
    sessionManager: manager,
    model: undefined,
  } as unknown as ExtensionContext;
  const event: ContextWithSystemEvent = {
    type: "context_with_system",
    messages: [
      {
        role: "system",
        content: "base",
        sections: { note: "old" },
        toolsAdded: [
          { name: "old_tool", description: "old", parameters: Type.Object({}) },
        ],
        timestamp: 0,
      },
      {
        role: "user",
        content: [
          { type: "text", text: "你好" },
          { type: "image", data: "not-retained", mimeType: "image/png" },
        ],
        timestamp: 0,
      },
      {
        role: "system",
        content: "",
        sections: { note: "new" },
        toolsRemoved: [{ name: "old_tool" }],
        toolsAdded: [
          { name: "new_tool", description: "new", parameters: Type.Object({}) },
        ],
        timestamp: 0,
      },
    ],
  };
  const before = structuredClone(event.messages);
  const observe = handlers.get("context_with_system");
  assert.ok(observe, "supported Pi hosts must register the observer");
  for (const lifecycle of [
    "session_start",
    "session_compact",
    "session_tree",
    "model_select",
    "session_shutdown",
  ]) {
    await observe(event, ctx);
    assert.deepEqual(
      event.messages,
      before,
      "observation leaves Pi input unchanged",
    );
    const snapshot = observer.read(ctx)!;
    assert.equal(snapshot.systemBytes, Buffer.byteLength("base\n\nnew"));
    assert.equal(snapshot.toolCount, 1);
    assert.equal(snapshot.conversationBytes, 6);
    assert.equal(snapshot.omittedBlocks, 1);
    assert.equal(JSON.stringify(snapshot).includes("not-retained"), false);
    const hook = handlers.get(lifecycle);
    assert.ok(hook);
    await hook({ type: lifecycle }, ctx);
    assert.equal(observer.read(ctx), undefined, lifecycle);
  }
});
