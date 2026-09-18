import { FileDiff, Menu, PanelLeftOpen, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { OpenPiLogo } from "../components/OpenPiLogo.tsx";
import { Composer } from "../features/composer/Composer.tsx";
import {
  InspectionPanel,
  type InspectionTarget,
} from "../features/inspection/InspectionPanel.tsx";
import { SessionSidebar } from "../features/sessions/SessionSidebar.tsx";
import { changeCalls, ReviewPanel } from "../features/review/ReviewPanel.tsx";
import { Trajectory } from "../features/trajectory/Trajectory.tsx";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { SubagentPanel } from "../features/subagents/SubagentPanel.tsx";
import { recordedSubagents } from "../features/subagents/recorded-subagents.ts";
import { sessionTitle, workspaceName } from "../lib/format.ts";
import { webStore } from "../store/web-store.ts";

export function App() {
  const state = useStore(webStore);
  const { t } = useTranslation();
  const { actions } = state;
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const auxiliaryTrigger = useRef<HTMLElement | null>(null);
  const auxiliaryOpen = useRef(false);
  const reviewTrigger = useRef<HTMLElement | null>(null);
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
  const [view, setView] = useState<"chat" | "trajectory">("chat");
  const [inspection, setInspection] = useState<InspectionTarget | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{
    sessionId: string;
    sessionPath: string;
  } | null>(null);
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
    setReviewTarget(null);
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

  useEffect(() => {
    actions.start();
    return actions.stop;
  }, [actions]);

  const selected = state.workspaceDraft
    ? undefined
    : state.snapshot?.selectedSession;
  const reviewVisible = Boolean(
    reviewTarget &&
      selected &&
      !state.sessionSwitching &&
      reviewTarget.sessionId === selected.id &&
      reviewTarget.sessionPath === selected.path,
  );
  useEffect(() => {
    if (reviewTarget && !reviewVisible) setReviewTarget(null);
  }, [reviewTarget, reviewVisible]);
  const closeReview = useCallback(() => {
    setReviewTarget(null);
    const trigger = reviewTrigger.current;
    reviewTrigger.current = null;
    queueMicrotask(() => {
      if (trigger?.isConnected && trigger.checkVisibility()) trigger.focus();
    });
  }, []);
  const openReview = () => {
    if (!selected || state.sessionSwitching) return;
    reviewTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setSubagentTarget(null);
    setInspection(null);
    setReviewTarget({ sessionId: selected.id, sessionPath: selected.path });
  };
  const changes = selected ? changeCalls(selected).length : 0;
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
    <div
      className={`app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""} ${state.mobileSidebarOpen ? "sidebar-open" : ""} ${subagentVisible ? "with-subagent-panel" : ""} ${reviewVisible ? "with-review-panel" : ""} ${loading ? "shell-loading" : ""}`}
    >
      <SessionSidebar
        snapshot={state.snapshot}
        selectedPath={state.workspaceDraft ? null : state.selectedPath}
        selectedWorkspace={state.selectedWorkspace}
        collapsed={state.collapsed}
        query={state.query}
        searchOpen={state.searchOpen}
        mobileOpen={mobileSidebarOpen}
        returnFocusRef={sidebarTrigger}
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
            {changes > 0 && (
              <button
                className="review-trigger"
                type="button"
                onClick={openReview}
              >
                <FileDiff aria-hidden="true" /> {t("changeEvidence")}{" "}
                <span>{changes}</span>
              </button>
            )}
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
        {state.snapshot && (
          <Composer
            workspaceDraft={state.workspaceDraft}
            draftModel={state.draftModel}
            modelSelectionPending={state.modelSelectionPending}
            modelSearch={state.modelSearch}
            thinkingPendingLevel={state.thinkingPendingLevel}
            onInspect={inspect}
            onInspectSubagent={inspectSubagent}
            activeTurn={state.activeTurn}
            turnCancellationPending={state.turnCancellationPending}
            turnTerminalStatus={state.turnTerminalStatus}
            pendingFollowUpsReceipt={state.pendingFollowUpsReceipt}
            commandDiscovery={state.commandDiscovery}
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
          onClose={() => setInspection(null)}
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
            (state.snapshot?.selectedSession?.entries ?? []).flatMap((entry) =>
              entry.message ? [entry.message] : [],
            ),
          )}
          liveAvailable={
            subagentTarget.sessionId === state.snapshot?.currentSessionId
          }
          onClose={() => setSubagentTarget(null)}
        />
      )}
      {reviewVisible && selected && (
        <ReviewPanel
          key={selected.path}
          session={selected}
          onClose={closeReview}
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
    </div>
  );
}
