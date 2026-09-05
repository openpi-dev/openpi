import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { WebSnapshot } from "../../../../protocol/types.ts";
import { formatElapsedMs } from "../../lib/format.ts";

type Status = "running" | "done" | "error" | "warn" | "unknown";

function canonicalStatus(value: string): Status {
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
}: {
  kind: string;
  label: string;
  status: Status;
}) {
  return (
    <span className={`activity-chip ${kind} ${status}`}>
      {status === "running" ? (
        <i className="activity-chip-dot" />
      ) : status === "done" ? (
        <Check />
      ) : status === "error" ? (
        <X />
      ) : (
        <span className="activity-chip-glyph">?</span>
      )}
      <span className="activity-chip-text">{label}</span>
    </span>
  );
}

export function ActivityBar({ snapshot }: { snapshot: WebSnapshot | null }) {
  const [, tick] = useState(0);
  const capabilities = snapshot?.runtime.capabilities;
  const running = [
    ...(capabilities?.subagents?.items ?? []),
    ...(capabilities?.workflows?.items ?? []),
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
      status: canonicalStatus(subagent.status),
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
    (capabilities?.workflows?.omitted ?? 0);
  if (!visible.length && !omitted) return null;
  return (
    <div className="activity-bar" role="status" aria-label="Runtime activity">
      {visible.map(({ key, ...chip }) => (
        <Chip key={key} {...chip} />
      ))}
      {omitted > 0 && <span className="activity-chip more">+{omitted}</span>}
    </div>
  );
}
