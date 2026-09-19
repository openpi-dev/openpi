import { Check, CircleStop, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { formatElapsedMs } from "../../lib/format.ts";
import { recordedSubagents } from "../subagents/recorded-subagents.ts";

type Status = "running" | "done" | "error" | "interrupted" | "warn" | "unknown";

function canonicalStatus(value: string, outcome?: string): Status {
  if (outcome === "interrupted") return "interrupted";
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
  statusLabel,
  onClick,
}: {
  kind: string;
  label: string;
  status: Status;
  statusLabel?: string;
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
      <span className="activity-chip-text">{label}</span>
      {statusLabel && <span className="sr-only"> · {statusLabel}</span>}
    </Tag>
  );
}

export function ActivityBar({
  snapshot,
  onInspectTerminal,
  onInspectSubagent,
}: {
  snapshot: WebSnapshot | null;
  onInspectTerminal?: (id: string) => void;
  onInspectSubagent?: (id?: string) => void;
}) {
  const { t } = useTranslation();
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
  const subagentCount = new Set([
    ...(capabilities?.subagents?.items ?? []).map((item) => item.id),
    ...saved.map((item) => item.id),
  ]).size;
  const activeSubagentCount = (capabilities?.subagents?.items ?? []).filter(
    (item) => item.status === "running",
  ).length;
  const running = [
    ...(capabilities?.subagents?.items ?? []),
    ...(capabilities?.workflows?.items ?? []),
    ...(capabilities?.["background-terminals"]?.items ?? []),
  ].some((item) => item.status === "running");
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
    statusLabel?: string;
    onClick?: () => void;
  }> = [];
  for (const workflow of capabilities?.workflows?.items ?? []) {
    const settled = workflow.agents.total - workflow.agents.running;
    const progress = workflow.agents.total
      ? ` · ${settled}/${workflow.agents.total} agents`
      : "";
    const phase =
      workflow.status === "running" && workflow.currentPhase
        ? ` · ${workflow.currentPhase}`
        : "";
    const elapsed = formatElapsedMs(workflow.startedAt, workflow.finishedAt);
    chips.push({
      key: `workflow-${workflow.runId}`,
      kind: "workflow",
      label: `${workflow.name || workflow.runId}${phase}${progress}${elapsed ? ` · ${elapsed}` : ""}`,
      status: canonicalStatus(workflow.status),
    });
  }
  for (const subagent of capabilities?.subagents?.items ?? []) {
    const elapsed = formatElapsedMs(subagent.createdAt, subagent.settledAt);
    chips.push({
      key: `subagent-${subagent.id}`,
      kind: "subagent",
      label: `${subagent.title || subagent.id}${elapsed ? ` · ${elapsed}` : ""}`,
      status: canonicalStatus(subagent.status, subagent.outcome),
      statusLabel: t(
        subagent.outcome === "interrupted"
          ? "subagentState_interrupted"
          : `subagentState_${subagent.status}`,
      ),
      onClick: onInspectSubagent
        ? () => onInspectSubagent(subagent.id)
        : undefined,
    });
  }
  for (const terminal of capabilities?.["background-terminals"]?.items ?? []) {
    const elapsed = formatElapsedMs(terminal.createdAt, terminal.settledAt);
    chips.push({
      key: `terminal-${terminal.id}`,
      onClick: onInspectTerminal
        ? () => onInspectTerminal(terminal.id)
        : undefined,
      kind: "terminal",
      label: `${terminal.title || terminal.id}${elapsed ? ` · ${elapsed}` : ""}`,
      status: canonicalStatus(terminal.status),
    });
  }
  chips.sort(
    (left, right) =>
      Number(right.status === "running") - Number(left.status === "running"),
  );
  const visible = chips.slice(0, 5);
  const omitted =
    chips.length -
    visible.length +
    (capabilities?.subagents?.omitted ?? 0) +
    (capabilities?.workflows?.omitted ?? 0) +
    (capabilities?.["background-terminals"]?.omitted ?? 0);
  if (!visible.length && !omitted && !(onInspectSubagent && subagentCount))
    return null;
  return (
    <div className="activity-bar" role="status" aria-label="Runtime activity">
      {onInspectSubagent && subagentCount > 0 && (
        <button
          className="activity-chip subagent-list-trigger"
          type="button"
          onClick={() => onInspectSubagent()}
        >
          {t("subagentList", {
            count: subagentCount,
            running: activeSubagentCount,
          })}
        </button>
      )}
      {visible.map(({ key, ...chip }) => (
        <Chip key={key} {...chip} />
      ))}
      {omitted > 0 && <span className="activity-chip more">+{omitted}</span>}
    </div>
  );
}
