import type {
  AgentSessionServices,
  InlineExtension,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import {
  jsonByteLength,
  WEB_MAX_COMMAND_BYTES,
  WEB_MAX_COMMAND_DESCRIPTION,
  WEB_MAX_COMMAND_NAME,
  WEB_MAX_COMMANDS,
  type WebCommandDiscoveryResult,
  type WebCommandSummary,
} from "../protocol/types.ts";

const WEB_MAX_COMMANDS_SCANNED = 1_024;

interface CommandDiscoveryBridge {
  readonly extension: InlineExtension;
  read(): readonly SlashCommandInfo[];
}

const bridges = new WeakMap<AgentSessionServices, CommandDiscoveryBridge>();

function commandText(value: string, maxLength: number) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .slice(0, maxLength)
    .trim();
}

export function createCommandDiscoveryBridge(): CommandDiscoveryBridge {
  let getCommands: (() => SlashCommandInfo[]) | undefined;
  return {
    extension: {
      name: "openpi-web-command-discovery",
      hidden: true,
      factory(pi) {
        getCommands = () => pi.getCommands();
      },
    },
    read() {
      if (!getCommands) {
        throw new Error("Pi command discovery is not bound to this Web runtime");
      }
      return getCommands();
    },
  };
}

export function registerCommandDiscoveryBridge(
  services: AgentSessionServices,
  bridge: CommandDiscoveryBridge,
) {
  bridges.set(services, bridge);
}

function resultFor(
  commands: WebCommandSummary[],
  totalAvailable: number,
): WebCommandDiscoveryResult {
  const result: WebCommandDiscoveryResult = {
    commands,
    totalAvailable,
    truncation: {
      truncated: commands.length < totalAvailable,
      commandsOmitted: totalAvailable - commands.length,
      maxCommands: WEB_MAX_COMMANDS,
      maxBytes: WEB_MAX_COMMAND_BYTES,
      bytes: 0,
    },
  };
  let bytes = jsonByteLength(result);
  while (result.truncation.bytes !== bytes) {
    result.truncation.bytes = bytes;
    bytes = jsonByteLength(result);
  }
  return result;
}

export function projectWebCommands(
  available: readonly SlashCommandInfo[],
): WebCommandDiscoveryResult {
  const totalAvailable = available.length;
  const commands: WebCommandSummary[] = [];
  const scanned = Math.min(totalAvailable, WEB_MAX_COMMANDS_SCANNED);
  for (let index = 0; index < scanned; index++) {
    if (commands.length >= WEB_MAX_COMMANDS) break;
    const command = available[index];
    if (!command || typeof command.name !== "string") continue;
    const name = commandText(command.name, WEB_MAX_COMMAND_NAME);
    if (!name || !/^[^\s/]+$/u.test(name)) continue;
    if (
      command.source !== "extension" &&
      command.source !== "prompt" &&
      command.source !== "skill"
    ) {
      continue;
    }
    const description =
      typeof command.description === "string"
        ? commandText(command.description, WEB_MAX_COMMAND_DESCRIPTION)
        : "";
    const projected: WebCommandSummary = {
      name,
      source: command.source,
      availability:
        command.source === "extension" ? "unsupported" : "available",
      ...(description ? { description } : {}),
      ...(command.source === "extension"
        ? {}
        : { argumentHint: "[arguments]" }),
    };
    const candidate = resultFor([...commands, projected], totalAvailable);
    if (candidate.truncation.bytes > WEB_MAX_COMMAND_BYTES) break;
    commands.push(projected);
  }

  let result = resultFor(commands, totalAvailable);
  while (
    result.truncation.bytes > WEB_MAX_COMMAND_BYTES &&
    result.commands.length > 0
  ) {
    result.commands.pop();
    result = resultFor(result.commands, totalAvailable);
  }
  return result;
}

export function commandsForServices(services: AgentSessionServices) {
  const bridge = bridges.get(services);
  if (!bridge) {
    throw new Error("Pi command discovery is unavailable for this Web runtime");
  }
  return projectWebCommands(bridge.read());
}
