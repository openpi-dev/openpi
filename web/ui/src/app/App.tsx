import { Menu, PanelLeftOpen, X } from "lucide-react";
import { Dialog } from "@astryxdesign/core/Dialog";
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
import { Trajectory } from "../features/trajectory/Trajectory.tsx";
import { Transcript } from "../features/transcript/Transcript.tsx";
import { webStore } from "../store/web-store.ts";
import { WebClient } from "../protocol/client.ts";
import type { WebCleanupConfirmationRequest } from "../../../runtime/confirmation.ts";

export function App() {
  const state = useStore(webStore);
  const { t } = useTranslation();
  const { actions } = state;
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
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
  const [confirmation, setConfirmation] =
    useState<WebCleanupConfirmationRequest | null>(null);
  const [answering, setAnswering] = useState(false);
  const [confirmationNotice, setConfirmationNotice] = useState<string | null>(
    null,
  );
  const [confirmationClient] = useState(() => new WebClient());
  const activeTurn = state.activeTurn;
  const confirmationWorkspace = state.snapshot?.selectedSession?.cwd;
  // A payload-free confirmation event refreshes the snapshot before this private read.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the snapshot revision intentionally triggers the authenticated read.
  useEffect(() => {
    if (
      !activeTurn ||
      state.connection !== "connected" ||
      state.sessionSwitching
    ) {
      setConfirmation(null);
      return;
    }
    let cancelled = false;
    void confirmationClient
      .pendingConfirmations()
      .then(({ pending }) => {
        if (cancelled) return;
        setConfirmation(
          pending.find(
            (item) =>
              item.sessionId === activeTurn.sessionId &&
              item.commandId === activeTurn.commandId &&
              item.epoch === activeTurn.epoch &&
              item.workspace === confirmationWorkspace &&
              item.expiresAt > Date.now(),
          ) ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setConfirmation(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    confirmationClient,
    activeTurn?.sessionId,
    activeTurn?.commandId,
    activeTurn?.epoch,
    confirmationWorkspace,
    state.snapshot?.cursor,
    state.connection,
    state.sessionSwitching,
  ]);

  const answerConfirmation = async (approved: boolean) => {
    if (!confirmation || answering) return;
    setAnswering(true);
    try {
      const receipt = await confirmationClient.answerConfirmation(
        confirmation,
        approved,
      );
      setConfirmationNotice(
        receipt.state === "approved"
          ? t("confirmationApproved")
          : t("confirmationDenied"),
      );
    } catch {
      setConfirmationNotice(t("confirmationStale"));
    } finally {
      setConfirmation(null);
      setAnswering(false);
    }
  };
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
        className={`conversation-shell ${selected ? "has-view" : ""} ${landing && (state.workspaceDraft || view === "chat") ? "landing" : ""}`}
      >
        <h1 className="sr-only">OpenPI</h1>
        <header className="mobile-header">
          <button
            ref={sidebarTrigger}
            type="button"
            aria-label={t("openSidebar")}
            aria-controls="session-sidebar"
            aria-expanded={mobileSidebarOpen}
            onClick={() => actions.toggleSidebar(true)}
          >
            <Menu />
          </button>
          <span className={`connection-state ${state.connection}`}>
            {t(state.connection)}
          </span>
        </header>
        {selected && (
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
        )}
        {state.sessionSwitching ? (
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
          />
        ) : null}
        <Composer
          workspaceDraft={state.workspaceDraft}
          draftModel={state.draftModel}
          modelSelectionPending={state.modelSelectionPending}
          modelSearch={state.modelSearch}
          thinkingPendingLevel={state.thinkingPendingLevel}
          onInspect={inspect}
          activeTurn={state.activeTurn}
          turnCancellationPending={state.turnCancellationPending}
          turnTerminalStatus={state.turnTerminalStatus}
          pendingFollowUpsReceipt={state.pendingFollowUpsReceipt}
          commandDiscovery={state.commandDiscovery}
          snapshot={state.snapshot}
          selectedPath={state.selectedPath}
          selectedWorkspace={state.selectedWorkspace}
          sessionSwitching={state.sessionSwitching}
          promptAdmissionPending={state.promptAdmissionPending}
          promptAdmissionRecovery={state.promptAdmissionRecovery}
          promptAdmissionResolution={state.promptAdmissionResolution}
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
      <Dialog
        isOpen={Boolean(confirmation)}
        onOpenChange={(open: boolean) => {
          if (!open) void answerConfirmation(false);
        }}
        purpose="form"
        width={480}
        aria-label={t("confirmationTitle")}
      >
        <div className="openpi-dialog cleanup-confirmation">
          <strong>{t("confirmationTitle")}</strong>
          <p>{t("confirmationDescription")}</p>
          <ul>
            {confirmation?.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button
              type="button"
              disabled={answering}
              onClick={() => void answerConfirmation(false)}
            >
              {t("deny")}
            </button>
            <button
              type="button"
              className="danger"
              disabled={answering}
              onClick={() => void answerConfirmation(true)}
            >
              {t("approveDeletion")}
            </button>
          </div>
        </div>
      </Dialog>
      {confirmationNotice && (
        <div className="notice" role="status">
          <span>{confirmationNotice}</span>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setConfirmationNotice(null)}
          >
            <X />
          </button>
        </div>
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
