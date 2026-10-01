import { Dialog } from "@astryxdesign/core/Dialog";
import { LoaderCircle, MessageSquare, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebHistoryAnchor } from "../../../../protocol/types.ts";
import type { WebTranscriptSearchResponse } from "../../../../search/transcript-search.ts";
import { WebClient } from "../../protocol/client.ts";

export function TranscriptSearchDialog({
  open,
  initialQuery,
  initialIncludeArchived,
  onClose,
  onOpenMessage,
}: {
  open: boolean;
  initialQuery: string;
  initialIncludeArchived: boolean;
  onClose: () => void;
  onOpenMessage: (
    anchor: WebHistoryAnchor,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [query, setQuery] = useState(initialQuery);
  const [includeArchived, setIncludeArchived] = useState(
    initialIncludeArchived,
  );
  const [result, setResult] = useState<{
    query: string;
    revision: number;
    includeArchived: boolean;
    response: WebTranscriptSearchResponse;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const mounted = useRef(false);
  const openRequest = useRef(0);
  const openingController = useRef<AbortController | null>(null);
  useEffect(() => {
    mounted.current = open;
    if (open) {
      setQuery(initialQuery);
      setIncludeArchived(initialIncludeArchived);
      setResult(null);
      setError(null);
      setOpening(null);
      input.current?.focus();
    }
    return () => {
      mounted.current = false;
      openRequest.current += 1;
      openingController.current?.abort();
      openingController.current = null;
    };
  }, [open, initialQuery, initialIncludeArchived]);
  const trimmed = query.trim();
  useLayoutEffect(() => {
    // A different result set cannot retain its predecessor's pending reveal.
    void open;
    void trimmed;
    void includeArchived;
    void searchRevision;
    openRequest.current += 1;
    openingController.current?.abort();
    openingController.current = null;
    setOpening(null);
  }, [open, trimmed, includeArchived, searchRevision]);
  useEffect(() => {
    if (!open || !trimmed) {
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      void client
        .searchTranscripts(trimmed, {
          includeArchived,
          signal: controller.signal,
        })
        .then((response) => {
          if (!controller.signal.aborted)
            setResult({
              query: trimmed,
              revision: searchRevision,
              includeArchived,
              response,
            });
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("transcriptSearchFailed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, open, trimmed, includeArchived, searchRevision]);
  const response =
    result?.query === trimmed &&
    result.revision === searchRevision &&
    result.includeArchived === includeArchived
      ? result.response
      : null;
  const openMessage = async (anchor: WebHistoryAnchor) => {
    if (opening) return;
    const controller = new AbortController();
    openingController.current = controller;
    const request = ++openRequest.current;
    setOpening(anchor.entryId);
    setError(null);
    try {
      const opened = await onOpenMessage(anchor, controller.signal);
      if (
        controller.signal.aborted ||
        !mounted.current ||
        request !== openRequest.current
      )
        return;
      if (opened) onClose();
      else setError("transcriptSearchOpenFailed");
    } catch {
      if (
        !controller.signal.aborted &&
        mounted.current &&
        request === openRequest.current
      )
        setError("transcriptSearchOpenFailed");
    } finally {
      if (openingController.current === controller)
        openingController.current = null;
      if (mounted.current && request === openRequest.current) setOpening(null);
    }
  };
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next: boolean) => !next && onClose()}
      purpose="form"
      width={680}
      aria-label={t("transcriptSearch")}
    >
      <div className="openpi-dialog transcript-search-dialog">
        <div className="transcript-search-heading">
          <Search aria-hidden="true" />
          <strong>{t("transcriptSearch")}</strong>
        </div>
        <label className="transcript-search-input">
          <Search aria-hidden="true" />
          <input
            ref={input}
            type="search"
            maxLength={200}
            value={query}
            aria-label={t("transcriptSearch")}
            placeholder={t("transcriptSearchPlaceholder")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                results.current
                  ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
                  ?.focus();
              }
            }}
          />
        </label>
        <label className="transcript-search-scope">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />
          {t("transcriptSearchIncludeArchived")}
        </label>
        <div className="transcript-search-feedback" role="status">
          {loading ? (
            <>
              <LoaderCircle className="is-spinning" aria-hidden="true" />
              {t("transcriptSearching")}
            </>
          ) : response && !response.matches.length ? (
            t("transcriptSearchEmpty")
          ) : null}
        </div>
        {error && (
          <p className="transcript-search-error" role="alert">
            {t(error)}
            {error === "transcriptSearchFailed" && (
              <button
                type="button"
                onClick={() => setSearchRevision((value) => value + 1)}
              >
                {t("transcriptSearchRetry")}
              </button>
            )}
          </p>
        )}
        {response && (
          <>
            <ul
              ref={results}
              className="transcript-search-results"
              aria-label={t("transcriptSearch")}
              onKeyDown={(event) => {
                if (
                  !["ArrowDown", "ArrowUp", "Home", "End"].includes(
                    event.key,
                  ) ||
                  event.nativeEvent.isComposing
                )
                  return;
                const buttons = Array.from(
                  results.current?.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ) ?? [],
                );
                if (!buttons.length) return;
                event.preventDefault();
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : event.key === "ArrowDown"
                        ? Math.min(index + 1, buttons.length - 1)
                        : Math.max(index - 1, 0);
                buttons[next]?.focus();
              }}
            >
              {response.matches.map((match) => {
                const name = match.sessionName || t("untitledSession");
                const source = t(`transcriptSearchSource_${match.source}`);
                return (
                  <li
                    key={JSON.stringify([
                      match.sessionId,
                      match.sessionPath,
                      match.messageId,
                      match.source,
                      match.lineOffset,
                    ])}
                  >
                    <button
                      type="button"
                      disabled={opening !== null}
                      aria-label={t("transcriptSearchResult", {
                        session: name,
                        source,
                      })}
                      onClick={() =>
                        void openMessage({
                          sessionId: match.sessionId,
                          sessionPath: match.sessionPath,
                          entryId: match.messageId,
                        })
                      }
                    >
                      <MessageSquare aria-hidden="true" />
                      <span>
                        <strong>{name}</strong>
                        <small>
                          {source}
                          {match.toolName ? ` · ${match.toolName}` : ""}
                        </small>
                        <span className="transcript-search-snippet">
                          {match.snippet}
                        </span>
                      </span>
                      {opening === match.messageId && (
                        <LoaderCircle
                          className="is-spinning"
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {response.partial && (
              <p className="transcript-search-partial">
                {t("transcriptSearchPartial")}
              </p>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
