import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../../components/Markdown.tsx";
import { WebClient } from "../../protocol/client.ts";

export function FullMessageText({
  preview,
  sessionId,
  sessionPath,
  entryId,
  markdown,
  fullText,
  onComplete,
}: {
  preview: string;
  sessionId: string;
  sessionPath: string;
  entryId: string;
  markdown: boolean;
  fullText?: string;
  onComplete?: (text: string) => void;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const request = useRef<AbortController | null>(null);
  const [chunks, setChunks] = useState<string[] | null>(null);
  const [nextCursor, setNextCursor] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => () => request.current?.abort(), []);

  const load = async () => {
    if (request.current || nextCursor === null) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    try {
      const page = await client.sessionItem(
        sessionId,
        sessionPath,
        entryId,
        nextCursor,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        page.entryId !== entryId ||
        (page.nextCursor !== null && page.nextCursor <= nextCursor)
      )
        throw new Error("Message identity changed");
      const nextChunks =
        nextCursor === 0 ? [page.text] : [...(chunks ?? []), page.text];
      setChunks(nextChunks);
      setNextCursor(page.nextCursor);
      if (page.nextCursor === null) onComplete?.(nextChunks.join(""));
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  };

  const text = fullText ?? chunks?.join("") ?? preview;
  return (
    <>
      {markdown ? (
        <Markdown>{text}</Markdown>
      ) : (
        <div className="message-body">{text}</div>
      )}
      {fullText === undefined && nextCursor !== null && (
        <button
          type="button"
          className="message-load-full"
          disabled={loading}
          onClick={() => void load()}
        >
          {t(
            loading
              ? "messageLoadingFull"
              : error
                ? "messageLoadFailed"
                : chunks
                  ? "messageLoadMore"
                  : "messageLoadFull",
          )}
        </button>
      )}
    </>
  );
}
