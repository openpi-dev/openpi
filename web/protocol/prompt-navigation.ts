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

/** Only an exact native parent identifies the duplicate display of one command episode. */
export function isSetupPromptEcho(message: WebLiveMessage, parent?: WebLiveMessage) {
  const displayed = setupDisplayMessage(message);
  return message.customType === "openpi-setup-request" && displayed.role === "user" &&
    parent?.customType === WEB_COMMAND_INPUT && Boolean(parent.commandId) && parent.content === displayed.content;
}

export function isSessionPrompt(entry: SessionEntry, parent?: SessionEntry) {
  if (entry.type === "message") return entry.message.role === "user";
  if (entry.type === "custom" && entry.customType === WEB_COMMAND_INPUT)
    return projectEntry(entry).message?.role === "user";
  if (entry.type !== "custom_message" || entry.customType !== "openpi-setup-request") return false;
  const message = projectEntry(entry).message!;
  const parentMessage = parent?.id === entry.parentId && parent.type === "custom" && parent.customType === WEB_COMMAND_INPUT ? projectEntry(parent).message : undefined;
  return setupDisplayMessage(message).role === "user" && !isSetupPromptEcho(message, parentMessage);
}
