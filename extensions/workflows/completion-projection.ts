import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  sanitizeWorkflowDisplayLine,
  shortenHome,
  statusWord,
  type WorkflowDetails,
} from "./model.ts";
import { buildWorkflowResultMessage } from "./prompt.ts";
import { safeStringify } from "./serialization.ts";

export interface WorkflowCompletionDisplayEntry {
  deliveryId: string;
  details: WorkflowDetails;
  runDir: string;
}

export interface WorkflowCompletionDisplay {
  version: 1;
  /** Backward-compatible single-run identity for delivery observers. */
  runId?: string;
  entries: WorkflowCompletionDisplayEntry[];
}

function compactDetails(details: WorkflowDetails): WorkflowDetails {
  return {
    ...details,
    ...(details.result !== undefined
      ? {
          result: JSON.parse(
            safeStringify(details.result, { maxBytes: 64 * 1024 }),
          ),
        }
      : {}),
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
}

/** Structured user-facing projection; the message content remains model-facing. */
export function buildWorkflowCompletionDisplay(
  entries: readonly WorkflowCompletionDisplayEntry[],
): WorkflowCompletionDisplay {
  return {
    version: 1,
    ...(entries.length === 1 ? { runId: entries[0]!.details.runId } : {}),
    entries: entries.map((entry) => ({
      ...entry,
      details: compactDetails(entry.details),
    })),
  };
}

export function isWorkflowCompletionDisplay(
  value: unknown,
): value is WorkflowCompletionDisplay {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkflowCompletionDisplay>;
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.deliveryId === "string" &&
        typeof entry.runDir === "string" &&
        entry.details &&
        typeof entry.details === "object" &&
        typeof entry.details.runId === "string" &&
        Array.isArray(entry.details.agents),
    )
  );
}

export function workflowCompletionSummary(details: WorkflowDetails) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  return sanitizeWorkflowDisplayLine(
    `workflow ${details.name ?? details.runId} · ${done + failed}/${details.agents.length} agents · ${elapsed} · ${statusWord(details.status)}`,
  );
}

function labels(details: WorkflowDetails, state: "error" | "uncertain") {
  return details.agents
    .filter((agent) => agent.state === state)
    .map((agent) => sanitizeWorkflowDisplayLine(agent.label));
}

/** Exceptional evidence that must remain visible while the report is collapsed. */
export function workflowCompletionAlerts(details: WorkflowDetails) {
  const alerts: string[] = [];
  if (details.error) {
    alerts.push(`Error: ${sanitizeWorkflowDisplayLine(details.error)}`);
  }

  const failed = labels(details, "error");
  if (failed.length > 0) alerts.push(`Failed agents: ${failed.join(", ")}`);
  const uncertain = labels(details, "uncertain");
  if (uncertain.length > 0) {
    alerts.push(`Uncertain agents: ${uncertain.join(", ")}`);
  }
  if (details.logsDropped) {
    alerts.push(`${details.logsDropped} earlier log line(s) dropped`);
  }

  for (const entry of details.logs ?? []) {
    if (!/\bdropped\b/i.test(entry.text)) continue;
    alerts.push(`Dropped work: ${sanitizeWorkflowDisplayLine(entry.text)}`);
  }

  for (const agent of details.agents) {
    if (!agent.worktreePath) continue;
    const reason = agent.worktreeCleanup?.reason ?? "cleanup was unsafe";
    alerts.push(
      `Retained worktree [${sanitizeWorkflowDisplayLine(agent.label)}]: ${shortenHome(agent.worktreePath)} (${sanitizeWorkflowDisplayLine(reason)})${
        agent.worktreeHandoffArtifact
          ? `; handoff ${sanitizeWorkflowDisplayLine(agent.worktreeHandoffArtifact)}`
          : ""
      }`,
    );
  }
  return [...new Set(alerts)].map((alert) => sanitizeTerminalText(alert));
}

/** Short return-value preview for collapsed success cards. */
export function workflowCompletionResultPreview(details: WorkflowDetails) {
  if (details.result === undefined) return undefined;
  if (typeof details.result === "string") {
    return sanitizeWorkflowDisplayLine(details.result);
  }
  const serialized = safeStringify(details.result, { maxBytes: 2 * 1024 });
  try {
    return sanitizeWorkflowDisplayLine(JSON.stringify(JSON.parse(serialized)));
  } catch {
    return sanitizeWorkflowDisplayLine(resultJson(details.result));
  }
}

/** Full operator evidence without the model-only transport lead-in/instruction. */
export function buildExpandedWorkflowCompletion(
  display: WorkflowCompletionDisplay,
) {
  return display.entries
    .map(
      ({ deliveryId, details, runDir }) =>
        `${buildWorkflowResultMessage(details, runDir)}\n\nDelivery id: ${sanitizeWorkflowDisplayLine(deliveryId)}`,
    )
    .join("\n\n");
}
