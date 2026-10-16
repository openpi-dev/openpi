import type { WebSessionSummary } from "../../../../protocol/types.ts";

/** Group forks under their source project; cwd remains filesystem authority. */
export function sessionProject(
  session: Pick<WebSessionSummary, "cwd" | "workspacePath">,
) {
  return session.workspacePath ?? session.cwd;
}

/** Ordering APIs insert before an exact visible anchor; null appends. */
export function movedItemAnchor<T>(
  items: readonly T[],
  index: number,
  down: boolean,
) {
  return items[index + (down ? 2 : -1)] ?? null;
}

export function droppedItemAnchor<T>(
  items: readonly T[],
  index: number,
  after: boolean,
) {
  return items[index + (after ? 1 : 0)] ?? null;
}

export function dropIsAfter(
  pointerY: number,
  bounds: { top: number; height: number },
) {
  return pointerY > bounds.top + bounds.height / 2;
}
