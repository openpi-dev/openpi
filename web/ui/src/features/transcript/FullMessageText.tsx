import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "../../components/Markdown.tsx";
import { WebClient } from "../../protocol/client.ts";
import { UserMessageContent } from "./UserMessageContent.tsx";

export function FullMessageText({
  preview,
  sessionId,
  sessionPath,
  entryId,
  markdown,
  fullText,
  onComplete,
  onProgress,
  purpose,
}: {
  preview: string;
  sessionId: string;
  sessionPath: string;
  entryId: string;
  markdown: boolean;
  fullText?: string;
  onComplete?: (text: string) => void;
  onProgress?: (text: string) => void;
  purpose?: "plan";
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const request = useRef<AbortController | null>(null);
  const loadButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
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
        ...(purpose ? ([purpose] as const) : []),
      );
      if (controller.signal.aborted) return;
      if (
        page.entryId !== entryId ||
        (purpose === "plan" && page.planStatus !== "ready") ||
        (page.nextCursor !== null && page.nextCursor <= nextCursor)
      )
        throw new Error("Message identity changed");
      const nextChunks =
        nextCursor === 0 ? [page.text] : [...(chunks ?? []), page.text];
      setChunks(nextChunks);
      setNextCursor(page.nextCursor);
      if (page.nextCursor === null) {
        onComplete?.(nextChunks.join(""));
        if (
          document.activeElement === loadButton.current &&
          !body.current?.closest("[hidden]")
        )
          body.current?.focus();
      } else onProgress?.(nextChunks.join(""));
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
      <div ref={body} className="message-full-text" tabIndex={-1}>
        {markdown ? (
          <Markdown>{text}</Markdown>
        ) : (
          <UserMessageContent
            content={text}
            incomplete={fullText === undefined && nextCursor !== null}
          />
        )}
      </div>
      {fullText === undefined && nextCursor !== null && (
        <button
          ref={loadButton}
          type="button"
          className="message-load-full"
          aria-disabled={loading}
          onClick={() => void load()}
        >
          {t(
            loading
              ? purpose === "plan"
                ? "planCardLoadingFull"
                : "messageLoadingFull"
              : error
                ? purpose === "plan"
                  ? "planCardLoadFailed"
                  : "messageLoadFailed"
                : chunks
                  ? "messageLoadMore"
                  : purpose === "plan"
                    ? "planCardLoadFull"
                    : "messageLoadFull",
          )}
        </button>
      )}
    </>
  );
}
