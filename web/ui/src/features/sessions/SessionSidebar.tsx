import { Dialog } from "@astryxdesign/core/Dialog";
import type { DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  Folder,
  FolderOpen,
  FolderPlus,
  ListOrdered,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Pin,
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
  type WebSessionSummary,
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
import type { CompletedResultExposure } from "../transcript/Transcript.tsx";
import { TranscriptSearchDialog } from "./TranscriptSearchDialog.tsx";

interface SessionSidebarProps {
  snapshot: WebSnapshot | null;
  selectedPath: string | null;
  selectedWorkspace: string | null;
  collapsed: Set<string>;
  query: string;
  searchOpen: boolean;
  mobileOpen: boolean;
  settingsDisabled: boolean;
  connected?: boolean;
  completedResultSeen?: CompletedResultExposure | null;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings: () => void;
  actions: WebStoreActions;
}

type EditTarget = { kind: "workspace" | "session"; path: string; name: string };
type DeleteTarget = { path: string; name: string };

const seenCompletionsKey = "openpi.seen-completions";
function completionKey(
  session: Pick<WebSessionSummary, "path" | "id" | "execution">,
) {
  const turn = session.execution?.lastTurn;
  return turn
    ? JSON.stringify([
        session.path,
        session.id,
        turn.commandId,
        turn.finishedAt,
      ])
    : "";
}

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
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const snapshot = props.snapshot;
  const [seenCompletions, setSeenCompletions] = useState<Set<string>>(() => {
    try {
      const stored: unknown = JSON.parse(
        window.sessionStorage.getItem(seenCompletionsKey) ?? "[]",
      );
      return new Set(
        Array.isArray(stored)
          ? stored
              .filter((key): key is string => typeof key === "string")
              .slice(-500)
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const selectedSummary = snapshot?.sessions.find(
    (session) =>
      session.path === snapshot.selectedSession?.path &&
      session.id === snapshot.selectedSession?.id,
  );
  const completedSelection = completionKey(
    selectedSummary ?? { id: "", path: "" },
  );
  useEffect(() => {
    const seen = props.completedResultSeen;
    const turn = selectedSummary?.execution?.lastTurn;
    if (
      !seen ||
      !selectedSummary ||
      props.selectedPath !== seen.sessionPath ||
      selectedSummary.id !== seen.sessionId ||
      selectedSummary.path !== seen.sessionPath ||
      turn?.outcome !== "completed" ||
      turn.commandId !== seen.commandId ||
      turn.finishedAt !== seen.finishedAt ||
      turn.resultEntryId !== seen.resultEntryId ||
      seenCompletions.has(completedSelection) ||
      props.connected === false
    )
      return;
    setSeenCompletions((previous) => {
      const next = new Set([...previous, completedSelection].slice(-500));
      try {
        window.sessionStorage.setItem(
          seenCompletionsKey,
          JSON.stringify([...next]),
        );
      } catch {
        /* Reading still works without browser storage. */
      }
      return next;
    });
  }, [
    completedSelection,
    selectedSummary,
    seenCompletions,
    props.completedResultSeen,
    props.selectedPath,
    props.connected,
  ]);
  const client = useMemo(() => new WebClient(), []);
  const [archived, setArchived] = useState(false);
  const [pinsCollapsed, setPinsCollapsed] = useState(false);
  const [pinSaving, setPinSaving] = useState(false);
  const pinInFlight = useRef(false);
  const draggedPin = useRef<{ path: string; id: string } | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [dropAfter, setDropAfter] = useState(false);
  const [pinError, setPinError] = useState(false);
  const pinnedSort = snapshot?.preferences.pinnedSort ?? "manual";
  const pinnedSessions = (snapshot?.sessions ?? [])
    .filter((session) => session.pinOrder !== undefined && !session.archived)
    .sort(
      (a, b) =>
        (pinnedSort === "updated" ? b.modified.localeCompare(a.modified) : 0) ||
        a.pinOrder! - b.pinOrder!,
    );
  const visiblePins = pinnedSessions.filter((session) => {
    const workspace = snapshot?.workspaces.find(
      (workspace) => workspace.path === session.cwd,
    );
    return `${sessionTitle(session, t("untitledSession"))} ${session.cwd} ${workspace?.name ?? ""}`
      .toLowerCase()
      .includes(props.query.trim().toLowerCase());
  });
  const savePin = async (
    session: { path: string; id: string },
    pinned: boolean,
    before?: { path: string; id: string } | null,
  ) => {
    if (pinInFlight.current) return;
    pinInFlight.current = true;
    setPinSaving(true);
    setPinError(false);
    try {
      await props.actions.setSessionPin(
        session.path,
        session.id,
        pinned,
        before,
      );
    } catch {
      setPinError(true);
    } finally {
      pinInFlight.current = false;
      setPinSaving(false);
    }
  };
  const savePinnedSort = async (pinnedSort: "manual" | "updated") => {
    if (pinInFlight.current) return;
    pinInFlight.current = true;
    setPinSaving(true);
    setPinError(false);
    try {
      await client.savePreferences({ pinnedSort });
      await props.actions.refreshSnapshot();
    } catch {
      setPinError(true);
    } finally {
      pinInFlight.current = false;
      setPinSaving(false);
    }
  };
  const archiveQuery = props.query.trim();
  const archiveScope = JSON.stringify([archived, archiveQuery]);
  const currentArchiveScope = useRef({ key: archiveScope });
  if (currentArchiveScope.current.key !== archiveScope)
    currentArchiveScope.current = { key: archiveScope };
  const mounted = useRef(false);
  const [archivePage, setArchivePage] = useState<
    (ArchivedSessionPage & { query: string }) | null
  >(null);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveError, setArchiveError] = useState<{
    query: string;
    kind: "failed" | "stale";
    cursor?: string;
    retainedCount?: number;
  } | null>(null);
  const archiveRequest = useRef<AbortController | null>(null);
  const scopedArchivePage =
    archivePage?.query === archiveQuery ? archivePage : null;
  const scopedArchiveError =
    archiveError?.query === archiveQuery ? archiveError : null;
  const loadArchives = useCallback(
    async (cursor?: string, retainedCount?: number) => {
      if (!archived) return;
      archiveRequest.current?.abort();
      const controller = new AbortController();
      archiveRequest.current = controller;
      setArchiveLoading(true);
      setArchiveError(null);
      try {
        let page = await client.listArchivedSessions(
          { query: archiveQuery, ...(cursor ? { cursor } : {}), limit: 25 },
          controller.signal,
        );
        if (controller.signal.aborted || archiveRequest.current !== controller)
          return;
        const sessions = [...page.sessions];
        // A metadata refresh should keep the range the reader already opened.
        while (
          !cursor &&
          retainedCount !== undefined &&
          sessions.length < retainedCount &&
          page.nextCursor
        ) {
          page = await client.listArchivedSessions(
            { query: archiveQuery, cursor: page.nextCursor, limit: 25 },
            controller.signal,
          );
          if (
            controller.signal.aborted ||
            archiveRequest.current !== controller
          )
            return;
          const additional = page.sessions.filter(
            (session) =>
              !sessions.some((existing) => existing.path === session.path),
          );
          sessions.push(...additional);
          if (!additional.length) break;
        }
        setArchivePage((previous) => ({
          ...page,
          query: archiveQuery,
          sessions:
            cursor && previous?.query === archiveQuery
              ? [
                  ...previous.sessions,
                  ...sessions.filter(
                    (session) =>
                      !previous.sessions.some(
                        (existing) => existing.path === session.path,
                      ),
                  ),
                ]
              : sessions,
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
            ...(retainedCount !== undefined ? { retainedCount } : {}),
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
  const saveInFlight = useRef(false);
  const [removing, setRemoving] = useState(false);
  const removeInFlight = useRef(false);
  const [removeError, setRemoveError] = useState(false);
  const [creating, setCreating] = useState(false);
  const createInFlight = useRef(false);
  const restore = async (path: string) => {
    if (restoreInFlight.current.has(path)) return;
    restoreInFlight.current.add(path);
    setRestoring(new Set(restoreInFlight.current));
    setRestoreError(false);
    const scope = currentArchiveScope.current;
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
          (archived || session.pinOrder === undefined) &&
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
          showPath: workspaces.some(
            (other) =>
              other.path !== workspace.path && other.name === workspace.name,
          ),
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
        showPath: false,
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
    if (saveInFlight.current) return;
    setDraft(target.name);
    setEditError(false);
    setEditTarget(target);
  };
  const saveEdit = async () => {
    const name = draft.trim();
    if (
      !editTarget ||
      !name ||
      name === editTarget.name ||
      saveInFlight.current
    )
      return;
    const target = editTarget;
    const scope = currentArchiveScope.current;
    const retainedCount = scopedArchivePage?.sessions.length ?? 25;
    saveInFlight.current = true;
    setSaving(true);
    setEditError(false);
    try {
      if (target.kind === "workspace")
        await props.actions.renameWorkspace(target.path, name);
      else await props.actions.renameSession(target.path, name);
      if (!mounted.current) return;
      setEditTarget(null);
      if (
        target.kind === "session" &&
        archived &&
        currentArchiveScope.current === scope
      )
        void loadArchives(undefined, retainedCount);
    } catch {
      if (mounted.current) setEditError(true);
    } finally {
      saveInFlight.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const removeWorkspace = async () => {
    if (!deleteTarget || removeInFlight.current) return;
    const target = deleteTarget;
    removeInFlight.current = true;
    setRemoving(true);
    setRemoveError(false);
    try {
      const removed = await props.actions.removeWorkspace(target.path);
      if (!mounted.current) return;
      if (removed) setDeleteTarget(null);
      else setRemoveError(true);
    } catch {
      if (mounted.current) setRemoveError(true);
    } finally {
      removeInFlight.current = false;
      if (mounted.current) setRemoving(false);
    }
  };
  const startSession = async (workspacePath: string | null) => {
    if (createInFlight.current) return;
    const scope = currentArchiveScope.current;
    createInFlight.current = true;
    setCreating(true);
    try {
      if (!workspacePath) {
        await props.actions.chooseWorkspace();
        return;
      }
      const target = await props.actions.createSession(workspacePath);
      if (
        !mounted.current ||
        currentArchiveScope.current !== scope ||
        !target?.sessionId ||
        !target.sessionPath ||
        target.workspacePath !== workspacePath
      )
        return;
      setArchived(false);
      props.actions.setQuery("");
    } catch {
      // Native creation owns error feedback; preserve the reader's list scope.
    } finally {
      createInFlight.current = false;
      if (mounted.current) setCreating(false);
    }
  };

  const renderSession = (
    session: Omit<
      WebSessionSummary,
      "source" | "origin" | "controller" | "readOnly"
    >,
    inPinned = false,
  ) => {
    const pinIndex = pinnedSessions.findIndex(
      (pin) => pin.path === session.path && pin.id === session.id,
    );
    const running = session.execution?.status === "running";
    const waiting = session.execution?.waitingForInput;
    const outcome = session.execution?.lastTurn?.outcome;
    const unreadComplete =
      outcome === "completed" && !seenCompletions.has(completionKey(session));
    const state =
      props.connected === false && running
        ? undefined
        : waiting
          ? "attention"
          : running
            ? "running"
            : outcome === "failed"
              ? "attention"
              : unreadComplete
                ? "completed"
                : undefined;
    const StatusIcon =
      state === "running"
        ? LoaderCircle
        : state === "attention"
          ? CircleAlert
          : Circle;
    const queued = session.execution?.pendingFollowUps ?? 0;
    const selected =
      session.path === confirmedPath &&
      session.id === snapshot?.selectedSession?.id;
    const stateLabel =
      state === "attention"
        ? waiting
          ? "waiting"
          : "failed"
        : state === "running" && session.execution?.compacting
          ? "compacting"
          : state;
    const statusLabel = [
      ...(stateLabel ? [t(`sidebarState_${stateLabel}`)] : []),
      ...(queued > 0 ? [t("pendingFollowUpsHint", { count: queued })] : []),
    ].join(" · ");
    return (
      <li
        className={`session-row ${dropPath === session.path ? (dropAfter ? "is-pin-drop-after" : "is-pin-drop-target") : ""}`}
        aria-label={sessionTitle(session, t("untitledSession"))}
        key={session.path}
        draggable={
          inPinned &&
          pinnedSort === "manual" &&
          !pinSaving &&
          !props.query.trim()
        }
        onDragStart={(event) => {
          if (!inPinned || pinnedSort !== "manual") return;
          draggedPin.current = { path: session.path, id: session.id };
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", session.id);
        }}
        onDragOver={(event) => {
          if (!inPinned || pinnedSort !== "manual" || !draggedPin.current)
            return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropPath(session.path);
          const bounds = event.currentTarget.getBoundingClientRect();
          setDropAfter(event.clientY > bounds.top + bounds.height / 2);
        }}
        onDragEnd={() => {
          draggedPin.current = null;
          setDropPath(null);
        }}
        onDrop={(event) => {
          if (!inPinned || pinnedSort !== "manual" || !draggedPin.current)
            return;
          event.preventDefault();
          const dragged = draggedPin.current;
          draggedPin.current = null;
          setDropPath(null);
          const bounds = event.currentTarget.getBoundingClientRect();
          const before =
            event.clientY > bounds.top + bounds.height / 2
              ? (pinnedSessions[pinIndex + 1] ?? null)
              : { path: session.path, id: session.id };
          void savePin(dragged, true, before);
        }}
      >
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
          onClick={() => void props.actions.selectSession(session.path)}
        >
          <span
            className="session-title"
            title={sessionTitle(session, t("untitledSession"))}
          >
            {sessionTitle(session, t("untitledSession"))}
          </span>
          {statusLabel && (
            <Tooltip content={statusLabel}>
              <span className="session-status" aria-hidden="true">
                {state && (
                  <StatusIcon
                    className={`session-state session-state-${state}`}
                  />
                )}
                {queued > 0 && (
                  <span className="session-queue">
                    <ListOrdered />
                    <span>{queued > 99 ? "99+" : queued}</span>
                  </span>
                )}
              </span>
            </Tooltip>
          )}
          {!state && (
            <span className="session-time">
              {relativeTime(session.modified)}
            </span>
          )}
        </button>
        {!archived && (
          <Tooltip
            content={t(inPinned ? "unpinConversation" : "pinConversation")}
          >
            <button
              type="button"
              className="session-pin-button"
              aria-label={t(inPinned ? "unpinConversation" : "pinConversation")}
              disabled={pinSaving}
              onClick={() => void savePin(session, !inPinned)}
            >
              <Pin
                aria-hidden="true"
                fill={inPinned ? "currentColor" : "none"}
              />
            </button>
          </Tooltip>
        )}
        <ActionMenu
          label={t("conversationOptions")}
          items={[
            ...(inPinned && pinnedSort === "manual"
              ? [
                  {
                    id: "move-up",
                    label: t("movePinUp"),
                    icon: <ArrowUp />,
                    isDisabled: pinSaving || pinIndex === 0,
                    onClick: () =>
                      void savePin(session, true, pinnedSessions[pinIndex - 1]),
                  },
                  {
                    id: "move-down",
                    label: t("movePinDown"),
                    icon: <ArrowDown />,
                    isDisabled:
                      pinSaving || pinIndex === pinnedSessions.length - 1,
                    onClick: () =>
                      void savePin(
                        session,
                        true,
                        pinnedSessions[pinIndex + 2] ?? null,
                      ),
                  },
                ]
              : []),
            {
              id: "rename",
              label: t("renameConversation"),
              icon: <SquarePen />,
              onClick: () =>
                openEdit({
                  kind: "session",
                  path: session.path,
                  name: sessionTitle(session, t("untitledSession")),
                }),
            },
            {
              id: archived ? "restore" : "archive",
              label: restoring.has(session.path)
                ? t("restoringConversation")
                : t(archived ? "restoreConversation" : "archiveConversation"),
              icon: archived ? <ArchiveRestore /> : <Archive />,
              isDisabled: restoring.has(session.path),
              onClick: () =>
                archived
                  ? void restore(session.path)
                  : void props.actions.archiveSession(session.path),
            },
          ]}
        />
      </li>
    );
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
        disabled={creating}
        aria-busy={creating || undefined}
        onClick={() => void startSession(props.selectedWorkspace)}
      >
        <SquarePen />
        <span>{t("newSession")}</span>
      </button>

      <div className="sidebar-navigation">
        {!archived && visiblePins.length > 0 && (
          <section
            className="pinned-section"
            aria-label={t("pinnedConversations")}
          >
            <div className="pinned-heading">
              <button
                type="button"
                className="workspace-heading-label"
                aria-expanded={!pinsCollapsed || Boolean(props.query.trim())}
                onClick={() => setPinsCollapsed((value) => !value)}
              >
                {t("pinnedConversations")}
                <ChevronDown
                  className={
                    pinsCollapsed && !props.query.trim() ? "is-collapsed" : ""
                  }
                  aria-hidden="true"
                />
              </button>
              <ActionMenu
                label={t("pinnedOptions")}
                items={[
                  {
                    id: "updated",
                    label: t("pinnedRecentlyUpdated"),
                    endContent:
                      pinnedSort === "updated" ? (
                        <Check size={16} aria-hidden="true" />
                      ) : undefined,
                    isDisabled: pinSaving,
                    onClick: () => void savePinnedSort("updated"),
                  },
                  {
                    id: "manual",
                    label: t("pinnedManualOrder"),
                    endContent:
                      pinnedSort === "manual" ? (
                        <Check size={16} aria-hidden="true" />
                      ) : undefined,
                    isDisabled: pinSaving,
                    onClick: () => void savePinnedSort("manual"),
                  },
                ]}
              />
            </div>
            {(!pinsCollapsed || Boolean(props.query.trim())) && (
              <ul className="pinned-sessions">
                {visiblePins.map((session) => renderSession(session, true))}
              </ul>
            )}
          </section>
        )}
        {pinError && (
          <p className="sidebar-scope-note" role="alert">
            {t("pinSaveFailed")}
          </p>
        )}
        <div
          className={`workspace-heading ${props.searchOpen ? "is-searching" : ""}`}
        >
          <Tooltip content={t("currentConversations")}>
            <button
              type="button"
              className="workspace-heading-label"
              aria-label={t("currentConversations")}
              aria-pressed={!archived}
              onClick={() => setArchived(false)}
            >
              {archived && <ArrowLeft aria-hidden="true" />}
              {t(archived ? "archivedConversations" : "workspaces")}
            </button>
          </Tooltip>
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
            <Tooltip content={t("archivedConversations")}>
              <button
                className="icon-button sidebar-archive-toggle"
                type="button"
                aria-label={t("archivedConversations")}
                aria-pressed={archived}
                onClick={() => setArchived((value) => !value)}
              >
                <Archive />
              </button>
            </Tooltip>
            <Tooltip content={t("addWorkspace")}>
              <button
                className="icon-button"
                type="button"
                aria-label={t("addWorkspace")}
                onClick={() => void props.actions.chooseWorkspace()}
              >
                <FolderPlus />
              </button>
            </Tooltip>
          </div>
        </div>

        {props.searchOpen && (
          <button
            type="button"
            className="sidebar-content-search"
            onClick={() => setTranscriptSearchOpen(true)}
          >
            <Search aria-hidden="true" />
            {t("transcriptSearch")}
          </button>
        )}
        <TranscriptSearchDialog
          open={transcriptSearchOpen}
          initialQuery={props.query}
          initialIncludeArchived={archived}
          onClose={() => setTranscriptSearchOpen(false)}
          onOpenMessage={props.actions.navigateToMessage}
        />
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
            {archiveLoading && (
              <span role="status">{t("loadingArchives")}</span>
            )}
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
                  scopedArchiveError.retainedCount,
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
        {archived &&
          Boolean(scopedArchivePage?.truncation.recordsUnscanned) && (
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
                (archived ? archiveCollapsed : props.collapsed).has(
                  group.path,
                ) && !props.query.trim();
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
                        if (!archived)
                          props.actions.toggleWorkspace(group.path);
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
                        {collapsed ? (
                          <Folder className="workspace-folder" />
                        ) : (
                          <FolderOpen className="workspace-folder" />
                        )}
                        <ChevronDown className="workspace-chevron" />
                      </span>
                      <span className="workspace-identity">
                        <strong>{group.name}</strong>
                        {group.showPath && (
                          <small>{compactPath(group.path)}</small>
                        )}
                      </span>
                    </button>
                    {!group.ungrouped && (
                      <span className="workspace-row-actions">
                        <ActionMenu
                          label={t("workspaceOptions")}
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
                              onClick: () => {
                                setRemoveError(false);
                                setDeleteTarget({
                                  path: group.path,
                                  name: group.name,
                                });
                              },
                            },
                          ]}
                        />
                        <Tooltip content={t("newSession")}>
                          <button
                            className="workspace-action"
                            type="button"
                            aria-label={`${t("newSession")} ${group.name}`}
                            disabled={creating}
                            aria-busy={creating || undefined}
                            onClick={(event) => {
                              event.stopPropagation();
                              void startSession(group.path);
                            }}
                          >
                            <Plus />
                          </button>
                        </Tooltip>
                      </span>
                    )}
                  </div>
                  {!collapsed && group.sessions.length > 0 && (
                    <ul className="workspace-sessions">
                      {group.sessions.map((session) => renderSession(session))}
                    </ul>
                  )}
                </section>
              );
            })
          ) : (
            <div
              className="empty"
              hidden={
                (!archived && visiblePins.length > 0) ||
                (archived && (archiveLoading || Boolean(scopedArchiveError)))
              }
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
          !open && !saveInFlight.current && setEditTarget(null)
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
            disabled={saving}
            aria-label={
              editTarget?.kind === "workspace"
                ? t("workspaceName")
                : t("conversationName")
            }
            onChange={(event) => setDraft(event.target.value)}
          />
          {editError && (
            <p className="sidebar-dialog-error" role="alert">
              {t("renameFailed")}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                if (!saveInFlight.current) setEditTarget(null);
              }}
            >
              {t("cancel")}
            </button>
            <button
              type="submit"
              className="primary"
              disabled={
                saving || !draft.trim() || draft.trim() === editTarget?.name
              }
            >
              {t(saving ? "savingName" : "save")}
            </button>
          </div>
        </form>
      </Dialog>

      <Dialog
        isOpen={Boolean(deleteTarget)}
        onOpenChange={(open: boolean) =>
          !open && !removeInFlight.current && setDeleteTarget(null)
        }
        purpose="form"
        width={440}
        aria-label={t("removeWorkspace")}
      >
        <div className="openpi-dialog">
          <strong>{t("removeWorkspace")}</strong>
          <p className="sidebar-dialog-path">{deleteTarget?.path}</p>
          <p>
            {deleteTarget?.name}：{t("workspaceDeleteConfirm")}
          </p>
          {removeError && (
            <p className="sidebar-dialog-error" role="alert">
              {t("workspaceRemoveFailed")}
            </p>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              disabled={removing}
              onClick={() => {
                if (!removeInFlight.current) setDeleteTarget(null);
              }}
            >
              {t("cancel")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={removing}
              onClick={() => void removeWorkspace()}
            >
              {t(removing ? "removingWorkspace" : "removeWorkspace")}
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
