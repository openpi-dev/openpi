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
  WebSessionProjection,
} from "../../../../protocol/types.ts";
import { WebClient } from "../../protocol/client.ts";

export function useGitReview(
  session: WebSessionProjection | undefined,
  refreshKey: number | undefined,
) {
  const client = useMemo(() => new WebClient(), []);
  const request = useRef<AbortController | null>(null);
  const [result, setResult] = useState<WebGitReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionId = session?.id;
  const sessionPath = session?.path;

  useLayoutEffect(() => {
    // A new target must not display the previous target's files, even briefly.
    void sessionPath;
    setResult(null);
    setError(null);
    setLoading(Boolean(sessionId));
  }, [sessionId, sessionPath]);

  const refresh = useCallback(async () => {
    if (!sessionId || !sessionPath) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await client.gitReview(
        sessionId,
        sessionPath,
        controller.signal,
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
      }
    }
  }, [client, sessionId, sessionPath]);

  useEffect(() => {
    void refreshKey;
    if (!sessionId) return;
    const timer = window.setTimeout(() => void refresh(), 200);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
      request.current = null;
    };
  }, [refresh, refreshKey, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, sessionId]);

  return { result, loading, error, refresh };
}
