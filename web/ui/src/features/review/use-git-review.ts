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

export function useGitReview(
  session: WebSessionProjection | undefined,
  refreshKey: number | undefined,
  {
    active = true,
    running = false,
  }: { active?: boolean; running?: boolean } = {},
) {
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
        { source },
      );
      if (!controller.signal.aborted) setResult(next);
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
  }, [client, sessionId, sessionPath, source]);

  const readFile = useCallback(
    async (file: string, signal: AbortSignal) => {
      if (!sessionId || !sessionPath) return;
      const response = await client.gitReview(sessionId, sessionPath, signal, {
        source,
        file,
      });
      if (!response.ok) throw new Error("File diff unavailable");
      return response.snapshot.files.find((entry) => entry.path === file);
    },
    [client, sessionId, sessionPath, source],
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
    () => ({ result, loading, error, refresh, source, setSource, readFile }),
    [result, loading, error, refresh, source, readFile],
  );
}
