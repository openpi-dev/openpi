import { useId } from "react";
import { Bot, ChevronRight, LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SubagentAvatar } from "./SubagentAvatar.tsx";

/** A child or operation links to the same transcript; its owner supplies exact facts. */
export function SubagentTaskRow({
  identity,
  title,
  label,
  state = "unknown",
  action,
  onInspect,
}: {
  identity: string;
  title: string;
  label: string;
  state?: "running" | "done" | "error" | "interrupted" | "unknown";
  action?: string;
  onInspect?: () => void;
}) {
  const { t } = useTranslation();
  const statusId = useId();
  const Tag = onInspect ? "button" : "div";
  return (
    <Tag
      className="subagent-card-open"
      data-status={state}
      type={onInspect ? "button" : undefined}
      aria-label={onInspect ? t("inspectSubagent", { name: title }) : undefined}
      aria-describedby={onInspect ? statusId : undefined}
      onClick={onInspect}
    >
      {action ? (
        <Bot className="subagent-operation-icon" aria-hidden="true" />
      ) : (
        <SubagentAvatar identity={identity} />
      )}
      {action && (
        <span className="subagent-operation-label">
          {action}
          {title && " ·"}
        </span>
      )}
      <span className="subagent-activity-title" title={title}>
        {title}
      </span>
      <span
        id={statusId}
        className={`subagent-state ${state}${action || state === "running" || state === "done" ? " subagent-state-hidden" : ""}`}
      >
        {label}
      </span>
      {!action && state === "running" && (
        <LoaderCircle className="subagent-running-icon" aria-hidden="true" />
      )}
      {onInspect && (
        <ChevronRight className="subagent-open-icon" aria-hidden="true" />
      )}
    </Tag>
  );
}
