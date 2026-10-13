import { Dialog } from "@astryxdesign/core/Dialog";
import { Circle, LoaderCircle } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  WebHistoryAnchor,
  WebSessionSummary,
  WebWorkspaceSummary,
} from "../../../../protocol/types.ts";
import type { WebTranscriptSearchResponse } from "../../../../search/transcript-search.ts";
import { sessionTitle, workspaceName } from "../../lib/format.ts";
import { WebClient } from "../../protocol/client.ts";
import "./transcript-search.css";

const sessionOptionKey = (session: WebSessionSummary) =>
  JSON.stringify(["session", session.id, session.path]);
const messageOptionKey = (
  match: WebTranscriptSearchResponse["matches"][number],
) =>
  JSON.stringify([
    "message",
    match.sessionId,
    match.sessionPath,
    match.messageId,
    match.source,
    match.lineOffset,
  ]);

export function TranscriptSearchDialog({
  open,
  initialQuery,
  initialIncludeArchived,
  sessions,
  workspaces,
  onClose,
  onCreateSession,
  onOpenSession,
  onOpenMessage,
}: {
  open: boolean;
  initialQuery: string;
  initialIncludeArchived: boolean;
  sessions?: readonly WebSessionSummary[];
  workspaces?: readonly WebWorkspaceSummary[];
  onClose: () => void;
  onCreateSession?: () => void;
  onOpenSession?: (
    path: string,
    signal?: AbortSignal,
  ) => Promise<boolean | void>;
  onOpenMessage: (
    anchor: WebHistoryAnchor,
    signal?: AbortSignal,
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [query, setQuery] = useState(initialQuery);
  const includeArchived = initialIncludeArchived;
  const [result, setResult] = useState<{
    query: string;
    revision: number;
    includeArchived: boolean;
    response: WebTranscriptSearchResponse;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [searchFailed, setSearchFailed] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const openingController = useRef<AbortController | null>(null);
  useEffect(() => {
    if (open) {
      setQuery(initialQuery);
      setResult(null);
      setSearchFailed(false);
      setOpenError(null);
      setOpening(null);
    }
    return () => {
      openingController.current?.abort();
      openingController.current = null;
    };
  }, [open, initialQuery]);
  const trimmed = query.trim();
  const workspaceNames = useMemo(
    () =>
      new Map(workspaces?.map((workspace) => [workspace.path, workspace.name])),
    [workspaces],
  );
  const localSessions = useMemo(() => {
    if (!open || !onOpenSession) return [];
    const needle = trimmed.toLocaleLowerCase();
    return (sessions ?? [])
      .filter((session) => {
        if (session.archived && !includeArchived) return false;
        return (
          !needle ||
          `${sessionTitle(session, t("untitledSession"))} ${session.cwd} ${workspaceNames.get(session.cwd) ?? ""}`
            .toLocaleLowerCase()
            .includes(needle)
        );
      })
      .sort(
        (a, b) =>
          b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path),
      );
  }, [
    open,
    sessions,
    workspaceNames,
    trimmed,
    includeArchived,
    onOpenSession,
    t,
  ]);
  const sessionGroups = trimmed
    ? [
        {
          name: "transcriptSearchSessions",
          sessions: localSessions.slice(0, 9),
        },
      ]
    : [
        {
          name: "pinnedConversations",
          sessions: localSessions
            .filter((session) => session.pinOrder !== undefined)
            .sort((a, b) => (a.pinOrder ?? 0) - (b.pinOrder ?? 0)),
        },
        {
          name: "transcriptSearchRecent",
          sessions: localSessions
            .filter((session) => session.pinOrder === undefined)
            .slice(0, 10),
        },
      ];
  useLayoutEffect(() => {
    // A different result set cannot retain its predecessor's pending reveal.
    void open;
    void trimmed;
    void includeArchived;
    void searchRevision;
    openingController.current?.abort();
    openingController.current = null;
    setOpening(null);
    setOpenError(null);
    setActiveOption(null);
  }, [open, trimmed, includeArchived, searchRevision]);
  useEffect(() => {
    if (!open || !trimmed) {
      setLoading(false);
      setSearchFailed(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setSearchFailed(false);
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
          if (!controller.signal.aborted) setSearchFailed(true);
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
  const optionKeys = [
    ...sessionGroups.flatMap((group) => group.sessions.map(sessionOptionKey)),
    ...(trimmed ? (response?.matches.map(messageOptionKey) ?? []) : []),
  ];
  const selectedKey =
    activeOption !== null && optionKeys.includes(activeOption)
      ? activeOption
      : optionKeys[0];
  const optionId = (key: string) => `${listId}-${encodeURIComponent(key)}`;
  const selectedId = selectedKey ? optionId(selectedKey) : undefined;
  useLayoutEffect(() => {
    if (open && selectedId)
      document
        .getElementById(selectedId)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedId]);
  const openResult = async (
    key: string,
    navigate: (signal: AbortSignal) => Promise<boolean | void>,
    failure: "transcriptSearchOpenFailed" | "transcriptSearchSessionOpenFailed",
  ) => {
    if (openingController.current) return;
    setActiveOption(key);
    input.current?.focus({ preventScroll: true });
    const controller = new AbortController();
    openingController.current = controller;
    setOpening(key);
    setOpenError(null);
    try {
      const opened = await navigate(controller.signal);
      if (controller.signal.aborted) return;
      if (opened !== false) onClose();
      else setOpenError(failure);
    } catch {
      if (!controller.signal.aborted) setOpenError(failure);
    } finally {
      if (openingController.current === controller) {
        openingController.current = null;
        setOpening(null);
      }
    }
  };
  const navigateResults = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return;
    if (
      !["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key) ||
      opening !== null
    )
      return;
    if (!selectedKey || !selectedId) {
      if (event.key === "Enter" && !trimmed && onCreateSession) {
        event.preventDefault();
        onClose();
        onCreateSession();
      }
      return;
    }
    event.preventDefault();
    const index = optionKeys.indexOf(selectedKey);
    if (event.key === "Enter") {
      document.getElementById(selectedId)?.click();
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? optionKeys.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, optionKeys.length - 1)
            : Math.max(index - 1, 0);
    setActiveOption(optionKeys[next] ?? null);
  };
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next: boolean) => !next && onClose()}
      purpose="info"
      width="min(520px, 92vw)"
      maxHeight="calc(var(--transcript-search-list-height) + 64px)"
      padding={0}
      className="transcript-search-modal"
      aria-label={t("transcriptSearch")}
    >
      {open && (
        <div className="transcript-search-dialog">
          <h2 className="transcript-search-sr-only">{t("transcriptSearch")}</h2>
          <input
            ref={input}
            className="transcript-search-input"
            data-autofocus
            type="search"
            maxLength={200}
            value={query}
            aria-label={t("transcriptSearch")}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={selectedId}
            placeholder={t("transcriptSearchPlaceholder")}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={navigateResults}
          />
          <span className="transcript-search-sr-only" role="status">
            {loading ? t("transcriptSearching") : null}
          </span>
          <div className="transcript-search-groups">
            <div id={listId} role="listbox" aria-label={t("transcriptSearch")}>
              {sessionGroups
                .filter(
                  (group) =>
                    group.sessions.length > 0 ||
                    (trimmed && response?.matches.length),
                )
                .map((group) => (
                  <fieldset key={group.name} aria-label={t(group.name)}>
                    <h3>
                      {t(group.name)}
                      {loading && (
                        <LoaderCircle
                          className="is-spinning"
                          aria-hidden="true"
                        />
                      )}
                    </h3>
                    <ul
                      className="transcript-search-results"
                      role="presentation"
                    >
                      {onOpenSession &&
                        group.sessions.map((session) => {
                          const name = sessionTitle(
                            session,
                            t("untitledSession"),
                          );
                          const key = sessionOptionKey(session);
                          const project = session.ungrouped
                            ? t("ungrouped")
                            : workspaceNames.get(session.cwd) ||
                              workspaceName(session.cwd);
                          return (
                            <li key={key} role="presentation">
                              <button
                                id={optionId(key)}
                                role="option"
                                aria-selected={key === selectedKey}
                                tabIndex={-1}
                                type="button"
                                disabled={opening !== null}
                                aria-label={t("transcriptSearchSessionResult", {
                                  session: name,
                                })}
                                onPointerMove={() => setActiveOption(key)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() =>
                                  void openResult(
                                    key,
                                    (signal) =>
                                      onOpenSession(session.path, signal),
                                    "transcriptSearchSessionOpenFailed",
                                  )
                                }
                              >
                                <span
                                  className="transcript-search-accessory"
                                  aria-hidden="true"
                                >
                                  {opening === key ? (
                                    <LoaderCircle className="is-spinning" />
                                  ) : session.unread ? (
                                    <Circle className="transcript-search-unread" />
                                  ) : null}
                                </span>
                                <span className="transcript-search-result-body">
                                  <span className="transcript-search-result-line">
                                    <span
                                      className="transcript-search-title"
                                      title={name}
                                    >
                                      {name}
                                    </span>
                                    <span
                                      className="transcript-search-project"
                                      title={session.cwd}
                                    >
                                      {project}
                                    </span>
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      {trimmed &&
                        response?.matches.map((match) => {
                          const name =
                            match.sessionName || t("untitledSession");
                          const source = t(
                            `transcriptSearchSource_${match.source}`,
                          );
                          const key = messageOptionKey(match);
                          return (
                            <li key={key} role="presentation">
                              <button
                                id={optionId(key)}
                                role="option"
                                aria-selected={key === selectedKey}
                                tabIndex={-1}
                                type="button"
                                disabled={opening !== null}
                                aria-label={t("transcriptSearchResult", {
                                  session: name,
                                  source,
                                })}
                                onPointerMove={() => setActiveOption(key)}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={() =>
                                  void openResult(
                                    key,
                                    (signal) =>
                                      onOpenMessage(
                                        {
                                          sessionId: match.sessionId,
                                          sessionPath: match.sessionPath,
                                          entryId: match.messageId,
                                        },
                                        signal,
                                      ),
                                    "transcriptSearchOpenFailed",
                                  )
                                }
                              >
                                <span
                                  className="transcript-search-accessory"
                                  aria-hidden="true"
                                >
                                  {opening === key && (
                                    <LoaderCircle className="is-spinning" />
                                  )}
                                </span>
                                <span className="transcript-search-result-body">
                                  <span className="transcript-search-result-line">
                                    <span
                                      className="transcript-search-title"
                                      title={name}
                                    >
                                      {name}
                                    </span>
                                    <span
                                      className="transcript-search-project"
                                      title={match.workspace ?? source}
                                    >
                                      {match.workspace
                                        ? workspaceNames.get(match.workspace) ||
                                          workspaceName(match.workspace)
                                        : source}
                                    </span>
                                  </span>
                                  <span className="transcript-search-snippet">
                                    {match.snippet}
                                  </span>
                                </span>
                              </button>
                            </li>
                          );
                        })}
                    </ul>
                  </fieldset>
                ))}
            </div>
            {!trimmed && !localSessions.length && (
              <div className="transcript-search-empty-history">
                <p>{t("noConversations")}</p>
                {onCreateSession && (
                  <button
                    className="transcript-search-create"
                    type="button"
                    onClick={() => {
                      onClose();
                      onCreateSession();
                    }}
                  >
                    {t("newSession")}
                  </button>
                )}
              </div>
            )}
            {trimmed &&
              !localSessions.length &&
              !response?.matches.length &&
              (loading ? (
                <div className="transcript-search-feedback" aria-hidden="true">
                  <LoaderCircle className="is-spinning" />
                </div>
              ) : response && !searchFailed ? (
                <div className="transcript-search-feedback" role="status">
                  {t("transcriptSearchEmpty")}
                </div>
              ) : null)}
            {searchFailed && (
              <p className="transcript-search-error" role="alert">
                {t("transcriptSearchFailed")}
                <button
                  type="button"
                  onClick={() => setSearchRevision((value) => value + 1)}
                >
                  {t("transcriptSearchRetry")}
                </button>
              </p>
            )}
            {openError && (
              <p className="transcript-search-error" role="alert">
                {t(openError)}
              </p>
            )}
            {response?.partial && (
              <p className="transcript-search-partial">
                {t("transcriptSearchPartial")}
              </p>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
