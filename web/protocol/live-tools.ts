import { evidenceRecord, LIVE_TOOL_LIMIT, type LiveToolEvidence } from "./evidence.ts";
import type { WebLiveMessage, WebMessagePart } from "./types.ts";

/** Input is the bounded Host protocol; partial results are complete snapshots. */
export function reduceLiveTools(current: LiveToolEvidence[], type: string, detail: Record<string, unknown>) {
  if (["session_start", "session_switched", "session_created"].includes(type)) return [];
  if (["agent_settled", "turn_settled"].includes(type)) return current.map((item) => item.state === "running" ? { ...item, state: "unknown" as const } : item);
  if (!type.startsWith("tool_execution_")) return current;
  const id = detail.toolCallId;
  if (typeof id !== "string" || id.length > 500) return current;
  const existing = current.find((item) => item.call.id === id);
  if (existing && existing.state !== "running" && !(existing.state === "unknown" && type === "tool_execution_end")) return current;
  const rawCall = evidenceRecord(detail.call);
  const call = rawCall.type === "toolCall" && typeof rawCall.name === "string" && typeof rawCall.arguments === "string"
    ? rawCall as Extract<WebMessagePart, { type: "toolCall" }>
    : existing?.call;
  if (!call || call.evidenceTruncated && call.id?.includes("[truncated]")) return current;
  const rawResult = evidenceRecord(detail.result);
  const result = typeof rawResult.content === "string" ? rawResult as unknown as WebLiveMessage : existing?.result;
  const item: LiveToolEvidence = { call, result, state: type === "tool_execution_end" ? detail.isError === true ? "failed" : "returned" : "running" };
  const next = [...current.filter((entry) => entry.call.id !== id), item].slice(-LIVE_TOOL_LIMIT);
  while (next.length > 0 && new TextEncoder().encode(JSON.stringify(next)).byteLength > 512 * 1024) next.shift();
  return next;
}
