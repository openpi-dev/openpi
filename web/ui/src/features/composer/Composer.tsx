import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Brain,
  Check,
  ChevronRight,
  Command,
  FileText,
  Folder,
  KeyRound,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import {
  type FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import {
  compactSummary,
  sessionTitle,
  workspaceName,
} from "../../lib/format.ts";
import type { WebStoreActions, WebStoreState } from "../../store/web-store.ts";
import { ActivityBar } from "../activity/ActivityBar.tsx";
import { FileReferenceDialog } from "./FileReferenceDialog.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import {
  filterWebCommands,
  SlashCommandMenu,
  slashCommandListId,
  slashCommandOptionId,
} from "./SlashCommandMenu.tsx";

interface ComposerProps {
  workspaceDraft?: boolean;
  draftModel?: WebStoreState["draftModel"];
  modelSelectionPending?: boolean;
  modelSearch?: WebStoreState["modelSearch"];
  thinkingPendingLevel: WebStoreState["thinkingPendingLevel"];
  onInspect?: (terminalId?: string) => void;
  onOpenProviders?: () => void;
  onInspectSubagent?: (id?: string) => void;
  snapshot: WebSnapshot | null;
  selectedPath?: string | null;
  selectedWorkspace: string | null;
  sessionSwitching: boolean;
  promptAdmissionPending: boolean;
  promptAdmissionRecovery?: WebStoreState["promptAdmissionRecovery"];
  promptAdmissionResolution?: WebStoreState["promptAdmissionResolution"];
  liveRunning: boolean;
  landing: boolean;
  actions: WebStoreActions;
  activeTurn: WebStoreState["activeTurn"];
  turnCancellationPending: boolean;
  turnTerminalStatus: string | null;
  pendingFollowUpsReceipt: number | null;
  commandDiscovery?: WebStoreState["commandDiscovery"];
}

export function Composer(props: ComposerProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const modelSearch =
    props.modelSearch ??
    ({
      query: "",
      status: "idle",
      models: [],
      totalMatches: 0,
      matchesOmitted: 0,
      error: null,
    } satisfies WebStoreState["modelSearch"]);
  const [cursor, setCursor] = useState(0);
  const [composerFocused, setComposerFocused] = useState(false);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const [activeCommand, setActiveCommand] = useState(0);
  const [fileReferenceOpen, setFileReferenceOpen] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const restoreFileReferenceFocus = useRef(false);
  useLayoutEffect(() => {
    // Programmatic clears and recovered drafts need the same sizing as typing.
    void prompt;
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
    element.style.overflowY = element.scrollHeight > 220 ? "auto" : "hidden";
  }, [prompt]);
  useEffect(() => {
    if (fileReferenceOpen || !restoreFileReferenceFocus.current) return;
    restoreFileReferenceFocus.current = false;
    const timer = window.setTimeout(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cursor, fileReferenceOpen]);
  const restoredRecoveryCommandId = useRef<string | null>(null);
  const commandMenuWasOpen = useRef(false);
  const selected = props.snapshot?.selectedSession;
  const selectedPath =
    props.selectedPath === undefined
      ? (selected?.path ?? null)
      : props.selectedPath;
  const sessionPath =
    selected?.cwd === props.selectedWorkspace ? selectedPath : null;
  const draftScope =
    (props.workspaceDraft ? null : sessionPath) ??
    (props.selectedWorkspace ? `new:${props.selectedWorkspace}` : "none");
  const draftScopeRef = useRef(draftScope);
  const draftRevision = useRef(0);
  const transferDraftToCreatedSession = useRef(false);
  const pendingSubmission = useRef<{
    revision: number;
    scope: string;
    canTransferToCreatedSession: boolean;
  } | null>(null);
  const active = Boolean(
    !props.workspaceDraft &&
      selected?.id &&
      selected.id === props.snapshot?.currentSessionId,
  );
  const draftSession = Boolean(
    props.selectedWorkspace &&
      (props.workspaceDraft ||
        (!selected && !props.snapshot?.currentSessionId)),
  );
  const canCompose = active || draftSession;
  const running =
    !props.workspaceDraft &&
    (props.snapshot?.runtime.status === "running" || props.liveRunning);
  const canStop =
    active &&
    running &&
    Boolean(props.activeTurn ?? props.snapshot?.runtime.activeTurn);
  const disabled =
    props.sessionSwitching || (!canCompose && Boolean(props.selectedWorkspace));
  const commandDiscovery = props.commandDiscovery ?? {
    sessionId: null,
    status: "idle" as const,
    commands: [],
    totalAvailable: 0,
    commandsOmitted: 0,
    error: null,
  };
  const slashStage = /^\/[^\s/]*$/u.test(prompt) && cursor > 0;
  const commandMenuOpen =
    composerFocused &&
    slashStage &&
    !menuDismissed &&
    canCompose &&
    !props.sessionSwitching;
  const commandSessionId = active ? selected?.id : null;
  const commandQuery = slashStage ? prompt.slice(1) : "";
  const filteredCommands = useMemo(
    () => filterWebCommands(commandDiscovery.commands, commandQuery),
    [commandQuery, commandDiscovery.commands],
  );
  const commandListVisible =
    commandMenuOpen &&
    !props.workspaceDraft &&
    commandDiscovery.status === "ready" &&
    filteredCommands.length > 0;
  const commandEntryAvailable =
    active && !prompt.trim() && !props.sessionSwitching;
  const contextEntryAvailable =
    canCompose && Boolean(props.selectedWorkspace) && !props.sessionSwitching;

  useEffect(() => {
    const opened = commandMenuOpen && !commandMenuWasOpen.current;
    commandMenuWasOpen.current = commandMenuOpen;
    if (
      !commandMenuOpen ||
      props.workspaceDraft ||
      !commandSessionId ||
      (commandDiscovery.status !== "idle" &&
        !(opened && commandDiscovery.status === "error"))
    ) {
      return;
    }
    void props.actions.discoverCommands();
  }, [
    commandDiscovery.status,
    commandMenuOpen,
    props.actions,
    props.workspaceDraft,
    commandSessionId,
  ]);

  useEffect(() => {
    const firstAvailable = filteredCommands.findIndex(
      (command) => command.availability === "available",
    );
    setActiveCommand(firstAvailable >= 0 ? firstAvailable : 0);
  }, [filteredCommands]);

  useEffect(() => {
    const recovery = props.promptAdmissionRecovery;
    const commandId = recovery?.commandId ?? null;
    if (restoredRecoveryCommandId.current === commandId) return;
    restoredRecoveryCommandId.current = commandId;
    if (!recovery) return;
    setPrompt((current) => current || recovery.content);
  }, [props.promptAdmissionRecovery]);

  useEffect(() => {
    const resolution = props.promptAdmissionResolution;
    if (!resolution) return;
    if (prompt.trim() === resolution.content) {
      setPrompt("");
    }
    props.actions.acknowledgePromptAdmissionResolution(resolution.commandId);
  }, [prompt, props.actions, props.promptAdmissionResolution]);

  useEffect(() => {
    const previousScope = draftScopeRef.current;
    if (previousScope === draftScope) return;
    draftScopeRef.current = draftScope;

    const submission = pendingSubmission.current;
    const createdSession =
      !props.workspaceDraft &&
      (transferDraftToCreatedSession.current ||
        (submission?.canTransferToCreatedSession &&
          submission.scope === previousScope)) &&
      Boolean(sessionPath) &&
      props.snapshot?.selectedSession?.path === sessionPath &&
      props.snapshot?.selectedSession?.cwd === props.selectedWorkspace;
    if (createdSession) {
      if (submission?.canTransferToCreatedSession)
        submission.scope = draftScope;
      transferDraftToCreatedSession.current = false;
      return;
    }

    const startingNewSession =
      props.workspaceDraft &&
      props.selectedWorkspace &&
      draftScope === `new:${props.selectedWorkspace}` &&
      props.snapshot?.selectedSession?.cwd === props.selectedWorkspace;
    if (startingNewSession) {
      transferDraftToCreatedSession.current = true;
      return;
    }

    draftRevision.current += 1;
    setPrompt("");
    setFileReferenceOpen(false);
    if (submission?.scope === previousScope) {
      submission.canTransferToCreatedSession = false;
    }
  }, [
    draftScope,
    props.snapshot?.selectedSession?.path,
    props.snapshot?.selectedSession?.cwd,
    props.selectedWorkspace,
    props.workspaceDraft,
    sessionPath,
  ]);

  const sendDraft = async (
    sendPrompt: (content: string) => Promise<boolean>,
  ) => {
    if (pendingSubmission.current) return;
    if (!props.selectedWorkspace) {
      await props.actions.chooseWorkspace();
      return;
    }
    const submission = {
      revision: draftRevision.current,
      scope: draftScopeRef.current,
      canTransferToCreatedSession: draftSession,
    };
    pendingSubmission.current = submission;
    try {
      if (await sendPrompt(prompt)) {
        if (
          pendingSubmission.current === submission &&
          draftScopeRef.current === submission.scope &&
          draftRevision.current === submission.revision
        ) {
          draftRevision.current += 1;
          setPrompt("");
        }
      }
    } finally {
      if (pendingSubmission.current === submission) {
        pendingSubmission.current = null;
      }
    }
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (
      !canCompose ||
      props.sessionSwitching ||
      props.modelSelectionPending ||
      props.thinkingPendingLevel !== null ||
      props.promptAdmissionPending ||
      props.promptAdmissionRecovery ||
      props.promptAdmissionResolution ||
      !prompt.trim()
    )
      return;
    await sendDraft(props.actions.sendPrompt);
  };

  const sendAsNew = () => sendDraft(props.actions.sendPromptAsNew);

  const completeCommand = (command: (typeof filteredCommands)[number]) => {
    if (command.availability !== "available") return;
    const value = `/${command.name} `;
    draftRevision.current += 1;
    setPrompt(value);
    setCursor(value.length);
    setMenuDismissed(true);
    queueMicrotask(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(value.length, value.length);
    });
  };

  const moveCommand = (offset: number) => {
    if (!filteredCommands.length) return;
    let next = activeCommand;
    for (let index = 0; index < filteredCommands.length; index++) {
      next =
        (next + offset + filteredCommands.length) % filteredCommands.length;
      if (filteredCommands[next]?.availability === "available") {
        setActiveCommand(next);
        return;
      }
    }
  };

  const insertFileReference = (reference: string) => {
    const position = Math.min(cursor, prompt.length);
    const before = prompt.slice(0, position);
    const after = prompt.slice(position);
    const formatted = `\`${reference.replaceAll("`", "\\`")}\``;
    const leading = before && !/\s$/u.test(before) ? " " : "";
    const trailing = after && !/^\s/u.test(after) ? " " : "";
    const value = `${before}${leading}${formatted}${trailing}${after}`;
    const nextCursor = before.length + leading.length + formatted.length;
    draftRevision.current += 1;
    setPrompt(value);
    setCursor(nextCursor);
    restoreFileReferenceFocus.current = true;
  };

  const workspaceItems = [
    ...(props.snapshot?.workspaces ?? []).map((workspace) => ({
      id: workspace.path,
      label: workspace.name,
      icon: <Folder />,
      endContent:
        workspace.path === props.selectedWorkspace ? <Check /> : undefined,
      onClick: () => props.actions.setWorkspace(workspace.path),
    })),
    { type: "divider" as const },
    {
      id: "add",
      label: t("addWorkspaceMenu"),
      icon: <Plus />,
      onClick: () => void props.actions.chooseWorkspace(),
    },
  ];
  const currentModel =
    props.draftModel ??
    props.snapshot?.models.find((model) => model.current) ??
    props.snapshot?.models[0];
  const workspaceLabel =
    props.snapshot?.workspaces.find(
      (workspace) => workspace.path === props.selectedWorkspace,
    )?.name ??
    (props.selectedWorkspace
      ? workspaceName(props.selectedWorkspace)
      : t("selectWorkspace"));
  const sessionSummary = props.snapshot?.sessions.find(
    (session) => session.path === sessionPath,
  );
  const targetLabel = active
    ? sessionTitle(sessionSummary ?? {}, selected?.id ?? t("untitledSession"))
    : draftSession
      ? t("newSession")
      : selected
        ? sessionTitle(sessionSummary ?? {}, selected.id)
        : t("newSession");
  const targetSummary = compactSummary(targetLabel, 48);
  const placeholder = !props.selectedWorkspace
    ? t("promptStart")
    : props.landing
      ? t("promptTask")
      : active
        ? t("promptMessage")
        : t("promptReadonly");
  const thinking = props.snapshot?.thinking;
  const confirmed = thinking?.level ?? null;
  const pending = props.thinkingPendingLevel ?? null;
  const shown = pending ?? confirmed;
  const supported = thinking?.supported ?? false;
  const weak = thinking ? !thinking.available.includes(confirmed ?? "") : false;
  const thinkingItems = (thinking?.available ?? []).map((lvl) => ({
    id: lvl,
    label: lvl,
    endContent: lvl === shown ? <Check /> : undefined,
    onClick: () => void props.actions.selectThinking(lvl),
  }));
  const thinkingDisabledReason = !thinking
    ? null
    : !supported
      ? "thinkingUnsupportedHint"
      : props.workspaceDraft
        ? "thinkingDraftHint"
        : !active
          ? "thinkingInactiveHint"
          : running
            ? "thinkingLockedRunning"
            : props.modelSelectionPending
              ? "thinkingModelPendingHint"
              : null;
  const thinkingAria = !supported
    ? t("thinkingUnsupported")
    : `${t("thinkingLevel")}: ${shown ?? t("unknownState")}${pending !== null ? `. ${t("thinkingPendingHint")}` : ""}`;
  const thinkingMenuItems = thinking
    ? [
        ...(weak
          ? [
              {
                id: "thinking-level-mismatch",
                label: t("thinkingLevelMismatch"),
                isDisabled: true,
              },
              { type: "divider" as const },
            ]
          : []),
        {
          type: "section" as const,
          id: "thinking-level",
          title: t("thinkingLevel"),
          items: thinkingItems,
        },
      ]
    : [];
  const hint = props.modelSelectionPending
    ? t("thinkingModelPendingHint")
    : props.thinkingPendingLevel !== null
      ? t("thinkingPendingHint")
      : props.workspaceDraft
        ? t("enterHint")
        : props.turnCancellationPending
          ? t("stoppingTurn")
          : props.turnTerminalStatus === "cancelled"
            ? t("stoppedTurn")
            : props.pendingFollowUpsReceipt !== null
              ? props.pendingFollowUpsReceipt > 0
                ? t("pendingFollowUpsHint", {
                    count: props.pendingFollowUpsReceipt,
                  })
                : t("acceptedHint")
              : canCompose
                ? running
                  ? t("queuedHint")
                  : t("enterHint")
                : t("activeOnlyHint");
  const showHint =
    props.modelSelectionPending ||
    props.thinkingPendingLevel !== null ||
    props.turnCancellationPending ||
    props.turnTerminalStatus === "cancelled" ||
    props.pendingFollowUpsReceipt !== null ||
    (canCompose && running && Boolean(prompt.trim()));

  return (
    <div className="composer-dock">
      {active && (
        <ActivityBar
          snapshot={props.snapshot}
          onInspectTerminal={props.onInspect}
          onInspectSubagent={props.onInspectSubagent}
        />
      )}
      {props.landing && (
        <div className="workspace-picker-row">
          <DropdownMenu
            className="workspace-picker-menu"
            button={{
              label: props.selectedWorkspace
                ? workspaceName(props.selectedWorkspace)
                : t("selectWorkspace"),
              icon: <Folder />,
              size: "md",
              variant: "ghost",
              className: "workspace-picker",
            }}
            items={workspaceItems}
            menuWidth={240}
            placement="above"
            alignment="start"
            hasChevron
          />
        </div>
      )}
      {props.promptAdmissionRecovery && (
        <section className="prompt-recovery" role="alert">
          <div>
            <strong>{t("promptAdmissionUnknown")}</strong>
            <span>
              {props.promptAdmissionRecovery.phase === "checking"
                ? t("promptAdmissionCheckingDetail")
                : props.promptAdmissionRecovery.phase === "verification-failed"
                  ? t("promptAdmissionVerificationFailedDetail")
                  : t("promptAdmissionUnknownDetail")}
            </span>
          </div>
          <div className="prompt-recovery-actions">
            <button
              type="button"
              disabled={props.promptAdmissionRecovery.phase === "submitting"}
              onClick={props.actions.abandonPromptAdmission}
            >
              {t("abandonAdmission")}
            </button>
            {props.promptAdmissionRecovery.phase === "verification-failed" && (
              <button
                type="button"
                onClick={() =>
                  void props.actions.checkPromptAdmissionRecovery()
                }
              >
                {t("retryAdmissionCheck")}
              </button>
            )}
            <button
              type="button"
              className="primary"
              disabled={
                props.promptAdmissionRecovery.phase !== "ready" ||
                !prompt.trim()
              }
              onClick={() => void sendAsNew()}
            >
              {props.promptAdmissionRecovery.phase === "submitting"
                ? t("sendingAsNew")
                : t("sendAsNew")}
            </button>
          </div>
        </section>
      )}
      <form
        className={`composer composer-m02 ${props.selectedWorkspace ? "" : "dormant"}`}
        onSubmit={(event) => void send(event)}
      >
        {!props.selectedWorkspace && (
          <button
            className="dormant-overlay"
            type="button"
            aria-label={t("selectWorkspace")}
            onClick={() => void props.actions.chooseWorkspace()}
          />
        )}
        {props.selectedWorkspace && (
          <div
            className="composer-target"
            title={`${workspaceLabel} / ${targetLabel}`}
          >
            <Folder aria-hidden="true" />
            <span>{workspaceLabel}</span>
            <ChevronRight aria-hidden="true" />
            <strong>{targetSummary}</strong>
          </div>
        )}
        <textarea
          ref={textarea}
          value={prompt}
          rows={1}
          disabled={disabled}
          readOnly={!props.selectedWorkspace}
          aria-label={t("describeTask")}
          aria-autocomplete="list"
          aria-controls={commandListVisible ? slashCommandListId : undefined}
          aria-activedescendant={
            commandListVisible && filteredCommands[activeCommand]
              ? slashCommandOptionId(activeCommand)
              : undefined
          }
          placeholder={placeholder}
          onChange={(event) => {
            draftRevision.current += 1;
            setPrompt(event.target.value);
            setCursor(event.target.selectionStart);
            setMenuDismissed(false);
          }}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onFocus={() => {
            setComposerFocused(true);
            setMenuDismissed(false);
          }}
          onBlur={() => setComposerFocused(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (commandMenuOpen) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveCommand(event.key === "ArrowDown" ? 1 : -1);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMenuDismissed(true);
                return;
              }
              if (
                event.key === "Tab" ||
                (event.key === "Enter" && !event.shiftKey)
              ) {
                const command = filteredCommands[activeCommand];
                if (command) {
                  event.preventDefault();
                  completeCommand(command);
                  return;
                }
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
        />
        {commandMenuOpen && (
          <SlashCommandMenu
            activeIndex={activeCommand}
            commandDiscovery={commandDiscovery}
            commands={filteredCommands}
            draft={Boolean(props.workspaceDraft)}
            preferBelow={props.landing}
            showUnavailableSummary={!commandQuery}
            onComplete={completeCommand}
            onSelect={setActiveCommand}
          />
        )}
        <div className="composer-toolbar">
          <div className="composer-toolbar-context">
            {contextEntryAvailable ? (
              <DropdownMenu
                className="composer-context-menu"
                button={{
                  label: t("addContext"),
                  icon: <Plus />,
                  isIconOnly: true,
                  size: "sm",
                  variant: "ghost",
                  className: "composer-context-trigger",
                }}
                items={[
                  {
                    id: "file-reference",
                    label: t("fileReference"),
                    icon: <FileText />,
                    onClick: () => setFileReferenceOpen(true),
                  },
                  {
                    id: "slash-commands",
                    label: t("commands"),
                    description: !active
                      ? t("commandsSessionRequired")
                      : prompt.trim()
                        ? t("commandsEmptyDraftOnly")
                        : undefined,
                    icon: <Command />,
                    isDisabled: !commandEntryAvailable,
                    onClick: () => {
                      draftRevision.current += 1;
                      setPrompt("/");
                      setCursor(1);
                      setMenuDismissed(false);
                      requestAnimationFrame(() => {
                        textarea.current?.focus();
                        textarea.current?.setSelectionRange(1, 1);
                      });
                    },
                  },
                ]}
                menuWidth={200}
                placement="above"
                alignment="start"
                hasChevron={false}
              />
            ) : (
              <span className="composer-context-placeholder" />
            )}
          </div>
          <div className="composer-toolbar-controls">
            {props.onInspect && (
              <button
                type="button"
                className="icon-button"
                aria-label={t("runtimeStatus")}
                title={t("runtimeStatus")}
                disabled={!active || props.sessionSwitching}
                onClick={() => props.onInspect?.()}
              >
                <SlidersHorizontal />
              </button>
            )}
            {props.onOpenProviders && (
              <Tooltip content={t("providerAvailability")} placement="above">
                <button
                  type="button"
                  className="icon-button"
                  data-provider-settings-trigger
                  aria-label={t("providerAvailability")}
                  onClick={props.onOpenProviders}
                >
                  <KeyRound />
                </button>
              </Tooltip>
            )}
            <div className="model-picker-wrap">
              <ModelPicker
                snapshot={props.snapshot}
                currentModel={currentModel}
                draftModel={props.draftModel}
                modelSearch={modelSearch}
                modelSelectionPending={Boolean(props.modelSelectionPending)}
                promptAdmissionPending={props.promptAdmissionPending}
                sessionSwitching={props.sessionSwitching}
                liveRunning={running}
                workspaceDraft={Boolean(props.workspaceDraft)}
                actions={props.actions}
              />
            </div>
            {thinking && (
              <div
                className="thinking-picker-wrap"
                data-level={confirmed ?? "none"}
                data-pending={pending !== null}
                data-warning={weak}
                title={
                  thinkingDisabledReason ? t(thinkingDisabledReason) : undefined
                }
              >
                <DropdownMenu
                  className="thinking-menu"
                  button={{
                    label: thinkingAria,
                    icon: <Brain />,
                    isIconOnly: true,
                    size: "sm",
                    variant: "ghost",
                    className: "thinking-picker",
                    isDisabled:
                      thinkingDisabledReason !== null ||
                      thinkingItems.length === 0,
                  }}
                  items={thinkingMenuItems}
                  menuWidth={220}
                  placement="above"
                  alignment="end"
                  hasChevron={false}
                />
              </div>
            )}
            {canStop ? (
              <Tooltip content={t("stopTurn")} placement="above">
                <button
                  className="send-button"
                  type="button"
                  aria-label={t("stopTurn")}
                  disabled={
                    props.turnCancellationPending || props.sessionSwitching
                  }
                  onClick={() => void props.actions.cancelActiveTurn()}
                >
                  <Square />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content={t("send")} placement="above">
                <button
                  className="send-button"
                  type="submit"
                  aria-label={t("send")}
                  disabled={
                    props.sessionSwitching ||
                    props.modelSelectionPending ||
                    props.thinkingPendingLevel !== null ||
                    !canCompose ||
                    !props.selectedWorkspace ||
                    props.promptAdmissionPending ||
                    Boolean(props.promptAdmissionRecovery) ||
                    Boolean(props.promptAdmissionResolution) ||
                    !prompt.trim()
                  }
                >
                  <Send />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <div
          className="composer-hint"
          data-visible={showHint}
          aria-live="polite"
        >
          {hint}
        </div>
      </form>
      <FileReferenceDialog
        open={fileReferenceOpen}
        sessionId={active ? selected?.id : undefined}
        onClose={() => setFileReferenceOpen(false)}
        onInsert={insertFileReference}
      />
    </div>
  );
}
