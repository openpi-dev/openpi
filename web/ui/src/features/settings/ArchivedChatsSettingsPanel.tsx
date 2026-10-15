import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  ChevronRight,
  Folder,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  WEB_MAX_ARCHIVED_SESSION_QUERY,
  type WebWorkspaceSummary,
} from "../../../../protocol/types.ts";
import {
  type ArchivedSessionPage,
  WebApiError,
  WebClient,
} from "../../protocol/client.ts";

export function ArchivedChatsSettingsPanel({
  workspaces,
  onRestore,
}: {
  workspaces: WebWorkspaceSummary[];
  onRestore: (path: string) => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const client = useMemo(() => new WebClient(), []);
  const [query, setQuery] = useState("");
  const [cwd, setCwd] = useState("");
  const [sort, setSort] = useState<"updated" | "created">("updated");
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [page, setPage] = useState<
    (ArchivedSessionPage & { scope: string }) | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{
    scope: string;
    stale: boolean;
    cursor?: string;
  } | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(new Set<string>());
  const inFlight = useRef(new Set<string>());
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const scopeKey = JSON.stringify([query.trim(), cwd, sort]);
  const currentScope = useRef({ key: scopeKey });
  if (currentScope.current.key !== scopeKey)
    currentScope.current = { key: scopeKey };
  const visiblePage = page?.scope === scopeKey ? page : null;
  const visibleError = error?.scope === scopeKey ? error : null;

  const load = useCallback(
    async (cursor?: string, retainedCount = 0) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(null);
      const options = {
        query: query.trim(),
        sort,
        ...(cwd ? { cwd } : {}),
        limit: 25,
      };
      try {
        let result = await client.listArchivedSessions(
          { ...options, ...(cursor ? { cursor } : {}) },
          controller.signal,
        );
        if (controller.signal.aborted || request.current !== controller) return;
        const sessions = [...result.sessions];
        while (
          !cursor &&
          sessions.length < retainedCount &&
          result.nextCursor
        ) {
          result = await client.listArchivedSessions(
            { ...options, cursor: result.nextCursor },
            controller.signal,
          );
          if (controller.signal.aborted || request.current !== controller)
            return;
          const additional = result.sessions.filter(
            (item) => !sessions.some((existing) => existing.path === item.path),
          );
          sessions.push(...additional);
          if (!additional.length) break;
        }
        setPage((previous) => ({
          ...result,
          scope: scopeKey,
          sessions:
            cursor && previous?.scope === scopeKey
              ? [
                  ...previous.sessions,
                  ...sessions.filter(
                    (item) =>
                      !previous.sessions.some(
                        (existing) => existing.path === item.path,
                      ),
                  ),
                ]
              : sessions,
        }));
      } catch (reason) {
        if (!controller.signal.aborted && request.current === controller)
          setError({
            scope: scopeKey,
            stale:
              reason instanceof WebApiError &&
              reason.code === "ARCHIVED_SESSION_CURSOR_STALE",
            ...(cursor ? { cursor } : {}),
          });
      } finally {
        if (request.current === controller) {
          request.current = null;
          setLoading(false);
        }
      }
    },
    [client, cwd, query, scopeKey, sort],
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setRestoreError(null);
    void load();
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [load]);

  const restore = async (path: string) => {
    if (inFlight.current.has(path)) return;
    inFlight.current.add(path);
    setRestoring(new Set(inFlight.current));
    setRestoreError(null);
    const scope = currentScope.current;
    try {
      const confirmed = await onRestore(path);
      if (!mounted.current || currentScope.current !== scope) return;
      if (!confirmed) {
        setRestoreError(path);
        return;
      }
      const retainedCount = visiblePage?.sessions.length ?? 0;
      setPage((previous) =>
        previous
          ? {
              ...previous,
              sessions: previous.sessions.filter((item) => item.path !== path),
            }
          : null,
      );
      await load(undefined, retainedCount);
    } catch {
      if (mounted.current && currentScope.current === scope)
        setRestoreError(path);
    } finally {
      inFlight.current.delete(path);
      if (mounted.current) setRestoring(new Set(inFlight.current));
    }
  };

  const groups = new Map<string, ArchivedSessionPage["sessions"]>();
  for (const session of visiblePage?.sessions ?? []) {
    const project = session.workspacePath ?? session.cwd;
    const list = groups.get(project) ?? [];
    list.push(session);
    groups.set(project, list);
  }
  const workspaceName = (path: string) =>
    workspaces.find((item) => item.path === path)?.name ??
    path.split(/[\\/]/u).filter(Boolean).at(-1) ??
    path;
  const workspaceOptions = [
    ...new Set([
      ...workspaces.map((item) => item.path),
      ...groups.keys(),
      ...(cwd ? [cwd] : []),
    ]),
  ];
  return (
    <section className="settings-content-page settings-archive-panel">
      <h1>{t("settingsArchivedChats")}</h1>
      <div className="settings-archive-toolbar">
        <label className="settings-archive-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            aria-label={t("searchArchivedChats")}
            placeholder={t("searchArchivedChats")}
            maxLength={WEB_MAX_ARCHIVED_SESSION_QUERY}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label={t("settingsClearSearch")}
              onClick={() => setQuery("")}
            >
              <X aria-hidden="true" />
            </button>
          )}
        </label>
        <select
          aria-label={t("archiveProjectFilter")}
          value={cwd}
          onChange={(event) => setCwd(event.target.value)}
        >
          <option value="">{t("archiveAllProjects")}</option>
          {workspaceOptions.map((path) => (
            <option key={path} value={path}>
              {workspaceName(path)}
            </option>
          ))}
        </select>
        <select
          aria-label={t("archiveSort")}
          value={sort}
          onChange={(event) =>
            setSort(event.target.value === "created" ? "created" : "updated")
          }
        >
          <option value="updated">{t("archiveSortUpdated")}</option>
          <option value="created">{t("archiveSortCreated")}</option>
        </select>
        <button
          type="button"
          className="icon-button"
          aria-label={t("refreshArchives")}
          disabled={loading}
          onClick={() => void load(undefined, visiblePage?.sessions.length)}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      {visibleError && (
        <div className="settings-archive-error" role="alert">
          <span>
            {t(visibleError.stale ? "archiveCursorStale" : "archiveLoadFailed")}
          </span>
          <button
            type="button"
            disabled={loading}
            onClick={() =>
              void load(visibleError.stale ? undefined : visibleError.cursor)
            }
          >
            {t("retryAdmissionCheck")}
          </button>
        </div>
      )}
      {restoreError && (
        <div className="settings-archive-error" role="alert">
          {t("restoreFailed")}
        </div>
      )}
      {loading && (
        <p role="status" className="settings-archive-status">
          {t("loadingArchives")}
        </p>
      )}
      {!loading && !visibleError && visiblePage?.sessions.length === 0 && (
        <div className="settings-archive-empty">
          <Archive aria-hidden="true" />
          <p>
            {t(
              query.trim() || cwd
                ? "noMatchingScannedArchives"
                : visiblePage.truncation.truncated
                  ? "noScannedArchives"
                  : "noArchivedSessions",
            )}
          </p>
        </div>
      )}
      <div className="settings-archive-groups">
        {[...groups].map(([path, sessions]) => (
          <section key={path} className="settings-archive-group">
            <button
              type="button"
              className="settings-archive-group-heading"
              aria-label={t("archiveProjectGroup", {
                project: workspaceName(path),
                count: sessions.length,
              })}
              aria-expanded={!collapsed.has(path)}
              aria-controls={`archive-group-${encodeURIComponent(path)}`}
              onClick={() =>
                setCollapsed((previous) => {
                  const next = new Set(previous);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                })
              }
            >
              {collapsed.has(path) ? (
                <ChevronRight aria-hidden="true" />
              ) : (
                <ChevronDown aria-hidden="true" />
              )}
              <Folder aria-hidden="true" />
              <span title={path}>{workspaceName(path)}</span>
              <small>{sessions.length}</small>
            </button>
            {!collapsed.has(path) && (
              <ul
                id={`archive-group-${encodeURIComponent(path)}`}
                className="settings-archive-list"
              >
                {sessions.map((session) => {
                  const title =
                    session.name ||
                    session.firstMessage ||
                    t("untitledSession");
                  const date = new Date(
                    sort === "created" ? session.created : session.modified,
                  );
                  return (
                    <li key={session.path} className="settings-archive-row">
                      <div>
                        <span
                          className="settings-archive-chat-title"
                          title={title}
                        >
                          {title}
                        </span>
                        <time
                          dateTime={
                            Number.isNaN(date.getTime())
                              ? undefined
                              : date.toISOString()
                          }
                        >
                          {Number.isNaN(date.getTime())
                            ? t("unknownState")
                            : new Intl.DateTimeFormat(i18n.language, {
                                dateStyle: "medium",
                              }).format(date)}
                        </time>
                      </div>
                      <button
                        type="button"
                        aria-label={t("restoreArchivedChat", { title })}
                        disabled={restoring.has(session.path)}
                        onClick={() => void restore(session.path)}
                      >
                        <ArchiveRestore aria-hidden="true" />
                        <span>
                          {t(
                            restoring.has(session.path)
                              ? "restoringConversation"
                              : "restoreConversation",
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        ))}
      </div>
      {!!visiblePage?.truncation.recordsUnscanned && (
        <p className="settings-archive-status">
          {t("archiveScanBounded", {
            count: visiblePage.truncation.recordsUnscanned,
          })}
        </p>
      )}
      {visiblePage?.nextCursor && (
        <button
          type="button"
          className="settings-archive-more"
          disabled={loading}
          onClick={() => void load(visiblePage.nextCursor)}
        >
          {t("moreArchives")}
        </button>
      )}
    </section>
  );
}
