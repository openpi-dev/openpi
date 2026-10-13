const key = "openpi:subagent-panel:v1";

/** Restore only the overview, scoped to the exact parent. Never persist a child selection. */
export function loadSubagentPanelPosition() {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (!value || typeof value !== "object") return null;
    const { sessionId, sessionPath } = value as Record<string, unknown>;
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      sessionId.length > 160 ||
      typeof sessionPath !== "string" ||
      !sessionPath ||
      sessionPath.length > 4096
    )
      return null;
    return { sessionId, sessionPath, navigation: 0 };
  } catch {
    return null;
  }
}

export function saveSubagentPanelPosition(
  target: { sessionId: string; sessionPath: string } | null,
) {
  try {
    if (target)
      sessionStorage.setItem(
        key,
        JSON.stringify({
          sessionId: target.sessionId,
          sessionPath: target.sessionPath,
        }),
      );
    else sessionStorage.removeItem(key);
  } catch {
    // Presentation remains usable when browser storage is unavailable.
  }
}
