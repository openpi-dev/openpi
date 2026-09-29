import { Menu, PanelLeftOpen, PanelRight, RefreshCw, X } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
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
import { SessionChangesPopover } from "../features/review/SessionChangesPopover.tsx";
import { useGitReview } from "../features/review/use-git-review.ts";
import { SessionSidebar } from "../features/sessions/SessionSidebar.tsx";
import { ProviderSettingsPage } from "../features/settings/ProviderSettingsPage.tsx";
import { recordedSubagents } from "../features/subagents/recorded-subagents.ts";
import { SubagentPanel } from "../features/subagents/SubagentPanel.tsx";
import { Trajectory } from "../features/trajectory/Trajectory.tsx";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { SessionUsageBar } from "../features/workbar/SessionUsageBar.tsx";
import type { WorkbarTool } from "../features/workbar/types.ts";
import { WorkbarPanel } from "../features/workbar/WorkbarPanel.tsx";
import { sessionTitle, workspaceName } from "../lib/format.ts";
import { QuestionPanel } from "../features/questions/QuestionPanel.tsx";
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

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function App() {
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
  const artifactOpenFromFiles = useRef(false);
  const artifactReturn = useRef<"files" | null>(null);
  const [artifactPanelOpen, setArtifactPanelOpen] = useState(false);
  const [resizingPane, setResizingPane] = useState(false);
  const [centerCollapsed, setCenterCollapsed] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [paneWidths, setPaneWidths] = useState({
    sidebar: SIDEBAR_DEFAULT_WIDTH,
    auxiliary: AUXILIARY_DEFAULT_WIDTH,
  });
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
  } | null>(null);
  const [workbarTarget, setWorkbarTarget] = useState<{
    sessionId: string;
    sessionPath: string;
    tool: WorkbarTool;
    requestRevision: number;
    reviewFilePath?: string;
  } | null>(null);
  const [workbarOpen, setWorkbarOpen] = useState(false);
  const [subagentTarget, setSubagentTarget] = useState<{
    sessionId: string;
    sessionPath: string;
    id?: string;
    navigation: number;
  } | null>(null);
  const inspectSubagent = useCallback((id?: string) => {
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
  }, []);
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
      session.id !== snapshot.currentSessionId
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
    inspection.sessionId === state.snapshot?.currentSessionId &&
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
    providerSettings.sessionId === state.snapshot?.currentSessionId &&
    providerSettings.sessionPath === state.snapshot?.selectedSession?.path;
  useEffect(() => {
    if (providerSettings && !providerSettingsVisible) setProviderSettings(null);
  }, [providerSettings, providerSettingsVisible]);
  const openProviderSettings = () => {
    const snapshot = state.snapshot;
    const session = snapshot?.selectedSession;
    if (
      state.workspaceDraft ||
      !session ||
      state.sessionSwitching ||
      session.id !== snapshot.currentSessionId
    )
      return;
    providerSettingsTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    actions.closeMobileSidebar();
    setInspection(null);
    setSubagentTarget(null);
    workbarReturnFocus.current = null;
    setWorkbarOpen(false);
    setProviderSettings({
      sessionId: session.id,
      sessionPath: session.path,
      cwd: session.cwd,
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
    return actions.sendPrompt(`/openpi-setup ${request}`);
  };

  useEffect(() => {
    actions.start();
    return actions.stop;
  }, [actions]);

  const selected = state.workspaceDraft
    ? undefined
    : state.snapshot?.selectedSession;
  const gitReview = useGitReview(selected, state.snapshot?.cursor);
  const gitSnapshot = gitReview.result?.ok
    ? gitReview.result.snapshot
    : undefined;
  const openReview = (filePath?: string, returnFocus?: HTMLElement) => {
    if (!selected || state.sessionSwitching) return;
    workbarReturnFocus.current =
      returnFocus ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    setSubagentTarget(null);
    setInspection(null);
    setWorkbarOpen(true);
    setWorkbarTarget((current) => ({
      sessionId: selected.id,
      sessionPath: selected.path,
      tool: "review",
      requestRevision: (current?.requestRevision ?? 0) + 1,
      ...(filePath ? { reviewFilePath: filePath } : {}),
    }));
  };
  const workbarBound = Boolean(
    workbarTarget &&
      selected &&
      !state.sessionSwitching &&
      workbarTarget.sessionId === selected.id &&
      workbarTarget.sessionPath === selected.path,
  );
  const workbarVisible = workbarOpen && workbarBound;
  useEffect(() => {
    if (!workbarTarget || workbarBound) return;
    workbarReturnFocus.current = null;
    setWorkbarTarget(null);
    setWorkbarOpen(false);
  }, [workbarBound, workbarTarget]);
  const openWorkbar = (tool: WorkbarTool = "launcher") => {
    if (!selected || state.sessionSwitching) return;
    if (!workbarVisible)
      workbarReturnFocus.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
    setInspection(null);
    setSubagentTarget(null);
    setWorkbarOpen(true);
    setWorkbarTarget((current) => ({
      sessionId: selected.id,
      sessionPath: selected.path,
      tool,
      requestRevision: (current?.requestRevision ?? 0) + 1,
      ...(tool === "review" && current?.reviewFilePath
        ? { reviewFilePath: current.reviewFilePath }
        : {}),
    }));
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
  const auxiliaryVisible = Boolean(
    subagentVisible || workbarVisible || artifactPanelOpen,
  );
  useEffect(() => {
    if (!auxiliaryVisible || viewportWidth <= AUXILIARY_BREAKPOINT)
      setCenterCollapsed(false);
  }, [auxiliaryVisible, viewportWidth]);
  const sidebarWidth = state.sidebarCollapsed ? 56 : paneWidths.sidebar;
  const auxiliaryMax = Math.max(
    AUXILIARY_MIN_WIDTH,
    Math.min(
      AUXILIARY_MAX_WIDTH,
      viewportWidth - sidebarWidth - CENTER_MIN_WIDTH,
    ),
  );
  const sidebarMax = Math.max(
    SIDEBAR_MIN_WIDTH,
    Math.min(
      SIDEBAR_MAX_WIDTH,
      viewportWidth -
        CENTER_MIN_WIDTH -
        (auxiliaryVisible ? paneWidths.auxiliary : 0),
    ),
  );
  useEffect(() => {
    if (viewportWidth <= AUXILIARY_BREAKPOINT) return;
    setPaneWidths((current) => {
      const sidebar = clamp(current.sidebar, SIDEBAR_MIN_WIDTH, sidebarMax);
      const auxiliary = clamp(
        current.auxiliary,
        AUXILIARY_MIN_WIDTH,
        auxiliaryMax,
      );
      return sidebar === current.sidebar && auxiliary === current.auxiliary
        ? current
        : { sidebar, auxiliary };
    });
  }, [auxiliaryMax, sidebarMax, viewportWidth]);
  const shellStyle = {
    "--sidebar-width": `${paneWidths.sidebar}px`,
    "--auxiliary-width": `${paneWidths.auxiliary}px`,
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
    selected?.entries.some(
      (entry) => entry.type === "message" && entry.message,
    ) || state.liveMessages.length > 0;
  const landing =
    !loading && !state.sessionSwitching && (!selected || !hasMessages);
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
          disabled={Boolean(subagentVisible || providerSettingsVisible)}
          onOpen={() => {
            setArtifactPanelOpen(true);
            artifactReturn.current = artifactOpenFromFiles.current
              ? "files"
              : null;
            artifactOpenFromFiles.current = false;
            setSubagentTarget(null);
            setWorkbarOpen(false);
            setInspection(null);
          }}
          onClose={() => {
            setArtifactPanelOpen(false);
            const target = artifactReturn.current;
            artifactReturn.current = null;
            if (target) openWorkbar(target);
          }}
        >
          <SessionSidebar
            snapshot={state.snapshot}
            selectedPath={state.workspaceDraft ? null : state.selectedPath}
            selectedWorkspace={state.selectedWorkspace}
            collapsed={state.collapsed}
            query={state.query}
            searchOpen={state.searchOpen}
            mobileOpen={mobileSidebarOpen}
            settingsDisabled={Boolean(
              state.workspaceDraft || state.sessionSwitching || !selected,
            )}
            returnFocusRef={sidebarTrigger}
            onOpenSettings={openProviderSettings}
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
              <SessionUsageBar usage={state.snapshot?.usage} />
              <button
                type="button"
                className="task-tools-trigger"
                aria-label={t("openTools")}
                title={t("openTools")}
                disabled={!selected || state.sessionSwitching}
                onClick={(event) => {
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
                running={state.liveRunning}
              />
            ) : landing ? (
              <section
                className="conversation landing-conversation"
                aria-label="Conversation"
              >
                <div className="landing-welcome">
                  <OpenPiLogo animated />
                </div>
              </section>
            ) : state.snapshot ? (
              <Transcript
                snapshot={state.snapshot}
                liveMessages={state.liveMessages}
                liveRunning={state.liveRunning}
                livePhase={state.livePhase}
                liveRetry={state.liveRetry}
                thinkingStarts={state.thinkingStarts}
                thinkingDurations={state.thinkingDurations}
                scrollToBottom={state.scrollToBottom}
                onResend={resend}
                onInspectSubagent={inspectSubagent}
              />
            ) : null}
            {!providerSettingsVisible &&
              selected &&
              state.snapshot &&
              !state.sessionSwitching &&
              selected.id === state.snapshot.currentSessionId && (
                <QuestionPanel
                  key={selected.id}
                  sessionId={selected.id}
                  revision={state.snapshot.cursor}
                  connected={state.connection === "connected"}
                />
              )}
            {state.snapshot && (
              <Composer
                planSelectionPending={state.planSelectionPending}
                workspaceDraft={state.workspaceDraft}
                draftModel={state.draftModel}
                modelSelectionPending={state.modelSelectionPending}
                modelSearch={state.modelSearch}
                thinkingPendingLevel={state.thinkingPendingLevel}
                onInspect={inspect}
                onOpenProviders={openProviderSettings}
                onInspectSubagent={inspectSubagent}
                activeTurn={state.activeTurn}
                turnCancellationPending={state.turnCancellationPending}
                turnTerminalStatus={state.turnTerminalStatus}
                pendingFollowUpsReceipt={state.pendingFollowUpsReceipt}
                commandDiscovery={state.commandDiscovery}
                accessory={
                  gitSnapshot && gitSnapshot.files.length > 0 ? (
                    <SessionChangesPopover
                      key={gitSnapshot.repositoryRoot}
                      snapshot={gitSnapshot}
                      onOpenReview={openReview}
                    />
                  ) : undefined
                }
                snapshot={state.snapshot}
                selectedPath={state.selectedPath}
                selectedWorkspace={selected?.cwd ?? state.selectedWorkspace}
                sessionSwitching={state.sessionSwitching}
                promptAdmissionPending={state.promptAdmissionPending}
                promptAdmissionRecovery={state.promptAdmissionRecovery}
                promptAdmissionResolution={state.promptAdmissionResolution}
                liveRunning={state.liveRunning}
                landing={landing}
                actions={actions}
              />
            )}
            {state.notice && (
              <div className="notice" role="alert">
                <span>{state.notice}</span>
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
              onOpenProviders={openProviderSettings}
            />
          )}
          {subagentVisible && (
            <SubagentPanel
              key={`${subagentTarget.sessionId}:${subagentTarget.navigation}`}
              sessionId={subagentTarget.sessionId}
              initialId={subagentTarget.id}
              activity={
                subagentTarget.sessionId === state.snapshot?.currentSessionId
                  ? state.snapshot?.runtime.capabilities.subagents
                  : undefined
              }
              records={recordedSubagents(
                (state.snapshot?.selectedSession?.entries ?? []).flatMap(
                  (entry) => (entry.message ? [entry.message] : []),
                ),
              )}
              liveAvailable={
                subagentTarget.sessionId === state.snapshot?.currentSessionId
              }
              onClose={() => setSubagentTarget(null)}
            />
          )}
          {workbarBound && selected && workbarTarget && (
            <WorkbarPanel
              key={selected.id}
              visible={workbarVisible}
              requestedTool={workbarTarget.tool}
              requestRevision={workbarTarget.requestRevision}
              sessionId={selected.id}
              cwd={selected.cwd}
              capabilities={state.snapshot?.runtime.capabilities ?? {}}
              messages={[
                ...selected.entries.flatMap((entry) =>
                  entry.message ? [entry.message] : [],
                ),
                ...state.liveMessages.map((entry) => entry.message),
              ]}
              review={gitReview}
              reviewInitialFilePath={workbarTarget.reviewFilePath}
              onBeforeArtifactOpen={() => {
                artifactOpenFromFiles.current = true;
              }}
              conversationCollapsed={centerCollapsed}
              onRestoreConversation={() => setCenterCollapsed(false)}
              onClose={closeWorkbar}
            />
          )}
          {!state.sidebarCollapsed && viewportWidth > AUXILIARY_BREAKPOINT && (
            <PaneResizeHandle
              side="left"
              value={paneWidths.sidebar}
              min={SIDEBAR_MIN_WIDTH}
              max={sidebarMax}
              defaultValue={SIDEBAR_DEFAULT_WIDTH}
              collapseThreshold={SIDEBAR_COLLAPSE_THRESHOLD}
              onCollapse={() => actions.toggleSidebar(false)}
              onChange={(sidebar) =>
                setPaneWidths((current) => ({ ...current, sidebar }))
              }
              onDraggingChange={setResizingPane}
            />
          )}
          {auxiliaryVisible &&
            !centerCollapsed &&
            viewportWidth > AUXILIARY_BREAKPOINT && (
              <PaneResizeHandle
                side="right"
                value={paneWidths.auxiliary}
                min={AUXILIARY_MIN_WIDTH}
                max={auxiliaryMax}
                defaultValue={AUXILIARY_DEFAULT_WIDTH}
                collapseThreshold={AUXILIARY_COLLAPSE_THRESHOLD}
                onCollapse={closeAuxiliaryPanel}
                onExpandPastMax={
                  workbarVisible ? () => setCenterCollapsed(true) : undefined
                }
                onChange={(auxiliary) =>
                  setPaneWidths((current) => ({ ...current, auxiliary }))
                }
                onDraggingChange={setResizingPane}
              />
            )}
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
            Boolean(state.activeTurn)
          }
          modelSelectionPending={state.modelSelectionPending}
          onSelectModel={(value) => void actions.selectModel(value)}
          onConfigureOpenPi={configureOpenPiFromSettings}
          interaction={
            state.snapshot &&
            !state.sessionSwitching &&
            providerSettings.sessionId === state.snapshot.currentSessionId ? (
              <div className="settings-interaction">
                <QuestionPanel
                  key={providerSettings.sessionId}
                  sessionId={providerSettings.sessionId}
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
