import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WebHistoryAnchor } from "./types.ts";

/** Provenance on the native branch, never a separate conversation registry. */
export const WEB_MESSAGE_RERUN = "openpi-web-message-rerun";

export function readMessageRerun(entries: readonly SessionEntry[], parentSession?: string) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== WEB_MESSAGE_RERUN) continue;
    const data = entry.data;
    if (!data || typeof data !== "object" || !("source" in data) || !("mode" in data)) continue;
    const source = data.source;
    if (!source || typeof source !== "object" ||
      !("sessionId" in source) || typeof source.sessionId !== "string" || !source.sessionId || source.sessionId.length > 128 ||
      !("sessionPath" in source) || typeof source.sessionPath !== "string" || source.sessionPath !== parentSession ||
      !("entryId" in source) || typeof source.entryId !== "string" || !source.entryId || source.entryId.length > 128 ||
      (data.mode !== "edit" && data.mode !== "regenerate")) continue;
    return { source: { sessionId: source.sessionId, sessionPath: source.sessionPath, entryId: source.entryId } satisfies WebHistoryAnchor, mode: data.mode } satisfies { source: WebHistoryAnchor; mode: "edit" | "regenerate" };
  }
}
