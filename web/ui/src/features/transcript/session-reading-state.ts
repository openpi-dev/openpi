import type { WebSessionProjection } from "../../../../protocol/types.ts";

export type ReadingWindow = {
  session: WebSessionProjection;
  anchor: string;
  validatedLeaf: string | null;
};

export type ReadingPosition = {
  key?: string;
  /** Native entry identity; key can name one rendered part of that entry. */
  entryId?: string;
  offset: number;
  scrollTop: number;
  pinned: boolean;
};

export type SessionReadingState = {
  window?: ReadingWindow;
  position?: ReadingPosition;
};

export type SessionReadingCache = Map<string, SessionReadingState> & {
  persist?: () => void;
};

export const READING_POSITION_STORAGE_KEY = "openpi:reading-positions:v1";

export function createSessionReadingCache() {
  const cache: SessionReadingCache = new Map();
  try {
    const serialized =
      localStorage.getItem(READING_POSITION_STORAGE_KEY) ?? "[]";
    const saved: unknown =
      serialized.length <= 32_768 ? JSON.parse(serialized) : [];
    if (Array.isArray(saved) && saved.length <= 4) {
      for (const item of saved) {
        if (!Array.isArray(item) || item.length !== 2) continue;
        const [scope, position] = item;
        if (typeof scope !== "string" || scope.length > 4600) continue;
        let identity: unknown;
        try {
          identity = JSON.parse(scope);
        } catch {
          continue;
        }
        if (
          !Array.isArray(identity) ||
          identity.length !== 2 ||
          !identity.every(
            (value) => typeof value === "string" && value.length > 0,
          ) ||
          typeof position !== "object" ||
          position === null ||
          !("key" in position) ||
          typeof position.key !== "string" ||
          !position.key ||
          position.key.length > 512 ||
          ("entryId" in position &&
            (typeof position.entryId !== "string" ||
              !position.entryId ||
              position.entryId.length > 128)) ||
          !("offset" in position) ||
          typeof position.offset !== "number" ||
          !Number.isFinite(position.offset) ||
          Math.abs(position.offset) > 1_000_000 ||
          !("scrollTop" in position) ||
          typeof position.scrollTop !== "number" ||
          !Number.isFinite(position.scrollTop) ||
          position.scrollTop < 0 ||
          !("pinned" in position) ||
          typeof position.pinned !== "boolean"
        )
          continue;
        cache.set(scope, {
          position: {
            key: position.key,
            offset: position.offset,
            ...("entryId" in position && typeof position.entryId === "string"
              ? { entryId: position.entryId }
              : {}),
            scrollTop: position.scrollTop,
            pinned: position.pinned,
          },
        });
      }
    }
  } catch {
    /* An unavailable browser store does not block reading. */
  }
  cache.persist = () => {
    try {
      // A bookmark is presentation metadata, never a persisted history window.
      localStorage.setItem(
        READING_POSITION_STORAGE_KEY,
        JSON.stringify(
          [...cache].flatMap(([scope, state]) =>
            state.position?.key
              ? [
                  [
                    scope,
                    {
                      key: state.position.key,
                      entryId: state.position.entryId,
                      offset: state.position.offset,
                      scrollTop: state.position.scrollTop,
                      pinned: state.position.pinned,
                    },
                  ],
                ]
              : [],
          ),
        ),
      );
    } catch {
      /* Continue with the current in-memory position. */
    }
  };
  return cache;
}

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
  cache.persist?.();
}
