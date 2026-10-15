import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { WEB_COMMAND_INPUT } from "../../extensions/shared/web-command-feedback.ts";
import { projectEntry, type WebLiveMessage } from "./types.ts";

/** The existing transcript display of a persisted setup request. */
export function setupDisplayMessage(message: WebLiveMessage) {
  if (message.role !== "custom" || message.customType !== "openpi-setup-request" || message.truncation?.details)
    return message;
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details) ||
    !("command" in details) || (details.command !== "openpi-setup" && details.command !== "my-pi-setup") ||
    !("request" in details) || typeof details.request !== "string") return message;
  return { ...message, role: "user", content: `/${details.command}${details.request ? ` ${details.request}` : ""}`, parts: undefined };
}

/** Pi can insert system context between a command and its setup message. Follow
 * only that continuous native parent chain; never search by matching text. */
export function setupPromptParent(
  entry: { parentId?: string | null },
  getEntry: (id: string) => { id: string; parentId?: string | null; message?: WebLiveMessage } | undefined,
) {
  let parentId = entry.parentId;
  const visited = new Set<string>();
  for (let depth = 0; parentId && depth < 32; depth++) {
    if (visited.has(parentId)) return undefined;
    visited.add(parentId);
    const parent = getEntry(parentId);
    if (!parent || parent.id !== parentId) return undefined;
    if (parent.message?.role !== "system") return parent.message;
    parentId = parent.parentId;
  }
  return undefined;
}

/** An exact command ancestor, across system context only, owns this echo. */
export function isSetupPromptEcho(message: WebLiveMessage, parent?: WebLiveMessage) {
  const displayed = setupDisplayMessage(message);
  return message.customType === "openpi-setup-request" && displayed.role === "user" &&
    parent?.role === "user" && parent.customType === WEB_COMMAND_INPUT &&
    typeof parent.commandId === "string" && parent.commandId.length > 0 && parent.commandId.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(parent.commandId) && parent.content === displayed.content;
}

export function isSessionPrompt(entry: SessionEntry, parent?: SessionEntry, entriesById?: ReadonlyMap<string, SessionEntry>) {
  if (entry.type === "message") return entry.message.role === "user";
  if (entry.type === "custom" && entry.customType === WEB_COMMAND_INPUT)
    return projectEntry(entry).message?.role === "user";
  if (entry.type !== "custom_message" || entry.customType !== "openpi-setup-request") return false;
  const message = projectEntry(entry).message!;
  const parentMessage = setupPromptParent(entry, (id) => {
    const ancestor = entriesById ? entriesById.get(id) : parent?.id === id ? parent : undefined;
    return ancestor && { ...ancestor, message: projectEntry(ancestor).message };
  });
  return setupDisplayMessage(message).role === "user" && !isSetupPromptEcho(message, parentMessage);
}
