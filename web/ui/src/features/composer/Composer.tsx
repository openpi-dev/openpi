import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Brain,
  Check,
  Folder,
  Plus,
  Send,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { workspaceName } from "../../lib/format.ts";
import type { WebStoreActions, WebStoreState } from "../../store/web-store.ts";
import { ActivityBar } from "../activity/ActivityBar.tsx";
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
  snapshot: WebSnapshot | null;
  selectedWorkspace: string | null;
  sessionSwitching: boolean;
  promptAdmissionPending: boolean;
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
  const textarea = useRef<HTMLTextAreaElement>(null);
  const commandMenuWasOpen = useRef(false);
  const selected = props.snapshot?.selectedSession;
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

  const resize = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
    element.style.overflowY = element.scrollHeight > 220 ? "auto" : "hidden";
  };

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!props.selectedWorkspace) {
      await props.actions.chooseWorkspace();
      return;
    }
    if (await props.actions.sendPrompt(prompt)) {
      setPrompt("");
      if (textarea.current) {
        textarea.current.style.height = "auto";
        textarea.current.style.overflowY = "hidden";
      }
    }
  };

  const completeCommand = (command: (typeof filteredCommands)[number]) => {
    if (command.availability !== "available") return;
    const value = `/${command.name} `;
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
    : `${t("thinkingLevel")}: ${shown ?? t("unknownState")}`;
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
  const hint =
    props.thinkingPendingLevel !== null
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

  return (
    <div className="composer-dock">
      {active && (
        <ActivityBar
          snapshot={props.snapshot}
          onInspectTerminal={props.onInspect}
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
      <form
        className={`composer ${props.selectedWorkspace ? "" : "dormant"}`}
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
            setPrompt(event.target.value);
            setCursor(event.target.selectionStart);
            setMenuDismissed(false);
            resize(event.currentTarget);
          }}
          onClick={(event) => setCursor(event.currentTarget.selectionStart)}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onFocus={() => {
            setComposerFocused(true);
            setMenuDismissed(false);
          }}
          onBlur={() => setComposerFocused(false)}
          onKeyDown={(event) => {
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
                (event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey)) &&
                !event.nativeEvent.isComposing
              ) {
                const command = filteredCommands[activeCommand];
                if (command) {
                  event.preventDefault();
                  completeCommand(command);
                  return;
                }
              }
            }
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
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
            onComplete={completeCommand}
            onSelect={setActiveCommand}
          />
        )}
        <div className="composer-toolbar">
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
                  !prompt.trim()
                }
              >
                <Send />
              </button>
            </Tooltip>
          )}
        </div>
        <div className="composer-hint" aria-live="polite">
          {hint}
        </div>
      </form>
    </div>
  );
}
