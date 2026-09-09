import type {
  WebLiveMessage,
  WebSnapshot,
} from "../../../../protocol/types.ts";

type Entry = NonNullable<WebSnapshot["selectedSession"]>["entries"][number];
export interface TrajectoryNode {
  key: string;
  kind: "user" | "assistant" | "call" | "result" | "event";
  title: string;
  timestamp?: string;
  callId?: string;
  input?: string;
  message?: WebLiveMessage;
  result?: WebLiveMessage;
  outcome?: "returned" | "error" | "unknown";
}

// This is record order, not a dependency graph or execution timing model.
export function buildTrajectory(entries: readonly Entry[]) {
  const order = new Map(entries.map((entry, index) => [entry.id, index]));
  const resultPositions = new Map<WebLiveMessage, number>();
  const calls = new Map<string, number>();
  const results = new Map<string, WebLiveMessage[]>();
  for (const entry of entries) {
    const message = "message" in entry ? entry.message : undefined;
    for (const part of message?.parts ?? []) {
      if (part.type === "toolCall" && part.id)
        calls.set(part.id, (calls.get(part.id) ?? 0) + 1);
    }
    if (message?.role === "toolResult" && message.toolCallId) {
      const values = results.get(message.toolCallId) ?? [];
      values.push(message);
      resultPositions.set(message, order.get(entry.id) ?? -1);
      results.set(message.toolCallId, values);
    }
  }
  const paired = new Set<WebLiveMessage>();
  const nodes: TrajectoryNode[] = [];
  for (const entry of entries) {
    const message = "message" in entry ? entry.message : undefined;
    if (!message) {
      nodes.push({
        key: entry.id,
        kind: "event",
        title: entry.type,
        timestamp: entry.timestamp,
      });
      continue;
    }
    if (message.role === "toolResult") continue;
    if (
      message.role !== "assistant" ||
      message.content ||
      !message.parts?.length ||
      message.parts?.some((part) => part.type !== "toolCall")
    ) {
      nodes.push({
        key: entry.id,
        kind:
          message.role === "user"
            ? "user"
            : message.role === "assistant"
              ? "assistant"
              : "event",
        title: message.customType || message.role || entry.type,
        timestamp: entry.timestamp,
        message,
      });
    }
    for (const [index, part] of (message.parts ?? []).entries()) {
      if (part.type !== "toolCall") continue;
      const candidates = part.id ? results.get(part.id) : undefined;
      const result =
        part.id &&
        calls.get(part.id) === 1 &&
        candidates?.length === 1 &&
        candidates[0]?.toolName === part.name &&
        !part.id.includes("[truncated]") &&
        (resultPositions.get(candidates[0]) ?? -1) > (order.get(entry.id) ?? -1)
          ? candidates[0]
          : undefined;
      if (result) paired.add(result);
      nodes.push({
        key: `${entry.id}:call:${index}`,
        kind: "call",
        title: part.name,
        timestamp: entry.timestamp,
        callId: part.id,
        input: part.arguments,
        message,
        result,
        outcome:
          result?.isError === true
            ? "error"
            : result?.isError === false
              ? "returned"
              : "unknown",
      });
    }
  }
  // Keep unpaired results at their actual record position, including clipped prefixes.
  const nodeOrder = new Map(
    nodes.map((node) => [node.key, order.get(node.key) ?? -1]),
  );
  for (const entry of entries) {
    const message = "message" in entry ? entry.message : undefined;
    if (message?.role === "toolResult" && !paired.has(message)) {
      nodes.push({
        key: entry.id,
        kind: "result",
        title: message.toolName || "toolResult",
        timestamp: entry.timestamp,
        callId: message.toolCallId,
        result: message,
        outcome:
          message.isError === true
            ? "error"
            : message.isError === false
              ? "returned"
              : "unknown",
      });
      nodeOrder.set(entry.id, order.get(entry.id) ?? 0);
    }
    for (const [index, part] of (message?.parts ?? []).entries()) {
      if (part.type === "toolCall")
        nodeOrder.set(`${entry.id}:call:${index}`, order.get(entry.id) ?? 0);
    }
  }
  nodes.sort(
    (a, b) => (nodeOrder.get(a.key) ?? 0) - (nodeOrder.get(b.key) ?? 0),
  );
  return nodes;
}
