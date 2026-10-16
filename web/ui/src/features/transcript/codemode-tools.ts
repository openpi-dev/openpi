import {
  type EvidenceState,
  evidenceRecord,
  type LiveToolEvidence,
  projectToolEvidence,
} from "../../../../protocol/evidence.ts";
import type {
  WebLiveMessage,
  WebMessagePart,
} from "../../../../protocol/types.ts";

type ToolCall = Extract<WebMessagePart, { type: "toolCall" }>;

export interface CodemodeChild {
  call: ToolCall;
  result?: WebLiveMessage;
  state: EvidenceState;
  /** History contains call/status evidence, not the nested tool's output. */
  outputMissing: boolean;
  argumentsOmitted?: boolean;
  error?: string;
}

/** A display projection of Pi's events and record. Never parse the script or invent results. */
export function codemodeChildren(
  call: ToolCall,
  result: WebLiveMessage | undefined,
  liveTools: readonly LiveToolEvidence[],
  liveState?: EvidenceState,
) {
  if (call.name !== "codemode" || !call.id || result?.forkSnapshotToolResult)
    return undefined;
  const settled = result !== undefined && liveState !== "running";
  const ids = new Set([call.id]);
  const live: LiveToolEvidence[] = [];
  // Events are in native start order. Nested descendants carry explicit parents.
  for (const item of liveTools) {
    if (!item.parentToolCallId || !ids.has(item.parentToolCallId)) continue;
    if (item.call.id) ids.add(item.call.id);
    live.push(item);
  }
  const details = evidenceRecord(result?.details);
  const ledger = Array.isArray(details.calls) ? details.calls : [];
  const cancelled = new Set(
    ledger.flatMap((item) => {
      const entry = evidenceRecord(item);
      return entry.status === "cancelled" && typeof entry.id === "string"
        ? [entry.id]
        : [];
    }),
  );
  const records = result?.nestedCalls;
  const children: CodemodeChild[] = [];
  for (const entry of records?.calls ?? []) {
    const observed = live.find(
      (item) =>
        item.call.id === entry.call.id && item.call.name === entry.call.name,
    );
    const state =
      entry.status !== "ok" && cancelled.has(entry.call.id ?? "")
        ? "cancelled"
        : entry.status === "ok"
          ? "returned"
          : entry.status === "error"
            ? "failed"
            : observed &&
                ["returned", "failed", "cancelled", "timed_out"].includes(
                  observed.state,
                )
              ? projectToolEvidence(
                  observed.call,
                  observed.result,
                  observed.state,
                ).state
              : "unknown";
    children.push({
      call: entry.call,
      result: observed?.result,
      state,
      outputMissing: !observed?.result,
      argumentsOmitted: entry.argumentsOmitted,
      error: entry.error,
    });
  }
  for (const item of live) {
    if (children.some((child) => child.call.id === item.call.id)) continue;
    // A complete persisted ledger supersedes stale in-memory events.
    if (settled && records?.complete) continue;
    children.push({
      call: item.call,
      result: item.result,
      state:
        settled && item.state === "running"
          ? "unknown"
          : item.result?.isError !== false && cancelled.has(item.call.id ?? "")
            ? "cancelled"
            : projectToolEvidence(item.call, item.result, item.state).state,
      outputMissing: false,
    });
  }
  const unmatchedLedger = ledger.some((item) => {
    const entry = evidenceRecord(item);
    // Pending native calls temporarily use /?. They have no terminal evidence
    // to project; after settlement even that unresolved identity must remain visible.
    if (
      !settled &&
      entry.status === "running" &&
      typeof entry.id === "string" &&
      entry.id.endsWith("/?")
    )
      return false;
    return !children.some(
      (child) => child.call.id === entry.id && child.call.name === entry.name,
    );
  });
  return {
    children,
    incomplete:
      records?.complete === false ||
      unmatchedLedger ||
      (settled && !records && ledger.length > children.length),
    // Keep script-level errors, and a running script after its children finish, visible.
    showWrapper:
      children.length === 0 ||
      unmatchedLedger ||
      result?.isError === true ||
      (liveState === "running" &&
        !children.some((child) => child.state === "running")),
  };
}
