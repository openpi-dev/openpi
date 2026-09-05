import { Menu, PanelLeftOpen, X } from "lucide-react";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { OpenPiLogo } from "../components/OpenPiLogo.tsx";
import { Composer } from "../features/composer/Composer.tsx";
import { SessionSidebar } from "../features/sessions/SessionSidebar.tsx";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { webStore } from "../store/web-store.ts";

export function App() {
  const state = useStore(webStore);
  const { t } = useTranslation();
  const { actions } = state;

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
              <h1 className="sr-only">OpenPI</h1>
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
      <button
        className="sidebar-scrim"
        type="button"
        aria-label={t("close")}
        onClick={actions.closeMobileSidebar}
      />
    </div>
  );
}
