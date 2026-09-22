import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type {
  AgentSessionServices,
  ExtensionAPI,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
  WEB_MAX_COMMAND_BYTES,
  WEB_MAX_COMMANDS,
} from "../../web/protocol/types.ts";
import {
  assertWebCommandSupported,
  commandsForServices,
  createCommandDiscoveryBridge,
  projectWebCommands,
  registerCommandDiscoveryBridge,
} from "../../web/runtime/command-discovery.ts";

function command(
  name: string,
  source: SlashCommandInfo["source"],
  description?: string,
): SlashCommandInfo {
  return {
    name,
    source,
    ...(description ? { description } : {}),
    sourceInfo: {
      path: `/private/project/${name}.md`,
      source: "private-fixture",
      scope: "project",
      origin: "top-level",
    },
  };
}

test("projects Pi command identities without exposing source metadata", () => {
  const result = projectWebCommands([
    command("extension:run", "extension", "Run\u0000 an extension"),
    command("review", "prompt", "Review this change"),
    command("ship", "skill", "Ship this change"),
  ]);

  assert.deepEqual(result.commands, [
    {
      name: "extension:run",
      source: "extension",
      availability: "unsupported",
      unavailableReason: "not_integrated",
      description: "Run  an extension",
    },
    {
      name: "review",
      source: "prompt",
      availability: "available",
      description: "Review this change",
      argumentHint: "[arguments]",
    },
    {
      name: "ship",
      source: "skill",
      availability: "available",
      description: "Ship this change",
      argumentHint: "[arguments]",
    },
  ]);
  assert.equal(JSON.stringify(result).includes("/private/project"), false);
  assert.equal(JSON.stringify(result).includes("private-fixture"), false);
});

test("bounds command projections by count, bytes, and scan work", () => {
  const countBounded = projectWebCommands(
    Array.from({ length: WEB_MAX_COMMANDS + 25 }, (_, index) =>
      command(`command-${index}`, "skill", "short"),
    ),
  );
  assert.equal(countBounded.commands.length, WEB_MAX_COMMANDS);
  assert.equal(countBounded.truncation.commandsOmitted, 25);
  assert.equal(countBounded.truncation.truncated, true);

  const byteBounded = projectWebCommands(
    Array.from({ length: WEB_MAX_COMMANDS }, (_, index) =>
      command(`large-${index}`, "prompt", "x".repeat(500)),
    ),
  );
  assert.ok(byteBounded.commands.length < WEB_MAX_COMMANDS);
  assert.ok(byteBounded.truncation.bytes <= WEB_MAX_COMMAND_BYTES);
  assert.equal(byteBounded.truncation.truncated, true);

  const scanBounded = projectWebCommands(
    Array.from({ length: 1_025 }, (_, index) =>
      index < 1_024
        ? command(`invalid command ${index}`, "skill")
        : command("outside-scan-bound", "skill"),
    ),
  );
  assert.deepEqual(scanBounded.commands, []);
  assert.equal(scanBounded.truncation.commandsOmitted, 1_025);
});

function ownedCommand(name: string, extension: string) {
  const item = command(name, "extension");
  item.sourceInfo.path = fileURLToPath(
    new URL(`../../extensions/${extension}/index.ts`, import.meta.url),
  );
  return item;
}

test("offers native setup and existing Web panels only for the actual package command sources", () => {
  const result = projectWebCommands([
    ownedCommand("openpi-setup", "setup"),
    ownedCommand("my-pi-setup", "setup"),
    ownedCommand("ps", "background-terminals"),
    ownedCommand("lg", "git-info"),
    ownedCommand("subagents", "subagents"),
    ownedCommand("usage", "usage"),
    ownedCommand("btw", "subagents"),
    ownedCommand("sessions", "sessions"),
    command("openpi-setup", "extension"),
    command("ps", "extension"),
  ]);
  assert.deepEqual(
    result.commands.slice(0, 2).map(({ name, availability, action }) => ({
      name,
      availability,
      action,
    })),
    [
      { name: "openpi-setup", availability: "available", action: undefined },
      { name: "my-pi-setup", availability: "available", action: undefined },
    ],
  );
  assert.deepEqual(
    result.commands.slice(2, 6).map(({ action }) => action),
    ["terminal", "review", "subagents", "runtime"],
  );
  assert.equal(result.commands[6]?.action, "side-conversation");
  assert.equal(result.commands[7]?.unavailableReason, "terminal_only");
  assert.ok(
    result.commands
      .slice(8)
      .every(
        (item) =>
          item.availability === "unsupported" && item.action === undefined,
      ),
  );
  assert.equal(JSON.stringify(result).includes("extensions/"), false);
});

test("guards the native untruncated registry while leaving ordinary prompts and unknown slash text to Pi", async () => {
  const services = Object.create(null) as AgentSessionServices;
  const available = [
    ...Array.from({ length: WEB_MAX_COMMANDS + 1 }, (_, index) =>
      command(`template-${index}`, "prompt"),
    ),
    ownedCommand("openpi-setup", "setup"),
    ownedCommand("ps", "background-terminals"),
    ownedCommand("btw", "subagents"),
    command("unreviewed", "extension"),
  ];
  const bridge = createCommandDiscoveryBridge();
  const api = { getCommands: () => available } as ExtensionAPI;
  await (typeof bridge.extension === "function"
    ? bridge.extension(api)
    : bridge.extension.factory(api));
  registerCommandDiscoveryBridge(services, bridge);
  assert.equal(
    commandsForServices(services).commands.some((item) => item.name === "btw"),
    false,
  );
  assert.doesNotThrow(() =>
    assertWebCommandSupported(services, "ordinary text"),
  );
  assert.doesNotThrow(() =>
    assertWebCommandSupported(services, "/unknown/path"),
  );
  assert.doesNotThrow(() =>
    assertWebCommandSupported(services, "/template-0 request"),
  );
  assert.doesNotThrow(() =>
    assertWebCommandSupported(services, "/openpi-setup inspect settings"),
  );
  assert.throws(
    () => assertWebCommandSupported(services, "/ps"),
    /opens a Web panel/u,
  );
  assert.throws(
    () => assertWebCommandSupported(services, "/ps ignored arguments"),
    /without arguments/u,
  );
  assert.throws(
    () => assertWebCommandSupported(services, "/btw question"),
    /opens a Web panel/u,
  );
  assert.throws(
    () => assertWebCommandSupported(services, "/unreviewed"),
    /not available in the Web runtime/u,
  );
  available.push(command("unsafe", "extension"));
  assert.throws(
    () => assertWebCommandSupported(services, "/unsafe"),
    /not available/u,
  );
});

test("fails closed before binding and follows the bridge registered for services", async () => {
  const services = Object.create(null) as AgentSessionServices;
  assert.throws(
    () => commandsForServices(services),
    /unavailable for this Web runtime/u,
  );

  const first = createCommandDiscoveryBridge();
  const firstApi = {
    getCommands: () => [command("first", "prompt")],
  } as ExtensionAPI;
  await (typeof first.extension === "function"
    ? first.extension(firstApi)
    : first.extension.factory(firstApi));
  registerCommandDiscoveryBridge(services, first);
  assert.equal(commandsForServices(services).commands[0]?.name, "first");

  const replacement = createCommandDiscoveryBridge();
  const replacementApi = {
    getCommands: () => [command("replacement", "skill")],
  } as ExtensionAPI;
  await (typeof replacement.extension === "function"
    ? replacement.extension(replacementApi)
    : replacement.extension.factory(replacementApi));
  registerCommandDiscoveryBridge(services, replacement);
  assert.equal(commandsForServices(services).commands[0]?.name, "replacement");
});
