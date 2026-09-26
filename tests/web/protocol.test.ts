import assert from "node:assert/strict";
import test from "node:test";
import {
  projectEntries,
  projectEntry,
  projectMessage,
  WEB_MAX_MESSAGE_PARTS,
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
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

test("assistant failure projection retains terminal evidence without inventing body text", () => {
  const projected = projectMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: "gateway_concurrency_limit (429)",
    content: [],
  });
  assert.equal(projected.content, "");
  assert.equal(projected.stopReason, "error");
  assert.equal(projected.errorMessage, "gateway_concurrency_limit (429)");
  assert.equal(
    projectMessage({
      role: "assistant",
      stopReason: "aborted",
      content: [{ type: "text", text: "partial" }],
    }).content,
    "partial",
  );
  assert.equal(
    projectMessage({ role: "assistant", stopReason: "aborted", content: [] })
      .stopReason,
    "aborted",
  );
});

test("assistant errors are bounded and redact credentials before they reach the wire", () => {
  const projected = projectMessage({
    role: "assistant",
    stopReason: "error",
    errorMessage: `Request https://name:password@example.test/path?api_key=secret failed; Authorization: Bearer example-long-secret-1234567890; token=short-secret; ${"unexpected failure ".repeat(200)}\u0000`,
    content: [{ type: "text", text: "partial answer" }],
  });
  assert.equal(projected.content, "partial answer");
  assert.equal(projected.stopReason, "error");
  assert.ok(projected.errorMessage?.includes("Request"));
  assert.ok(projected.errorMessage?.includes("[redacted]"));
  assert.ok(!projected.errorMessage?.includes("password"));
  assert.ok(!projected.errorMessage?.includes("short-secret"));
  assert.ok(!projected.errorMessage?.includes("example-long-secret"));
  assert.ok(!projected.errorMessage?.includes("\u0000"));
  assert.ok((projected.errorMessage?.length ?? 0) < 600);
  assert.equal(projected.truncation?.text, true);
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

test("message projection accounts for JSON escaping in the details budget", () => {
  const projected = projectMessage({
    role: "toolResult",
    content: "done",
    details: { blob: '"'.repeat(20 * 1024) },
  });
  assert.equal(projected.details, undefined);
  assert.equal(projected.truncation?.details, true);
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

test("entry projection preserves custom messages as transcript messages", () => {
  const projected = projectEntry({
    type: "custom_message",
    id: "setup-request",
    parentId: null,
    timestamp: "2026-09-19T10:00:00.000Z",
    customType: "openpi-setup-request",
    content: "Apply a dark theme",
    display: false,
    details: { source: "settings" },
  });
  assert.equal(projected.type, "message");
  assert.equal(projected.message?.role, "custom");
  assert.equal(projected.message?.customType, "openpi-setup-request");
  assert.equal(projected.message?.content, "Apply a dark theme");
  assert.equal(projected.message?.display, false);
  assert.deepEqual(projected.message?.details, { source: "settings" });
});

test("message projection bounds parts and reports exact omissions", () => {
  const projected = projectMessage({
    role: "assistant",
    content: Array.from({ length: WEB_MAX_MESSAGE_PARTS + 7 }, (_, index) => ({
      type: "text",
      text: `part-${index}`,
    })),
  });

  assert.equal(projected.parts?.length, WEB_MAX_MESSAGE_PARTS);
  assert.equal(projected.truncation?.partsOmitted, 7);
  assert.equal(projected.truncation?.truncated, true);
});

test("projection does not inspect parts or getters beyond its work budget", () => {
  const content = Array.from({ length: WEB_MAX_MESSAGE_PARTS }, () => ({
    type: "text",
    text: "safe",
  }));
  Object.defineProperty(content, WEB_MAX_MESSAGE_PARTS, {
    enumerable: true,
    get: () => {
      throw new Error("unbounded part inspected");
    },
  });
  const details = {};
  Object.defineProperty(details, "secret", {
    enumerable: true,
    get: () => {
      throw new Error("details getter invoked");
    },
  });

  const projected = projectMessage({ role: "assistant", content, details });
  assert.equal(projected.parts?.length, WEB_MAX_MESSAGE_PARTS);
  assert.equal(projected.truncation?.partsOmitted, 1);
  assert.equal(projected.truncation?.details, true);
});

test("entry projection retains the newest bounded transcript with evidence", () => {
  const entries = Array.from({ length: 300 }, (_, index) => ({
    type: "message" as const,
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(index).toISOString(),
    message: {
      role: "user" as const,
      content: "x".repeat(20_000),
      timestamp: index,
    },
  }));
  const projected = projectEntries(entries);

  assert.ok(projected.bytes <= WEB_MAX_SELECTED_TRANSCRIPT_BYTES);
  assert.equal(projected.entries.at(-1)?.id, "entry-299");
  assert.ok(projected.truncation.entriesOmitted > 0);
  assert.equal(projected.truncation.truncated, true);
});

test("entry projection rolls retained message truncation into aggregate evidence", () => {
  const entries = [
    {
      type: "message" as const,
      id: "entry-1",
      parentId: null,
      timestamp: new Date(0).toISOString(),
      message: {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "tool",
        content: [{ type: "text" as const, text: "done" }],
        details: { private: "x".repeat(64 * 1024) },
        isError: false,
        timestamp: 0,
      },
    },
  ];

  const projected = projectEntries(entries);
  assert.equal(projected.truncation.entriesOmitted, 0);
  assert.equal(projected.truncation.messagesTruncated, 1);
  assert.equal(projected.truncation.truncated, true);
});
