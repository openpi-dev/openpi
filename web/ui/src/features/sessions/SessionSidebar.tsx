import { Dialog } from "@astryxdesign/core/Dialog";
import type { DropdownMenuOption } from "@astryxdesign/core/DropdownMenu";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bell,
  BrushCleaning,
  Check,
  ChevronDown,
  Circle,
  CircleAlert,
  Folder,
  FolderOpen,
  ListOrdered,
  LoaderCircle,
  MailOpen,
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
  type WebSidebarPinTarget,
  type WebSnapshot,
} from "../../../../protocol/types.ts";
import { compactPath, sessionTitle } from "../../lib/format.ts";
import {
  type ArchivedSessionPage,
  WebApiError,
  WebClient,
} from "../../protocol/client.ts";
import type { WebStoreActions } from "../../store/web-store.ts";
import { ConversationMenu, captureSidebarFocus } from "./ConversationMenu.tsx";
import { TranscriptSearchDialog } from "./TranscriptSearchDialog.tsx";
import { ManagedWorktreesDialog } from "./ManagedWorktreesDialog.tsx";
import {
  dropIsAfter,
  movedItemAnchor,
  droppedItemAnchor,
  sessionProject,
} from "./sidebar-order.ts";

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
  sessionViewVisible?: boolean;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
  onOpenSettings: () => void;
  actions: WebStoreActions;
}

type EditTarget = { kind: "workspace" | "session"; path: string; name: string };
type DeleteTarget = { path: string; name: string };
type SidebarSession = Omit<
  WebSessionSummary,
  "source" | "origin" | "controller" | "readOnly"
>;

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
    : JSON.stringify([session.path, session.id]);
}

function activityTime(session: SidebarSession) {
  return session.firstUnread?.type === "turn"
    ? session.firstUnread.finishedAt
    : (session.execution?.lastTurn?.finishedAt ?? Date.parse(session.modified));
}

function activitySessionKey(session: Pick<SidebarSession, "path" | "id">) {
  return JSON.stringify([session.path, session.id]);
}

function activityPriority(session: SidebarSession, connected = true) {
  return connected && session.execution?.waitingForInput
    ? 0
    : session.unread
      ? 1
      : connected && session.execution?.status === "running"
        ? 2
        : 3;
}

function ActionMenu({
  items,
  label,
  alignment = "start",
}: {
  items: DropdownMenuOption[];
  label: string;
  alignment?: "start" | "end";
}) {
  return (
    <span className="astryx-menu-trigger">
      <DropdownMenu
        className="sidebar-action-menu"
        button={{
          label,
          icon: <MoreHorizontal />,
          isIconOnly: true,
          size: "sm",
          variant: "ghost",
          className: "menu-action-button",
        }}
        items={items}
        menuWidth={240}
        placement="below"
        alignment={alignment}
        hasChevron={false}
      />
    </span>
  );
}

export function SessionSidebar(props: SessionSidebarProps) {
  const { t } = useTranslation();
  const worktreeFocus = useRef<(() => void) | null>(null);
  const [worktreeWorkspace, setWorktreeWorkspace] = useState<string | null>(
    null,
  );
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [transcriptSearchOpen, setTranscriptSearchOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityCount, setActivityCount] = useState(10);
  const [showPriority, setShowPriority] = useState(true);
  const [retainedPriority, setRetainedPriority] = useState(new Set<string>());
  const activityCatalog = useRef<{
    openedAt: number;
    sessions: Set<string>;
  } | null>(null);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [recentsCollapsed, setRecentsCollapsed] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState(new Set<string>());
  const [recentCount, setRecentCount] = useState(10);
  const [readError, setReadError] = useState(false);
  const [actionNotice, setActionNotice] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [readingAll, setReadingAll] = useState(false);
  const reading = useRef(new Set<string>());
  const lastReadView = useRef<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [draft, setDraft] = useState("");
  const [editError, setEditError] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchButton = useRef<HTMLButtonElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const sidebar = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const activityTail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!actionNotice) return;
    const timer = window.setTimeout(() => setActionNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [actionNotice]);
  const snapshot = props.snapshot;
  const confirmedPath =
    snapshot?.selectedSession?.path === props.selectedPath
      ? props.selectedPath
      : null;
  const selectedSummary = snapshot?.sessions.find(
    (session) =>
      session.path === snapshot.selectedSession?.path &&
      session.id === snapshot.selectedSession?.id,
  );
  const completedSelection = completionKey(
    selectedSummary ?? { id: "", path: "" },
  );
  useEffect(() => {
    void completedSelection;
    void props.selectedPath;
    lastReadView.current = null;
  }, [completedSelection, props.selectedPath]);
  useEffect(() => {
    if (
      !props.sessionViewVisible ||
      !selectedSummary ||
      props.selectedPath !== selectedSummary.path ||
      lastReadView.current === completedSelection ||
      props.connected === false
    )
      return;
    let active = true;
    const acknowledge = () => {
      if (
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        document.querySelector("dialog[open]")
      )
        return;
      if (lastReadView.current === completedSelection) return;
      lastReadView.current = completedSelection;
      if (!selectedSummary.unread || !selectedSummary.readRevision) return;
      void props.actions
        .setSessionRead(
          selectedSummary.path,
          selectedSummary.id,
          true,
          selectedSummary.readRevision,
        )
        .catch(() => {
          if (active) setReadError(true);
        });
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    window.addEventListener("focus", acknowledge);
    document.addEventListener("close", acknowledge, true);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", acknowledge);
      window.removeEventListener("focus", acknowledge);
      document.removeEventListener("close", acknowledge, true);
    };
  }, [
    completedSelection,
    selectedSummary,
    props.sessionViewVisible,
    props.selectedPath,
    props.connected,
    props.actions,
  ]);
  const client = useMemo(() => new WebClient(), []);
  const [archived, setArchived] = useState(false);
  const [pinsCollapsed, setPinsCollapsed] = useState(false);
  const [pinSaving, setPinSaving] = useState(false);
  const pinInFlight = useRef(false);
  const draggedPin = useRef<WebSidebarPinTarget | null>(null);
  // One trailing click after a drag. Cleared by that click or by a later
  // pointerdown. A wall-clock window drops the click when the post-drop render
  // is slower than the window.
  const suppressDragClick = useRef(false);
  const [draggingSidebar, setDraggingSidebar] = useState(false);
  const draggedChat = useRef<{
    path: string;
    id: string;
    scope: string;
  } | null>(null);
  const [workspaceDrop, setWorkspaceDrop] = useState<string | null>(null);
  const [dropPath, setDropPath] = useState<string | null>(null);
  const [dropAfter, setDropAfter] = useState(false);
  const [pinError, setPinError] = useState(false);
  const pinnedSort = snapshot?.preferences.pinnedSort ?? "manual";
  const grouping = snapshot?.preferences.sidebarGrouping ?? "project";
  const chatsSort = snapshot?.preferences.chatsSort ?? "updated";
  const pinnedSessions = (snapshot?.sessions ?? [])
    .filter((session) => session.pinOrder !== undefined && !session.archived)
    .sort(
      (a, b) =>
        (pinnedSort === "updated" ? b.modified.localeCompare(a.modified) : 0) ||
        a.pinOrder! - b.pinOrder!,
    );
  const visiblePins = pinnedSessions.filter((session) => {
    const workspace = snapshot?.workspaces.find(
      (workspace) => workspace.path === sessionProject(session),
    );
    return `${sessionTitle(session, t("untitledSession"))} ${session.cwd} ${workspace?.name ?? ""}`
      .toLowerCase()
      .includes(props.query.trim().toLowerCase());
  });
  const saveSidebarChange = async (change: () => Promise<unknown>) => {
    if (pinInFlight.current) return;
    pinInFlight.current = true;
    setPinSaving(true);
    setPinError(false);
    try {
      await change();
    } catch {
      setPinError(true);
    } finally {
      pinInFlight.current = false;
      setPinSaving(false);
    }
  };
  const savePin = (
    session: { path: string; id: string },
    pinned: boolean,
    before?: { path: string; id: string } | null,
  ) =>
    saveSidebarChange(() =>
      props.actions.setSessionPin(session.path, session.id, pinned, before),
    );
  const saveSidebarPin = (
    target: WebSidebarPinTarget,
    pinned: boolean,
    before?: WebSidebarPinTarget | null,
  ) =>
    saveSidebarChange(() =>
      props.actions.setSidebarPin(target, pinned, before),
    );
  const savePreferences = (
    patch: Parameters<WebClient["savePreferences"]>[0],
  ) =>
    saveSidebarChange(async () => {
      await client.savePreferences(patch);
      await props.actions.refreshSnapshot();
    });
  const saveRead = async (session: SidebarSession, read: boolean) => {
    if (!session.readRevision) return;
    const key = completionKey(session);
    if (reading.current.has(key)) return;
    if (session.path === props.selectedPath) lastReadView.current = key;
    reading.current.add(key);
    setReadError(false);
    try {
      await props.actions.setSessionRead(
        session.path,
        session.id,
        read,
        session.readRevision,
      );
    } catch {
      setReadError(true);
    } finally {
      reading.current.delete(key);
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
            : sessionProject(session) === workspacePath &&
              !session.ungrouped) &&
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
        !workspaces.some(
          (workspace) => workspace.path === sessionProject(session),
        )
      ) {
        workspaces.push({
          path: sessionProject(session),
          name: sessionProject(session),
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
        pinOrder: undefined,
        showPath: false,
        matches: false,
      },
    ].filter(
      (group) =>
        group.sessions.length > 0 ||
        (!archived && !group.ungrouped && (!query || group.matches)),
    );
  }, [archived, props.query, scopedArchivePage, snapshot, t]);

  const sortChats = (sessions: SidebarSession[]) =>
    [...sessions].sort(
      (a, b) =>
        (chatsSort === "manual"
          ? (a.order ?? Number.MAX_SAFE_INTEGER) -
            (b.order ?? Number.MAX_SAFE_INTEGER)
          : 0) ||
        b.modified.localeCompare(a.modified) ||
        a.path.localeCompare(b.path),
    );
  const limitSessions = (sessions: SidebarSession[], limit: number) => {
    if (sessions.length <= limit + 1) return sessions;
    const visible = sessions.slice(0, limit);
    const selected = sessions.find(
      (session) =>
        session.path === confirmedPath &&
        session.id === snapshot?.selectedSession?.id,
    );
    if (selected && !visible.includes(selected)) visible.push(selected);
    return visible;
  };
  const projectGroups = grouped.filter((group) => !group.ungrouped);
  const pinnedProjects = projectGroups.filter(
    (group) => group.pinOrder !== undefined,
  );
  const sidebarPins = [
    ...visiblePins.map((session) => ({
      kind: "session" as const,
      session,
      pinOrder: session.pinOrder!,
    })),
    ...pinnedProjects.map((project) => ({
      kind: "workspace" as const,
      project,
      pinOrder: project.pinOrder!,
    })),
  ].sort((a, b) => {
    const modified = (pin: typeof a) =>
      pin.kind === "session"
        ? pin.session.modified
        : pin.project.sessions.reduce(
            (latest, session) =>
              session.modified > latest ? session.modified : latest,
            "",
          );
    return (
      (pinnedSort === "updated" ? modified(b).localeCompare(modified(a)) : 0) ||
      a.pinOrder - b.pinOrder
    );
  });
  const pinTarget = (pin: (typeof sidebarPins)[number]): WebSidebarPinTarget =>
    pin.kind === "session"
      ? { kind: "session", path: pin.session.path, id: pin.session.id }
      : { kind: "workspace", path: pin.project.path };
  const ordinaryProjects = projectGroups.filter(
    (group) => group.pinOrder === undefined,
  );
  const shownProjects =
    projectsExpanded ||
    props.query.trim() ||
    archived ||
    ordinaryProjects.length <= 6
      ? ordinaryProjects
      : ordinaryProjects.slice(0, 5);
  const selectedProject = ordinaryProjects.find(
    (project) =>
      selectedSummary?.path === confirmedPath &&
      project.path ===
        (selectedSummary ? sessionProject(selectedSummary) : undefined),
  );
  if (selectedProject && !shownProjects.includes(selectedProject))
    shownProjects.push(selectedProject);
  const recentSessions = sortChats(
    (snapshot?.sessions ?? []).filter(
      (session) =>
        !session.archived &&
        session.pinOrder === undefined &&
        !snapshot?.workspaces.some(
          (project) =>
            project.pinOrder !== undefined &&
            project.path === sessionProject(session),
        ) &&
        (grouping === "list" ||
          snapshot?.preferences.projectsInRecents !== false ||
          session.ungrouped ||
          !projectGroups.some(
            (project) => project.path === sessionProject(session),
          )) &&
        (!props.query.trim() ||
          `${sessionTitle(session, t("untitledSession"))} ${session.cwd} ${snapshot?.workspaces.find((workspace) => workspace.path === sessionProject(session))?.name ?? ""}`
            .toLowerCase()
            .includes(props.query.trim().toLowerCase())),
    ),
  );
  const shownRecent = props.query.trim()
    ? recentSessions
    : limitSessions(recentSessions, recentCount);
  const needsAttention = (session: SidebarSession) =>
    activityPriority(session, props.connected) < 3;
  const activityCutoff = new Date();
  activityCutoff.setHours(0, 0, 0, 0);
  activityCutoff.setDate(activityCutoff.getDate() - 6);
  const activitySessions = (snapshot?.sessions ?? []).filter(
    (session) =>
      !session.archived &&
      (needsAttention(session) ||
        retainedPriority.has(activitySessionKey(session)) ||
        (["completed", "failed"].includes(
          session.execution?.lastTurn?.outcome ?? "",
        ) &&
          (session.execution?.lastTurn?.finishedAt ?? 0) >=
            activityCutoff.getTime())),
  );
  const priorityOrder = new Map(
    [...retainedPriority].map((key, index) => [key, index]),
  );
  const prioritySessions = activitySessions
    .filter(
      (session) =>
        needsAttention(session) ||
        retainedPriority.has(activitySessionKey(session)),
    )
    .sort(
      (a, b) =>
        (priorityOrder.get(activitySessionKey(a)) ?? Infinity) -
          (priorityOrder.get(activitySessionKey(b)) ?? Infinity) ||
        activityPriority(a, props.connected) -
          activityPriority(b, props.connected) ||
        b.modified.localeCompare(a.modified),
    );
  const priorityPaths = new Set(
    prioritySessions.map((session) => session.path),
  );
  const settledActivity = activitySessions
    .filter((session) => !showPriority || !priorityPaths.has(session.path))
    .sort((a, b) => activityTime(b) - activityTime(a));
  const shownPriority = showPriority
    ? prioritySessions.slice(0, activityCount)
    : [];
  const shownActivity = settledActivity.slice(
    0,
    Math.max(0, activityCount - shownPriority.length),
  );
  const hasMoreActivity =
    activitySessions.length > shownPriority.length + shownActivity.length;
  useEffect(() => {
    const tail = activityTail.current;
    if (!activityOpen || !hasMoreActivity || !tail) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect();
          setActivityCount(activityCount + 10);
        }
      },
      { root: tail.closest(".sidebar-navigation") },
    );
    observer.observe(tail);
    return () => observer.disconnect();
  }, [activityOpen, hasMoreActivity, activityCount]);
  useEffect(() => {
    if (!activityOpen) {
      activityCatalog.current = null;
      setRetainedPriority((previous) =>
        previous.size ? new Set<string>() : previous,
      );
      setActivityCount(10);
      return;
    }
    const catalog = activityCatalog.current ?? {
      openedAt: Date.now(),
      sessions: new Set((snapshot?.sessions ?? []).map(activitySessionKey)),
    };
    const attentionSessions = (snapshot?.sessions ?? [])
      .filter(
        (session) =>
          !session.archived && activityPriority(session, props.connected) < 3,
      )
      .sort(
        (a, b) =>
          activityPriority(a, props.connected) -
            activityPriority(b, props.connected) ||
          b.modified.localeCompare(a.modified),
      );
    const newlyCreated = attentionSessions.filter(
      (session) =>
        !catalog.sessions.has(activitySessionKey(session)) &&
        Date.parse(session.created) >= catalog.openedAt,
    );
    for (const session of snapshot?.sessions ?? [])
      catalog.sessions.add(activitySessionKey(session));
    activityCatalog.current = catalog;
    setRetainedPriority((previous) => {
      const next = new Set([
        ...newlyCreated.map(activitySessionKey),
        ...previous,
        ...attentionSessions.map(activitySessionKey),
      ]);
      return next.size === previous.size ? previous : next;
    });
  }, [activityOpen, snapshot?.sessions, props.connected]);
  const unreadSessions = (snapshot?.sessions ?? []).filter(
    (session) => !session.archived && session.unread,
  );
  const readableUnread = unreadSessions.filter(
    (session) => session.readRevision,
  );
  const readablePriority = showPriority
    ? prioritySessions.filter(
        (session) => session.unread && session.readRevision,
      )
    : [];
  const markAllRead = async (sessions: SidebarSession[]) => {
    if (readingAll) return;
    setReadingAll(true);
    try {
      await Promise.all(sessions.map((session) => saveRead(session, true)));
    } finally {
      setReadingAll(false);
    }
  };

  const activeWorkspace = confirmedPath
    ? selectedSummary
      ? sessionProject(selectedSummary)
      : snapshot?.selectedSession?.cwd
    : null;
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
      setActivityOpen(false);
      props.actions.setQuery("");
    } catch {
      // Native creation owns error feedback; preserve the reader's list scope.
    } finally {
      createInFlight.current = false;
      if (mounted.current) setCreating(false);
    }
  };

  const endDrag = useCallback(() => {
    if (draggedPin.current || draggedChat.current)
      suppressDragClick.current = true;
    draggedPin.current = null;
    draggedChat.current = null;
    setDraggingSidebar(false);
    setDropPath(null);
    setWorkspaceDrop(null);
  }, []);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        (!draggedPin.current && !draggedChat.current)
      )
        return;
      event.preventDefault();
      endDrag();
    };
    const blur = () => {
      if (draggedPin.current || draggedChat.current) endDrag();
    };
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("blur", blur);
    };
  }, [endDrag]);
  const movePin = (index: number, down: boolean) => {
    const target = sidebarPins[index];
    if (!target) return;
    const before = movedItemAnchor(sidebarPins, index, down);
    void saveSidebarPin(
      pinTarget(target),
      true,
      before ? pinTarget(before) : null,
    );
  };
  const pinMoveItems = (index: number): DropdownMenuOption[] =>
    pinnedSort === "manual"
      ? [
          {
            id: "move-up",
            label: t("movePinUp"),
            icon: <ArrowUp />,
            isDisabled: pinSaving || index <= 0,
            onClick: () => movePin(index, false),
          },
          {
            id: "move-down",
            label: t("movePinDown"),
            icon: <ArrowDown />,
            isDisabled: pinSaving || index === sidebarPins.length - 1,
            onClick: () => movePin(index, true),
          },
        ]
      : [];
  const chatSortItems: DropdownMenuOption[] = [
    {
      id: "updated",
      label: t("pinnedRecentlyUpdated"),
      endContent: chatsSort === "updated" ? <Check size={16} /> : undefined,
      isDisabled: pinSaving,
      onClick: () => void savePreferences({ chatsSort: "updated" }),
    },
    {
      id: "manual",
      label: t("pinnedManualOrder"),
      endContent: chatsSort === "manual" ? <Check size={16} /> : undefined,
      isDisabled: pinSaving,
      onClick: () => void savePreferences({ chatsSort: "manual" }),
    },
  ];
  const pinSortItems: DropdownMenuOption[] = [
    {
      id: "updated",
      label: t("pinnedRecentlyUpdated"),
      endContent: pinnedSort === "updated" ? <Check size={16} /> : undefined,
      isDisabled: pinSaving,
      onClick: () => void savePreferences({ pinnedSort: "updated" }),
    },
    {
      id: "manual",
      label: t("pinnedManualOrder"),
      endContent: pinnedSort === "manual" ? <Check size={16} /> : undefined,
      isDisabled: pinSaving,
      onClick: () => void savePreferences({ pinnedSort: "manual" }),
    },
  ];
  const organizationItems: DropdownMenuOption[] = [
    {
      label: t("sidebarGroupBy"),
      items: [
        {
          label: t("sidebarByProject"),
          endContent: grouping === "project" ? <Check size={16} /> : undefined,
          isDisabled: pinSaving,
          onClick: () => void savePreferences({ sidebarGrouping: "project" }),
        },
        {
          label: t("sidebarFlatList"),
          endContent: grouping === "list" ? <Check size={16} /> : undefined,
          isDisabled: pinSaving,
          onClick: () => void savePreferences({ sidebarGrouping: "list" }),
        },
      ],
    },
    { label: t("sidebarChatSort"), items: chatSortItems },
  ];
  const recentOptions: DropdownMenuOption[] = [
    ...organizationItems,
    ...(grouping === "project"
      ? [
          {
            label: t("sidebarShow"),
            items: [
              {
                label: t("sidebarProjectsInRecents"),
                endContent:
                  snapshot?.preferences.projectsInRecents !== false ? (
                    <Check size={16} />
                  ) : undefined,
                isDisabled: pinSaving,
                onClick: () =>
                  void savePreferences({
                    projectsInRecents:
                      snapshot?.preferences.projectsInRecents === false,
                  }),
              },
            ],
          },
        ]
      : []),
  ];
  const activityActions = (
    <div className="sidebar-section-actions is-always-visible">
      <ActionMenu
        label={t("sidebarActivityOptions")}
        items={[
          {
            type: "section",
            title: t("sidebarShow"),
            items: [
              {
                label: t("sidebarPriority"),
                endContent: showPriority ? <Check size={16} /> : undefined,
                onClick: () => setShowPriority((value) => !value),
              },
            ],
          },
          { type: "divider" },
          {
            label: t("sidebarMarkAllRead"),
            icon: <MailOpen />,
            isDisabled: readingAll || !readablePriority.length,
            onClick: () => void markAllRead(readablePriority),
          },
        ]}
      />
      {showPriority &&
        prioritySessions.some((session) => !needsAttention(session)) && (
          <Tooltip content={t("sidebarClearRead")}>
            <button
              className="icon-button"
              type="button"
              aria-label={t("sidebarClearRead")}
              onClick={() =>
                setRetainedPriority(
                  new Set(
                    prioritySessions
                      .filter(needsAttention)
                      .map(activitySessionKey),
                  ),
                )
              }
            >
              <BrushCleaning aria-hidden="true" />
            </button>
          </Tooltip>
        )}
    </div>
  );
  const renderSession = (
    session: SidebarSession,
    inPinned = false,
    orderScope?: { key: string; sessions: SidebarSession[] },
  ) => {
    const pinIndex = sidebarPins.findIndex(
      (pin) =>
        pin.kind === "session" &&
        pin.session.path === session.path &&
        pin.session.id === session.id,
    );
    const target: WebSidebarPinTarget = {
      kind: "session",
      path: session.path,
      id: session.id,
    };
    const isPinned = session.pinOrder !== undefined;
    const running =
      props.connected !== false && session.execution?.status === "running";
    const waiting =
      props.connected !== false && session.execution?.waitingForInput;
    const outcome =
      session.firstUnread?.type === "turn"
        ? session.firstUnread.outcome
        : session.execution?.lastTurn?.outcome;
    const state = waiting
      ? "attention"
      : running
        ? "running"
        : session.unread
          ? outcome === "failed"
            ? "attention"
            : outcome === "completed"
              ? "completed"
              : "unread"
          : undefined;
    const StatusIcon =
      state === "running"
        ? LoaderCircle
        : state === "attention"
          ? CircleAlert
          : Circle;
    const queued =
      props.connected !== false
        ? (session.execution?.pendingFollowUps ?? 0)
        : 0;
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
      ...(stateLabel ? [t("sidebarState_" + stateLabel)] : []),
      ...(queued > 0 ? [t("pendingFollowUpsHint", { count: queued })] : []),
    ].join(" · ");
    const chatIndex =
      orderScope?.sessions.findIndex(
        (item) => item.path === session.path && item.id === session.id,
      ) ?? -1;
    const manualChat =
      !archived && !inPinned && chatsSort === "manual" && Boolean(orderScope);
    const moveChat = (before?: SidebarSession | null) =>
      saveSidebarChange(() =>
        props.actions.setSessionOrder(
          session.path,
          session.id,
          before ? { path: before.path, id: before.id } : null,
        ),
      );
    const movementItems: DropdownMenuOption[] = inPinned
      ? pinMoveItems(pinIndex)
      : manualChat && orderScope
        ? [
            {
              id: "move-up",
              label: t("movePinUp"),
              icon: <ArrowUp />,
              isDisabled: pinSaving || chatIndex <= 0,
              onClick: () =>
                void moveChat(
                  movedItemAnchor(orderScope.sessions, chatIndex, false),
                ),
            },
            {
              id: "move-down",
              label: t("movePinDown"),
              icon: <ArrowDown />,
              isDisabled:
                pinSaving || chatIndex === orderScope.sessions.length - 1,
              onClick: () =>
                void moveChat(
                  movedItemAnchor(orderScope.sessions, chatIndex, true),
                ),
            },
          ]
        : [];
    return (
      <li
        className={
          "session-row " +
          (session.unread ? "is-unread " : "") +
          (dropPath === session.path
            ? dropAfter
              ? "is-pin-drop-after"
              : "is-pin-drop-target"
            : "")
        }
        aria-label={sessionTitle(session, t("untitledSession"))}
        data-session-key={JSON.stringify([session.path, session.id])}
        key={session.path}
        draggable={
          !pinSaving &&
          !props.query.trim() &&
          (inPinned ? pinnedSort === "manual" : manualChat)
        }
        onDragStart={(event) => {
          event.stopPropagation();
          if (inPinned && pinnedSort === "manual") draggedPin.current = target;
          else if (manualChat && orderScope)
            draggedChat.current = {
              path: session.path,
              id: session.id,
              scope: orderScope.key,
            };
          else {
            event.preventDefault();
            return;
          }
          setDraggingSidebar(true);
          suppressDragClick.current = true;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", session.id);
        }}
        onDragOver={(event) => {
          if (
            !(inPinned && pinnedSort === "manual" && draggedPin.current) &&
            !(manualChat && draggedChat.current?.scope === orderScope?.key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setDropPath(session.path);
          setWorkspaceDrop(null);
          const bounds = event.currentTarget.getBoundingClientRect();
          setDropAfter(dropIsAfter(event.clientY, bounds));
        }}
        onDragEnd={endDrag}
        onDrop={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const after = dropIsAfter(event.clientY, bounds);
          if (inPinned && pinnedSort === "manual" && draggedPin.current) {
            event.preventDefault();
            event.stopPropagation();
            const next = sidebarPins[pinIndex + 1];
            void saveSidebarPin(
              draggedPin.current,
              true,
              after ? (next ? pinTarget(next) : null) : target,
            );
          } else if (
            manualChat &&
            orderScope &&
            draggedChat.current?.scope === orderScope.key
          ) {
            event.preventDefault();
            event.stopPropagation();
            const dragged = draggedChat.current;
            const before = droppedItemAnchor(
              orderScope.sessions,
              chatIndex,
              after,
            );
            void saveSidebarChange(() =>
              props.actions.setSessionOrder(
                dragged.path,
                dragged.id,
                before ? { path: before.path, id: before.id } : null,
              ),
            );
          } else return;
          endDrag();
        }}
      >
        <button
          className={"session " + (selected ? "active" : "")}
          type="button"
          aria-current={selected ? "page" : undefined}
          aria-label={[
            sessionTitle(session, t("untitledSession")),
            session.path,
            statusLabel,
          ]
            .filter(Boolean)
            .join(" · ")}
          onClick={() => {
            if (
              selected &&
              session.unread &&
              props.sessionViewVisible &&
              props.connected !== false
            )
              void saveRead(session, true);
            void props.actions.selectSession(session.path);
          }}
          onDoubleClick={(event) => {
            if (
              selected &&
              props.connected !== false &&
              event.target instanceof Element &&
              event.target.closest(".session-title")
            )
              openEdit({
                kind: "session",
                path: session.path,
                name: sessionTitle(session, t("untitledSession")),
              });
          }}
        >
          <span className="session-copy">
            <span
              className="session-title"
              title={sessionTitle(session, t("untitledSession"))}
            >
              {sessionTitle(session, t("untitledSession"))}
            </span>
            {activityOpen && (
              <span className="session-project">
                <Folder aria-hidden="true" />
                {snapshot?.workspaces.find(
                  (project) => project.path === sessionProject(session),
                )?.name ?? compactPath(sessionProject(session))}
              </span>
            )}
          </span>
          {statusLabel && (
            <Tooltip content={statusLabel}>
              <span className="session-status" aria-hidden="true">
                {state && (
                  <StatusIcon
                    className={"session-state session-state-" + state}
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
        </button>
        {!archived && (
          <Tooltip
            content={t(isPinned ? "unpinConversation" : "pinConversation")}
          >
            <button
              type="button"
              className="session-pin-button"
              aria-label={t(isPinned ? "unpinConversation" : "pinConversation")}
              disabled={pinSaving}
              onClick={(event) => {
                const focus = captureSidebarFocus(event.currentTarget);
                void savePin(session, !isPinned).finally(focus);
              }}
            >
              <Pin
                aria-hidden="true"
                fill={isPinned ? "currentColor" : "none"}
              />
            </button>
          </Tooltip>
        )}
        <ConversationMenu
          session={session}
          archived={archived}
          connected={props.connected !== false}
          pinSaving={pinSaving}
          restoring={restoring.has(session.path)}
          movementItems={movementItems}
          client={client}
          actions={props.actions}
          onRename={() =>
            openEdit({
              kind: "session",
              path: session.path,
              name: sessionTitle(session, t("untitledSession")),
            })
          }
          onPin={() => savePin(session, !isPinned)}
          onRead={() => saveRead(session, Boolean(session.unread))}
          onArchive={() =>
            archived
              ? restore(session.path)
              : props.actions.archiveSession(session.path)
          }
          onNotice={(message, error = false) =>
            setActionNotice({ message, error })
          }
        />
      </li>
    );
  };

  const renderWorkspace = (
    group: (typeof grouped)[number],
    inPinned = false,
  ) => {
    const collapsed =
      (archived ? archiveCollapsed : props.collapsed).has(group.path) &&
      !props.query.trim();
    const active = !group.ungrouped && activeWorkspace === group.path;
    const pinIndex = sidebarPins.findIndex(
      (pin) => pin.kind === "workspace" && pin.project.path === group.path,
    );
    const projectIndex = ordinaryProjects.findIndex(
      (project) => project.path === group.path,
    );
    const canReorder =
      !archived && !group.ungrouped && !pinSaving && !props.query.trim();
    const moveProject = (down: boolean) =>
      saveSidebarChange(() =>
        props.actions.setWorkspaceOrder(
          group.path,
          movedItemAnchor(ordinaryProjects, projectIndex, down)?.path ?? null,
        ),
      );
    const target: WebSidebarPinTarget = { kind: "workspace", path: group.path };
    const sessions = sortChats(group.sessions);
    const projectUnread = readableUnread.filter(
      (session) => !session.ungrouped && sessionProject(session) === group.path,
    );
    const expanded =
      archived ||
      Boolean(props.query.trim()) ||
      expandedGroups.has(group.path) ||
      sessions.length <= 6;
    const items: DropdownMenuOption[] = [
      ...(!archived
        ? [
            {
              id: "pin",
              label: t(inPinned ? "unpinWorkspace" : "pinWorkspace"),
              icon: <Pin />,
              isDisabled: pinSaving,
              onClick: () => void saveSidebarPin(target, !inPinned),
            },
            {
              id: "mark-read",
              label: t("sidebarMarkAllRead"),
              icon: <MailOpen />,
              isDisabled: readingAll || !projectUnread.length,
              onClick: () => void markAllRead(projectUnread),
            },
          ]
        : []),
      ...(inPinned
        ? pinMoveItems(pinIndex)
        : !archived
          ? [
              {
                id: "move-up",
                label: t("movePinUp"),
                icon: <ArrowUp />,
                isDisabled: !canReorder || projectIndex <= 0,
                onClick: () => void moveProject(false),
              },
              {
                id: "move-down",
                label: t("movePinDown"),
                icon: <ArrowDown />,
                isDisabled:
                  !canReorder || projectIndex === ordinaryProjects.length - 1,
                onClick: () => void moveProject(true),
              },
            ]
          : []),
      ...(!group.ungrouped
        ? [
            {
              id: "managed-worktrees",
              label: t("managedWorktrees"),
              icon: <Folder />,
              isDisabled: props.connected === false,
              onClick: () => {
                const row = Array.from(
                  sidebar.current?.querySelectorAll<HTMLElement>(
                    ".workspace-group",
                  ) ?? [],
                ).find((item) => item.dataset.workspaceKey === group.path);
                worktreeFocus.current = captureSidebarFocus(
                  row?.querySelector<HTMLElement>(
                    ".workspace-row-actions .menu-action-button",
                  ) ?? null,
                );
                queueMicrotask(() => setWorktreeWorkspace(group.path));
              },
            },
          ]
        : []),
      {
        id: "rename",
        label: t("renameWorkspace"),
        icon: <SquarePen />,
        onClick: () =>
          openEdit({ kind: "workspace", path: group.path, name: group.name }),
      },
      {
        id: "remove",
        label: t("removeWorkspace"),
        icon: <Trash2 />,
        variant: "destructive",
        onClick: () => {
          setRemoveError(false);
          setDeleteTarget({ path: group.path, name: group.name });
        },
      },
    ];
    return (
      <section
        className={
          "workspace-group " +
          (collapsed ? "collapsed " : "") +
          (active ? "is-active-workspace " : "") +
          (workspaceDrop === group.path
            ? dropAfter
              ? "is-pin-drop-after"
              : "is-pin-drop-target"
            : "")
        }
        key={group.path}
        data-workspace-key={group.path}
        aria-label={group.name}
        onDragOver={(event) => {
          if (
            !canReorder ||
            !draggedPin.current ||
            (inPinned
              ? pinnedSort !== "manual"
              : draggedPin.current.kind !== "workspace")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          setWorkspaceDrop(group.path);
          setDropPath(null);
          const bounds = event.currentTarget.getBoundingClientRect();
          setDropAfter(dropIsAfter(event.clientY, bounds));
        }}
        onDragEnd={endDrag}
        onDragLeave={(event) => {
          if (
            !(event.relatedTarget instanceof Node) ||
            !event.currentTarget.contains(event.relatedTarget)
          )
            setWorkspaceDrop(null);
        }}
        onDrop={(event) => {
          if (
            !canReorder ||
            !draggedPin.current ||
            (inPinned
              ? pinnedSort !== "manual"
              : draggedPin.current.kind !== "workspace")
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          const after = dropIsAfter(event.clientY, bounds);
          const dragged = draggedPin.current;
          if (dragged.kind !== "workspace" || dragged.path !== group.path) {
            if (inPinned) {
              const next = sidebarPins[pinIndex + 1];
              void saveSidebarPin(
                dragged,
                true,
                after ? (next ? pinTarget(next) : null) : target,
              );
            } else {
              void saveSidebarChange(() =>
                props.actions.setWorkspaceOrder(
                  dragged.path,
                  after
                    ? (ordinaryProjects[projectIndex + 1]?.path ?? null)
                    : group.path,
                ),
              );
            }
          }
          endDrag();
        }}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: Dragging is an optional pointer shortcut; the adjacent menu provides keyboard reordering. */}
        <div
          className="workspace-button"
          draggable={canReorder && (!inPinned || pinnedSort === "manual")}
          onDragStart={(event) => {
            if (
              !canReorder ||
              (inPinned && pinnedSort !== "manual") ||
              (event.target instanceof Element &&
                event.target.closest(".workspace-row-actions"))
            ) {
              event.preventDefault();
              return;
            }
            draggedPin.current = target;
            // Chromium captures the native drag before new drop areas move
            // the source. Ignore a delayed frame after drop/cancellation.
            requestAnimationFrame(() => {
              if (mounted.current && draggedPin.current === target)
                setDraggingSidebar(true);
            });
            suppressDragClick.current = true;
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", group.path);
          }}
        >
          <button
            className="workspace-label"
            type="button"
            aria-expanded={!collapsed}
            aria-current={active ? "location" : undefined}
            disabled={Boolean(props.query.trim())}
            title={group.ungrouped ? undefined : group.path}
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
              {collapsed ? (
                <Folder className="workspace-folder" />
              ) : (
                <FolderOpen className="workspace-folder" />
              )}
            </span>
            <span className="workspace-identity">
              <strong>{group.name}</strong>
              {group.showPath && <small>{compactPath(group.path)}</small>}
            </span>
          </button>
          {!group.ungrouped && (
            <span className="workspace-row-actions">
              <ActionMenu label={t("workspaceOptions")} items={items} />
              <Tooltip content={t("newSession")}>
                <button
                  className="workspace-action"
                  type="button"
                  aria-label={t("newSession") + " " + group.name}
                  disabled={creating}
                  aria-busy={creating || undefined}
                  onClick={() => void startSession(group.path)}
                >
                  <SquarePen />
                </button>
              </Tooltip>
            </span>
          )}
        </div>
        {!collapsed &&
          !sessions.length &&
          !archived &&
          !props.query.trim() &&
          !loadedHistoryBounded && (
            <p className="workspace-empty">{t("noConversations")}</p>
          )}
        {!collapsed && sessions.length > 0 && (
          <>
            <ul className="workspace-sessions">
              {(expanded ? sessions : limitSessions(sessions, 5)).map(
                (session) =>
                  renderSession(session, false, { key: group.path, sessions }),
              )}
            </ul>
            {!archived && !props.query.trim() && sessions.length > 6 && (
              <button
                className="sidebar-show-more is-indented"
                type="button"
                aria-expanded={expandedGroups.has(group.path)}
                onClick={() =>
                  setExpandedGroups((previous) => {
                    const next = new Set(previous);
                    if (next.has(group.path)) next.delete(group.path);
                    else next.add(group.path);
                    return next;
                  })
                }
              >
                {t(
                  expandedGroups.has(group.path)
                    ? "sidebarShowLess"
                    : "sidebarShowMore",
                )}
              </button>
            )}
          </>
        )}
      </section>
    );
  };
  const activityByDay = new Map<string, SidebarSession[]>();
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  for (const session of shownActivity) {
    const date = new Date(activityTime(session));
    const day =
      date.toDateString() === today.toDateString()
        ? t("sidebarToday")
        : date.toDateString() === yesterday.toDateString()
          ? t("sidebarYesterday")
          : Number.isFinite(date.getTime())
            ? date.toLocaleDateString(undefined, {
                weekday: "long",
              })
            : t("sidebarEarlier");
    activityByDay.set(day, [...(activityByDay.get(day) ?? []), session]);
  }
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
      onPointerDownCapture={() => {
        // A new gesture is intentional; only suppress the drag's trailing click.
        if (!draggedPin.current && !draggedChat.current)
          suppressDragClick.current = false;
      }}
      onClickCapture={(event) => {
        if (event.detail !== 0 && suppressDragClick.current) {
          event.preventDefault();
          event.stopPropagation();
          suppressDragClick.current = false;
        }
      }}
      onKeyDown={(event) => {
        if (!props.mobileOpen || event.defaultPrevented) return;
        // Native dialogs own focus; menus own dismissal but return Tab to the drawer.
        if (
          event.target instanceof Element &&
          (event.target.closest("dialog") ||
            (event.key !== "Tab" && event.target.closest('[role="menu"]')))
        )
          return;
        // Pointer-opened menus can leave focus on their trigger. Their own
        // layer must consume Escape before the surrounding mobile drawer.
        if (
          event.key === "Escape" &&
          sidebar.current?.querySelector(
            '[aria-haspopup="menu"][aria-expanded="true"]',
          )
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
        <span className="sidebar-brand-title">OpenPI</span>
        <div className="sidebar-header-actions">
          <Tooltip
            content={t(
              activityOpen ? "sidebarViewChats" : "sidebarViewActivity",
            )}
          >
            <button
              className="icon-button sidebar-activity-toggle"
              type="button"
              aria-label={t(
                activityOpen ? "sidebarViewChats" : "sidebarViewActivity",
              )}
              aria-pressed={activityOpen}
              onClick={() => {
                setArchived(false);
                setActivityOpen((value) => !value);
              }}
            >
              <Bell aria-hidden="true" />
              {unreadSessions.length > 0 && (
                <span className="sidebar-unread-dot" />
              )}
            </button>
          </Tooltip>
          <Tooltip content={t("searchConversations")}>
            <button
              ref={searchButton}
              className="icon-button"
              type="button"
              aria-label={t("searchConversations")}
              onClick={() => setTranscriptSearchOpen(true)}
            >
              <Search aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content={t("collapseSidebar")} placement="end">
            <button
              ref={closeButton}
              className="collapse-button sidebar-mobile-close"
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

      <TranscriptSearchDialog
        open={transcriptSearchOpen}
        initialQuery={props.query}
        initialIncludeArchived={archived}
        sessions={snapshot?.sessions ?? []}
        workspaces={snapshot?.workspaces ?? []}
        onClose={() => setTranscriptSearchOpen(false)}
        onOpenMessage={props.actions.navigateToMessage}
        onOpenSession={(path) => props.actions.selectSession(path)}
        onCreateSession={() => void startSession(props.selectedWorkspace)}
      />
      <div className="sidebar-navigation">
        {actionNotice && (
          <p
            className="sidebar-scope-note sidebar-action-feedback"
            role={actionNotice.error ? "alert" : "status"}
          >
            {actionNotice.message}
          </p>
        )}
        {pinError && (
          <p className="sidebar-scope-note" role="alert">
            {t("sidebarSaveFailed")}
          </p>
        )}
        {readError && (
          <p className="sidebar-scope-note" role="alert">
            {t("sidebarReadFailed")}
          </p>
        )}
        {activityOpen ? (
          <section
            className="sidebar-activity"
            aria-label={t("sidebarActivity")}
          >
            {showPriority && (
              <section aria-label={t("sidebarPriority")}>
                <div className="sidebar-section-heading">
                  <h2 className="sidebar-section-label">
                    {t("sidebarPriority")}
                  </h2>
                  {activityActions}
                </div>
                <ul className="sidebar-activity-sessions">
                  {shownPriority.map((session) => renderSession(session))}
                </ul>
                {!shownPriority.length && (
                  <p className="sidebar-activity-empty">
                    {t("sidebarActivityEmpty")}
                  </p>
                )}
              </section>
            )}
            {[...activityByDay].map(([day, sessions], index) => (
              <section key={day} aria-label={day}>
                <div className="sidebar-section-heading">
                  <h2 className="sidebar-section-label">{day}</h2>
                  {!showPriority && index === 0 && activityActions}
                </div>
                <ul className="sidebar-activity-sessions">
                  {sessions.map((session) => renderSession(session))}
                </ul>
              </section>
            ))}
            {!showPriority && !activityByDay.size && (
              <section aria-label={t("sidebarToday")}>
                <div className="sidebar-section-heading">
                  <h2 className="sidebar-section-label">{t("sidebarToday")}</h2>
                  {activityActions}
                </div>
                <p className="sidebar-activity-empty">
                  {t("sidebarActivityEmpty")}
                </p>
              </section>
            )}
            {hasMoreActivity && (
              <div
                ref={activityTail}
                className="sidebar-activity-tail"
                role="status"
                aria-label={t("loading")}
              >
                <LoaderCircle aria-hidden="true" />
              </div>
            )}
          </section>
        ) : (
          <>
            {!archived &&
              (sidebarPins.length > 0 ||
                (draggingSidebar &&
                  draggedPin.current &&
                  pinnedSort === "manual")) && (
                <section
                  className={
                    "pinned-section " +
                    (workspaceDrop === "pinned-tail" ? "is-pin-drop-after" : "")
                  }
                  aria-label={t("pinnedConversations")}
                  onDragOver={(event) => {
                    if (
                      pinSaving ||
                      pinnedSort !== "manual" ||
                      !draggedPin.current ||
                      props.query.trim()
                    )
                      return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setWorkspaceDrop("pinned-tail");
                    setDropPath(null);
                  }}
                  onDragLeave={(event) => {
                    if (
                      !(event.relatedTarget instanceof Node) ||
                      !event.currentTarget.contains(event.relatedTarget)
                    )
                      setWorkspaceDrop(null);
                  }}
                  onDrop={(event) => {
                    if (
                      pinSaving ||
                      pinnedSort !== "manual" ||
                      !draggedPin.current ||
                      props.query.trim()
                    )
                      return;
                    event.preventDefault();
                    event.stopPropagation();
                    void saveSidebarPin(draggedPin.current, true, null);
                    endDrag();
                  }}
                >
                  <div className="sidebar-section-heading">
                    <button
                      type="button"
                      className="workspace-heading-label"
                      aria-expanded={
                        !pinsCollapsed || Boolean(props.query.trim())
                      }
                      onClick={() => setPinsCollapsed((value) => !value)}
                    >
                      {t("pinnedConversations")}
                      <ChevronDown
                        className={
                          pinsCollapsed && !props.query.trim()
                            ? "is-collapsed"
                            : ""
                        }
                        aria-hidden="true"
                      />
                    </button>
                    <div className="sidebar-section-actions">
                      <ActionMenu
                        label={t("pinnedOptions")}
                        items={pinSortItems}
                        alignment="end"
                      />
                    </div>
                  </div>
                  {draggingSidebar &&
                    pinnedSort === "manual" &&
                    (sidebarPins.length === 0 || pinsCollapsed) && (
                      <p className="sidebar-drop-hint">{t("sidebarDropPin")}</p>
                    )}
                  {(!pinsCollapsed || Boolean(props.query.trim())) && (
                    <ul className="pinned-sessions">
                      {sidebarPins.map((pin) =>
                        pin.kind === "session" ? (
                          renderSession(pin.session, true)
                        ) : (
                          <li
                            key={pin.project.path}
                            className="pinned-workspace"
                          >
                            {renderWorkspace(pin.project, true)}
                          </li>
                        ),
                      )}
                    </ul>
                  )}
                </section>
              )}
            {(archived || grouping === "project" || props.searchOpen) && (
              <div
                className={
                  "workspace-heading sidebar-section-heading " +
                  (props.searchOpen ? "is-searching" : "")
                }
              >
                <button
                  type="button"
                  className="workspace-heading-label"
                  aria-label={
                    archived ? t("currentConversations") : t("sidebarProjects")
                  }
                  aria-expanded={
                    archived
                      ? undefined
                      : !projectsCollapsed || Boolean(props.query.trim())
                  }
                  onClick={() =>
                    archived
                      ? setArchived(false)
                      : setProjectsCollapsed((value) => !value)
                  }
                >
                  {archived && <ArrowLeft aria-hidden="true" />}
                  {t(archived ? "archivedConversations" : "sidebarProjects")}
                  {!archived && (
                    <ChevronDown
                      className={
                        projectsCollapsed && !props.query.trim()
                          ? "is-collapsed"
                          : ""
                      }
                      aria-hidden="true"
                    />
                  )}
                </button>
                <div className="session-search">
                  <Search />
                  <input
                    ref={searchInput}
                    type="search"
                    value={props.query}
                    placeholder={t("searchPlaceholder")}
                    maxLength={
                      archived ? WEB_MAX_ARCHIVED_SESSION_QUERY : undefined
                    }
                    aria-label={t("searchConversations")}
                    onChange={(event) =>
                      props.actions.setQuery(event.target.value)
                    }
                  />
                  <button
                    type="button"
                    aria-label={t("closeSearch")}
                    onClick={() => props.actions.setSearchOpen(false)}
                  >
                    <X />
                  </button>
                </div>
                <div className="workspace-actions sidebar-section-actions">
                  {!archived && (
                    <ActionMenu
                      label={t("sidebarProjectOptions")}
                      items={organizationItems}
                    />
                  )}
                  {archived && (
                    <Tooltip content={t("sidebarFilterList")}>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={t("sidebarFilterList")}
                        onClick={() => props.actions.setSearchOpen(true)}
                      >
                        <Search />
                      </button>
                    </Tooltip>
                  )}
                  {!archived && (
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
                  )}
                </div>
              </div>
            )}
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
              {(archived
                ? grouped
                : grouping === "project" &&
                    (!projectsCollapsed || props.query.trim())
                  ? shownProjects
                  : []
              ).map((group) => renderWorkspace(group))}
              {!archived &&
                grouping === "project" &&
                draggingSidebar &&
                draggedPin.current?.kind === "workspace" &&
                !props.query.trim() && (
                  <section
                    className={
                      "sidebar-project-tail " +
                      (workspaceDrop === "project-tail"
                        ? "is-pin-drop-target"
                        : "")
                    }
                    aria-label={t("sidebarDropProjectLast")}
                    onDragOver={(event) => {
                      if (pinSaving || draggedPin.current?.kind !== "workspace")
                        return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setWorkspaceDrop("project-tail");
                      setDropPath(null);
                    }}
                    onDragLeave={(event) => {
                      if (
                        !(event.relatedTarget instanceof Node) ||
                        !event.currentTarget.contains(event.relatedTarget)
                      )
                        setWorkspaceDrop(null);
                    }}
                    onDrop={(event) => {
                      if (pinSaving || draggedPin.current?.kind !== "workspace")
                        return;
                      event.preventDefault();
                      const target = draggedPin.current;
                      void saveSidebarChange(() =>
                        props.actions.setWorkspaceOrder(target.path, null),
                      );
                      endDrag();
                    }}
                  >
                    {t("sidebarDropProjectLast")}
                  </section>
                )}
              {!archived &&
                grouping === "project" &&
                !projectsCollapsed &&
                !props.query.trim() &&
                ordinaryProjects.length > 6 && (
                  <button
                    className="sidebar-show-more"
                    type="button"
                    aria-expanded={projectsExpanded}
                    onClick={() => setProjectsExpanded((value) => !value)}
                  >
                    {t(
                      projectsExpanded ? "sidebarShowLess" : "sidebarShowMore",
                    )}
                  </button>
                )}
              {!archived && (
                <section
                  className="sidebar-recents"
                  aria-label={t("sidebarRecent")}
                >
                  <div className="sidebar-section-heading">
                    <button
                      type="button"
                      className="workspace-heading-label"
                      aria-expanded={
                        !recentsCollapsed || Boolean(props.query.trim())
                      }
                      onClick={() => setRecentsCollapsed((value) => !value)}
                    >
                      {t("sidebarRecent")}
                      <ChevronDown
                        className={
                          recentsCollapsed && !props.query.trim()
                            ? "is-collapsed"
                            : ""
                        }
                        aria-hidden="true"
                      />
                    </button>
                    <div className="sidebar-section-actions">
                      <ActionMenu
                        label={t("sidebarRecentOptions")}
                        items={recentOptions}
                      />
                    </div>
                  </div>
                  {(!recentsCollapsed || Boolean(props.query.trim())) && (
                    <ul className="recent-sessions">
                      {shownRecent.map((session) =>
                        renderSession(session, false, {
                          key: "recent",
                          sessions: recentSessions,
                        }),
                      )}
                    </ul>
                  )}
                  {!recentsCollapsed &&
                    shownRecent.length < recentSessions.length && (
                      <button
                        className="sidebar-show-more"
                        type="button"
                        onClick={() => setRecentCount((count) => count + 10)}
                      >
                        {t("sidebarShowMore")}
                      </button>
                    )}
                </section>
              )}
              {(archived
                ? !grouped.length
                : !sidebarPins.length &&
                  !recentSessions.length &&
                  (grouping === "list" || !ordinaryProjects.length)) && (
                <div
                  className="empty"
                  hidden={
                    archived && (archiveLoading || Boolean(scopedArchiveError))
                  }
                >
                  {props.query.trim()
                    ? t(
                        archived &&
                          scopedArchivePage?.truncation.recordsUnscanned
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
                    onClick={() =>
                      void loadArchives(scopedArchivePage.nextCursor)
                    }
                  >
                    {t("moreArchives")}
                  </button>
                )}
            </div>
          </>
        )}
      </div>
      <div className="sidebar-footer">
        <button
          className="sidebar-settings-button sidebar-archive-toggle"
          type="button"
          aria-label={t("archivedConversations")}
          aria-pressed={archived}
          title={t("archivedConversations")}
          onClick={() => {
            setActivityOpen(false);
            setArchived((value) => !value);
          }}
        >
          <Archive aria-hidden="true" />
          <span>{t("archivedConversations")}</span>
        </button>
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

      {worktreeWorkspace && (
        <ManagedWorktreesDialog
          key={worktreeWorkspace}
          workspace={worktreeWorkspace}
          client={client}
          actions={props.actions}
          connected={props.connected !== false}
          onClose={() => {
            setWorktreeWorkspace(null);
            worktreeFocus.current?.();
          }}
        />
      )}
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
