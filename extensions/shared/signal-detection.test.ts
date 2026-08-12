import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReminderText,
  detectSignals,
  extractCommand,
  injectReminder,
  lastUserMessageHasAuthorization,
} from "./signal-detection.ts";

test("detectSignals recognizes commit and verify commands", () => {
  assert.deepEqual(detectSignals("git commit -m 'fix: x'"), ["commit"]);
  assert.deepEqual(detectSignals("npx tsc --noEmit"), ["verify"]);
  assert.deepEqual(detectSignals("git commit && npx tsc"), [
    "commit",
    "verify",
  ]);
  assert.deepEqual(detectSignals("ls -la"), []);
  // A plain test run is verify, not commit.
  assert.deepEqual(detectSignals("npm run verify"), ["verify"]);
});

test("extractCommand reads the bash command from common event shapes", () => {
  assert.equal(
    extractCommand({ input: { command: "git commit" } }),
    "git commit",
  );
  assert.equal(extractCommand({ params: { command: "npm test" } }), "npm test");
  assert.equal(extractCommand({ input: "ls" }), "ls");
  assert.equal(extractCommand({ params: "pwd" }), "pwd");
  assert.equal(extractCommand({ input: {} }), null);
  assert.equal(extractCommand({}), null);
});

test("authorization detection scans the last user message only", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: [{ type: "text", text: "请继续" }] },
  ];
  assert.equal(lastUserMessageHasAuthorization(messages), false);
  assert.equal(
    lastUserMessageHasAuthorization([
      ...messages,
      { role: "user", content: "裁定：T11 继续推进" },
    ]),
    true,
  );
  assert.equal(
    lastUserMessageHasAuthorization([
      ...messages,
      { role: "user", content: [{ type: "text", text: "approved" }] },
    ]),
    true,
  );
  // A user message without text is not an authorization.
  assert.equal(
    lastUserMessageHasAuthorization([
      { role: "user", content: [{ type: "image", data: "x" }] },
    ]),
    false,
  );
});

test("injectReminder appends to the last user message and clones input", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: "reply" },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ];
  const injected = injectReminder(messages, "⚠️ 提醒", "multi-signal-sync");
  assert.ok(injected);
  assert.match(JSON.stringify(injected), /<multi-signal-sync>/);
  assert.match(JSON.stringify(injected), /⚠️ 提醒/);
  // Original untouched.
  assert.equal(JSON.stringify(messages).includes("multi-signal-sync"), false);
  // String-content user message becomes a block array.
  const single = injectReminder([{ role: "user", content: "only" }], "x", "t");
  assert.ok(
    Array.isArray((single?.[0] as { content?: unknown } | undefined)?.content),
  );
});

test("buildReminderText carries signal labels and context", () => {
  assert.match(buildReminderText(["commit", "verify"]), /commit \+ 验证通过/);
  assert.match(buildReminderText(["commit"], "commit-task-sync"), /git commit/);
});
