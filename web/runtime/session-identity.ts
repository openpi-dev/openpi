import { resolve } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { WebModelSelectionOptions } from "./types.ts";

export function matchesSessionIdentity(
  sessionManager: Pick<SessionManager, "getSessionId" | "getSessionFile">,
  expected?: WebModelSelectionOptions,
) {
  const sessionId = sessionManager.getSessionId();
  if (
    expected?.expectedSessionId !== undefined &&
    expected.expectedSessionId !== sessionId
  ) {
    return false;
  }
  if (expected?.expectedSessionPath === undefined) return true;
  const sessionFile = sessionManager.getSessionFile();
  return sessionFile === undefined
    ? expected.expectedSessionPath === `current:${sessionId}`
    : resolve(sessionFile) === resolve(expected.expectedSessionPath);
}
