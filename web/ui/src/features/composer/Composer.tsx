import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import {
  Check,
  Folder,
  Plus,
  Send,
  Square,
  SlidersHorizontal,
} from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { workspaceName } from "../../lib/format.ts";
import type { WebStoreActions, WebStoreState } from "../../store/web-store.ts";
import { ActivityBar } from "../activity/ActivityBar.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

interface ComposerProps {
  workspaceDraft?: boolean;
  draftModel?: WebStoreState["draftModel"];
  modelSelectionPending?: boolean;
  modelSearch?: WebStoreState["modelSearch"];
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
  const textarea = useRef<HTMLTextAreaElement>(null);
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
  const hint = props.workspaceDraft
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
          placeholder={placeholder}
          onChange={(event) => {
            setPrompt(event.target.value);
            resize(event.currentTarget);
          }}
          onKeyDown={(event) => {
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
