export const WEB_TURN_TIMING_ENTRY = "openpi-web-turn-timing";

export interface WebTurnTiming {
  version: 1;
  sessionId: string;
  commandId: string;
  epoch: number;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  outcome: "completed" | "cancelled" | "failed" | "uncertain";
  /** A live terminal publication may seed unread state; history discovery may not. */
  unreadEligible?: boolean;
  /** Exact native input that began this execution, before any steering input. */
  promptEntryId?: string;
  resultEntryId?: string;
}

/** Only this bounded runtime record is exposed from a Pi custom entry. */
export function readTurnTiming(value: unknown): WebTurnTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.sessionId !== "string" || !record.sessionId || record.sessionId.length > 500 ||
    typeof record.commandId !== "string" || !record.commandId || record.commandId.length > 500 ||
    [record.promptEntryId, record.resultEntryId].some((id) => id !== undefined && (typeof id !== "string" || !id || id.length > 500 || /[\u0000-\u001f\u007f]/u.test(id))) ||
    !Number.isSafeInteger(record.epoch) || Number(record.epoch) < 1 ||
    ![record.startedAt, record.finishedAt, record.elapsedMs].every((number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0) ||
    !["completed", "cancelled", "failed", "uncertain"].includes(String(record.outcome))
  ) return undefined;
  return {
    version: 1,
    sessionId: record.sessionId,
    commandId: record.commandId,
    epoch: Number(record.epoch),
    startedAt: Number(record.startedAt),
    finishedAt: Number(record.finishedAt),
    elapsedMs: Number(record.elapsedMs),
    outcome: record.outcome as WebTurnTiming["outcome"],
    ...(typeof record.unreadEligible === "boolean" ? { unreadEligible: record.unreadEligible } : {}),
    ...(typeof record.promptEntryId === "string" ? { promptEntryId: record.promptEntryId } : {}),
    ...(typeof record.resultEntryId === "string" ? { resultEntryId: record.resultEntryId } : {}),
  };
}

/** Recover exact branch evidence. Reading it neither publishes nor acknowledges activity. */
export function readSessionTurnEvidence(branch: readonly SessionEntry[], sessionId: string, includeLegacyResults = false) {
  let preceding: SessionEntry | undefined;
  let lastTurn: { commandId: string; finishedAt: number; outcome: WebTurnTiming["outcome"]; resultEntryId?: string } | undefined;
  const results = [];
  const seen = new Set<string>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === WEB_TURN_TIMING_ENTRY) {
      const timing = readTurnTiming(entry.data);
      if (timing?.sessionId === sessionId) {
        const resultEntryId = timing.outcome === "completed" && preceding?.type === "message" && preceding.message.role === "assistant" && ["stop", "length"].includes(preceding.message.stopReason) && (!timing.resultEntryId || timing.resultEntryId === preceding.id) ? preceding.id : undefined;
        lastTurn = { commandId: timing.commandId, finishedAt: timing.finishedAt, outcome: timing.outcome, ...(resultEntryId ? { resultEntryId } : {}) };
        const identity = JSON.stringify([lastTurn.commandId, lastTurn.finishedAt]);
        if ((timing.unreadEligible === true || timing.unreadEligible === undefined && includeLegacyResults) && (lastTurn.outcome === "completed" || lastTurn.outcome === "failed") && !seen.has(identity)) {
          results.push({ ...lastTurn, outcome: lastTurn.outcome });
          seen.add(identity);
        }
      } else lastTurn = undefined;
      preceding = entry;
    } else if (entry.type === "message") preceding = entry;
  }
  return { lastTurn, results };
}
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
