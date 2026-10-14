import { useId } from "react";
import { useTranslation } from "react-i18next";
import { SubagentAvatar } from "./SubagentAvatar.tsx";

/** A child activity has no disclosure or actions of its own; its owner supplies exact facts. */
export function SubagentTaskRow({
  identity,
  title,
  label,
  state = "unknown",
  onInspect,
}: {
  identity: string;
  title: string;
  label: string;
  state?: "running" | "done" | "error" | "interrupted" | "unknown";
  onInspect?: () => void;
}) {
  const { t } = useTranslation();
  const statusId = useId();
  const Tag = onInspect ? "button" : "div";
  return (
    <Tag
      className="subagent-card-open"
      type={onInspect ? "button" : undefined}
      aria-label={onInspect ? t("inspectSubagent", { name: title }) : undefined}
      aria-describedby={onInspect ? statusId : undefined}
      onClick={onInspect}
    >
      <SubagentAvatar identity={identity} />
      <span className="subagent-activity-title" title={title}>
        {title}
      </span>
      <span id={statusId} className={`subagent-state ${state}`}>
        {label}
      </span>
    </Tag>
  );
}
