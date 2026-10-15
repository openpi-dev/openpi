import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { WEB_COMMAND_INPUT } from "../../extensions/shared/web-command-feedback.ts";
import {
  isSessionPrompt,
  isSetupPromptEcho,
  setupDisplayMessage,
  setupPromptParent,
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

test("Web setup display does not replace the canonical full prompt or original metadata", () => {
  const manager = SessionManager.inMemory("/synthetic/setup-renderer");
  const id = manager.appendCustomMessageEntry(
    "openpi-setup-request",
    "Full original prompt\nCurrent configuration:\nInternal execution constraints",
    true,
    { command: "my-pi-setup", request: "  保持原话\n和换行  " },
  );
  const entry = manager.getEntry(id)!;
  const before = JSON.stringify(entry);
  const message = projectEntry(entry).message!;
  assert.equal(
    setupDisplayMessage(message).content,
    "/my-pi-setup   保持原话\n和换行  ",
  );
  assert.equal(
    message.content,
    "Full original prompt\nCurrent configuration:\nInternal execution constraints",
  );
  assert.equal(JSON.stringify(entry), before);
  assert.deepEqual(message.details, {
    command: "my-pi-setup",
    request: "  保持原话\n和换行  ",
  });
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

test("setup echo follows only bounded, exact system ancestry and preserves independent episodes", () => {
  const manager = SessionManager.inMemory("/synthetic/system-setup-echo");
  const commandId = manager.appendCustomEntry(WEB_COMMAND_INPUT, {
    text: "/openpi-setup set theme",
    commandId: "episode-1",
  });
  manager.appendMessage({
    role: "system",
    content: "Tools changed",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "system",
    content: "System prompt changed",
    timestamp: 2,
  });
  const setupId = manager.appendCustomMessageEntry(
    "openpi-setup-request",
    "Complete model request",
    true,
    { command: "openpi-setup", request: "set theme", requestId: 1 },
  );
  const branch = new Map(manager.getBranch().map((entry) => [entry.id, entry]));
  const setup = branch.get(setupId)!;
  const frozen = JSON.stringify(manager.getEntries());
  assert.equal(isSessionPrompt(setup, undefined, branch), false);
  assert.equal(JSON.stringify(manager.getEntries()), frozen);
  const projected = new Map(
    [...branch].map(([id, entry]) => [id, projectEntry(entry)]),
  );
  assert.equal(
    setupPromptParent(setup, (id) => projected.get(id))?.commandId,
    "episode-1",
  );
  const parentId = setup.parentId!;
  for (const role of ["assistant", "user", "custom", "toolResult"]) {
    const changed = new Map(projected);
    const parent = changed.get(parentId)!;
    changed.set(parentId, {
      ...parent,
      message: { role, content: "Intervening episode fact" },
    });
    assert.equal(
      isSetupPromptEcho(
        projectEntry(setup).message!,
        setupPromptParent(setup, (id) => changed.get(id)),
      ),
      false,
    );
  }
  const missing = new Map(projected);
  missing.delete(parentId);
  assert.equal(
    setupPromptParent(setup, (id) => missing.get(id)),
    undefined,
  );
  const incompleteBranch = new Map(branch);
  incompleteBranch.delete(parentId);
  assert.equal(
    isSessionPrompt(setup, branch.get(parentId), incompleteBranch),
    true,
  );
  const cyclic = new Map(projected);
  cyclic.set(parentId, { ...cyclic.get(parentId)!, parentId });
  assert.equal(
    setupPromptParent(setup, (id) => cyclic.get(id)),
    undefined,
  );
  assert.equal(
    setupPromptParent(setup, () => ({
      ...projected.get(parentId)!,
      id: "wrong-native-id",
    })),
    undefined,
  );
  const command = projectEntry(branch.get(commandId)!).message!;
  for (const commandId of ["", "bad\ncommand", "x".repeat(129)])
    assert.equal(
      isSetupPromptEcho(projectEntry(setup).message!, {
        ...command,
        commandId,
      }),
      false,
    );
  const bounded = new Map(projected);
  for (let index = 0; index < 33; index++)
    bounded.set(`system-${index}`, {
      id: `system-${index}`,
      parentId: index === 32 ? commandId : `system-${index + 1}`,
      type: "message",
      timestamp: "",
      message: { role: "system", content: "Runtime context" },
    });
  assert.equal(
    setupPromptParent({ parentId: "system-0" }, (id) => bounded.get(id)),
    undefined,
  );
  manager.appendCustomEntry(WEB_COMMAND_INPUT, {
    text: "/openpi-setup set theme",
    commandId: "episode-2",
  });
  manager.appendMessage({
    role: "system",
    content: "Another tool state",
    timestamp: 3,
  });
  const second = manager.appendCustomMessageEntry(
    "openpi-setup-request",
    "Second full request",
    true,
    { command: "openpi-setup", request: "set theme", requestId: 2 },
  );
  const all = new Map(manager.getBranch().map((entry) => [entry.id, entry]));
  assert.equal(
    [...all.values()].filter((entry) => isSessionPrompt(entry, undefined, all))
      .length,
    2,
  );
  assert.equal(isSessionPrompt(all.get(second)!, undefined, all), false);
});
