import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WEB_COMMAND_INPUT } from "../../extensions/shared/web-command-feedback.ts";
import {
  isSessionPrompt,
  isSetupPromptEcho,
  setupDisplayMessage,
} from "../../web/protocol/prompt-navigation.ts";
import { projectEntry } from "../../web/protocol/types.ts";

test("setup prompt display preserves the existing aliases and rejects malformed or truncated details", () => {
  const request = {
    role: "custom",
    content: "Model-facing request",
    customType: "openpi-setup-request",
    details: { command: "my-pi-setup", request: "set theme" },
  };
  assert.deepEqual(setupDisplayMessage(request), {
    ...request,
    role: "user",
    content: "/my-pi-setup set theme",
    parts: undefined,
  });
  assert.equal(
    setupDisplayMessage({
      ...request,
      details: { command: "unknown", request: "set theme" },
    }).role,
    "custom",
  );
  assert.equal(
    setupDisplayMessage({
      ...request,
      truncation: { truncated: true, details: true },
    }).content,
    request.content,
  );
  assert.equal(
    isSetupPromptEcho(request, {
      role: "user",
      customType: WEB_COMMAND_INPUT,
      content: "/my-pi-setup set theme",
      commandId: "episode",
    }),
    true,
  );
  assert.equal(
    isSetupPromptEcho(request, {
      role: "user",
      customType: WEB_COMMAND_INPUT,
      content: "/my-pi-setup set theme",
    }),
    false,
  );
});

test("same-text setup episodes collapse only when the supplied native parent is exact", () => {
  const manager = SessionManager.inMemory("/synthetic/prompt-navigation");
  const commandId = manager.appendCustomEntry(WEB_COMMAND_INPUT, {
    text: "/openpi-setup set theme",
    commandId: "episode",
  });
  const setupId = manager.appendCustomMessageEntry(
    "openpi-setup-request",
    "Model request",
    true,
    { command: "openpi-setup", request: "set theme" },
  );
  const command = manager.getEntry(commandId)!;
  const setup = manager.getEntry(setupId)!;
  assert.equal(isSessionPrompt(command), true);
  assert.equal(isSessionPrompt(setup, command), false);
  assert.equal(
    isSessionPrompt(setup, { ...command, id: "different-native-id" }),
    true,
  );
  assert.equal(isSessionPrompt(setup), true);
  assert.equal(projectEntry(command).message?.role, "user");
  const unknown = manager.appendCustomEntry(WEB_COMMAND_INPUT, { text: 12 });
  assert.equal(isSessionPrompt(manager.getEntry(unknown)!), false);
  const invalid = manager.appendCustomMessageEntry(
    "openpi-setup-request",
    "Custom only",
    true,
    { command: "unknown", request: "literal" },
  );
  assert.equal(isSessionPrompt(manager.getEntry(invalid)!), false);
  const truncated = manager.appendCustomMessageEntry(
    "openpi-setup-request",
    "Truncated custom",
    true,
    { command: "openpi-setup", request: "x".repeat(100000) },
  );
  assert.equal(
    projectEntry(manager.getEntry(truncated)!).message?.truncation?.details,
    true,
  );
  assert.equal(isSessionPrompt(manager.getEntry(truncated)!), false);
});
