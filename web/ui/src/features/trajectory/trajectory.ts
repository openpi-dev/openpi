import type {
  EvidenceState,
  LiveToolEvidence,
} from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebSnapshot,
} from "../../../../protocol/types.ts";
import { codemodeChildren } from "../transcript/codemode-tools.ts";

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
  state?: EvidenceState;
  parentKey?: string;
  durationMs?: number;
  missingOutput?: boolean;
  error?: string;
}

export function defaultTrajectoryNode(nodes: readonly TrajectoryNode[]) {
  for (let index = nodes.length - 1; index >= 0; index--) {
    const node = nodes[index];
    if (
      node &&
      (node.kind !== "event" ||
        Boolean(node.message || node.input !== undefined || node.result))
    )
      return node;
  }
  return nodes.at(-1);
}

/** Reading groups only; native record order and result pairing stay intact. */
export function groupTrajectory(nodes: readonly TrajectoryNode[]) {
  const groups: {
    key: string;
    prompt?: TrajectoryNode;
    runs: TrajectoryNode[][];
  }[] = [];
  for (const node of nodes) {
    if (node.kind === "user" || !groups.length)
      groups.push({
        key: node.key,
        ...(node.kind === "user" ? { prompt: node } : {}),
        runs: [],
      });
    const group = groups.at(-1)!;
    const previous = group.runs.at(-1);
    if (node.kind === "event" && previous?.[0]?.kind === "event")
      previous.push(node);
    else group.runs.push([node]);
  }
  return groups;
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

/** Browser projection of native response and nested-call facts; no script parsing. */
export function trajectoryRecords(
  entries: readonly Entry[],
  liveTools: readonly LiveToolEvidence[] = [],
) {
  const base = buildTrajectory(entries);
  const retained = new Set(base.map((node) => node.key));
  const responses = entries.flatMap((entry) =>
    entry.message?.role === "assistant" && !retained.has(entry.id)
      ? [
          {
            key: entry.id,
            kind: "assistant" as const,
            title: "assistant",
            timestamp: entry.timestamp,
            message: entry.message,
          },
        ]
      : [],
  );
  const positions = new Map(entries.map((entry, index) => [entry.id, index]));
  const owners = new Map<string, string>();
  const callCounts = new Map<string, number>();
  for (const entry of entries)
    for (const [index, part] of (entry.message?.parts ?? []).entries()) {
      if (part.type === "toolCall") {
        owners.set(`${entry.id}:call:${index}`, entry.id);
        if (part.id)
          callCounts.set(part.id, (callCounts.get(part.id) ?? 0) + 1);
      }
    }
  const records = [...base, ...responses].sort((left, right) => {
    const owner = (node: TrajectoryNode) =>
      positions.get(owners.get(node.key) ?? node.key) ?? -1;
    return (
      owner(left) - owner(right) ||
      Number(left.kind === "call") - Number(right.kind === "call")
    );
  });
  return records.flatMap((node): TrajectoryNode[] => {
    if (node.kind !== "call" || node.title !== "codemode") return [node];
    const part = node.message?.parts?.find(
      (part) => part.type === "toolCall" && part.id === node.callId,
    );
    if (part?.type !== "toolCall" || !part.id || callCounts.get(part.id) !== 1)
      return [node];
    const children = codemodeChildren(part, node.result, liveTools);
    return [
      node,
      ...(children?.children ?? []).map((child) => {
        const duration = node.result?.nestedCalls?.calls.find(
          (record) => record.call.id === child.call.id,
        )?.durationMs;
        return {
          key: `${node.key}:nested:${child.call.id}`,
          kind: "call" as const,
          title: child.call.name,
          parentKey: node.key,
          callId: child.call.id,
          input: child.call.arguments,
          result: child.result,
          missingOutput: child.outputMissing,
          error: child.error,
          state: child.state,
          outcome:
            child.state === "returned"
              ? ("returned" as const)
              : ["failed", "cancelled", "timed_out"].includes(child.state)
                ? ("error" as const)
                : ("unknown" as const),
          ...(duration !== undefined ? { durationMs: duration } : {}),
        };
      }),
    ];
  });
}

/** Format only measured durations; unknown timing stays absent. */
export function trajectoryDuration(milliseconds?: number) {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(2)} s`;
}
