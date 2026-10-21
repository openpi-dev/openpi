import { Tooltip } from "@astryxdesign/core/Tooltip";
import { Activity, Check, ChevronDown, CircleStop, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { formatElapsedMs } from "../../lib/format.ts";
import { recordedSubagents } from "../subagents/recorded-subagents.ts";
import { subagentOverview } from "../subagents/subagent-overview.ts";

type Status = "running" | "done" | "error" | "interrupted" | "warn" | "unknown";

function canonicalStatus(value: string): Status {
  if (value === "interrupted") return "interrupted";
  if (value === "running") return "running";
  if (value === "done" || value === "completed") return "done";
  if (["error", "failed", "aborted", "killed", "timed_out"].includes(value))
    return "error";
  if (value === "uncertain") return "warn";
  return "unknown";
}

function Chip({
  kind,
  label,
  status,
  elapsed,
  onClick,
}: {
  kind: string;
  label: string;
  status: Status;
  elapsed?: string;
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className={`activity-chip ${kind} ${status}`}
      type={onClick ? "button" : undefined}
      onClick={onClick}
    >
      {status === "running" ? (
        <i className="activity-chip-dot" />
      ) : status === "done" ? (
        <Check />
      ) : status === "error" ? (
        <X />
      ) : status === "interrupted" ? (
        <CircleStop />
      ) : (
        <span className="activity-chip-glyph">?</span>
      )}
      <span
        key={`${status}:${label}`}
        className="activity-chip-text"
        title={label}
      >
        {label}
      </span>
      {elapsed && <span className="activity-chip-elapsed">{elapsed}</span>}
    </Tag>
  );
}

export function ActivityBar({
  snapshot,
  onInspectSubagent,
  observed = true,
  expanded,
  onExpandedChange,
}: {
  snapshot: WebSnapshot | null;
  onInspectSubagent?: (id?: string) => void;
  observed?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const { t } = useTranslation();
  const summary = useRef<HTMLElement>(null);
  const [, tick] = useState(0);
  const capabilities = snapshot?.runtime.capabilities;
  const saved = useMemo(
    () =>
      recordedSubagents(
        (snapshot?.selectedSession?.entries ?? []).flatMap((entry) =>
          entry.message ? [entry.message] : [],
        ),
      ),
    [snapshot?.selectedSession?.entries],
  );
  const liveSubagents = capabilities?.subagents;
  const workflows = capabilities?.workflows?.items ?? [];
  const workflowChildren = workflows.flatMap(
    (item) => item.children?.items ?? [],
  );
  const knownSubagentCount = new Set([
    ...(liveSubagents?.items ?? []).map((item) => `subagents:${item.id}`),
    ...saved.map((item) => `subagents:${item.id}`),
    ...workflowChildren.map((item) => `workflows:${item.id}`),
  ]).size;
  const subagentCount = Math.max(
    knownSubagentCount,
    (liveSubagents?.items.length ?? 0) +
      (liveSubagents?.omitted ?? 0) +
      workflowChildren.length +
      workflows.reduce((sum, item) => sum + (item.children?.omitted ?? 0), 0),
  );
  const subagents = subagentOverview(
    liveSubagents?.items ?? [],
    saved,
    workflows,
    observed,
  );
  const activeSubagentCount = subagents.filter(
    (item) => item.state === "running",
  ).length;
  const completedSubagentCount = subagents.filter(
    (item) => item.state === "done",
  ).length;
  const otherSubagentCount = subagents.filter(
    (item) => item.state === "error" || item.state === "interrupted",
  ).length;
  const unknownSubagentCount = Math.max(
    0,
    subagentCount -
      activeSubagentCount -
      completedSubagentCount -
      otherSubagentCount,
  );
  const subagentLabel = [
    t("subagentProgress", {
      running: activeSubagentCount,
      completed: completedSubagentCount,
    }),
    otherSubagentCount
      ? t("subagentSummaryOther", { count: otherSubagentCount })
      : "",
    unknownSubagentCount
      ? t("subagentSummaryUnknown", { count: unknownSubagentCount })
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const admission = liveSubagents?.childExecutionAdmission;
  const running = (capabilities?.workflows?.items ?? []).some(
    (item) => item.status === "running",
  );
  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(
      () => tick((value) => value + 1),
      1_000,
    );
    return () => window.clearInterval(interval);
  }, [running]);

  const chips: Array<{
    key: string;
    kind: string;
    label: string;
    status: Status;
    elapsed?: string;
    onClick?: () => void;
  }> = [];
  for (const workflow of capabilities?.workflows?.items ?? []) {
    const settled = workflow.agents.done + workflow.agents.error;
    const progress = workflow.agents.total
      ? ` · ${t("activityAgentProgress", { completed: settled, total: workflow.agents.total })}`
      : "";
    const phase =
      workflow.status === "running" && workflow.currentPhase
        ? ` · ${workflow.currentPhase}`
        : "";
    const elapsed = formatElapsedMs(workflow.startedAt, workflow.finishedAt);
    chips.push({
      key: `workflow-${workflow.runId}`,
      kind: "workflow",
      label: `${workflow.name || workflow.runId}${phase}${progress}`,
      elapsed,
      status: canonicalStatus(workflow.status),
    });
  }
  chips.sort(
    (left, right) =>
      Number(right.status === "running") - Number(left.status === "running"),
  );
  const omitted = capabilities?.workflows?.omitted ?? 0;
  if (
    !chips.length &&
    !omitted &&
    !(onInspectSubagent && subagentCount) &&
    !admission?.enabled
  )
    return null;
  const activeCount =
    chips.filter((chip) => chip.status === "running").length +
    activeSubagentCount;
  const failedCount =
    chips.filter((chip) => chip.status === "error").length +
    subagents.filter((item) => item.state === "error").length;
  const statistics = [
    observed && activeCount > 0
      ? t("runtimeActivityRunning", { count: activeCount })
      : t("runtimeActivityCount", {
          count: chips.length + subagentCount + omitted,
        }),
    failedCount > 0 ? t("processFailureCount", { count: failedCount }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <details
        className="activity-summary"
        open={expanded}
        onToggle={(event) => {
          if (event.currentTarget.open !== expanded)
            onExpandedChange?.(event.currentTarget.open);
        }}
      >
        <summary ref={summary}>
          {observed && activeCount > 0 ? (
            <i className="activity-chip-dot" aria-hidden="true" />
          ) : (
            <Activity aria-hidden="true" />
          )}
          <span>{t("runtimeActivities")}</span>
          <ChevronDown
            className="activity-summary-chevron"
            aria-hidden="true"
          />
        </summary>
        <div
          className="activity-bar composer-status-details"
          hidden={expanded === false}
          role="status"
          aria-label={t("runtimeActivities")}
        >
          {onInspectSubagent && subagentCount > 0 && (
            <button
              className="activity-chip subagent-list-trigger"
              type="button"
              onClick={() => onInspectSubagent()}
            >
              {subagentLabel}
            </button>
          )}
          {admission?.enabled && admission.limit !== undefined && (
            <span className="activity-chip subagent-list-trigger">
              {t("activityCapacity", {
                running: admission.held,
                limit: admission.limit,
                queued: admission.queued,
              })}
            </span>
          )}
          {chips.map(({ key, ...chip }) => (
            <Chip key={key} {...chip} />
          ))}
          {omitted > 0 && (
            <span className="activity-chip more">+{omitted}</span>
          )}
        </div>
      </details>
      <Tooltip
        anchorRef={summary}
        focusTrigger="always"
        content={statistics}
        placement="above"
      />
    </>
  );
}
