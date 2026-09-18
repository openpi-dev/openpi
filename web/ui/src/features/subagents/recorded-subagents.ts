import type { WebLiveMessage } from "../../../../protocol/types.ts";

export interface RecordedSubagent {
  id: string;
  title: string;
  receipt?: string;
  result?: string;
  state?: "running" | "done" | "error" | "interrupted";
}

function object(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Only exact IDs in the parent's saved tool receipts/results establish ownership. */
export function recordedSubagents(messages: readonly WebLiveMessage[]) {
  const records = new Map<string, RecordedSubagent>();
  for (const message of messages) {
    const spawn =
      message.role === "toolResult" && message.toolName === "subagent_spawn";
    const result =
      (message.role === "toolResult" &&
        ["subagent_wait", "subagent_check"].includes(message.toolName ?? "")) ||
      message.customType === "subagent-result";
    if ((!spawn && !result) || message.isError) continue;
    const details = object(message.details);
    for (const entry of Array.isArray(details.results)
      ? details.results
      : [details]) {
      const item = object(entry);
      if (
        typeof item.id !== "string" ||
        !item.id ||
        item.id.length > 160 ||
        /[\u0000-\u001f\u007f]/u.test(item.id)
      )
        continue;
      const previous = records.get(item.id);
      const record: RecordedSubagent = {
        ...previous,
        id: item.id,
        title:
          typeof item.title === "string"
            ? item.title
            : (previous?.title ?? item.id),
      };
      if (spawn) record.receipt = message.content;
      else {
        record.result =
          typeof details.displayContent === "string"
            ? details.displayContent
            : message.content;
        record.state =
          item.outcome === "interrupted"
            ? "interrupted"
            : item.status === "done" ||
                item.status === "error" ||
                item.status === "running"
              ? item.status
              : undefined;
      }
      records.delete(item.id);
      records.set(item.id, record);
    }
  }
  return [...records.values()].slice(-32);
}
