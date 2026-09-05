import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Check, ChevronDown, Folder, Plus, Send } from "lucide-react";
import { type FormEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { workspaceName } from "../../lib/format.ts";
import type { WebStoreActions } from "../../store/web-store.ts";
import { ActivityBar } from "../activity/ActivityBar.tsx";

interface ComposerProps {
  snapshot: WebSnapshot | null;
  selectedWorkspace: string | null;
  sessionSwitching: boolean;
  promptAdmissionPending: boolean;
  liveRunning: boolean;
  landing: boolean;
  actions: WebStoreActions;
}

export function Composer(props: ComposerProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const selected = props.snapshot?.selectedSession;
  const active = Boolean(
    selected?.id && selected.id === props.snapshot?.currentSessionId,
  );
  const draftSession = Boolean(
    props.selectedWorkspace && !selected && !props.snapshot?.currentSessionId,
  );
  const canCompose = active || draftSession;
  const running =
    props.snapshot?.runtime.status === "running" || props.liveRunning;
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
    if (await props.actions.sendPrompt(prompt)) setPrompt("");
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
    props.snapshot?.models.find((model) => model.current) ??
    props.snapshot?.models[0];
  const modelItems = (props.snapshot?.models ?? []).map((model) => ({
    id: `${model.provider}/${model.id}`,
    label: model.label,
    endContent: model.current ? <Check /> : undefined,
    onClick: () =>
      void props.actions.selectModel(`${model.provider}/${model.id}`),
  }));
  const placeholder = !props.selectedWorkspace
    ? t("promptStart")
    : props.landing
      ? t("promptTask")
      : active
        ? t("promptMessage")
        : t("promptReadonly");
  const hint = canCompose
    ? running
      ? t("queuedHint")
      : t("enterHint")
    : t("activeOnlyHint");

  return (
    <div className="composer-dock">
      <ActivityBar snapshot={props.snapshot} />
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
          <div className="model-picker-wrap">
            <DropdownMenu
              className="model-menu"
              button={{
                label: currentModel?.label || t("noModels"),
                endContent: <ChevronDown />,
                size: "sm",
                variant: "ghost",
                className: "model-picker",
                isDisabled:
                  props.sessionSwitching ||
                  !active ||
                  !props.selectedWorkspace ||
                  props.liveRunning ||
                  !modelItems.length,
              }}
              items={modelItems}
              menuWidth={260}
              placement="above"
              alignment="end"
              hasChevron={false}
            />
          </div>
          <Tooltip content={t("send")} placement="above">
            <button
              className="send-button"
              type="submit"
              aria-label={t("send")}
              disabled={
                props.sessionSwitching ||
                !canCompose ||
                !props.selectedWorkspace ||
                props.promptAdmissionPending ||
                !prompt.trim()
              }
            >
              <Send />
            </button>
          </Tooltip>
        </div>
        <div className="composer-hint" aria-live="polite">
          {hint}
        </div>
      </form>
    </div>
  );
}
