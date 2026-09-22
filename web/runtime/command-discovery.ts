import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
const extensionRoot = fileURLToPath(new URL("../../extensions/", import.meta.url));
const ownedSupport: Record<string, {
  extension: string;
  availability: WebCommandSummary["availability"];
  action?: WebCommandSummary["action"];
  unavailableReason?: WebCommandSummary["unavailableReason"];
}> = {
  "openpi-setup": { extension: "setup", availability: "available" },
  "my-pi-setup": { extension: "setup", availability: "available" },
  ps: { extension: "background-terminals", availability: "available", action: "terminal" },
  lg: { extension: "git-info", availability: "available", action: "review" },
  subagents: { extension: "subagents", availability: "available", action: "subagents" },
  usage: { extension: "usage", availability: "available", action: "runtime" },
  btw: { extension: "subagents", availability: "available", action: "side-conversation" },
  sessions: { extension: "sessions", availability: "unsupported", unavailableReason: "terminal_only" },
  web: { extension: "web", availability: "unsupported", unavailableReason: "terminal_only" },
};

function commandSupport(command: SlashCommandInfo) {
  if (command.source !== "extension")
    return { availability: "available" as const, argumentHint: "[arguments]" };
  const owned = Object.hasOwn(ownedSupport, command.name) ? ownedSupport[command.name] : undefined;
  if (owned && command.sourceInfo?.path &&
    resolve(command.sourceInfo.path) === resolve(extensionRoot, owned.extension, "index.ts")) {
    const { extension: _extension, ...support } = owned;
    return { ...support, ...(support.action ? {} : support.availability === "available" ? { argumentHint: "[request]" } : {}) };
  }
  return { availability: "unsupported" as const, unavailableReason: "not_integrated" as const };
}

/** Match Pi's exact dispatch name against the untruncated native registry. */
export function assertWebCommandSupported(services: AgentSessionServices, content: string) {
  if (!content.startsWith("/")) return;
  const bridge = bridges.get(services);
  if (!bridge) throw new Error("Pi command discovery is unavailable for this Web runtime");
  const space = content.indexOf(" ");
  const name = content.slice(1, space === -1 ? undefined : space);
  const command = bridge.read().find((candidate) => candidate.name === name);
  if (!command || command.source !== "extension") return;
  const support = commandSupport(command);
  if ("action" in support && support.action)
    throw new Error(`/${name} opens a Web panel. Run it from the Web command menu without arguments.`);
  if (support.availability === "unsupported")
    throw new Error(`/${name} is not available in the Web runtime. Use this command in the Pi terminal.`);
}

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
      ...commandSupport(command),
      ...(description ? { description } : {}),
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
