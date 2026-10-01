import type { WebSessionProjection } from "../../../../protocol/types.ts";

export type ReadingWindow = {
  session: WebSessionProjection;
  anchor: string;
  validatedLeaf: string | null;
};

export type ReadingPosition = {
  key?: string;
  offset: number;
  scrollTop: number;
  pinned: boolean;
};

export type SessionReadingState = {
  window?: ReadingWindow;
  position?: ReadingPosition;
};

export type SessionReadingCache = Map<string, SessionReadingState>;

export function sessionReadingScope(
  session: Pick<WebSessionProjection, "id" | "path"> | undefined,
) {
  return JSON.stringify([session?.id, session?.path]);
}

export function rememberSessionReading(
  cache: SessionReadingCache,
  scope: string,
  state: SessionReadingState,
) {
  const saved = { ...cache.get(scope), ...state };
  cache.delete(scope);
  cache.set(scope, saved);
  // Each window already has an entry/byte bound; evict its bookmark with it.
  if (cache.size > 4) cache.delete(cache.keys().next().value!);
}
