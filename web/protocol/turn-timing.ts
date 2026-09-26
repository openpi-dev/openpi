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
}

/** Only this bounded runtime record is exposed from a Pi custom entry. */
export function readTurnTiming(value: unknown): WebTurnTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.sessionId !== "string" || !record.sessionId || record.sessionId.length > 500 ||
    typeof record.commandId !== "string" || !record.commandId || record.commandId.length > 500 ||
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
  };
}
