import type {
  WebSessionProjection,
  WebSnapshot,
} from "../../../protocol/types.ts";

/** A copied file can share an id without owning the current Pi runtime. */
export function isControlledSession(
  snapshot: WebSnapshot | null | undefined,
  session:
    | Pick<WebSessionProjection, "id" | "path">
    | null
    | undefined = snapshot?.selectedSession,
) {
  if (!snapshot || !session || session.id !== snapshot.currentSessionId)
    return false;
  const currentPath =
    snapshot.currentSessionPath ??
    snapshot.sessions.find(
      (item) =>
        item.id === snapshot.currentSessionId && item.controller === "web",
    )?.path ??
    snapshot.runtime.activeTurn?.sessionPath;
  return Boolean(currentPath && currentPath === session.path);
}
