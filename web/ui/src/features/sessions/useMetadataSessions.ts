import { useCallback, useEffect, useRef, useState } from "react";
import type { WebMetadataSessionPage } from "../../../../protocol/types.ts";
import { WebApiError, type WebClient } from "../../protocol/client.ts";

/** Own only this chooser request; never mutate the shared snapshot or selection. */
export function useMetadataSessions(
  client: WebClient,
  query: string,
  enabled: boolean,
  selection: string,
) {
  const active = enabled && Boolean(query.trim());
  const key = JSON.stringify([active, query, selection]);
  const current = useRef({ key });
  if (current.current.key !== key) current.current = { key };
  const request = useRef<AbortController | null>(null);
  const [state, setState] = useState<{
    key: string;
    page?: WebMetadataSessionPage;
    loading: boolean;
    error?: "stale" | "failed";
    cursor?: string;
  }>({ key, loading: false });
  const scoped = state.key === key ? state : { key, loading: false };
  const load = useCallback(
    async (cursor?: string) => {
      if (!active) return;
      const scope = current.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setState((old) => ({
        ...(old.key === key ? old : { key }),
        loading: true,
      }));
      try {
        const page = await client.listMetadataSessions(
          { query, limit: 50, ...(cursor ? { cursor } : {}) },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          current.current !== scope ||
          request.current !== controller
        )
          return;
        setState((old) => ({
          key,
          loading: false,
          page: {
            ...page,
            sessions:
              cursor && old.key === key && old.page
                ? [
                    ...old.page.sessions,
                    ...page.sessions.filter(
                      (row) =>
                        !old.page!.sessions.some(
                          (prior) =>
                            prior.path === row.path && prior.id === row.id,
                        ),
                    ),
                  ]
                : page.sessions,
          },
        }));
      } catch (error) {
        if (
          !controller.signal.aborted &&
          current.current === scope &&
          request.current === controller
        ) {
          setState((old) => ({
            ...(old.key === key ? old : { key }),
            loading: false,
            error:
              error instanceof WebApiError &&
              error.code === "CATALOG_CURSOR_STALE"
                ? "stale"
                : "failed",
            ...(cursor ? { cursor } : {}),
          }));
        }
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [active, client, key, query],
  );
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => void load(), 200);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [active, load]);
  return { ...scoped, active, load };
}
