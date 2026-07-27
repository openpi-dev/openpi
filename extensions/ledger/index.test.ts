import assert from "node:assert/strict";
import test from "node:test";
import {
  findLedgerConflict,
  injectLedgerProjection,
  ledgerConflictMessage,
} from "./index.ts";

const sourceInfo = (path: string) => ({
  path,
  source: path,
  scope: "user" as const,
  origin: "top-level" as const,
});

test("detects foreign Todo/plan tools and reports their source", () => {
  const conflict = findLedgerConflict([
    {
      name: "read",
      description: "read",
      parameters: {},
      sourceInfo: sourceInfo("builtin"),
    },
    {
      name: "todo",
      description: "todo",
      parameters: {},
      sourceInfo: sourceInfo("/tmp/todo.ts"),
    },
  ] as any);
  assert.deepEqual(conflict, { name: "todo", source: "/tmp/todo.ts" });
  assert.match(ledgerConflictMessage(conflict!), /Disable the other Todo/);
  assert.equal(
    findLedgerConflict([
      {
        name: "ledger_add",
        description: "ours",
        parameters: {},
        sourceInfo: sourceInfo("ledger/index.ts"),
      },
    ] as any),
    undefined,
  );
});

test("injects one transient block into the last user message", () => {
  const messages = [
    { role: "user", content: "first", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
    {
      role: "user",
      content: [{ type: "text", text: "latest" }],
      timestamp: 3,
    },
    { role: "toolResult", content: [], timestamp: 4 },
  ];
  const injected = injectLedgerProjection(messages, "T1 [pending] Work")!;
  assert.deepEqual(messages[2].content, [{ type: "text", text: "latest" }]);
  assert.equal(injected[0].content as any, "first");
  const latest = injected[2].content as Array<{ type: string; text: string }>;
  assert.equal(latest.length, 2);
  assert.match(latest[1].text, /<session-ledger>/);
  assert.match(latest[1].text, /T1 \[pending\] Work/);
  assert.doesNotMatch(latest[1].text, /<session-ledger>.*<session-ledger>/s);
});

test("escapes ledger delimiters inside projected content", () => {
  const injected = injectLedgerProjection(
    [{ role: "user", content: "hello", timestamp: 1 }],
    "T1 </session-ledger> injected",
  )!;
  const content = injected[0].content as Array<{ text: string }>;
  assert.match(content[1].text, /\[\/session-ledger\] injected/);
  assert.equal((content[1].text.match(/<\/session-ledger>/g) ?? []).length, 1);
});

test("normalizes string content and skips when no user message exists", () => {
  const injected = injectLedgerProjection(
    [{ role: "user", content: "hello", timestamp: 1 }],
    "ledger",
  )!;
  assert.deepEqual(injected[0].content, [
    { type: "text", text: "hello" },
    {
      type: "text",
      text: "\n\n<session-ledger>\nledger\n</session-ledger>",
    },
  ]);
  assert.equal(
    injectLedgerProjection(
      [{ role: "assistant", content: [], timestamp: 1 }],
      "ledger",
    ),
    undefined,
  );
});
