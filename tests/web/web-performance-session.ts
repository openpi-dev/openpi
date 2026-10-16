export const performanceSessionId = "m12-synthetic-session";
export const performanceFixturePath = "/m12-fixture/session.jsonl";

type PerformanceSessionIdentity = {
  currentSessionId?: string;
  currentSessionPath?: string;
  sessions?: readonly { id: string; path: string }[];
  selectedSession?: { id: string; path: string } | null;
};

/** The synthetic snapshot must be one Session, or the UI stays on reconnect. */
export function assertPerformanceSessionIdentity(
  snapshot: PerformanceSessionIdentity,
) {
  const session = snapshot.sessions?.find(
    (item) => item.id === performanceSessionId,
  );
  const actual = {
    currentSessionId: snapshot.currentSessionId ?? null,
    currentSessionPath: snapshot.currentSessionPath ?? null,
    sessionId: session?.id ?? null,
    sessionPath: session?.path ?? null,
    selectedSessionId: snapshot.selectedSession?.id ?? null,
    selectedSessionPath: snapshot.selectedSession?.path ?? null,
  };
  const expected = {
    currentSessionId: performanceSessionId,
    currentSessionPath: performanceFixturePath,
    sessionId: performanceSessionId,
    sessionPath: performanceFixturePath,
    selectedSessionId: performanceSessionId,
    selectedSessionPath: performanceFixturePath,
  };
  if (
    actual.currentSessionId !== expected.currentSessionId ||
    actual.currentSessionPath !== expected.currentSessionPath ||
    actual.sessionId !== expected.sessionId ||
    actual.sessionPath !== expected.sessionPath ||
    actual.selectedSessionId !== expected.selectedSessionId ||
    actual.selectedSessionPath !== expected.selectedSessionPath
  ) {
    throw new Error(
      `synthetic session identity mismatch: ${JSON.stringify(actual)}`,
    );
  }
}
