import { evidenceRecord, evidenceText, LIVE_TOOL_LIMIT, type EvidenceState, type LiveToolEvidence } from "./evidence.ts";
import type { WebLiveMessage, WebMessagePart } from "./types.ts";

/** A pending native parent authorizes retaining its already observed UI data. */
export function mergeCodemodeLiveTools(current: readonly LiveToolEvidence[], pending: LiveToolEvidence[]) {
  const scripts = new Set(pending.filter((item) => item.call.id && item.call.name === "codemode" && item.state === "running").map((item) => item.call.id));
  if (!scripts.size) return pending;
  const next = [
    ...current.filter((item) => item.parentToolCallId && scripts.has(item.parentToolCallId)),
    ...pending.map((item) => {
      const previous = current.find((entry) => entry.call.id === item.call.id && entry.call.name === "codemode" && entry.state === "running");
      return scripts.has(item.call.id) && previous?.result ? { ...item, result: previous.result } : item;
    }),
  ].slice(-LIVE_TOOL_LIMIT);
  while (next.length > 0 && new TextEncoder().encode(JSON.stringify(next)).byteLength > 512 * 1024) next.shift();
  return next;
}

/** Operator projection of Pi's own ledger, never script parsing or execution. */
export function projectCodemodeEvidence(
  call: Extract<WebMessagePart, { type: "toolCall" }>,
  result?: WebLiveMessage,
  liveState?: EvidenceState,
  liveTools: readonly LiveToolEvidence[] = [],
) {
  const state = liveState ?? (result?.isError === true ? "failed" : result?.isError === false ? "returned" : "unknown");
  const details = evidenceRecord(result?.details);
  const nested = evidenceRecord(result?.nestedCalls);
  const saved = Array.isArray(nested.calls) ? nested.calls : [];
  const direct = Array.isArray(details.calls) ? details.calls : [];
  // Nested tools can call tools themselves. Retain native receipts that the
  // script's direct-call ledger does not contain; never derive them from code.
  const ledger = [...direct, ...saved.filter((item) => {
    const entry = evidenceRecord(item);
    return !direct.some((value) => {
      const raw = evidenceRecord(value);
      return raw.id === entry.id && raw.name === entry.name;
    });
  })];
  const calls = ledger.map((value, index) => {
    const raw = evidenceRecord(value);
    const id = typeof raw.id === "string" ? raw.id : undefined;
    const name = typeof raw.name === "string" ? evidenceText(raw.name).text : "";
    const receipt = evidenceRecord(saved.find((item) => {
      const entry = evidenceRecord(item);
      return id && entry.id === id && entry.name === raw.name;
    }));
    const recordedArguments = receipt.arguments ?? raw.arguments;
    let args: Record<string, unknown> | undefined;
    let argumentsText = typeof raw.args === "string" ? evidenceText(raw.args).text : "";
    if (recordedArguments && typeof recordedArguments === "object" && !Array.isArray(recordedArguments)) {
      args = evidenceRecord(recordedArguments);
      argumentsText = evidenceText(JSON.stringify(args, null, 2)).text;
    } else if (argumentsText) {
      try {
        const parsed: unknown = JSON.parse(argumentsText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = evidenceRecord(parsed);
      } catch {
        // Native preview strings can be cut through JSON. Keep them literal.
      }
    }
    const childState: EvidenceState = raw.status === "ok" ? "returned"
      : raw.status === "error" ? "failed"
      : raw.status === "cancelled" ? "cancelled"
      : raw.status === "running" && state === "running" ? "running" : "unknown";
    const live = id && call.id ? liveTools.find((item) => item.call.id === id && item.call.name === raw.name && item.parentToolCallId === call.id) : undefined;
    return {
      key: `${index}:${id ?? ""}`,
      id, name, args, argumentsText,
      state: childState,
      durationMs: typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs) && raw.durationMs >= 0 ? raw.durationMs : undefined,
      error: typeof raw.error === "string" ? evidenceText(raw.error).text : undefined,
      live,
    };
  });
  let script = call.arguments;
  try {
    const args = evidenceRecord(JSON.parse(call.arguments));
    if (typeof args.code === "string") script = args.code;
  } catch { /* A bounded argument projection may be incomplete JSON. */ }
  const scriptText = evidenceText(script);
  const output = evidenceText(result?.content ?? "");
  return {
    state, calls, script: scriptText.text, output: output.text,
    partial: nested.complete === false || Boolean(result?.truncation?.details || result?.truncation?.nestedCalls),
    truncated: scriptText.truncated || output.truncated || Boolean(call.evidenceTruncated || result?.truncation?.text),
    recovery: typeof details.fullOutputPath === "string" ? evidenceText(details.fullOutputPath).text : undefined,
  };
}
