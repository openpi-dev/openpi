import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  WEB_COMMAND_INPUT,
  WEB_COMMAND_FEEDBACK,
  registerWebCommandFeedback,
  publishWebCommandFeedback,
} from "../../extensions/shared/web-command-feedback.ts";
import { projectEntry, WEB_MAX_TEXT } from "../../web/protocol/types.ts";

test("command operator records preserve order and truncation without adding model messages", () => {
  const session = SessionManager.inMemory("/tmp");
  session.appendCustomEntry(WEB_COMMAND_INPUT, {
    text: "/plan " + "x".repeat(WEB_MAX_TEXT),
    commandId: "command",
  });
  session.appendCustomEntry(WEB_COMMAND_FEEDBACK, {
    text: "Writes remain blocked",
    truncated: true,
  });
  session.appendCustomEntry("private-extension-state", { text: "secret" });
  const entries = session.getBranch().map((entry) => projectEntry(entry));
  const messages = entries.flatMap((entry) =>
    entry.message ? [entry.message] : [],
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "user");
  assert.equal(messages[0]!.commandId, "command");
  assert.equal(messages[0]!.content.length, WEB_MAX_TEXT);
  assert.equal(messages[1]!.truncation?.truncated, true);
  assert.equal(JSON.stringify(entries).includes("secret"), false);
  assert.deepEqual(session.buildSessionContext().messages, []);
});

test("command feedback belongs only to its active Session and unregistering removes the transport", () => {
  const scope = {};
  const received: string[] = [];
  const unregister = registerWebCommandFeedback(scope, (text) =>
    received.push(text),
  );
  try {
    assert.equal(publishWebCommandFeedback({}, "foreign"), false);
    assert.equal(publishWebCommandFeedback(scope, "owned"), true);
    assert.throws(() => registerWebCommandFeedback(scope, () => {}));
    assert.deepEqual(received, ["owned"]);
  } finally {
    unregister();
  }
  assert.equal(publishWebCommandFeedback(scope, "late"), false);
});
