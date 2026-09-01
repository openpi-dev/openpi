import assert from "node:assert/strict";
import test from "node:test";
import {
  projectMessage,
  WEB_MAX_PARTS,
} from "../../web/protocol/types.ts";

test("message projection does not create phantom text for detail-only messages", () => {
  const projected = projectMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal" },
      { type: "toolCall", name: "bash", arguments: "{}" },
    ],
  });
  assert.equal(projected.content, "");
  assert.equal(projected.parts?.length, 2);
});

test("message projection keeps text parts separated without phantom blank lines", () => {
  const projected = projectMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal" },
      { type: "text", text: "visible" },
      { type: "toolCall", name: "bash", arguments: "{}" },
    ],
  });
  assert.equal(projected.content, "visible");
});

test("message projection caps structured parts", () => {
  const projected = projectMessage({
    role: "assistant",
    content: Array.from({ length: WEB_MAX_PARTS + 20 }, (_, index) => ({
      type: "text",
      text: String(index),
    })),
  });
  assert.equal(projected.parts?.length, WEB_MAX_PARTS);
});

test("message projection keeps tool call ids", () => {
  const projected = projectMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: "call-1", name: "subagent_spawn", arguments: {} },
    ],
  });
  const part = projected.parts?.[0];
  assert.equal(part?.type, "toolCall");
  assert.equal(part && "id" in part ? part.id : undefined, "call-1");
});

test("message projection keeps tool result correlation and details", () => {
  const projected = projectMessage({
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "subagent_wait",
    content: "done",
    isError: false,
    details: { results: [{ id: "sa-1", status: "done" }] },
  });
  assert.equal(projected.toolCallId, "call-1");
  assert.equal(projected.isError, false);
  assert.deepEqual(projected.details, {
    results: [{ id: "sa-1", status: "done" }],
  });
});

test("message projection drops oversized details", () => {
  const projected = projectMessage({
    role: "toolResult",
    toolCallId: "call-2",
    toolName: "workflow",
    content: "done",
    isError: false,
    details: { blob: "x".repeat(64 * 1024) },
  });
  assert.equal(projected.details, undefined);
});

test("message projection keeps custom delivery messages", () => {
  const projected = projectMessage({
    role: "custom",
    customType: "subagent-result",
    content: "Subagent sa-1 finished.",
    display: true,
    details: { id: "sa-1", status: "done" },
  });
  assert.equal(projected.customType, "subagent-result");
  assert.equal(projected.display, true);
  assert.deepEqual(projected.details, { id: "sa-1", status: "done" });
});
