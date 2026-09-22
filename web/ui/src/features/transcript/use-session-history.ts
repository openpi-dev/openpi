import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  jsonByteLength,
  WEB_MAX_ENTRIES,
  WEB_MAX_SELECTED_TRANSCRIPT_BYTES,
  type WebHistoryAnchor,
  type WebSessionHistoryPage,
  type WebSessionProjection,
} from "../../../../protocol/types.ts";
import { WebApiError, WebClient } from "../../protocol/client.ts";

const MAX_READING_ENTRIES = WEB_MAX_ENTRIES * 4;
const MAX_READING_BYTES = WEB_MAX_SELECTED_TRANSCRIPT_BYTES * 4;
type ReadingWindow = {
  session: WebSessionProjection;
  anchor: string;
  validatedLeaf: string | null;
};
type PageRequest = {
  controller: AbortController;
  scope: string;
  anchor: WebHistoryAnchor;
  before: string;
  page?: WebSessionHistoryPage;
};

function scopeFor(session: WebSessionProjection | undefined) {
  return JSON.stringify([session?.id, session?.path]);
}

function compatible(window: ReadingWindow, session: WebSessionProjection) {
  return (
    session.history?.leafEntryId === window.validatedLeaf ||
    (session.history?.anchorEntryId === window.anchor &&
      session.history.anchorOnBranch === true)
  );
}

function truncationFor(
  entries: WebSessionProjection["entries"],
  base: WebSessionProjection["truncation"],
  entriesOmitted = base.entriesOmitted,
) {
  const messagesTruncated = entries.filter(
    (entry) => entry.message?.truncation,
  ).length;
  const messagePartsOmitted = entries.reduce(
    (sum, entry) => sum + (entry.message?.truncation?.partsOmitted ?? 0),
    0,
  );
  return {
    ...base,
    entriesOmitted,
    messagesTruncated,
    messagePartsOmitted,
    truncated:
      entriesOmitted > 0 || messagesTruncated > 0 || messagePartsOmitted > 0,
  };
}

export function useSessionHistory(
  selected: WebSessionProjection | undefined,
  callbacks: {
    onAnchorChange?: (anchor: WebHistoryAnchor | null) => void;
    onRefresh?: () => Promise<boolean>;
    beforePrepend: () => void;
  },
) {
  const client = useMemo(() => new WebClient(), []);
  const latest = useRef({ selected, callbacks });
  latest.current = { selected, callbacks };
  const cache = useRef<ReadingWindow | null>(null);
  const request = useRef<PageRequest | null>(null);
  const refreshAttempt = useRef<string | null>(null);
  const [window, setWindow] = useState<ReadingWindow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState(0);
  const scope = scopeFor(selected);
  const previousScope = useRef(scope);

  const publish = useCallback((next: ReadingWindow) => {
    cache.current = next;
    setWindow(next);
    latest.current.callbacks.onAnchorChange?.({
      sessionId: next.session.id,
      sessionPath: next.session.path,
      entryId: next.anchor,
    });
  }, []);
  const clear = useCallback((changed = false) => {
    request.current?.controller.abort();
    request.current = null;
    cache.current = null;
    setWindow(null);
    setLoading(false);
    setError(changed ? "historyChanged" : null);
    refreshAttempt.current = null;
    latest.current.callbacks.onAnchorChange?.(null);
    setReset((value) => value + 1);
  }, []);
  const refresh = useCallback((force = false) => {
    const current = cache.current;
    const session = latest.current.selected;
    if (!current || !session) return;
    const key = JSON.stringify([
      scopeFor(session),
      current.anchor,
      session.history?.leafEntryId,
    ]);
    if (!force && refreshAttempt.current === key) return;
    refreshAttempt.current = key;
    setError(null);
    const failed = () => {
      if (refreshAttempt.current !== key || cache.current !== current) return;
      request.current?.controller.abort();
      request.current = null;
      setLoading(false);
      setError("historyValidationUnavailable");
    };
    latest.current.callbacks.onAnchorChange?.({
      sessionId: current.session.id,
      sessionPath: current.session.path,
      entryId: current.anchor,
    });
    const refreshing = latest.current.callbacks.onRefresh?.();
    if (!refreshing) {
      failed();
      return;
    }
    void refreshing
      .then((ok) => {
        if (!ok) failed();
      })
      .catch(failed);
  }, []);
  const applyPage = useCallback(
    (pending: PageRequest) => {
      const current = cache.current;
      const session = latest.current.selected;
      if (
        !pending.page ||
        request.current !== pending ||
        pending.controller.signal.aborted ||
        !current ||
        !session ||
        pending.scope !== scopeFor(session) ||
        !compatible(current, session)
      )
        return;
      const page = pending.page;
      const known = new Set(current.session.entries.map((entry) => entry.id));
      const entries = [
        ...page.entries.filter((entry) => !known.has(entry.id)),
        ...current.session.entries,
      ];
      let bytes = jsonByteLength(entries);
      // Reading farther back evicts the distant newer end, never the visible top.
      while (
        entries.length > MAX_READING_ENTRIES ||
        bytes > MAX_READING_BYTES
      ) {
        const removed = entries.pop();
        if (!removed) break;
        bytes -= jsonByteLength(removed) + (entries.length ? 1 : 0);
      }
      latest.current.callbacks.beforePrepend();
      publish({
        ...current,
        anchor: entries.at(-1)?.id ?? current.anchor,
        session: {
          ...current.session,
          entries,
          bytes,
          truncation: truncationFor(
            entries,
            current.session.truncation,
            page.truncation.entriesOmitted,
          ),
          history: {
            ...current.session.history!,
            beforeEntryId: page.history?.beforeEntryId ?? null,
          },
        },
      });
      request.current = null;
      setLoading(false);
      setError(null);
    },
    [publish],
  );

  useLayoutEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      clear();
      return;
    }
    let current = cache.current;
    if (!current || !selected) return;
    if (
      selected.history?.anchorEntryId === current.anchor &&
      selected.history.anchorOnBranch === false
    ) {
      clear(true);
      void latest.current.callbacks.onRefresh?.();
      return;
    }
    if (!compatible(current, selected)) {
      refresh();
      return;
    }
    setError((current) =>
      current === "historyValidationUnavailable" ? null : current,
    );
    const leaf = selected.history?.leafEntryId ?? null;
    if (leaf !== current.validatedLeaf) {
      const overlap = selected.entries.findIndex(
        (entry) => entry.id === current!.anchor,
      );
      const following =
        overlap >= 0
          ? selected.entries.slice(overlap + 1)
          : selected.entries[0]?.parentId === current.anchor
            ? selected.entries
            : null;
      const addedBytes =
        following?.reduce((sum, entry) => sum + jsonByteLength(entry) + 1, 0) ??
        0;
      if (
        following &&
        current.session.entries.length + following.length <=
          MAX_READING_ENTRIES &&
        current.session.bytes + addedBytes <= MAX_READING_BYTES
      ) {
        current = {
          ...current,
          anchor: leaf ?? current.anchor,
          validatedLeaf: leaf,
          session: {
            ...current.session,
            entries: [...current.session.entries, ...following],
            bytes: current.session.bytes + addedBytes,
            truncation: truncationFor(
              [...current.session.entries, ...following],
              current.session.truncation,
            ),
          },
        };
      } else {
        // A missed snapshot can leave a gap. Keep the verified reading window
        // intact; Jump to latest returns to the bounded, current snapshot.
        current = { ...current, validatedLeaf: leaf };
      }
      publish(current);
    }
    if (request.current?.page) applyPage(request.current);
  }, [scope, selected, clear, refresh, publish, applyPage]);

  useLayoutEffect(
    () => () => {
      request.current?.controller.abort();
      request.current = null;
      latest.current.callbacks.onAnchorChange?.(null);
    },
    [],
  );

  const loadOlder = async () => {
    if (request.current) return;
    const session = latest.current.selected;
    if (!session?.history?.leafEntryId) return;
    let current = cache.current;
    if (current && !compatible(current, session)) {
      refresh(true);
      return;
    }
    if (!current) {
      current = {
        session,
        anchor: session.history.leafEntryId,
        validatedLeaf: session.history.leafEntryId,
      };
      publish(current);
    }
    const before = current.session.history?.beforeEntryId;
    if (!before) return;
    const pending: PageRequest = {
      controller: new AbortController(),
      scope: scopeFor(session),
      before,
      anchor: {
        sessionId: session.id,
        sessionPath: session.path,
        entryId: current.anchor,
      },
    };
    request.current = pending;
    setLoading(true);
    setError(null);
    try {
      const page = await client.sessionHistory(
        pending.anchor,
        before,
        pending.controller.signal,
      );
      if (
        request.current !== pending ||
        pending.controller.signal.aborted ||
        pending.scope !== scopeFor(latest.current.selected)
      )
        return;
      if (
        page.id !== session.id ||
        page.path !== session.path ||
        page.anchorEntryId !== pending.anchor.entryId ||
        page.requestedBeforeEntryId !== before ||
        page.history?.anchorEntryId !== pending.anchor.entryId ||
        page.history.anchorOnBranch !== true
      )
        throw new WebApiError(
          "Session history identity changed",
          409,
          "SESSION_HISTORY_CHANGED",
        );
      pending.page = page;
      applyPage(pending);
      if (request.current === pending) refresh();
    } catch (reason) {
      if (request.current !== pending || pending.controller.signal.aborted)
        return;
      request.current = null;
      setLoading(false);
      if (
        reason instanceof WebApiError &&
        reason.code === "SESSION_HISTORY_CHANGED"
      ) {
        clear(true);
        void latest.current.callbacks.onRefresh?.();
      } else setError("historyUnavailable");
    }
  };
  const visible = window && scopeFor(window.session) === scope ? window : null;
  const resetToLatest = useCallback(() => clear(), [clear]);
  const verifying = Boolean(
    visible && selected && !compatible(visible, selected),
  );
  return {
    session: visible?.session ?? selected,
    engaged: Boolean(visible),
    hasMore: Boolean((visible?.session ?? selected)?.history?.beforeEntryId),
    hasNewer: Boolean(
      visible && visible.anchor !== selected?.history?.leafEntryId,
    ),
    verifying,
    loading,
    error,
    reset,
    loadOlder,
    resetToLatest,
  };
}
