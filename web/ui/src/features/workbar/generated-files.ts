import { projectToolEvidence } from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";

export interface GeneratedFileRecord {
  id: string;
  path: string;
  reference: string;
  tool: "write" | "edit";
  change?: string;
}

export function generatedFiles(
  messages: readonly WebLiveMessage[],
): GeneratedFileRecord[] {
  const calls = new Map<
    string,
    Extract<WebMessagePart, { type: "toolCall" }>
  >();
  const files = new Map<string, GeneratedFileRecord>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (
        part.type === "toolCall" &&
        part.id &&
        (part.name === "write" || part.name === "edit")
      ) {
        calls.set(part.id, part);
      }
    }
    if (
      message.role !== "toolResult" ||
      !message.toolCallId ||
      message.isError !== false
    ) {
      continue;
    }
    const call = calls.get(message.toolCallId);
    if (!call || (call.name !== "write" && call.name !== "edit")) continue;
    const evidence = projectToolEvidence(call, message);
    const path = evidence.path;
    const reference = evidence.resolvedPath ?? path;
    if (!path || !reference) continue;
    files.delete(reference);
    files.set(reference, {
      id: message.toolCallId,
      path,
      reference,
      tool: call.name,
      ...(evidence.change ? { change: evidence.change } : {}),
    });
  }
  return [...files.values()].reverse();
}
