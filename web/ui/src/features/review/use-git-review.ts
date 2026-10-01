import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  WebGitReviewResult,
  WebGitReviewSource,
  WebSessionProjection,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";
import { useTranslation } from "react-i18next";

export function useGitReview(
  session: WebSessionProjection | undefined,
  refreshKey: number | undefined,
  {
    active = true,
    running = false,
  }: { active?: boolean; running?: boolean } = {},
) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const request = useRef<AbortController | null>(null);
  const timer = useRef<number | null>(null);
  const queued = useRef(false);
  const visibility = useRef({ active, running });
  visibility.current = { active, running };
  const [result, setResult] = useState<WebGitReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<WebGitReviewSource>("unstaged");
  const sessionId = session?.id;
  const sessionPath = session?.path;

  useLayoutEffect(() => {
    // A new target must not display the previous target's files, even briefly.
    void sessionPath;
    void source;
    setResult(null);
    setError(null);
    setLoading(Boolean(sessionId));
  }, [sessionId, sessionPath, source]);

  const refresh = useCallback(async () => {
    if (!sessionId || !sessionPath) return;
    if (document.visibilityState === "hidden") return;
    if (request.current) {
      queued.current = true;
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await client.gitReview(
        sessionId,
        sessionPath,
        controller.signal,
        { source, offset: "0" },
      );
      if (!controller.signal.aborted) {
        if (!next.ok)
          setError(
            t(
              next.reason === "not_git_repository"
                ? "gitReviewNotRepository"
                : next.reason === "baseline_unavailable"
                  ? "gitReviewBaselineUnavailable"
                  : "gitReviewFailed",
            ),
          );
        setResult((previous) => {
          if (!next.ok && previous?.ok) return previous;
          if (
            next.ok &&
            previous?.ok &&
            next.snapshot.revision === previous.snapshot.revision
          )
            return previous;
          return next;
        });
      }
    } catch (nextError) {
      if (!controller.signal.aborted)
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Git review unavailable",
        );
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setLoading(false);
        if (queued.current) {
          queued.current = false;
          const current = visibility.current;
          if ((current.active || !current.running) && timer.current === null) {
            timer.current = window.setTimeout(
              () => {
                timer.current = null;
                void refresh();
              },
              current.active ? 200 : 2000,
            );
          }
        }
      }
    }
  }, [client, sessionId, sessionPath, source, t]);

  const loadMore = useCallback(async () => {
    if (
      !sessionId ||
      !sessionPath ||
      !result?.ok ||
      result.snapshot.nextOffset === undefined ||
      request.current
    )
      return;
    const snapshot = result.snapshot;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await client.gitReview(
        sessionId,
        sessionPath,
        controller.signal,
        {
          source,
          offset: String(snapshot.nextOffset),
          revision: snapshot.revision,
        },
      );
      if (controller.signal.aborted) return;
      if (!next.ok || next.snapshot.revision !== snapshot.revision)
        throw new Error(
          t(
            !next.ok && next.reason === "revision_changed"
              ? "gitReviewChanged"
              : "gitReviewFailed",
          ),
        );
      setResult({
        ok: true,
        snapshot: {
          ...next.snapshot,
          files: [...snapshot.files, ...next.snapshot.files],
          additions: snapshot.additions + next.snapshot.additions,
          deletions: snapshot.deletions + next.snapshot.deletions,
        },
      });
    } catch (error) {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : t("gitReviewFailed"));
    } finally {
      if (!controller.signal.aborted) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [client, sessionId, sessionPath, source, result, t]);

  const readFile = useCallback(
    async (file: string, signal: AbortSignal, revision: string) => {
      if (!sessionId || !sessionPath) return;
      const response = await client.gitReview(sessionId, sessionPath, signal, {
        source,
        file,
        revision,
      });
      if (!response.ok || response.snapshot.revision !== revision)
        throw new Error(
          t(
            !response.ok && response.reason !== "revision_changed"
              ? "gitReviewFailed"
              : "gitReviewChanged",
          ),
        );
      return response.snapshot.files.find((entry) => entry.path === file);
    },
    [client, sessionId, sessionPath, source, t],
  );

  useEffect(() => {
    if (!sessionId) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void refresh();
    }, 200);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      queued.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    // Entering the panel promotes an idle background refresh. Cursor updates
    // must not keep restarting this timer while the panel is already visible.
    if (active && timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, [active]);

  useEffect(() => {
    void refreshKey;
    if (!active && running) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
      queued.current = false;
      return;
    }
    if (!sessionId || timer.current !== null) return;
    timer.current = window.setTimeout(
      () => {
        timer.current = null;
        void refresh();
      },
      active ? 200 : 2000,
    );
  }, [refresh, refreshKey, active, running, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const onFocus = () => {
      const current = visibility.current;
      if (current.active || !current.running) void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh, sessionId]);

  return useMemo(
    () => ({
      result,
      loading,
      error,
      refresh,
      source,
      setSource,
      readFile,
      loadMore,
    }),
    [result, loading, error, refresh, source, readFile, loadMore],
  );
}
