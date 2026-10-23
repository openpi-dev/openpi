import type { WebCapabilityDetail } from "../../../../../extensions/shared/web-observer-registry.ts";
import type { LiveToolState } from "../../../../../extensions/subagents/src/domain.ts";
import type { LiveToolEvidence } from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
  WebSnapshot,
} from "../../../../protocol/types.ts";

/** Adapt the child owner's display data to the same read-only projection as a parent conversation. */
export function subagentTranscriptSnapshot(
  parentSessionId: string,
  detail: WebCapabilityDetail,
  preferences: WebSnapshot["preferences"],
  redactedThinking: string,
) {
  const sessionId = JSON.stringify([parentSessionId, detail.kind, detail.id]);
  const entries: NonNullable<WebSnapshot["selectedSession"]>["entries"] = [];
  const calls = new Set<string>();
  const results = new Map<string, WebLiveMessage>();
  const occurrences = new Map<string, number>();
  const toolCall = (tool: LiveToolState) => ({
    type: "toolCall" as const,
    id: tool.toolId,
    name: tool.name,
    arguments: tool.argsPreview ?? "{}",
  });
  const append = (id: string, message: WebLiveMessage) => {
    entries.push({ type: "message", id, timestamp: "", message });
  };
  for (const item of detail.transcript) {
    // Legacy observers lack IDs. Content + occurrence preserves their existing
    // disclosures as the retained window advances, without using array indexes.
    const content = JSON.stringify(item);
    const occurrence = occurrences.get(content) ?? 0;
    occurrences.set(content, occurrence + 1);
    const id = item.id ?? `${content}:${occurrence}`;
    if (item.kind === "user") {
      append(id, { role: "user", content: item.text });
    } else if (item.kind === "toolResult") {
      const result = {
        role: "toolResult",
        toolCallId: item.toolId,
        toolName: item.name,
        isError: item.isError,
        content: item.outputPreview ?? "",
      };
      results.set(item.toolId, result);
      append(id, result);
    } else {
      const parts = item.parts.map((part): WebMessagePart => {
        if (part.type === "toolCall") {
          calls.add(part.toolId);
          return toolCall(part);
        }
        if (part.type === "thinking")
          return {
            type: "thinking",
            text: part.redacted ? redactedThinking : part.text,
          };
        return part;
      });
      append(id, {
        role: "assistant",
        content: parts
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n"),
        parts,
        ...(parts.some((part) => part.type === "toolCall")
          ? { stopReason: "toolUse" }
          : {}),
      });
    }
  }
  const running = detail.status === "running";
  const liveTools = detail.liveTools.map(
    (tool): LiveToolEvidence => ({
      call: toolCall(tool),
      result: results.get(tool.toolId) ?? {
        role: "toolResult",
        toolCallId: tool.toolId,
        toolName: tool.name,
        content: tool.outputPreview ?? "",
        ...(tool.done ? { isError: tool.isError === true } : {}),
      },
      state: results.has(tool.toolId)
        ? results.get(tool.toolId)!.isError
          ? "failed"
          : "returned"
        : tool.done
          ? tool.isError
            ? "failed"
            : "returned"
          : running
            ? "running"
            : "unknown",
    }),
  );
  const liveParts: WebMessagePart[] = [];
  if (detail.liveAssistant?.thinking)
    liveParts.push({ type: "thinking", text: detail.liveAssistant.thinking });
  if (detail.liveAssistant?.text)
    liveParts.push({ type: "text", text: detail.liveAssistant.text });
  liveParts.push(
    ...liveTools
      .filter(
        (tool) => !calls.has(tool.call.id!) && !results.has(tool.call.id!),
      )
      .map((tool) => tool.call),
  );
  if (liveParts.length)
    append(detail.nextEntryId ?? "live-assistant", {
      role: "assistant",
      content: detail.liveAssistant?.text ?? "",
      parts: liveParts,
    });
  if (
    detail.finalText &&
    !entries.some(
      (entry) =>
        entry.message?.role === "assistant" &&
        entry.message.content.trim() === detail.finalText.trim(),
    )
  )
    append("final-result", {
      role: "assistant",
      content: detail.finalText,
      parts: [{ type: "text", text: detail.finalText }],
    });
  return {
    protocolVersion: 1,
    generatedAt: new Date(detail.createdAt).toISOString(),
    cursor: 0,
    preferences,
    sessions: [],
    workspaces: [],
    models: [],
    // No controller identity or session-file path: inspecting a child must not
    // grant parent input, history, retry, fork or file-opening authority.
    runtime: { status: "idle", capabilities: {} },
    selectedSession: {
      id: sessionId,
      path: "",
      cwd: detail.cwd,
      entries,
      bytes: 0,
      truncation: {
        truncated: detail.truncated,
        entriesOmitted: detail.omittedEntries,
        messagePartsOmitted: 0,
        messagesTruncated: 0,
        maxBytes: 64 * 1024,
      },
    },
    selectedExecution: {
      sessionId,
      sessionPath: "",
      status: running
        ? "running"
        : detail.status === "unknown"
          ? "unknown"
          : "idle",
      liveTools,
      liveToolsOmitted: 0,
    },
    truncation: {
      truncated: false,
      sessionsOmitted: 0,
      workspacesOmitted: 0,
      modelsOmitted: 0,
      maxBytes: 0,
      bytes: 0,
    },
  } satisfies WebSnapshot;
}
