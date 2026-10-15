import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WebHistoryAnchor,
  WebSessionProjection,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";
import type { TurnNavigationItem } from "./TurnNavigation.tsx";

export function usePromptNavigation(
  selected: WebSessionProjection | undefined,
  loaded: TurnNavigationItem[],
  active: boolean,
) {
  const client = useMemo(() => new WebClient(), []);
  const leaf = selected?.history?.leafEntryId ?? selected?.entries.at(-1)?.id;
  const sessionId = selected?.id;
  const sessionPath = selected?.path;
  const scope = JSON.stringify([selected?.id, selected?.path, leaf]);
  const owner = useRef(scope);
  owner.current = scope;
  const [index, setIndex] = useState<{ scope: string; ids: string[] } | null>(
    null,
  );
  const [previews, setPreviews] = useState<Record<string, TurnNavigationItem>>(
    {},
  );
  const requests = useRef(new Map<string, AbortController>());
  const anchor = useMemo<WebHistoryAnchor | null>(
    () =>
      sessionId && sessionPath && leaf
        ? { sessionId, sessionPath, entryId: leaf }
        : null,
    [sessionId, sessionPath, leaf],
  );

  useEffect(() => {
    setIndex(null);
    setPreviews({});
    if (!active || !anchor) return;
    const controller = new AbortController();
    const read = async () => {
      try {
        let before: string | null = null;
        let ids: string[] = [];
        const seen = new Set<string>();
        // A complete ID-only index enables unloaded landmarks. A capped or
        // failed index leaves the verified loaded window usable.
        for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
          const page = await client.sessionPromptHistory(
            anchor,
            before,
            controller.signal,
          );
          if (controller.signal.aborted || owner.current !== scope) return;
          if (
            page.sessionId !== anchor.sessionId ||
            page.sessionPath !== anchor.sessionPath ||
            page.anchorEntryId !== anchor.entryId ||
            page.requestedBeforeEntryId !== before ||
            page.entryIds.length > 100 ||
            page.entryIds.some((id) => !id || seen.has(id)) ||
            new Set(page.entryIds).size !== page.entryIds.length ||
            (page.nextBeforeEntryId !== null &&
              (page.entryIds.length === 0 ||
                page.nextBeforeEntryId !== page.entryIds[0]))
          )
            return;
          for (const id of page.entryIds) seen.add(id);
          ids = [...page.entryIds, ...ids];
          if (page.nextBeforeEntryId === null) {
            setIndex({ scope, ids });
            return;
          }
          before = page.nextBeforeEntryId;
        }
      } catch {
        /* Failed optional metadata never replaces a verified window. */
      }
    };
    const idle =
      typeof window.requestIdleCallback === "function"
        ? window.requestIdleCallback(() => void read(), { timeout: 2000 })
        : undefined;
    const timer =
      idle === undefined ? window.setTimeout(() => void read(), 0) : undefined;
    return () => {
      controller.abort();
      if (idle !== undefined) window.cancelIdleCallback(idle);
      if (timer !== undefined) window.clearTimeout(timer);
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, [scope, active, anchor, client]);

  const items = useMemo(() => {
    const byId = new Map(loaded.map((item) => [item.entryId, item]));
    if (index?.scope !== scope) return loaded;
    const ids = new Set(index.ids);
    return [
      ...index.ids.map(
        (entryId) =>
          byId.get(entryId) ??
          previews[entryId] ?? {
            entryId,
            title: "",
            previewState: "idle" as const,
          },
      ),
      ...loaded.filter((item) => !ids.has(item.entryId)),
    ];
  }, [index, scope, loaded, previews]);
  const available = useRef(items);
  available.current = items;
  const requestPreview = useCallback(
    (entryId: string) => {
      if (
        !active ||
        !anchor ||
        owner.current !== scope ||
        requests.current.has(entryId)
      )
        return;
      const item = available.current.find((item) => item.entryId === entryId);
      if (
        !item ||
        item.previewState === undefined ||
        item.previewState === "ready"
      )
        return;
      const controller = new AbortController();
      requests.current.set(entryId, controller);
      setPreviews((previous) => ({
        ...previous,
        [entryId]: { entryId, title: "", previewState: "loading" },
      }));
      void client
        .sessionPromptPreview(anchor, entryId, controller.signal)
        .then((preview) => {
          if (controller.signal.aborted || owner.current !== scope) return;
          if (
            preview.sessionId !== anchor.sessionId ||
            preview.sessionPath !== anchor.sessionPath ||
            preview.anchorEntryId !== anchor.entryId ||
            preview.entryId !== entryId ||
            typeof preview.prompt !== "string" ||
            typeof preview.response !== "string" ||
            Array.from(preview.prompt).length > 240 ||
            Array.from(preview.response).length > 240
          )
            throw new Error("Unverified preview");
          setPreviews((previous) => ({
            ...previous,
            [entryId]: {
              entryId,
              title: preview.prompt,
              reply: preview.response,
              previewState: "ready",
            },
          }));
        })
        .catch(() => {
          if (!controller.signal.aborted && owner.current === scope)
            setPreviews((previous) => ({
              ...previous,
              [entryId]: { entryId, title: "", previewState: "unavailable" },
            }));
        })
        .finally(() => {
          if (requests.current.get(entryId) === controller)
            requests.current.delete(entryId);
        });
    },
    [active, anchor, scope, client],
  );
  return { items, requestPreview };
}
