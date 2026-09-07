import { Menu, PanelLeftOpen, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { OpenPiLogo } from "../components/OpenPiLogo.tsx";
import {
  InspectionPanel,
  type InspectionTarget,
} from "../features/inspection/InspectionPanel.tsx";
import { Composer } from "../features/composer/Composer.tsx";
import { SessionSidebar } from "../features/sessions/SessionSidebar.tsx";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { webStore } from "../store/web-store.ts";

export function App() {
  const state = useStore(webStore);
  const { t } = useTranslation();
  const { actions } = state;
  const [inspection, setInspection] = useState<InspectionTarget | null>(null);
  const currentModel = state.snapshot?.models.find((model) => model.current);
  const modelKey = JSON.stringify([currentModel?.provider, currentModel?.id]);
  const inspect = (terminalId?: string) => {
    const snapshot = state.snapshot;
    const session = snapshot?.selectedSession;
    if (
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

  const selected = state.snapshot?.selectedSession;
  const hasMessages =
    selected?.entries.some(
      (entry) => entry.type === "message" && entry.message,
    ) || state.liveMessages.length > 0;
  const landing = !selected || !hasMessages;
  const resend = useCallback(
    (content: string) => actions.sendPrompt(content),
    [actions],
  );

  return (
    <div
      className={`app-shell ${state.sidebarCollapsed ? "sidebar-collapsed" : ""} ${state.mobileSidebarOpen ? "sidebar-open" : ""}`}
    >
      <SessionSidebar
        snapshot={state.snapshot}
        selectedPath={state.selectedPath}
        selectedWorkspace={state.selectedWorkspace}
        collapsed={state.collapsed}
        query={state.query}
        searchOpen={state.searchOpen}
        mobileOpen={state.mobileSidebarOpen}
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
      <main className={`conversation-shell ${landing ? "landing" : ""}`}>
        <h1 className="sr-only">OpenPI</h1>
        <header className="mobile-header">
          <button
            type="button"
            aria-label={t("openSidebar")}
            onClick={() => actions.toggleSidebar(true)}
          >
            <Menu />
          </button>
          <span className={`connection-state ${state.connection}`}>
            {t(state.connection)}
          </span>
        </header>
        {state.sessionSwitching ? (
          <div className="conversation switching" role="status">
            <div className="conversation-running">
              <span className="conversation-running-dot" />
              <span>{t("switchingSession")}</span>
            </div>
          </div>
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
          />
        ) : null}
        <Composer
          onInspect={inspect}
          activeTurn={state.activeTurn}
          turnCancellationPending={state.turnCancellationPending}
          turnTerminalStatus={state.turnTerminalStatus}
          pendingFollowUpsReceipt={state.pendingFollowUpsReceipt}
          snapshot={state.snapshot}
          selectedWorkspace={state.selectedWorkspace}
          sessionSwitching={state.sessionSwitching}
          promptAdmissionPending={state.promptAdmissionPending}
          liveRunning={state.liveRunning}
          landing={landing}
          actions={actions}
        />
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
      <button
        className="sidebar-scrim"
        type="button"
        aria-label={t("close")}
        onClick={actions.closeMobileSidebar}
      />
    </div>
  );
}
