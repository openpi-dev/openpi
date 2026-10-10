import { Menu, PanelLeftOpen, PanelRight, RefreshCw, X } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { OpenPiLogo } from "../components/OpenPiLogo.tsx";
import { PaneResizeHandle } from "../components/PaneResizeHandle.tsx";
import {
  ArtifactProvider,
  type ArtifactProviderHandle,
} from "../features/artifacts/Artifacts.tsx";
import { Composer } from "../features/composer/Composer.tsx";
import {
  InspectionPanel,
  type InspectionTarget,
} from "../features/inspection/InspectionPanel.tsx";
import {
  QuestionPanel,
  type QuestionWorkingCache,
} from "../features/questions/QuestionPanel.tsx";
import type { DiffLineReference } from "../features/review/DiffCodePreview.tsx";
import { useGitReview } from "../features/review/use-git-review.ts";
import { SessionSidebar } from "../features/sessions/SessionSidebar.tsx";
import { ProviderSettingsPage } from "../features/settings/ProviderSettingsPage.tsx";
import { recordedSubagents } from "../features/subagents/recorded-subagents.ts";
import { SessionOverview } from "../features/subagents/SessionOverview.tsx";
import { SubagentPanel } from "../features/subagents/SubagentPanel.tsx";
import { subagentOverview } from "../features/subagents/subagent-overview.ts";
import { Trajectory } from "../features/trajectory/Trajectory.tsx";
import {
  createSessionReadingCache,
  type ReadingPosition,
  sessionReadingScope,
} from "../features/transcript/session-reading-state.ts";
import type {
  WebHistoryAnchor,
  WebSessionProjection,
} from "../../../protocol/types.ts";
import { WebClient } from "../protocol/client.ts";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { SessionUsageBar } from "../features/workbar/SessionUsageBar.tsx";
import type { WorkbarTool } from "../features/workbar/types.ts";
import { WorkbarPanel } from "../features/workbar/WorkbarPanel.tsx";
import { useBrowserConnector } from "../features/workbar/browser-connector.ts";
import { useBrowserControl } from "../features/workbar/browser-control.ts";
import {
  loadWorkbarPositions,
  saveWorkbarPositions,
  type WorkbarWorkspace,
} from "../features/workbar/workbar-position-storage.ts";
import { sessionTitle, workspaceName } from "../lib/format.ts";
import { isControlledSession } from "../lib/session-control.ts";
import { webStore } from "../store/web-store.ts";

const SIDEBAR_DEFAULT_WIDTH = 280;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 420;
const SIDEBAR_COLLAPSE_THRESHOLD = 190;
const AUXILIARY_DEFAULT_WIDTH = 520;
const AUXILIARY_MIN_WIDTH = 360;
const AUXILIARY_MAX_WIDTH = 720;
const AUXILIARY_COLLAPSE_THRESHOLD = 320;
const CENTER_MIN_WIDTH = 440;
const AUXILIARY_BREAKPOINT = 1_100;
const MAX_WORKBAR_POSITIONS = 32;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function App() {
  useBrowserConnector();
  const state = useStore(webStore);
  const { t } = useTranslation();
  const { actions } = state;
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const auxiliaryTrigger = useRef<HTMLElement | null>(null);
  const auxiliaryOpen = useRef(false);
  const inspectionFallbackFocus = useRef<HTMLElement | null>(null);
  const providerSettingsTrigger = useRef<HTMLElement | null>(null);
  const workbarReturnFocus = useRef<HTMLElement | null>(null);
  const artifactProvider = useRef<ArtifactProviderHandle>(null);
  const browserOpener = useRef<
    ((url: string) => string | undefined) | undefined
  >(undefined);
  const browserReady = useCallback(
    (open: ((url: string) => string | undefined) | undefined) => {
      browserOpener.current = open;
    },
    [],
  );
  const readingCache = useMemo(createSessionReadingCache, []);
  const readingRestored = useRef(new Set<string>());
  const [, updateReadingRestore] = useState(0);
  const [restoredNavigation, setRestoredNavigation] = useState<
    | (WebHistoryAnchor & {
        revision: number;
        session: WebSessionProjection;
        restorePosition: ReadingPosition;
      })
    | null
  >(null);
  const questionWorkingCache = useMemo<QuestionWorkingCache>(
    () => new Map(),
    [],
  );
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [addSourcesRequest, setAddSourcesRequest] = useState<{
    sessionId: string;
    path: string;
    revision: number;
    feedback?: DiffLineReference;
  }>();
  const [resizingPane, setResizingPane] = useState(false);
  const [centerCollapsed, setCenterCollapsed] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [paneWidths, setPaneWidths] = useState({
    sidebar: SIDEBAR_DEFAULT_WIDTH,
    auxiliary: AUXILIARY_DEFAULT_WIDTH,
  });
  const [paneWidthsEdited, setPaneWidthsEdited] = useState(false);
  const preferencesLoaded = Boolean(state.snapshot);
  const savedSidebarWidth = state.snapshot?.preferences.sidebarWidth;
  const savedAuxiliaryWidth = state.snapshot?.preferences.auxiliaryWidth;
  useEffect(() => {
    if (!preferencesLoaded || paneWidthsEdited || resizingPane) return;
    setPaneWidths({
      sidebar: savedSidebarWidth ?? SIDEBAR_DEFAULT_WIDTH,
      auxiliary: savedAuxiliaryWidth ?? AUXILIARY_DEFAULT_WIDTH,
    });
  }, [
    savedSidebarWidth,
    savedAuxiliaryWidth,
    preferencesLoaded,
    paneWidthsEdited,
    resizingPane,
  ]);
  useEffect(() => {
    if (!paneWidthsEdited || resizingPane) return;
    const timer = window.setTimeout(() => {
      void actions
        .savePreferences({
          sidebarWidth: paneWidths.sidebar,
          auxiliaryWidth: paneWidths.auxiliary,
        })
        .catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(timer);
  }, [actions, paneWidths, paneWidthsEdited, resizingPane]);
  const resizePane = (side: "sidebar" | "auxiliary", value: number) => {
    // Once adjusted here, this page owns its widths until reload. A save
    // acknowledgement or later snapshot must not overwrite newer input.
    setPaneWidthsEdited(true);
    setPaneWidths((current) => ({ ...current, [side]: value }));
  };
  const [narrow, setNarrow] = useState(
    () => window.matchMedia?.("(max-width: 760px)").matches ?? false,
  );
  const mobileSidebarOpen = narrow && state.mobileSidebarOpen;
  useEffect(() => {
    const media = window.matchMedia?.("(max-width: 760px)");
    if (!media) return;
    const update = () => {
      setNarrow(media.matches);
      if (!media.matches) actions.closeMobileSidebar();
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [actions]);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  const [inspection, setInspection] = useState<InspectionTarget | null>(null);
  const [providerSettings, setProviderSettings] = useState<{
    sessionId: string;
    sessionPath: string;
    cwd: string;
    entry: "general" | "credentials" | "browser";
  } | null>(null);
  const [workbarWorkspaces, setWorkbarWorkspaces] =
    useState<WorkbarWorkspace[]>(loadWorkbarPositions);
  useEffect(() => {
    const save = () => saveWorkbarPositions(workbarWorkspaces);
    save();
    window.addEventListener("pagehide", save);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") save();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", save);
      document.removeEventListener("visibilitychange", onVisibility);
      save();
    };
  }, [workbarWorkspaces]);
  const workbarSession = state.workspaceDraft
    ? undefined
    : state.snapshot?.selectedSession;
  const workbarTarget = workbarWorkspaces.find(
    (workspace) =>
      workspace.sessionId === workbarSession?.id &&
      workspace.sessionPath === workbarSession?.path,
  );
  const workbarOpen = workbarTarget?.open ?? false;
  const reviewTurn = workbarTarget?.reviewTurn;
  const updateWorkbar = useCallback(
    (update: (workspace: WorkbarWorkspace) => WorkbarWorkspace) => {
      const session = webStore.getState().snapshot?.selectedSession;
      if (!session) return;
      setWorkbarWorkspaces((workspaces) =>
        workspaces.map((workspace) =>
          workspace.sessionId === session.id &&
          workspace.sessionPath === session.path
            ? update(workspace)
            : workspace,
        ),
      );
    },
    [],
  );
  const setWorkbarOpen = useCallback(
    (open: boolean) => updateWorkbar((workspace) => ({ ...workspace, open })),
    [updateWorkbar],
  );
  const setReviewTurn = (turn: WorkbarWorkspace["reviewTurn"] | null) =>
    updateWorkbar((workspace) => ({
      ...workspace,
      reviewTurn: turn ?? undefined,
    }));
  const [workbarActiveTool, setWorkbarActiveTool] =
    useState<WorkbarTool | null>(null);
  const [subagentTarget, setSubagentTarget] = useState<{
    sessionId: string;
    sessionPath: string;
    id?: string;
    navigation: number;
  } | null>(null);
  const inspectSubagent = useCallback(
    (id?: string) => {
      const current = webStore.getState();
      const session = current.snapshot?.selectedSession;
      if (
        current.workspaceDraft ||
        current.sessionSwitching ||
        !session ||
        !session.id
      )
        return;
      if (!auxiliaryOpen.current)
        auxiliaryTrigger.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      auxiliaryOpen.current = true;
      workbarReturnFocus.current = null;
      setWorkbarOpen(false);
      setSubagentTarget((previous) => ({
        sessionId: session.id,
        sessionPath: session.path,
        id,
        navigation: (previous?.navigation ?? 0) + 1,
      }));
    },
    [setWorkbarOpen],
  );
  const subagentVisible =
    subagentTarget &&
    !state.workspaceDraft &&
    !state.sessionSwitching &&
    subagentTarget.sessionId === state.snapshot?.selectedSession?.id &&
    subagentTarget.sessionPath === state.snapshot?.selectedSession?.path;
  useEffect(() => {
    if (subagentTarget && !subagentVisible) setSubagentTarget(null);
  }, [subagentTarget, subagentVisible]);
  useEffect(() => {
    if (subagentVisible || !auxiliaryOpen.current) return;
    auxiliaryOpen.current = false;
    const trigger = auxiliaryTrigger.current;
    auxiliaryTrigger.current = null;
    queueMicrotask(() => {
      if (trigger?.isConnected && trigger.checkVisibility()) trigger.focus();
    });
  }, [subagentVisible]);
  const currentModel = state.snapshot?.models.find((model) => model.current);
  const modelKey = JSON.stringify([currentModel?.provider, currentModel?.id]);
  const inspect = (terminalId?: string) => {
    const snapshot = state.snapshot;
    const session = snapshot?.selectedSession;
    if (
      state.workspaceDraft ||
      !snapshot ||
      !session ||
      state.sessionSwitching ||
      !isControlledSession(snapshot, session)
    )
      return;
    workbarReturnFocus.current = null;
    setWorkbarOpen(false);
    setInspection({
      sessionId: session.id,
      sessionPath: session.path,
      cwd: session.cwd,
      model: currentModel?.label ?? "",
      modelKey,
      terminalId,
    });
  };
  const inspectionVisible =
    inspection &&
    !state.workspaceDraft &&
    !state.sessionSwitching &&
    isControlledSession(state.snapshot, {
      id: inspection.sessionId,
      path: inspection.sessionPath,
    }) &&
    inspection.sessionPath === state.snapshot?.selectedSession?.path &&
    inspection.modelKey === modelKey;
  useEffect(() => {
    if (inspection && !inspectionVisible) setInspection(null);
  }, [inspection, inspectionVisible]);
  const closeInspection = useCallback(() => {
    setInspection(null);
    const fallback = inspectionFallbackFocus.current;
    inspectionFallbackFocus.current = null;
    if (!fallback) return;
    requestAnimationFrame(() => {
      if (fallback.isConnected && fallback.checkVisibility()) fallback.focus();
    });
  }, []);
  const providerSettingsVisible =
    providerSettings &&
    !state.workspaceDraft &&
    !state.sessionSwitching &&
    isControlledSession(state.snapshot, {
      id: providerSettings.sessionId,
      path: providerSettings.sessionPath,
    }) &&
    providerSettings.sessionPath === state.snapshot?.selectedSession?.path;
  useEffect(() => {
    if (providerSettings && !providerSettingsVisible) setProviderSettings(null);
  }, [providerSettings, providerSettingsVisible]);
  const openProviderSettings = async (
    entry: "general" | "credentials" | "browser" = "general",
  ) => {
    providerSettingsTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const target = await actions.prepareSession();
    if (!target) return;
    const current = webStore.getState();
    const snapshot = current.snapshot;
    const session = snapshot?.selectedSession;
    if (
      current.workspaceDraft ||
      !session ||
      current.sessionSwitching ||
      !isControlledSession(snapshot, session) ||
      session.id !== target.sessionId ||
      session.path !== target.sessionPath
    )
      return;
    actions.closeMobileSidebar();
    setInspection(null);
    setSubagentTarget(null);
    workbarReturnFocus.current = null;
    setWorkbarOpen(false);
    setProviderSettings({
      sessionId: session.id,
      sessionPath: session.path,
      cwd: session.cwd,
      entry,
    });
  };
  const closeProviderSettings = useCallback(() => {
    setProviderSettings(null);
    requestAnimationFrame(() => {
      const trigger = providerSettingsTrigger.current;
      providerSettingsTrigger.current = null;
      if (trigger?.isConnected && trigger.checkVisibility()) trigger.focus();
      else
        document
          .querySelector<HTMLButtonElement>("[data-provider-settings-trigger]")
          ?.focus();
    });
  }, []);
  const openRuntimeStatusFromSettings = () => {
    inspectionFallbackFocus.current =
      providerSettingsTrigger.current ??
      document.querySelector<HTMLElement>("[data-provider-settings-trigger]");
    setProviderSettings(null);
    inspect();
  };
  const configureOpenPiFromSettings = async (request: string) => {
    if (await actions.sendPrompt(`/openpi-setup ${request}`)) return true;
    const latest = webStore.getState();
    throw new Error(
      (typeof latest.notice === "string" ? latest.notice : null) ||
        t(
          latest.promptAdmissionRecovery
            ? "setupResolveAdmission"
            : latest.liveRunning || latest.activeTurn
              ? "settingsSetupBusyHint"
              : "setupRequestFailed",
        ),
    );
  };

  useEffect(() => {
    actions.start();
    return actions.stop;
  }, [actions]);

  const selected = state.workspaceDraft
    ? undefined
    : state.snapshot?.selectedSession;
  const readingScope = sessionReadingScope(selected);
  const readingSourceId = selected?.id;
  const readingSourcePath = selected?.path;
  const readingRestorePending = Boolean(
    selected &&
      !readingRestored.current.has(readingScope) &&
      readingCache.get(readingScope)?.position?.key &&
      readingCache.get(readingScope)?.position?.pinned === false,
  );
  useEffect(() => {
    // Read the current native projection at this identity boundary. Sliding
    // live snapshots must not continually abort an older-window restoration.
    const source = webStore.getState();
    const selected = source.workspaceDraft
      ? undefined
      : source.snapshot?.selectedSession;
    if (
      !selected ||
      selected.id !== readingSourceId ||
      selected.path !== readingSourcePath ||
      state.sessionSwitching ||
      readingRestored.current.has(readingScope)
    )
      return;
    const position = readingCache.get(readingScope)?.position;
    const settled = () => {
      readingRestored.current.add(readingScope);
      updateReadingRestore((revision) => revision + 1);
    };
    if (
      !position?.key ||
      position.pinned ||
      readingCache.get(readingScope)?.window ||
      (state.historyNavigation?.sessionId === selected.id &&
        state.historyNavigation.sessionPath === selected.path)
    ) {
      settled();
      return;
    }
    const anchor = {
      sessionId: selected.id,
      sessionPath: selected.path,
      entryId: position.entryId ?? position.key,
    };
    const controller = new AbortController();
    let retry: number | undefined;
    const interrupt = (event: Event) => {
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(".conversation, .turn-rail, .jump-to-latest")
      )
        return;
      if (
        event instanceof KeyboardEvent &&
        ![
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        return;
      controller.abort();
      settled();
      setRestoredNavigation((current) =>
        current?.sessionId === anchor.sessionId &&
        current.sessionPath === anchor.sessionPath
          ? null
          : current,
      );
    };
    for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
      document.addEventListener(type, interrupt, true);
    const apply = (session: WebSessionProjection) => {
      const current = webStore.getState();
      if (
        controller.signal.aborted ||
        readingRestored.current.has(readingScope) ||
        current.historyNavigation ||
        current.sessionSwitching ||
        current.workspaceDraft ||
        current.selectedPath !== anchor.sessionPath ||
        current.snapshot?.selectedSession?.id !== anchor.sessionId ||
        current.snapshot.selectedSession.path !== anchor.sessionPath ||
        readingCache.get(readingScope)?.position !== position ||
        session.id !== anchor.sessionId ||
        session.path !== anchor.sessionPath ||
        session.history?.anchorEntryId !== anchor.entryId ||
        session.history.anchorOnBranch !== true ||
        !session.entries.some((entry) => entry.id === anchor.entryId)
      )
        return;
      setRestoredNavigation({
        ...anchor,
        session,
        restorePosition: position,
        revision: -1,
      });
      settled();
    };
    if (state.connection === "connected") {
      if (selected.entries.some((entry) => entry.id === anchor.entryId))
        apply({
          ...selected,
          history: {
            leafEntryId: selected.history?.leafEntryId ?? null,
            beforeEntryId: selected.history?.beforeEntryId ?? null,
            anchorEntryId: anchor.entryId,
            anchorOnBranch: true,
          },
        });
      else {
        const load = (attempt: number) => {
          void new WebClient()
            .sessionMessageWindow(anchor, controller.signal)
            .then(apply, () => {
              // Cancellation and temporary connectivity failures never consume
              // or erase the bookmark. StrictMode can safely start a fresh read.
              if (!controller.signal.aborted && attempt === 0)
                retry = window.setTimeout(() => load(1), 500);
            });
        };
        load(0);
      }
    }
    return () => {
      controller.abort();
      window.clearTimeout(retry);
      for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
        document.removeEventListener(type, interrupt, true);
    };
  }, [
    readingSourceId,
    readingSourcePath,
    state.connection,
    state.sessionSwitching,
    state.historyNavigation,
    readingScope,
    readingCache,
  ]);
  const controlled = isControlledSession(state.snapshot, selected);
  const savedSubagents = useMemo(
    () =>
      recordedSubagents(
        (selected?.entries ?? []).flatMap((entry) =>
          entry.message ? [entry.message] : [],
        ),
      ),
    [selected?.entries],
  );
  const liveSubagents = controlled
    ? state.snapshot?.runtime.capabilities.subagents
    : undefined;
  const overviewAgents = useMemo(
    () => subagentOverview(liveSubagents?.items ?? [], savedSubagents),
    [liveSubagents?.items, savedSubagents],
  );
  const execution = state.snapshot?.selectedExecution;
  const selectedExecution =
    execution?.sessionId === selected?.id &&
    execution?.sessionPath === selected?.path
      ? execution
      : undefined;
  const selectedRunning =
    (controlled &&
      (state.liveRunning ||
        Boolean(state.activeTurn) ||
        state.snapshot?.runtime.status === "running")) ||
    selectedExecution?.status === "running";
  const gitReview = useGitReview(selected, state.snapshot?.cursor, {
    active: workbarOpen && workbarActiveTool === "review",
    running: selectedRunning,
    initialSource: workbarTarget?.reading.review?.scope.startsWith("workspace:")
      ? workbarTarget.reading.review.source
      : "unstaged",
    initialBaseRef: workbarTarget?.reading.review?.baseRef,
  });
  const workbarBound = Boolean(
    workbarTarget &&
      selected &&
      state.selectedPath === selected.path &&
      workbarTarget.sessionId === selected.id &&
      workbarTarget.sessionPath === selected.path,
  );
  const workbarVisible = workbarOpen && workbarBound && !state.sessionSwitching;
  useEffect(() => {
    // Switching only detaches this view. It never cancels a tool or discards
    // its reading position; stale focus must not cross Session identities.
    void selected?.id;
    void selected?.path;
    workbarReturnFocus.current = null;
  }, [selected?.id, selected?.path]);
  useEffect(() => {
    if (!workbarTarget || state.sessionSwitching) return;
    setWorkbarWorkspaces((workspaces) => {
      if (workspaces.at(-1) === workbarTarget) return workspaces;
      return [
        ...workspaces.filter((workspace) => workspace !== workbarTarget),
        workbarTarget,
      ];
    });
  }, [workbarTarget, state.sessionSwitching]);
  const openWorkbar = (tool: WorkbarTool = "launcher") => {
    if (!selected || state.sessionSwitching) return;
    if (artifactPanelOpen) {
      artifactProvider.current?.close({ restoreFocus: false });
    }
    if (!workbarVisible)
      workbarReturnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setInspection(null);
    setSubagentTarget(null);
    setWorkbarWorkspaces((workspaces) => {
      const current = workspaces.find(
        (workspace) =>
          workspace.sessionId === selected.id &&
          workspace.sessionPath === selected.path,
      );
      const next = {
        sessionId: selected.id,
        sessionPath: selected.path,
        tool,
        requestRevision: (current?.requestRevision ?? 0) + 1,
        open: true,
        reading: current?.reading ?? {},
        reviewTurn: tool === "review" ? undefined : current?.reviewTurn,
      };
      return [
        ...workspaces.filter((workspace) => workspace !== current),
        next,
      ].slice(-MAX_WORKBAR_POSITIONS);
    });
  };
  const closeWorkbar = () => {
    setCenterCollapsed(false);
    setWorkbarOpen(false);
    const trigger = workbarReturnFocus.current;
    workbarReturnFocus.current = null;
    requestAnimationFrame(() => {
      if (trigger?.isConnected && trigger.checkVisibility()) trigger.focus();
    });
  };
  const browserScope =
    !state.sessionSwitching &&
    !state.workspaceDraft &&
    isControlledSession(state.snapshot, selected)
      ? selected
      : undefined;
  useBrowserControl(
    browserScope?.id,
    browserScope?.path,
    async (url, signal) => {
      openWorkbar("browser");
      const deadline = Date.now() + 5000;
      while (!browserOpener.current && !signal.aborted && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 40));
      return signal.aborted ? undefined : browserOpener.current?.(url);
    },
  );
  const browserSettingsLink = useRef(
    new URLSearchParams(location.search).get("settings") === "browser",
  );
  const openBrowserSettingsFromLink = useEffectEvent(() => {
    void openProviderSettings("browser");
  });
  useEffect(() => {
    if (
      !browserSettingsLink.current ||
      !state.snapshot ||
      state.sessionSwitching
    )
      return;
    browserSettingsLink.current = false;
    openBrowserSettingsFromLink();
  }, [state.snapshot, state.sessionSwitching]);
  const auxiliaryVisible = Boolean(
    subagentVisible || workbarVisible || artifactPanelOpen,
  );
  useEffect(() => {
    if (!auxiliaryVisible || viewportWidth <= AUXILIARY_BREAKPOINT)
      setCenterCollapsed(false);
  }, [auxiliaryVisible, viewportWidth]);
  const sidebarMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      viewportWidth -
        CENTER_MIN_WIDTH -
        (auxiliaryVisible && !centerCollapsed ? paneWidths.auxiliary : 0),
    ),
  );
  const sidebarWidth = clamp(paneWidths.sidebar, SIDEBAR_MIN_WIDTH, sidebarMax);
  const auxiliaryMax = Math.max(
    AUXILIARY_MIN_WIDTH,
    Math.min(
      AUXILIARY_MAX_WIDTH,
      viewportWidth -
        (state.sidebarCollapsed ? 56 : sidebarWidth) -
        CENTER_MIN_WIDTH,
    ),
  );
  const auxiliaryWidth = clamp(
    paneWidths.auxiliary,
    AUXILIARY_MIN_WIDTH,
    auxiliaryMax,
  );
  const shellStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--auxiliary-width": `${auxiliaryWidth}px`,
  } as CSSProperties;
  const closeAuxiliaryPanel = () => {
    if (artifactPanelOpen) artifactProvider.current?.close();
    else if (workbarVisible) closeWorkbar();
    else if (subagentVisible) setSubagentTarget(null);
  };
  const loading = !state.snapshot;
  const workspacePath = state.sessionSwitching
    ? state.snapshot?.sessions.find(
        (session) => session.path === state.selectedPath,
      )?.cwd
    : state.workspaceDraft
      ? state.selectedWorkspace
      : (selected?.cwd ?? state.selectedWorkspace);
  const workspace = state.snapshot?.workspaces.find(
    (item) => item.path === workspacePath,
  );
  const currentSession = state.snapshot?.sessions.find(
    (session) => session.path === selected?.path && session.id === selected?.id,
  );
  const switchingTo = state.sessionSwitching
    ? state.snapshot?.sessions.find(
        (session) => session.path === state.selectedPath,
      )
    : undefined;
  const taskTitle = state.sessionSwitching
    ? switchingTo
      ? sessionTitle(switchingTo, t("untitledSession"))
      : t("switchingSession")
    : selected
      ? sessionTitle(currentSession ?? {}, t("untitledSession"))
      : state.selectedWorkspace
        ? t("newSession")
        : "OpenPI";
  const hasMessages =
    Boolean(selected?.rerun) ||
    selected?.entries.some(
      (entry) =>
        (entry.type === "message" && entry.message) ||
        entry.type === "compaction",
    ) ||
    Boolean(selected?.history?.beforeEntryId) ||
    state.liveMessages.length > 0;
  const landing =
    !loading &&
    !state.sessionSwitching &&
    (!selected ||
      (!hasMessages &&
        !(
          state.snapshot?.selectedExecution?.sessionId === selected.id &&
          state.snapshot.selectedExecution?.sessionPath === selected.path &&
          state.snapshot.selectedExecution.compaction
        )));
  const resend = useCallback(
    (content: string) => actions.sendPrompt(content),
    [actions],
  );

  return (
    <>
      <div
        inert={providerSettingsVisible ? true : undefined}
        aria-hidden={providerSettingsVisible ? true : undefined}
        className={`app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""} ${state.mobileSidebarOpen ? "sidebar-open" : ""} ${subagentVisible ? "with-subagent-panel" : ""} ${workbarVisible ? "with-workbar-panel" : ""} ${artifactPanelOpen ? "with-artifact-panel" : ""} ${centerCollapsed ? "center-collapsed" : ""} ${resizingPane ? "is-resizing" : ""} ${loading ? "shell-loading" : ""}`}
        style={shellStyle}
      >
        <ArtifactProvider
          ref={artifactProvider}
          sessionId={selected?.id}
          sessionPath={selected?.path}
          disabled={Boolean(
            state.workspaceDraft ||
              state.sessionSwitching ||
              subagentVisible ||
              providerSettingsVisible,
          )}
          onOpen={() => {
            setArtifactPanelOpen(true);
            setSubagentTarget(null);
            setWorkbarOpen(false);
            setInspection(null);
          }}
          onClose={() => {
            setArtifactPanelOpen(false);
          }}
        >
          <SessionSidebar
            sessionViewVisible={
              !centerCollapsed &&
              !providerSettingsVisible &&
              !state.sessionSwitching &&
              !state.workspaceDraft
            }
            connected={state.connection === "connected"}
            snapshot={state.snapshot}
            selectedPath={state.workspaceDraft ? null : state.selectedPath}
            selectedWorkspace={state.selectedWorkspace}
            collapsed={state.collapsed}
            query={state.query}
            searchOpen={state.searchOpen}
            mobileOpen={mobileSidebarOpen}
            settingsDisabled={Boolean(
              state.sessionSwitching ||
                state.modelSelectionPending ||
                !state.snapshot,
            )}
            returnFocusRef={sidebarTrigger}
            onOpenSettings={() => void openProviderSettings("general")}
            actions={actions}
          />
          {state.sidebarCollapsed && (
            <button
              className="sidebar-expand"
              type="button"
              aria-label={t("expandSidebar")}
              title={t("expandSidebar")}
              onClick={() => actions.toggleSidebar(false)}
            >
              <PanelLeftOpen />
            </button>
          )}
          <main
            inert={mobileSidebarOpen}
            className={`conversation-shell ${selected ? "has-view" : ""} ${landing && (!selected || view === "chat") ? "landing" : ""}`}
          >
            <header className="task-header">
              <button
                className="task-header-menu"
                ref={sidebarTrigger}
                type="button"
                aria-label={t("openSidebar")}
                aria-controls="session-sidebar"
                aria-expanded={mobileSidebarOpen}
                onClick={() => actions.toggleSidebar(true)}
              >
                <Menu />
              </button>
              <div className="task-identity">
                {workspacePath && (
                  <span className="task-workspace" title={workspacePath}>
                    {workspace?.name || workspaceName(workspacePath)}
                    <span className="sr-only"> {workspacePath}</span>
                  </span>
                )}
                <h1 title={taskTitle}>{taskTitle}</h1>
              </div>
              <SessionUsageBar
                key={
                  selected
                    ? `usage:${selected.id}:${selected.path}`
                    : "usage:no-session"
                }
                usage={
                  selected && !state.sessionSwitching
                    ? state.snapshot?.usage
                    : undefined
                }
                workspace={
                  workspace?.name || (selected && workspaceName(selected.cwd))
                }
                sessionId={selected?.id}
              />
              {selected && !state.sessionSwitching && (
                <SessionOverview
                  key={`overview:${selected.id}:${selected.path}`}
                  sessionId={selected.id}
                  workspace={workspace?.name || workspaceName(selected.cwd)}
                  agents={overviewAgents}
                  omitted={liveSubagents?.omitted ?? 0}
                  review={gitReview.result}
                  reviewLoading={gitReview.loading}
                  reviewError={gitReview.error}
                  sessionPath={selected.path}
                  revision={selected.history?.leafEntryId ?? undefined}
                  onAddSources={
                    controlled
                      ? () =>
                          setAddSourcesRequest((previous) => ({
                            sessionId: selected.id,
                            path: selected.path,
                            revision: (previous?.revision ?? 0) + 1,
                          }))
                      : undefined
                  }
                  onSubagents={() => inspectSubagent()}
                  onReview={() => openWorkbar("review")}
                />
              )}
              <button
                type="button"
                className="task-tools-trigger"
                aria-label={t("openTools")}
                title={t("openTools")}
                disabled={!selected || state.sessionSwitching}
                onClick={(event) => {
                  if (artifactPanelOpen)
                    artifactProvider.current?.close({ restoreFocus: false });
                  workbarReturnFocus.current = event.currentTarget;
                  if (workbarBound && !workbarVisible) setWorkbarOpen(true);
                  else openWorkbar("launcher");
                }}
              >
                <PanelRight aria-hidden="true" />
              </button>
              <span className={`connection-state ${state.connection}`}>
                {t(state.connection)}
              </span>
            </header>
            {selected && !state.sessionSwitching && (
              <div className="conversation-view-row">
                <fieldset
                  className="conversation-view-switch"
                  aria-label={t("conversationView")}
                >
                  <button
                    type="button"
                    aria-pressed={view === "chat"}
                    onClick={() => setView("chat")}
                  >
                    {t("chatView")}
                  </button>
                  <button
                    type="button"
                    aria-pressed={view === "trajectory"}
                    onClick={() => setView("trajectory")}
                  >
                    {t("trajectory")}
                  </button>
                </fieldset>
              </div>
            )}
            {loading ? (
              <section className="shell-state" role="status" aria-live="polite">
                <OpenPiLogo compact />
                <p>
                  {t(
                    state.connection === "unavailable"
                      ? "unavailable"
                      : "connecting",
                  )}
                </p>
                {state.connection === "unavailable" && (
                  <button
                    type="button"
                    onClick={() =>
                      void actions.refreshSnapshot({ resetCursor: true })
                    }
                  >
                    <RefreshCw aria-hidden="true" /> {t("retryAdmissionCheck")}
                  </button>
                )}
              </section>
            ) : state.sessionSwitching ? (
              <div className="conversation switching" role="status">
                <div className="conversation-running">
                  <span className="conversation-running-dot" />
                  <span>{t("switchingSession")}</span>
                </div>
              </div>
            ) : view === "trajectory" && selected && state.snapshot ? (
              <Trajectory
                key={selected.path}
                snapshot={state.snapshot}
                running={selectedRunning}
              />
            ) : landing ? (
              <section
                className="conversation landing-conversation"
                aria-label="Conversation"
              >
                <div className="landing-welcome">
                  <OpenPiLogo animated />
                  <p className="landing-tagline">{t("landingTagline")}</p>
                </div>
              </section>
            ) : state.snapshot ? (
              <Transcript
                resultExposureEnabled={
                  !centerCollapsed &&
                  !providerSettingsVisible &&
                  !state.sessionSwitching &&
                  !state.workspaceDraft &&
                  view === "chat"
                }
                key={`transcript:${JSON.stringify([selected?.id, selected?.path])}`}
                readingCache={readingCache}
                readingRestorePending={readingRestorePending}
                snapshot={state.snapshot}
                liveMessages={state.liveMessages}
                liveRunning={state.liveRunning}
                livePhase={state.livePhase}
                activityObserved={state.connection === "connected"}
                liveRetry={state.liveRetry}
                thinkingStarts={state.thinkingStarts}
                thinkingDurations={state.thinkingDurations}
                scrollToBottom={state.scrollToBottom}
                onResend={resend}
                onEdit={actions.editMessage}
                onRegenerate={actions.regenerateMessage}
                onOpenOriginal={actions.navigateToMessage}
                onFork={actions.forkMessage}
                forkPending={state.sessionForkPending}
                forkAvailable={
                  controlled &&
                  !selectedRunning &&
                  state.snapshot.runtime.status === "idle" &&
                  !state.promptAdmissionPending &&
                  !state.promptAdmissionRecovery &&
                  !state.activeTurn &&
                  !state.modelSelectionPending &&
                  !state.sessionSwitching &&
                  !selected?.path.startsWith("current:") &&
                  !(
                    selectedExecution?.pendingFollowUps ||
                    selectedExecution?.pendingSteering ||
                    selectedExecution?.compaction?.state === "running"
                  )
                }
                onInspectSubagent={inspectSubagent}
                onReviewTurn={(promptEntryId, filePath) => {
                  openWorkbar("review");
                  workbarReturnFocus.current =
                    document.activeElement instanceof HTMLElement
                      ? document.activeElement
                      : null;
                  setReviewTurn({
                    promptEntryId,
                    filePath,
                    revision: (reviewTurn?.revision ?? 0) + 1,
                  });
                }}
                onHistoryAnchorChange={actions.setHistoryAnchor}
                historyNavigation={
                  state.historyNavigation ??
                  (restoredNavigation?.sessionId === selected?.id &&
                  restoredNavigation?.sessionPath === selected?.path
                    ? restoredNavigation
                    : null)
                }
                onNavigateToMessage={actions.navigateToMessage}
                onRefreshHistory={actions.refreshSnapshot}
                onPromptProjection={actions.rememberPromptProjection}
              />
            ) : null}
            {!providerSettingsVisible &&
              selected &&
              state.snapshot &&
              !state.sessionSwitching &&
              isControlledSession(state.snapshot, selected) && (
                <QuestionPanel
                  key={JSON.stringify([selected.id, selected.path])}
                  sessionId={selected.id}
                  sessionPath={selected.path}
                  workingCache={questionWorkingCache}
                  revision={state.snapshot.cursor}
                  connected={state.connection === "connected"}
                />
              )}
            {state.snapshot && (
              <div className="workbar-chat-context" hidden={!workbarVisible}>
                <span className="workbar-chat-title" title={taskTitle}>
                  {taskTitle}
                </span>
                <span className="workbar-chat-status" role="status">
                  {t(selectedRunning ? "turnState_running" : state.connection)}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    closeWorkbar();
                    requestAnimationFrame(() =>
                      document
                        .querySelector<HTMLTextAreaElement>(
                          ".composer textarea",
                        )
                        ?.focus({ preventScroll: true }),
                    );
                  }}
                >
                  {t("workbarContinueInChat")}
                </button>
              </div>
            )}
            {state.snapshot && (
              <Composer
                addSourcesRequest={addSourcesRequest}
                planSelectionPending={state.planSelectionPending}
                workspaceDraft={state.workspaceDraft}
                draftModel={state.draftModel}
                createdSession={state.createdSession}
                modelSelectionPending={state.modelSelectionPending}
                modelSearch={state.modelSearch}
                thinkingPendingLevel={state.thinkingPendingLevel}
                onInspect={inspect}
                onOpenProviders={() => void openProviderSettings("credentials")}
                onCommandAction={(action) => {
                  const current = webStore.getState();
                  if (
                    current.sessionSwitching ||
                    current.workspaceDraft ||
                    !selected ||
                    current.snapshot?.selectedSession?.path !== selected.path ||
                    current.snapshot.selectedSession.id !== selected.id
                  )
                    return false;
                  if (
                    action === "terminal" ||
                    action === "review" ||
                    action === "side-conversation"
                  )
                    openWorkbar(action);
                  else if (action === "subagents") inspectSubagent();
                  else inspect();
                  return true;
                }}
                onInspectSubagent={inspectSubagent}
                activeTurn={state.activeTurn}
                turnCancellationPending={state.turnCancellationPending}
                turnTerminalStatus={state.turnTerminalStatus}
                pendingFollowUpsReceipt={state.pendingFollowUpsReceipt}
                pendingSteeringReceipt={state.pendingSteeringReceipt}
                commandDiscovery={state.commandDiscovery}
                snapshot={state.snapshot}
                selectedPath={state.selectedPath}
                selectedWorkspace={selected?.cwd ?? state.selectedWorkspace}
                sessionSwitching={state.sessionSwitching}
                promptAdmissionPending={state.promptAdmissionPending}
                promptAdmissionRecovery={state.promptAdmissionRecovery}
                promptAdmissionResolution={state.promptAdmissionResolution}
                restoredPromptDraft={state.restoredPromptDraft}
                liveRunning={state.liveRunning}
                landing={landing}
                actions={actions}
              />
            )}
            {state.notice && (
              <div
                className={
                  typeof state.notice === "string"
                    ? "notice"
                    : "notice notice-success"
                }
                role={typeof state.notice === "string" ? "alert" : "status"}
              >
                <span>
                  {typeof state.notice === "string"
                    ? state.notice
                    : state.notice.message}
                </span>
                <button
                  type="button"
                  aria-label={t("close")}
                  onClick={actions.clearNotice}
                >
                  <X />
                </button>
              </div>
            )}
          </main>
          {inspectionVisible && (
            <InspectionPanel
              key={`${inspection.sessionId}:${inspection.sessionPath}:${inspection.terminalId ?? "status"}`}
              target={inspection}
              onClose={closeInspection}
              onOpenProviders={() => void openProviderSettings("credentials")}
            />
          )}
          {subagentVisible && (
            <SubagentPanel
              key={`${subagentTarget.sessionId}:${subagentTarget.navigation}`}
              sessionId={subagentTarget.sessionId}
              initialId={subagentTarget.id}
              activity={
                isControlledSession(state.snapshot, {
                  id: subagentTarget.sessionId,
                  path: subagentTarget.sessionPath,
                })
                  ? state.snapshot?.runtime.capabilities.subagents
                  : undefined
              }
              records={savedSubagents}
              liveAvailable={isControlledSession(state.snapshot, {
                id: subagentTarget.sessionId,
                path: subagentTarget.sessionPath,
              })}
              onClose={() => setSubagentTarget(null)}
            />
          )}
          {workbarVisible && selected && workbarTarget && (
            <WorkbarPanel
              key={`${selected.id}:${selected.path}`}
              visible={workbarVisible}
              requestedTool={workbarTarget.tool}
              requestRevision={workbarTarget.requestRevision}
              sessionId={selected.id}
              sessionPath={selected.path}
              onBrowserReady={browserReady}
              canControl={
                !state.sessionSwitching &&
                isControlledSession(state.snapshot, selected)
              }
              onActivateSession={() =>
                void actions.selectSession(selected.path)
              }
              cwd={selected.cwd}
              snapshot={state.snapshot ?? undefined}
              capabilities={
                isControlledSession(state.snapshot, selected)
                  ? (state.snapshot?.runtime.capabilities ?? {})
                  : {}
              }
              readingState={workbarTarget.reading}
              onActiveToolChange={setWorkbarActiveTool}
              review={gitReview}
              reviewTurn={reviewTurn ?? undefined}
              onWorkspaceReview={() => setReviewTurn(null)}
              onReferenceLine={(feedback) => {
                const current = webStore.getState();
                const session = current.snapshot?.selectedSession;
                if (
                  current.workspaceDraft ||
                  current.sessionSwitching ||
                  current.selectedPath !== selected.path ||
                  session?.id !== selected.id ||
                  session.path !== selected.path ||
                  !isControlledSession(current.snapshot, session)
                )
                  return;
                setView("chat");
                setAddSourcesRequest((previous) => ({
                  sessionId: selected.id,
                  path: selected.path,
                  revision: (previous?.revision ?? 0) + 1,
                  feedback,
                }));
              }}
              conversationCollapsed={centerCollapsed}
              onRestoreConversation={() => setCenterCollapsed(false)}
              onExpandReview={() => setCenterCollapsed(true)}
              onClose={closeWorkbar}
            />
          )}
          <section
            aria-label={t("resizePanes")}
            style={{ display: "contents" }}
          >
            {!state.sidebarCollapsed &&
              !narrow &&
              (!auxiliaryVisible || viewportWidth > AUXILIARY_BREAKPOINT) && (
                <PaneResizeHandle
                  side="left"
                  value={sidebarWidth}
                  min={SIDEBAR_MIN_WIDTH}
                  max={sidebarMax}
                  defaultValue={SIDEBAR_DEFAULT_WIDTH}
                  collapseThreshold={SIDEBAR_COLLAPSE_THRESHOLD}
                  onCollapse={() => actions.toggleSidebar(false)}
                  onChange={(sidebar) => resizePane("sidebar", sidebar)}
                  onDraggingChange={setResizingPane}
                />
              )}
            {auxiliaryVisible &&
              !centerCollapsed &&
              viewportWidth > AUXILIARY_BREAKPOINT && (
                <PaneResizeHandle
                  side="right"
                  value={auxiliaryWidth}
                  min={AUXILIARY_MIN_WIDTH}
                  max={auxiliaryMax}
                  defaultValue={AUXILIARY_DEFAULT_WIDTH}
                  collapseThreshold={AUXILIARY_COLLAPSE_THRESHOLD}
                  onCollapse={closeAuxiliaryPanel}
                  onExpandPastMax={
                    workbarVisible ? () => setCenterCollapsed(true) : undefined
                  }
                  onChange={(auxiliary) => resizePane("auxiliary", auxiliary)}
                  onDraggingChange={setResizingPane}
                />
              )}
          </section>
          <button
            className="sidebar-scrim"
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            aria-label={t("close")}
            onClick={actions.closeMobileSidebar}
          />
        </ArtifactProvider>
      </div>
      {providerSettingsVisible && (
        <ProviderSettingsPage
          key={`${providerSettings.sessionId}:${providerSettings.sessionPath}`}
          sessionId={providerSettings.sessionId}
          cwd={providerSettings.cwd}
          entry={providerSettings.entry}
          models={state.snapshot?.models ?? []}
          currentModel={currentModel}
          thinkingLevel={
            state.thinkingPendingLevel ??
            state.snapshot?.thinking?.level ??
            t("unknownState")
          }
          theme={state.snapshot?.preferences.theme ?? "system"}
          plan={state.snapshot?.runtime.plan}
          planSelectionPending={state.planSelectionPending}
          onExitPlan={() => actions.selectPlanMode(false)}
          setupOutcome={state.snapshot?.runtime.setup}
          capabilities={state.snapshot?.runtime.capabilities}
          setupBusy={
            state.liveRunning ||
            state.promptAdmissionPending ||
            Boolean(state.activeTurn) ||
            state.modelSelectionPending ||
            state.thinkingPendingLevel !== null ||
            state.sessionSwitching
          }
          setupBlockedReason={
            state.promptAdmissionRecovery
              ? t("setupResolveAdmission")
              : undefined
          }
          modelSelectionPending={state.modelSelectionPending}
          sessionPath={providerSettings.sessionPath}
          onSelectModel={(value) => actions.selectModel(value)}
          onConfigureOpenPi={configureOpenPiFromSettings}
          interaction={
            state.snapshot &&
            !state.sessionSwitching &&
            providerSettings.sessionId === state.snapshot.currentSessionId ? (
              <div className="settings-interaction">
                <QuestionPanel
                  key={JSON.stringify([
                    providerSettings.sessionId,
                    providerSettings.sessionPath,
                  ])}
                  sessionId={providerSettings.sessionId}
                  sessionPath={providerSettings.sessionPath}
                  workingCache={questionWorkingCache}
                  revision={state.snapshot.cursor}
                  connected={state.connection === "connected"}
                />
                {(state.activeTurn || state.liveRunning) && (
                  <button
                    type="button"
                    disabled={state.turnCancellationPending}
                    onClick={() => void actions.cancelActiveTurn()}
                  >
                    {t("stopTurn")}
                  </button>
                )}
              </div>
            ) : undefined
          }
          onPreferencesChanged={() => actions.refreshSnapshot()}
          onOpenRuntimeStatus={openRuntimeStatusFromSettings}
          onClose={closeProviderSettings}
        />
      )}
    </>
  );
}
