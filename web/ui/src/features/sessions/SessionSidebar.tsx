import { Dialog } from "@astryxdesign/core/Dialog";
import type { DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Archive,
  ArchiveRestore,
  CircleDot,
  ListOrdered,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  WEB_MAX_ARCHIVED_SESSION_QUERY,
  type WebSnapshot,
} from "../../../../protocol/types.ts";
import { OpenPiLogo } from "../../components/OpenPiLogo.tsx";
import { compactPath, relativeTime, sessionTitle } from "../../lib/format.ts";
import {
  type ArchivedSessionPage,
  WebApiError,
  WebClient,
} from "../../protocol/client.ts";
import type { WebStoreActions } from "../../store/web-store.ts";

interface SessionSidebarProps {
  snapshot: WebSnapshot | null;
  selectedPath: string | null;
  selectedWorkspace: string | null;
  collapsed: Set<string>;
  query: string;
  searchOpen: boolean;
  mobileOpen: boolean;
  settingsDisabled: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings: () => void;
  actions: WebStoreActions;
}

type EditTarget = { kind: "workspace" | "session"; path: string; name: string };
type DeleteTarget = { path: string; name: string };

function ActionMenu({
  items,
  label,
}: {
  items: DropdownMenuOption[];
  label: string;
}) {
  return (
    <span className="astryx-menu-trigger">
      <DropdownMenu
        button={{
          label,
          icon: <MoreHorizontal />,
          isIconOnly: true,
          size: "sm",
          variant: "ghost",
          className: "menu-action-button",
        }}
        items={items}
        menuWidth={190}
        placement="below"
        alignment="end"
        hasChevron={false}
      />
    </span>
  );
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { t } = useTranslation();
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [draft, setDraft] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const snapshot = props.snapshot;
  const client = useMemo(() => new WebClient(), []);
  const [archived, setArchived] = useState(false);
  const archiveQuery = props.query.trim();
  const archiveScope = JSON.stringify([archived, archiveQuery]);
  const currentArchiveScope = useRef(archiveScope);
  currentArchiveScope.current = archiveScope;
  const mounted = useRef(false);
  const [archivePage, setArchivePage] = useState<
    (ArchivedSessionPage & { query: string }) | null
  >(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<{
    query: string;
    kind: "failed" | "stale";
    cursor?: string;
  } | null>(null);
  const archiveRequest = useRef<AbortController | null>(null);
  const scopedArchivePage =
    archivePage?.query === archiveQuery ? archivePage : null;
  const scopedArchiveError =
    archiveError?.query === archiveQuery ? archiveError : null;
  const loadArchives = useCallback(
    async (cursor?: string) => {
      if (!archived) return;
      archiveRequest.current?.abort();
      const controller = new AbortController();
      archiveRequest.current = controller;
      setArchiveLoading(true);
      setArchiveError(null);
      try {
        const page = await client.listArchivedSessions(
          { query: archiveQuery, ...(cursor ? { cursor } : {}), limit: 25 },
          controller.signal,
        );
        if (controller.signal.aborted || archiveRequest.current !== controller)
          return;
        setArchivePage((previous) => ({
          ...page,
          query: archiveQuery,
          sessions:
            cursor && previous?.query === archiveQuery
              ? [
                  ...previous.sessions,
                  ...page.sessions.filter(
                    (session) =>
                      !previous.sessions.some(
                        (existing) => existing.path === session.path,
                      ),
                  ),
                ]
              : page.sessions,
        }));
      } catch (error) {
        if (!controller.signal.aborted && archiveRequest.current === controller)
          setArchiveError({
            query: archiveQuery,
            kind:
              error instanceof WebApiError &&
              error.code === "ARCHIVED_SESSION_CURSOR_STALE"
                ? "stale"
                : "failed",
            ...(cursor ? { cursor } : {}),
          });
      } finally {
        if (archiveRequest.current === controller) {
          archiveRequest.current = null;
          setArchiveLoading(false);
        }
      }
    },
    [archiveQuery, archived, client],
  );
  const [archiveCollapsed, setArchiveCollapsed] = useState<Set<string>>(
    new Set(),
  );
  const [restoring, setRestoring] = useState<Set<string>>(new Set());
  const restoreInFlight = useRef(new Set<string>());
  const [restoreError, setRestoreError] = useState(false);
  const [saving, setSaving] = useState(false);
  const restore = async (path: string) => {
    if (restoreInFlight.current.has(path)) return;
    restoreInFlight.current.add(path);
    setRestoring(new Set(restoreInFlight.current));
    setRestoreError(false);
    const scope = archiveScope;
    try {
      const restored = await props.actions.unarchiveSession(path);
      if (!mounted.current || currentArchiveScope.current !== scope) return;
      if (!restored) setRestoreError(true);
      else {
        setArchivePage((page) =>
          page
            ? {
                ...page,
                sessions: page.sessions.filter((item) => item.path !== path),
              }
            : null,
        );
        await loadArchives();
      }
    } finally {
      restoreInFlight.current.delete(path);
      if (mounted.current) setRestoring(new Set(restoreInFlight.current));
    }
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setRestoreError(false);
    setArchiveError(null);
    if (archived) {
      setArchivePage((page) => (page?.query === archiveQuery ? page : null));
      void loadArchives();
    }
    return () => {
      archiveRequest.current?.abort();
      archiveRequest.current = null;
    };
  }, [archiveQuery, archived, loadArchives]);

  useEffect(() => {
    if (!props.searchOpen) return;
    searchInput.current?.focus();
    return () => searchButton.current?.focus();
  }, [props.searchOpen]);
  useEffect(() => {
    if (!props.mobileOpen) return;
    closeButton.current?.focus();
    return () => {
      const trigger = props.returnFocusRef?.current;
      if (trigger?.checkVisibility()) trigger.focus();
    };
  }, [props.mobileOpen, props.returnFocusRef]);
  // A refreshed/filtered row can remove the focused control in any commit.
  useEffect(() => {
    if (
      props.mobileOpen &&
      document.activeElement === document.body &&
      !document.querySelector("dialog:modal")
    )
      closeButton.current?.focus();
  });
  useEffect(() => {
    if (!editTarget) return;
    editInput.current?.focus();
    editInput.current?.select();
  }, [editTarget]);

  const grouped = useMemo(() => {
    const query = props.query.trim().toLowerCase();
    const sessions = archived
      ? (scopedArchivePage?.sessions ?? [])
      : (snapshot?.sessions ?? []);
    const visible = (workspacePath: string, workspaceMatches: boolean) =>
      sessions.filter(
        (session) =>
          Boolean(session.archived) === archived &&
          (workspacePath === "__ungrouped__"
            ? session.ungrouped
            : session.cwd === workspacePath && !session.ungrouped) &&
          (!query ||
            archived ||
            workspaceMatches ||
            `${sessionTitle(session, t("untitledSession"))} ${session.cwd}`
              .toLowerCase()
              .includes(query)),
      );
    const workspaces = [...(snapshot?.workspaces ?? [])];
    for (const session of sessions) {
      if (
        !session.ungrouped &&
        !workspaces.some((workspace) => workspace.path === session.cwd)
      ) {
        workspaces.push({
          path: session.cwd,
          name: session.cwd,
          current: false,
        });
      }
    }
    return [
      ...workspaces.map((workspace) => {
        const matches =
          Boolean(query) &&
          `${workspace.name} ${workspace.path}`.toLowerCase().includes(query);
        return {
          ...workspace,
          sessions: visible(workspace.path, matches),
          ungrouped: false,
          matches,
        };
      }),
      {
        path: "__ungrouped__",
        name: t("ungrouped"),
        current: false,
        sessions: visible("__ungrouped__", false),
        ungrouped: true,
        matches: false,
      },
    ].filter(
      (group) =>
        group.sessions.length > 0 ||
        (!archived && !group.ungrouped && (!query || group.matches)),
    );
  }, [archived, props.query, scopedArchivePage, snapshot, t]);

  const confirmedPath =
    snapshot?.selectedSession?.path === props.selectedPath
      ? props.selectedPath
      : null;
  const activeWorkspace = confirmedPath
    ? (snapshot?.selectedSession?.cwd ??
      snapshot?.sessions.find(
        (session) =>
          session.path === confirmedPath &&
          session.id === snapshot?.selectedSession?.id,
      )?.cwd)
    : props.selectedPath
      ? null
      : props.selectedWorkspace;
  const loadedHistoryBounded = Boolean(
    snapshot?.truncation.sessionsOmitted ||
      snapshot?.truncation.workspacesOmitted,
  );

  const openEdit = (target: EditTarget) => {
    setDraft(target.name);
    setEditTarget(target);
  };
  const saveEdit = async () => {
    const name = draft.trim();
    if (!editTarget || !name || saving) return;
    setSaving(true);
    try {
      if (editTarget.kind === "workspace")
        await props.actions.renameWorkspace(editTarget.path, name);
      else await props.actions.renameSession(editTarget.path, name);
      setEditTarget(null);
    } catch {
      // The store reports the error; keep the user's draft in the dialog.
    } finally {
      setSaving(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Only the modal dialog handles keys; the desktop complementary landmark does not.
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-modal is present only with the responsive dialog role, verified by browser accessibility tests.
    <div
      ref={sidebar}
      id="session-sidebar"
      className="session-sidebar"
      role={props.mobileOpen ? "dialog" : "complementary"}
      aria-modal={props.mobileOpen || undefined}
      aria-label="Session navigation"
      tabIndex={props.mobileOpen ? -1 : undefined}
      onKeyDown={(event) => {
        if (!props.mobileOpen || event.defaultPrevented) return;
        // Native dialogs own focus; menus own dismissal but return Tab to the drawer.
        if (
          event.target instanceof Element &&
          (event.target.closest("dialog") ||
            (event.key !== "Tab" && event.target.closest('[role="menu"]')))
        )
          return;
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          props.actions.closeMobileSidebar();
        }
        if (event.key !== "Tab") return;
        const controls = Array.from(
          sidebar.current?.querySelectorAll<HTMLElement>(
            "button, input, select, textarea, a[href], [tabindex]",
          ) ?? [],
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(":disabled") &&
            element.checkVisibility({ visibilityProperty: true }),
        );
        const next = event.shiftKey ? controls.at(-1) : controls[0];
        const boundary = event.shiftKey ? controls[0] : controls.at(-1);
        if (
          document.activeElement === sidebar.current ||
          document.activeElement === boundary
        ) {
          event.preventDefault();
          next?.focus();
        }
      }}
    >
      <div className="sidebar-brand">
        <OpenPiLogo compact />
        <Tooltip content={t("collapseSidebar")} placement="end">
          <button
            ref={closeButton}
            className="collapse-button"
            type="button"
            aria-label={t("collapseSidebar")}
            onClick={() =>
              props.mobileOpen
                ? props.actions.closeMobileSidebar()
                : props.actions.toggleSidebar(false)
            }
          >
            <PanelLeftClose />
          </button>
        </Tooltip>
      </div>

      <button
        className="new-session-button"
        type="button"
        aria-label={t("newSession")}
        title={t("newSession")}
        onClick={() =>
          props.selectedWorkspace
            ? void props.actions.createSession(props.selectedWorkspace)
            : void props.actions.chooseWorkspace()
        }
      >
        <SquarePen />
        <span>{t("newSession")}</span>
      </button>

      <div
        className={`workspace-heading ${props.searchOpen ? "is-searching" : ""}`}
      >
        <span className="workspace-heading-label">{t("workspaces")}</span>
        <div className="session-search">
          <Search />
          <input
            ref={searchInput}
            type="search"
            value={props.query}
            placeholder={t("searchPlaceholder")}
            maxLength={archived ? WEB_MAX_ARCHIVED_SESSION_QUERY : undefined}
            aria-label={t("searchConversations")}
            onChange={(event) => props.actions.setQuery(event.target.value)}
          />
          <button
            type="button"
            aria-label={t("closeSearch")}
            onClick={() => props.actions.setSearchOpen(false)}
          >
            <X />
          </button>
        </div>
        <div className="workspace-actions">
          <Tooltip content={t("searchConversations")}>
            <button
              ref={searchButton}
              className="icon-button"
              type="button"
              aria-label={t("searchConversations")}
              onClick={() => props.actions.setSearchOpen(true)}
            >
              <Search />
            </button>
          </Tooltip>
          <Tooltip content={t("addWorkspace")}>
            <button
              className="icon-button"
              type="button"
              aria-label={t("addWorkspace")}
              onClick={() => void props.actions.chooseWorkspace()}
            >
              <Plus />
            </button>
          </Tooltip>
        </div>
      </div>

      <fieldset
        className="session-view-switch"
        aria-label={t("conversationViews")}
      >
        <button
          type="button"
          aria-pressed={!archived}
          onClick={() => setArchived(false)}
        >
          {t("currentConversations")}
        </button>
        <button
          type="button"
          aria-pressed={archived}
          onClick={() => setArchived(true)}
        >
          {t("archivedConversations")}
        </button>
      </fieldset>
      {archived && (
        <div className="sidebar-archive-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t("refreshArchives")}
            title={t("refreshArchives")}
            disabled={archiveLoading}
            onClick={() => void loadArchives()}
          >
            <RefreshCw aria-hidden="true" />
          </button>
          {archiveLoading && <span role="status">{t("loadingArchives")}</span>}
        </div>
      )}
      {archived && scopedArchiveError && (
        <div className="sidebar-scope-note" role="alert">
          <p>
            {t(
              scopedArchiveError.kind === "stale"
                ? "archiveCursorStale"
                : "archiveLoadFailed",
            )}
          </p>
          <button
            type="button"
            disabled={archiveLoading}
            onClick={() =>
              void loadArchives(
                scopedArchiveError.kind === "stale"
                  ? undefined
                  : scopedArchiveError.cursor,
              )
            }
          >
            {t(
              scopedArchiveError.kind === "stale"
                ? "refreshArchives"
                : "retryArchives",
            )}
          </button>
        </div>
      )}
      {archived && Boolean(scopedArchivePage?.truncation.recordsUnscanned) && (
        <p className="sidebar-scope-note">
          {t("archiveScanBounded", {
            count: scopedArchivePage?.truncation.recordsUnscanned,
          })}
        </p>
      )}
      {!archived && loadedHistoryBounded && (
        <p className="sidebar-scope-note">
          {t("loadedHistoryBounded", {
            sessions: snapshot?.truncation.sessionsOmitted,
            workspaces: snapshot?.truncation.workspacesOmitted,
          })}
        </p>
      )}
      {archived && restoreError && (
        <p className="sidebar-scope-note" role="alert">
          {t("restoreFailed")}
        </p>
      )}
      <div className="workspace-tree">
        {grouped.length ? (
          grouped.map((group) => {
            const collapsed =
              (archived ? archiveCollapsed : props.collapsed).has(group.path) &&
              !props.query.trim();
            const active = !group.ungrouped && activeWorkspace === group.path;
            return (
              <section
                className={`workspace-group ${collapsed ? "collapsed" : ""} ${active ? "is-active-workspace" : ""}`}
                key={group.path}
              >
                <div className="workspace-button">
                  <button
                    className="workspace-label"
                    type="button"
                    aria-expanded={!collapsed}
                    aria-current={active ? "location" : undefined}
                    disabled={Boolean(props.query.trim())}
                    title={
                      group.path === "__ungrouped__" ? undefined : group.path
                    }
                    onClick={() => {
                      if (!archived) props.actions.toggleWorkspace(group.path);
                      else
                        setArchiveCollapsed((previous) => {
                          const next = new Set(previous);
                          if (next.has(group.path)) next.delete(group.path);
                          else next.add(group.path);
                          return next;
                        });
                    }}
                  >
                    <span className="workspace-toggle" aria-hidden="true">
                      <span className="workspace-chevron">⌄</span>
                    </span>
                    <span className="workspace-identity">
                      <strong>{group.name}</strong>
                      {!group.ungrouped && (
                        <small>{compactPath(group.path)}</small>
                      )}
                    </span>
                  </button>
                  {!group.ungrouped && (
                    <span className="workspace-row-actions">
                      <ActionMenu
                        label="Workspace options"
                        items={[
                          {
                            id: "rename",
                            label: t("renameWorkspace"),
                            icon: <SquarePen />,
                            onClick: () =>
                              openEdit({
                                kind: "workspace",
                                path: group.path,
                                name: group.name,
                              }),
                          },
                          {
                            id: "remove",
                            label: t("removeWorkspace"),
                            icon: <Trash2 />,
                            variant: "destructive",
                            onClick: () =>
                              setDeleteTarget({
                                path: group.path,
                                name: group.name,
                              }),
                          },
                        ]}
                      />
                      <Tooltip content={t("newSession")}>
                        <button
                          className="workspace-action"
                          type="button"
                          aria-label={`${t("newSession")} ${group.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            void props.actions.createSession(group.path);
                          }}
                        >
                          <Plus />
                        </button>
                      </Tooltip>
                    </span>
                  )}
                </div>
                {!collapsed && (
                  <div className="workspace-sessions">
                    {group.sessions.length ? (
                      group.sessions.map((session) => {
                        const running = session.execution?.status === "running";
                        const queued = session.execution?.pendingFollowUps ?? 0;
                        const selected =
                          session.path === confirmedPath &&
                          session.id === snapshot?.selectedSession?.id;
                        const statusLabel = [
                          ...(running ? [t("execution_running")] : []),
                          ...(queued > 0
                            ? [t("pendingFollowUpsHint", { count: queued })]
                            : []),
                        ].join(" · ");
                        return (
                          <div className="session-row" key={session.path}>
                            <button
                              className={`session ${selected ? "active" : ""}`}
                              type="button"
                              aria-current={selected ? "page" : undefined}
                              aria-label={[
                                sessionTitle(session, t("untitledSession")),
                                session.path,
                                statusLabel,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                              onClick={() =>
                                void props.actions.selectSession(session.path)
                              }
                            >
                              <span
                                className="session-title"
                                title={sessionTitle(
                                  session,
                                  t("untitledSession"),
                                )}
                              >
                                {sessionTitle(session, t("untitledSession"))}
                              </span>
                              {statusLabel && (
                                <Tooltip content={statusLabel}>
                                  <span
                                    className="session-status"
                                    aria-hidden="true"
                                  >
                                    {running && (
                                      <CircleDot className="session-running" />
                                    )}
                                    {queued > 0 && (
                                      <span className="session-queue">
                                        <ListOrdered />
                                        <span>
                                          {queued > 99 ? "99+" : queued}
                                        </span>
                                      </span>
                                    )}
                                  </span>
                                </Tooltip>
                              )}
                              <span className="session-time">
                                {relativeTime(session.modified)}
                              </span>
                            </button>
                            <ActionMenu
                              label={t("conversationOptions")}
                              items={[
                                {
                                  id: "rename",
                                  label: t("renameConversation"),
                                  icon: <SquarePen />,
                                  onClick: () =>
                                    openEdit({
                                      kind: "session",
                                      path: session.path,
                                      name: sessionTitle(
                                        session,
                                        t("untitledSession"),
                                      ),
                                    }),
                                },
                                {
                                  id: archived ? "restore" : "archive",
                                  label: restoring.has(session.path)
                                    ? t("restoringConversation")
                                    : t(
                                        archived
                                          ? "restoreConversation"
                                          : "archiveConversation",
                                      ),
                                  icon: archived ? (
                                    <ArchiveRestore />
                                  ) : (
                                    <Archive />
                                  ),
                                  isDisabled: restoring.has(session.path),
                                  onClick: () =>
                                    archived
                                      ? void restore(session.path)
                                      : void props.actions.archiveSession(
                                          session.path,
                                        ),
                                },
                              ]}
                            />
                          </div>
                        );
                      })
                    ) : (
                      <div className="empty">{t("noConversations")}</div>
                    )}
                  </div>
                )}
              </section>
            );
          })
        ) : (
          <div
            className="empty"
            hidden={archived && (archiveLoading || Boolean(scopedArchiveError))}
          >
            {props.query.trim()
              ? t(
                  archived && scopedArchivePage?.truncation.recordsUnscanned
                    ? "noMatchingScannedArchives"
                    : !archived && loadedHistoryBounded
                      ? "noMatchingLoaded"
                      : "noMatching",
                )
              : t(
                  archived
                    ? scopedArchivePage?.truncation.recordsUnscanned
                      ? "noScannedArchives"
                      : "noArchivedSessions"
                    : "noSessions",
                )}
          </div>
        )}
        {archived &&
          scopedArchivePage?.nextCursor &&
          scopedArchiveError?.kind !== "stale" && (
            <button
              type="button"
              className="sidebar-archive-more"
              disabled={archiveLoading}
              onClick={() => void loadArchives(scopedArchivePage.nextCursor)}
            >
              {t("moreArchives")}
            </button>
          )}
      </div>

      <div className="sidebar-footer">
        <button
          className="sidebar-settings-button"
          type="button"
          aria-label={t("settings")}
          title={t("settings")}
          data-provider-settings-trigger
          disabled={props.settingsDisabled}
          onClick={props.onOpenSettings}
        >
          <Settings aria-hidden="true" />
          <span>{t("settings")}</span>
        </button>
      </div>

      <Dialog
        isOpen={Boolean(editTarget)}
        onOpenChange={(open: boolean) =>
          !open && !saving && setEditTarget(null)
        }
        purpose="form"
        width={400}
        aria-label={
          editTarget?.kind === "workspace"
            ? t("renameWorkspace")
            : t("renameConversation")
        }
      >
        <form
          className="openpi-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}
        >
          <strong>
            {editTarget?.kind === "workspace"
              ? t("renameWorkspace")
              : t("renameConversation")}
          </strong>
          <input
            ref={editInput}
            value={draft}
            maxLength={80}
            aria-label={
              editTarget?.kind === "workspace"
                ? t("workspaceName")
                : t("conversationName")
            }
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="dialog-actions">
            <button type="button" onClick={() => setEditTarget(null)}>
              {t("cancel")}
            </button>
            <button type="submit" className="primary" disabled={saving}>
              {t("save")}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog
        isOpen={Boolean(deleteTarget)}
        onOpenChange={(open: boolean) => !open && setDeleteTarget(null)}
        purpose="form"
        width={440}
        aria-label={t("deleteWorkspace")}
      >
        <div className="openpi-dialog">
          <strong>{t("deleteWorkspace")}</strong>
          <p>
            {deleteTarget?.name}：{t("workspaceDeleteConfirm")}
          </p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setDeleteTarget(null)}>
              {t("cancel")}
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (!deleteTarget) return;
                void props.actions.removeWorkspace(deleteTarget.path);
                setDeleteTarget(null);
              }}
            >
              {t("deleteWorkspace")}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
