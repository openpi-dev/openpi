import type { InlineExtension, SessionManager } from "@earendil-works/pi-coding-agent";
import { captureGitTurnChanges, type GitTurnChangeCapture } from "../host/git-review.ts";
import { jsonByteLength, type WebGitReviewResult } from "../protocol/types.ts";
import {
  WEB_MAX_TURN_CHANGE_RECORD_BYTES,
  WEB_TURN_CHANGES_ENTRY,
  type WebTurnChangesDetail,
} from "../protocol/turn-changes.ts";

interface PendingTurn {
  sessionId: string;
  beforeEntryId: string | null;
  capture?: GitTurnChangeCapture;
}

function promptEntryId(manager: SessionManager, pending: PendingTurn) {
  if (manager.getSessionId() !== pending.sessionId) return undefined;
  const branch = manager.getBranch();
  const before = pending.beforeEntryId === null
    ? -1
    : branch.findIndex((entry) => entry.id === pending.beforeEntryId);
  if (pending.beforeEntryId !== null && before < 0) return undefined;
  const prompt = branch.slice(before + 1).find(
    (entry) => entry.type === "message" && entry.message.role === "user",
  );
  return prompt?.id;
}

function persistedChanges(result: WebGitReviewResult | undefined, sessionId: string, id: string): WebTurnChangesDetail {
  if (!result?.ok) return {
    version: 1, sessionId, promptEntryId: id, state: "unavailable", fileCount: null,
    files: [], additions: 0, deletions: 0,
  };
  const files = result.snapshot.files.map((file) => ({ ...file, diffLoaded: true }));
  let partial = result.snapshot.truncated || files.some((file) => file.diffTruncated);
  const record = (): WebTurnChangesDetail => ({
    version: 1,
    sessionId,
    promptEntryId: id,
    state: partial ? "partial" : "complete",
    fileCount: partial ? null : files.length,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  });
  while (jsonByteLength(record()) > WEB_MAX_TURN_CHANGE_RECORD_BYTES) {
    const file = [...files].reverse().find((item) => item.diff);
    if (file) {
      file.diff = "";
      file.diffTruncated = true;
    } else if (files.length) files.pop();
    else break;
    partial = true;
  }
  return record();
}

/** Pi-native, Web-only evidence for the user's prompt/response turn. */
export function createTurnChangeRecorder(manager: SessionManager, cwd: string): InlineExtension {
  let pending: PendingTurn | undefined;
  const settle = async () => {
    const previous = pending;
    pending = undefined;
    if (!previous) return;
    const id = promptEntryId(manager, previous);
    let result: WebGitReviewResult | undefined;
    try {
      result = await previous.capture?.read();
    } catch {
      // The missing capture is persisted as unavailable, never as no changes.
    } finally {
      await previous.capture?.dispose().catch(() => undefined);
    }
    if (!id || manager.getSessionId() !== previous.sessionId) return;
    try {
      manager.appendCustomEntry(WEB_TURN_CHANGES_ENTRY, persistedChanges(result, previous.sessionId, id));
    } catch {
      // Optional display evidence must not change Pi's terminal outcome.
    }
  };
  return {
    name: "openpi-web-turn-changes",
    hidden: true,
    factory(pi) {
      pi.on("message_start", async (event) => {
        if (event.message.role !== "user") return;
        await settle();
        const sessionId = manager.getSessionId();
        const next: PendingTurn = { sessionId, beforeEntryId: manager.getLeafId() };
        pending = next;
        try {
          next.capture = await captureGitTurnChanges(
            manager.getSessionFile() ?? `current:${sessionId}`,
            cwd,
          );
        } catch {
          // A failed pre-turn snapshot cannot be reconstructed after the turn.
        }
      });
      pi.on("agent_settled", settle);
      pi.on("session_shutdown", async () => {
        const previous = pending;
        pending = undefined;
        await previous?.capture?.dispose().catch(() => undefined);
      });
    },
  };
}
