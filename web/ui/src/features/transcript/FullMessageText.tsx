import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  partIndex,
}: {
  preview: string;
  sessionId: string;
  sessionPath: string;
  entryId: string;
  markdown: boolean;
  fullText?: string;
  onComplete?: (text: string) => void;
  onProgress?: (text: string) => void;
  purpose?: "plan" | "thinking";
  partIndex?: number;
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

  const load = useCallback(async () => {
    if (request.current || nextCursor === null) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(false);
    try {
      const identity = [
        sessionId,
        sessionPath,
        entryId,
        nextCursor,
        controller.signal,
      ] as const;
      const page = await (purpose === "thinking"
        ? client.sessionItem(...identity, purpose, partIndex)
        : purpose
          ? client.sessionItem(...identity, purpose)
          : client.sessionItem(...identity));
      if (controller.signal.aborted) return;
      if (
        page.entryId !== entryId ||
        (purpose === "plan" && page.planStatus !== "ready") ||
        (purpose === "thinking" && page.partIndex !== partIndex) ||
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
  }, [
    client,
    sessionId,
    sessionPath,
    entryId,
    nextCursor,
    purpose,
    partIndex,
    chunks,
    onComplete,
    onProgress,
  ]);

  useEffect(() => {
    if (
      purpose !== "thinking" ||
      fullText !== undefined ||
      chunks !== null ||
      error
    )
      return;
    const element = body.current;
    if (!element) return;
    // A default-open reasoning row inside a folded turn is still hidden.
    // Hydrate only when its expanded body is actually brought into view.
    if (typeof IntersectionObserver === "undefined") {
      if (!element.closest("[hidden], details:not([open])")) void load();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        void load();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [purpose, fullText, chunks, error, load]);

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
      {purpose === "thinking" &&
        fullText === undefined &&
        nextCursor !== null && (
          <p className="evidence-warning">{t("thinkingPartialText")}</p>
        )}
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
                : purpose === "thinking"
                  ? "thinkingLoadingFull"
                  : "messageLoadingFull"
              : error
                ? purpose === "plan"
                  ? "planCardLoadFailed"
                  : purpose === "thinking"
                    ? "thinkingLoadFailed"
                    : "messageLoadFailed"
                : chunks
                  ? "messageLoadMore"
                  : purpose === "plan"
                    ? "planCardLoadFull"
                    : purpose === "thinking"
                      ? "thinkingLoadFull"
                      : "messageLoadFull",
          )}
        </button>
      )}
    </>
  );
}
