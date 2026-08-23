import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_ID_WATERMARK_ENTRY_TYPE = "subagent-id-watermark";

export interface SubagentIdCounters {
  readonly modelCounter: number;
  readonly btwCounter: number;
}

interface IdWatermarkData {
  readonly version: 1;
  readonly id: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function idFrom(value: unknown) {
  const candidate = record(value)?.id;
  return typeof candidate === "string" ? candidate : undefined;
}

function idFromEntry(entry: SessionEntry) {
  if (entry.type === "custom") {
    const data = record(entry.data);
    if (
      entry.customType === SUBAGENT_ID_WATERMARK_ENTRY_TYPE &&
      data?.version === 1
    ) {
      return idFrom(data);
    }
    if (
      entry.customType === "subagent-finished" ||
      entry.customType === "btw-result"
    ) {
      return idFrom(data);
    }
    if (entry.customType === "subagent-result") {
      return idFrom(data?.details) ?? idFrom(data);
    }
    return undefined;
  }

  if (entry.type === "custom_message") {
    return entry.customType === "subagent-result"
      ? idFrom(entry.details)
      : undefined;
  }

  if (entry.type !== "message") return undefined;
  const message = record(entry.message);
  return message?.role === "toolResult" && message.toolName === "subagent_spawn"
    ? idFrom(message.details)
    : undefined;
}

function sequence(id: string | undefined, prefix: "sa" | "btw") {
  if (!id) return undefined;
  const match = new RegExp(`^${prefix}-(\\d+)$`, "u").exec(id);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Restore branch-local id high-water marks, including sessions from before watermarks existed. */
export function restoreSubagentIdCounters(
  entries: readonly SessionEntry[],
): SubagentIdCounters {
  let modelCounter = 0;
  let btwCounter = 0;
  for (const entry of entries) {
    const id = idFromEntry(entry);
    modelCounter = Math.max(modelCounter, sequence(id, "sa") ?? 0);
    btwCounter = Math.max(btwCounter, sequence(id, "btw") ?? 0);
  }
  return { modelCounter, btwCounter };
}

export function subagentIdWatermark(id: string): IdWatermarkData {
  return { version: 1, id };
}
