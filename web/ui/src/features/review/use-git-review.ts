import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const generation = useRef(0);
  const request = useRef<AbortController | null>(null);
  const [result, setResult] = useState<WebGitReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!session) return;
    const current = ++generation.current;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    try {
      const next = await client.gitReview(
        session.id,
        session.path,
        controller.signal,
      );
      if (generation.current === current) setResult(next);
    } catch (nextError) {
      if (generation.current === current)
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Git review unavailable",
        );
    } finally {
      if (generation.current === current) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [client, session]);

  useEffect(() => {
    void refreshKey;
    if (!session) {
      request.current?.abort();
      request.current = null;
      generation.current++;
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }
    const timer = window.setTimeout(() => void refresh(), 200);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
    };
  }, [refresh, refreshKey, session]);

  useEffect(() => {
    if (!session) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh, session]);

  return { result, loading, error, refresh };
}
