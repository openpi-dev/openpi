import assert from "node:assert/strict";
import test from "node:test";
import {
  projectEntries,
  projectEntry,
  projectMessage,
  WEB_MAX_MESSAGE_PARTS,
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
} from "../../web/protocol/types.ts";
import { WEB_TURN_CHANGES_ENTRY } from "../../web/protocol/turn-changes.ts";
import { WEB_COMMAND_HANDLED } from "../../extensions/shared/web-command-feedback.ts";

test("image projection retains bounded native names for prompt reconciliation and omits image bytes", () => {
  const projected = projectMessage({
    role: "user",
    content: [
      {
        type: "image",
        mimeType: "image/png",
        name: "截屏 100%.png",
        data: "private-bytes",
        previewUrl: "private-preview",
      },
    ],
  });
  assert.deepEqual(projected.parts, [
    {
      type: "image",
      mimeType: "image/png",
      name: "截屏 100%.png",
      sourcePartIndex: 0,
    },
  ]);
  assert.equal(JSON.stringify(projected).includes("private-"), false);
  const oversized = projectMessage({
    role: "user",
    content: [{ type: "image", mimeType: "image/png", name: "x".repeat(400) }],
  });
  assert.equal(
    oversized.parts?.[0]?.type === "image" && oversized.parts[0].name?.length,
    255,
  );
});

test("image source indices refer to original native parts even when unsupported parts are skipped", () => {
  const projected = projectMessage({
    role: "user",
    content: [
      { type: "unknown", data: "omitted" },
      { type: "image", mimeType: "image/png", data: "first" },
      { type: "text", text: "caption" },
      null,
      { type: "image", mimeType: "image/jpeg", data: "second" },
    ],
  });
  assert.deepEqual(projected.parts, [
    { type: "image", mimeType: "image/png", sourcePartIndex: 1 },
    { type: "text", text: "caption" },
    { type: "image", mimeType: "image/jpeg", sourcePartIndex: 4 },
  ]);
  assert.equal(JSON.stringify(projected).includes("omitted"), false);
});

test("command handler-return projection retains exact identities without inventing an assistant result", () => {
  const entry = {
    id: "handled",
    parentId: "feedback",
    timestamp: "2026-10-01T00:00:00Z",
    type: "custom" as const,
    customType: WEB_COMMAND_HANDLED,
    data: { inputEntryId: "input", commandId: "command" },
  };
  const projected = projectEntry(entry);
  assert.deepEqual(projected.message, {
    role: "custom",
    customType: WEB_COMMAND_HANDLED,
    content: "",
    details: { inputEntryId: "input", commandId: "command" },
  });
  for (const data of [
    null,
    { commandId: "command" },
    { inputEntryId: "bad id", commandId: "command" },
    { inputEntryId: "input", commandId: "" },
  ]) {
    assert.equal(projectEntry({ ...entry, data }).message, undefined);
  }
});

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
  assert.equal(projected.truncation?.visibleText, undefined);
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

test("structured tool details preserve special own JSON keys without changing prototypes", () => {
  const details = JSON.parse(
    '{"__proto__":{"evidence":"retained"},"constructor":"literal","prototype":{"__proto__":{"nested":true}}}',
  );
  const projected = projectMessage({
    role: "toolResult",
    content: "done",
    details,
  });
  assert.equal(JSON.stringify(projected.details), JSON.stringify(details));
  assert.ok(projected.details && typeof projected.details === "object");
  assert.equal(Object.getPrototypeOf(projected.details), Object.prototype);
  assert.equal(Object.hasOwn(projected.details, "__proto__"), true);
  assert.equal(Object.hasOwn(Object.prototype, "evidence"), false);
  assert.equal(Object.hasOwn(Object.prototype, "nested"), false);
  assert.equal(projected.truncation?.details, undefined);
});

test("structured detail node exhaustion reports omitted array elements", () => {
  const projected = projectMessage({
    role: "toolResult",
    content: "done",
    details: Array.from({ length: 4 }, () => Array(128).fill(1)),
  });
  assert.equal(projected.details, undefined);
  assert.equal(projected.truncation?.details, true);
});

test("structured detail node exhaustion reports omitted object properties", () => {
  const projected = projectMessage({
    role: "toolResult",
    content: "done",
    details: {
      first: Array.from({ length: 3 }, () => Array(128).fill(1)),
      last: Array(122).fill(1),
      omitted: true,
    },
  });
  assert.equal(projected.details, undefined);
  assert.equal(projected.truncation?.details, true);
});

test("structured details exactly at the node boundary remain complete", () => {
  const details = [
    Array(128).fill(1),
    Array(128).fill(1),
    Array(128).fill(1),
    Array(123).fill(1),
  ];
  const projected = projectMessage({
    role: "toolResult",
    content: "done",
    details,
  });
  assert.deepEqual(projected.details, details);
  assert.equal(projected.truncation?.details, undefined);
});

test("native subagent display receipts survive projection while model follow-ups stay hidden", () => {
  const details = {
    results: [
      { id: "sa-1", status: "done" },
      { id: "sa-2", status: "done" },
    ],
  };
  const display = projectEntry({
    type: "custom",
    id: "receipt",
    parentId: "answer",
    timestamp: "2026-09-30T00:00:00Z",
    customType: "subagent-result",
    data: { content: "First result\n\nSecond result", details },
  });
  assert.equal(display.type, "message");
  assert.equal(display.id, "receipt");
  assert.equal(display.message?.display, true);
  assert.equal(display.message?.content, "First result\n\nSecond result");
  assert.deepEqual(display.message?.details, details);
  const transport = projectEntry({
    type: "custom_message",
    id: "transport",
    parentId: "receipt",
    timestamp: "2026-09-30T00:00:00Z",
    customType: "subagent-result",
    content: "Private model transport instruction",
    details,
    display: false,
  });
  assert.equal(transport.message?.display, false);
});

test("native subagent display receipts use bounded content and do not invoke getters", () => {
  const entry = {
    type: "custom" as const,
    id: "receipt",
    parentId: "answer",
    timestamp: "2026-09-30T00:00:00Z",
    customType: "subagent-result",
    data: { content: "x".repeat(20_000) },
  };
  const projected = projectEntry(entry);
  assert.ok((projected.message?.content.length ?? 0) < 12_100);
  assert.equal(projected.message?.truncation?.text, true);
  const data = Object.defineProperty({}, "content", {
    get() {
      throw new Error("not display evidence");
    },
  });
  assert.equal(projectEntry({ ...entry, data }).message, undefined);
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
  assert.equal(projected.truncation?.visibleText, true);
});

test("visible text recovery is limited to clipped user and assistant bodies", () => {
  const longText = "x".repeat(13_000);
  assert.equal(
    projectMessage({ role: "user", content: longText }).truncation?.visibleText,
    true,
  );
  assert.equal(
    projectMessage({
      role: "assistant",
      content: [{ type: "text", text: longText }],
    }).truncation?.visibleText,
    true,
  );
  assert.equal(
    projectMessage({ role: "toolResult", content: longText }).truncation
      ?.visibleText,
    undefined,
  );
  const thinking = projectMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: longText }],
  });
  assert.equal(thinking.truncation?.text, true);
  assert.equal(thinking.truncation?.visibleText, undefined);
  const argumentsOnly = projectMessage({
    role: "assistant",
    content: [
      { type: "toolCall", name: "bash", arguments: { command: longText } },
    ],
  });
  assert.equal(argumentsOnly.truncation?.visibleText, undefined);
  const omittedText = projectMessage({
    role: "assistant",
    content: [
      ...Array.from({ length: WEB_MAX_MESSAGE_PARTS }, () => ({
        type: "thinking",
        thinking: "short",
      })),
      { type: "text", text: "later body" },
    ],
  });
  assert.equal(omittedText.truncation?.visibleText, true);
  const farOmittedText = projectMessage({
    role: "assistant",
    content: [
      ...Array.from({ length: WEB_MAX_MESSAGE_PARTS * 2 }, () => ({
        type: "thinking",
        thinking: "short",
      })),
      { type: "text", text: "later body" },
    ],
  });
  assert.equal(farOmittedText.truncation?.visibleText, true);
});

test("turn changes project bounded summary without persisted diff contents", () => {
  const projected = projectEntry({
    type: "custom",
    id: "changes",
    parentId: "answer",
    timestamp: "2026-09-23T01:00:00.000Z",
    customType: WEB_TURN_CHANGES_ENTRY,
    data: {
      version: 1,
      sessionId: "session",
      promptEntryId: "prompt",
      state: "complete",
      fileCount: 1,
      additions: 1,
      deletions: 1,
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          diff: "sensitive patch",
          diffTruncated: false,
          additions: 1,
          deletions: 1,
        },
      ],
    },
  });
  assert.equal(projected.turnChanges?.promptEntryId, "prompt");
  assert.deepEqual(projected.turnChanges?.files, [
    { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
  ]);
  assert.ok(!JSON.stringify(projected).includes("sensitive patch"));
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
