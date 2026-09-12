import assert from "node:assert/strict";
import test from "node:test";
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
