import { allocateResultBudgets } from "../shared/result-budget.ts";
import { sanitizeTerminalText } from "../shared/terminal-text.ts";
import { projectText } from "../shared/text-projection.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  sanitizeWorkflowDisplayLine,
  shortenHome,
  statusWord,
  type WorkflowDetails,
  type WorkflowLogEntry,
  type WorkflowStatus,
} from "./model.ts";
import { safeStringify } from "./serialization.ts";

const MAX_DISPLAY_ENTRIES = 64;
const MAX_DISPLAY_BYTES = 64 * 1024;
const MAX_EXPANDED_ENTRY_BYTES = 48 * 1024;
const MAX_ALERTS = 16;
const MAX_FIELD_BYTES = 2 * 1024;

export interface WorkflowCompletionSourceEntry {
  deliveryId: string;
  details: WorkflowDetails;
  runDir: string;
}

/** Bounded operator-facing facts. Runtime state remains in artifacts/model context. */
export interface WorkflowCompletionDisplayEntry {
  deliveryId: string;
  runId: string;
  status: WorkflowStatus;
  summary: string;
  alerts: string[];
  resultPreview?: string;
  expanded: string;
}

export interface WorkflowCompletionDisplay {
  version: 1;
  /** Backward-compatible single-run identity for delivery observers. */
  runId?: string;
  entries: WorkflowCompletionDisplayEntry[];
  omittedEntries?: number;
}

function boundedLine(value: string, maxBytes = MAX_FIELD_BYTES) {
  return projectText(sanitizeWorkflowDisplayLine(value), {
    maxBytes,
    maxLines: 1,
    recovery: "",
  });
}

function labels(details: WorkflowDetails, state: "error" | "uncertain") {
  return details.agents
    .filter((agent) => agent.state === state)
    .map((agent) => sanitizeWorkflowDisplayLine(agent.label));
}

function completionSummary(details: WorkflowDetails) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  return boundedLine(
    `workflow ${details.name ?? details.runId} · ${done + failed}/${details.agents.length} agents · ${elapsed} · ${statusWord(details.status)}`,
  );
}

function isDroppedWorkLog(entry: WorkflowLogEntry) {
  if (entry.kind === "pipeline-drop") return true;
  const text = entry.text;
  const negated =
    /\b(?:no|none|nothing|not|zero|0)\b.{0,48}\b(?:dropped|discarded|omitted)\b/iu.test(
      text,
    ) ||
    /(?:没有|并未|未曾|未|无|零(?:个|项)?).{0,24}(?:丢弃|丢失|遗漏)/u.test(
      text,
    );
  if (negated) return false;
  return (
    /\b(?:dropped|discarded|omitted)\b/iu.test(text) ||
    /(?:被)?(?:丢弃|丢失|遗漏)/u.test(text)
  );
}

/** Exceptional evidence that must remain visible while the report is collapsed. */
function completionAlerts(details: WorkflowDetails) {
  const alerts: string[] = [];
  if (details.error) alerts.push(`Error: ${details.error}`);

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
    if (!isDroppedWorkLog(entry)) continue;
    alerts.push(`Dropped work: ${sanitizeWorkflowDisplayLine(entry.text)}`);
  }

  for (const agent of details.agents) {
    if (agent.worktreePath) {
      const reason = agent.worktreeCleanup?.reason ?? "cleanup was unsafe";
      alerts.push(
        `Retained worktree [${sanitizeWorkflowDisplayLine(agent.label)}]: ${shortenHome(agent.worktreePath)} (${sanitizeWorkflowDisplayLine(reason)})${
          agent.worktreeHandoffArtifact
            ? `; handoff ${sanitizeWorkflowDisplayLine(agent.worktreeHandoffArtifact)}`
            : ""
        }`,
      );
      continue;
    }
    if (!agent.worktreeHandoffArtifact) continue;
    const cleanup = agent.worktreeCleanup;
    const work = cleanup?.commits
      ? `${cleanup.commits} commit${cleanup.commits === 1 ? "" : "s"} on ${cleanup.branch}`
      : agent.worktreeBranch
        ? `branch ${agent.worktreeBranch}`
        : "isolated work";
    alerts.push(
      `Worktree handoff [${sanitizeWorkflowDisplayLine(agent.label)}]: ${sanitizeWorkflowDisplayLine(work)}; ${sanitizeWorkflowDisplayLine(agent.worktreeHandoffArtifact)}`,
    );
  }

  const unique = [...new Set(alerts)].map((alert) =>
    sanitizeTerminalText(boundedLine(alert, 512)),
  );
  if (unique.length <= MAX_ALERTS) return unique;
  return [
    ...unique.slice(0, MAX_ALERTS - 1),
    `${unique.length - MAX_ALERTS + 1} more exceptional item(s); expand for evidence`,
  ];
}

/** Short return-value preview for collapsed success cards. */
function completionResultPreview(details: WorkflowDetails) {
  if (details.result === undefined) return undefined;
  if (typeof details.result === "string") return boundedLine(details.result);
  const serialized = safeStringify(details.result, { maxBytes: 2 * 1024 });
  try {
    return boundedLine(JSON.stringify(JSON.parse(serialized)));
  } catch {
    return boundedLine(resultJson(details.result));
  }
}

/** Operator evidence, intentionally independent from the model transport report. */
function buildOperatorReport(
  details: WorkflowDetails,
  runDir: string,
  deliveryId: string,
) {
  const { done, failed, uncertain } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""}${uncertain ? `, ${uncertain} uncertain` : ""} across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
    `Delivery id: ${deliveryId}`,
  ];

  const artifacts = [
    details.resultArtifact ? `Result: ${details.resultArtifact}` : undefined,
    details.transcriptArtifact
      ? `Transcripts: ${details.transcriptArtifact}`
      : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  if (artifacts.length > 0) lines.push("", "Artifacts:", ...artifacts);

  const replayed = details.agents.filter((agent) => agent.replayed).length;
  if (details.resumedFrom) {
    lines.push(
      `Resumed from ${details.resumedFrom}: replayed ${replayed}/${details.agents.length} agent call(s), ran ${details.agents.length - replayed} for real.`,
    );
  }
  if (details.resumeNote) lines.push(`Resume: ${details.resumeNote}`);
  if (details.error) lines.push(`Error: ${details.error}`);

  if (details.logs?.length) {
    lines.push("", "Log:");
    if (details.logsDropped) {
      lines.push(`  (${details.logsDropped} earlier line(s) dropped)`);
    }
    for (const entry of details.logs) lines.push(`  ${entry.text}`);
  }

  const isolated = details.agents.filter(
    (agent) => agent.worktreeBranch || agent.worktreePath,
  );
  if (isolated.length > 0) {
    lines.push("", "Isolated worktrees:");
    for (const agent of isolated) {
      const cleanup = agent.worktreeCleanup;
      const work = cleanup?.commits
        ? `${cleanup.commits} commit${cleanup.commits === 1 ? "" : "s"} on ${cleanup.branch}`
        : agent.worktreeBranch
          ? `committed to branch ${agent.worktreeBranch}`
          : "no commits";
      lines.push(
        `- [${agent.label}] ${work}${
          agent.worktreePath
            ? `; kept at ${shortenHome(agent.worktreePath)} (${cleanup?.reason ?? "uncommitted changes"})`
            : cleanup?.branchDeleted
              ? "; empty branch deleted"
              : cleanup?.reason
                ? `; cleanup warning: ${cleanup.reason}`
                : ""
        }${agent.worktreeHandoffArtifact ? `; handoff ${agent.worktreeHandoffArtifact}` : ""}`,
      );
    }
  }

  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const state =
        agent.state === "done"
          ? agent.replayed
            ? "ok (replayed)"
            : "ok"
          : agent.state === "error"
            ? "FAILED"
            : agent.state === "uncertain"
              ? "UNCERTAIN"
              : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${state}` +
          (agent.acceptance
            ? ` · deprecated model self-attestation ${agent.acceptance.status}`
            : "") +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined) {
    lines.push("", "Result:", resultJson(details.result));
  }
  return sanitizeTerminalText(lines.join("\n"));
}

/** Build a byte-bounded display projection without retaining runtime objects. */
export function buildWorkflowCompletionDisplay(
  sourceEntries: readonly WorkflowCompletionSourceEntry[],
): WorkflowCompletionDisplay {
  const selected = sourceEntries.slice(0, MAX_DISPLAY_ENTRIES);
  const fixedEntry = ({
    deliveryId,
    details,
  }: WorkflowCompletionSourceEntry) => ({
    deliveryId: boundedLine(deliveryId, 512),
    runId: boundedLine(details.runId, 512),
    status: details.status,
    summary: completionSummary(details),
    alerts: completionAlerts(details),
    resultPreview: completionResultPreview(details),
    expanded: "",
  });
  let fixedEntries = selected.map(fixedEntry);
  const fixedSize = () =>
    Buffer.byteLength(
      JSON.stringify({
        version: 1,
        ...(sourceEntries.length === 1
          ? { runId: fixedEntries[0]?.runId ?? "" }
          : {}),
        entries: fixedEntries,
        ...(sourceEntries.length > selected.length
          ? { omittedEntries: sourceEntries.length - selected.length }
          : {}),
      }),
      "utf8",
    );
  while (selected.length > 1 && fixedSize() > MAX_DISPLAY_BYTES / 2) {
    selected.pop();
    fixedEntries.pop();
  }
  const fixedBytes = fixedSize();
  const reports = selected.map(({ deliveryId, details, runDir }) =>
    buildOperatorReport(details, runDir, deliveryId),
  );
  const allocation = allocateResultBudgets(
    reports.map((report) => Buffer.byteLength(report, "utf8")),
    undefined,
    {
      maxBatchBytes: Math.max(0, MAX_DISPLAY_BYTES - fixedBytes),
      maxResultBytes: MAX_EXPANDED_ENTRY_BYTES,
      minResultBytes: 512,
      headroomShare: 0,
      estimatedBytesPerToken: 4,
    },
  );
  let budgets = [...allocation.budgets];
  const projectedEntries = () =>
    fixedEntries.map((entry, index) => ({
      ...entry,
      expanded: projectText(reports[index]!, {
        maxBytes: budgets[index] ?? 0,
        maxLines: 600,
        recovery: `Full workflow evidence is available in ${shortenHome(selected[index]!.runDir)}.`,
      }),
    }));
  let entries = projectedEntries();
  const projectedSize = () =>
    Buffer.byteLength(
      JSON.stringify({
        version: 1,
        ...(sourceEntries.length === 1
          ? { runId: entries[0]?.runId ?? "" }
          : {}),
        entries,
        ...(sourceEntries.length > selected.length
          ? { omittedEntries: sourceEntries.length - selected.length }
          : {}),
      }),
      "utf8",
    );
  for (let attempt = 0; projectedSize() > MAX_DISPLAY_BYTES; attempt++) {
    if (attempt >= 8) {
      budgets = budgets.map(() => 0);
    } else {
      const expandedBytes = budgets.reduce((sum, budget) => sum + budget, 0);
      const overflow = projectedSize() - MAX_DISPLAY_BYTES;
      const target = Math.max(
        0,
        expandedBytes - overflow - entries.length * 16,
      );
      const scale = expandedBytes > 0 ? target / expandedBytes : 0;
      budgets = budgets.map((budget) => Math.floor(budget * scale));
    }
    entries = projectedEntries();
  }
  const display: WorkflowCompletionDisplay = {
    version: 1,
    ...(sourceEntries.length === 1
      ? { runId: entries[0]?.runId ?? sourceEntries[0]!.details.runId }
      : {}),
    entries,
    ...(sourceEntries.length > selected.length
      ? { omittedEntries: sourceEntries.length - selected.length }
      : {}),
  };
  return display;
}

function isString(value: unknown, maxBytes = MAX_FIELD_BYTES) {
  return (
    typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function isStatus(value: unknown): value is WorkflowStatus {
  return (
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted" ||
    value === "uncertain"
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

export function isWorkflowCompletionDisplay(
  value: unknown,
): value is WorkflowCompletionDisplay {
  if (!value || typeof value !== "object") return false;
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return false;
  }
  if (bytes > MAX_DISPLAY_BYTES) return false;
  try {
    const candidate = value as Partial<WorkflowCompletionDisplay>;
    if (
      !hasOnlyKeys(candidate, [
        "version",
        "runId",
        "entries",
        "omittedEntries",
      ]) ||
      candidate.version !== 1 ||
      !Array.isArray(candidate.entries) ||
      candidate.entries.length > MAX_DISPLAY_ENTRIES ||
      (candidate.runId !== undefined && !isString(candidate.runId, 512)) ||
      (candidate.omittedEntries !== undefined &&
        (!Number.isSafeInteger(candidate.omittedEntries) ||
          candidate.omittedEntries <= 0))
    ) {
      return false;
    }
    return candidate.entries.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const record = entry as Partial<WorkflowCompletionDisplayEntry>;
      return (
        hasOnlyKeys(record, [
          "deliveryId",
          "runId",
          "status",
          "summary",
          "alerts",
          "resultPreview",
          "expanded",
        ]) &&
        isString(record.deliveryId, 512) &&
        isString(record.runId, 512) &&
        isStatus(record.status) &&
        isString(record.summary) &&
        Array.isArray(record.alerts) &&
        record.alerts.length <= MAX_ALERTS &&
        record.alerts.every((alert) => isString(alert, 512)) &&
        (record.resultPreview === undefined ||
          isString(record.resultPreview)) &&
        isString(record.expanded, MAX_EXPANDED_ENTRY_BYTES)
      );
    });
  } catch {
    return false;
  }
}

export function workflowCompletionSummary(
  entry: WorkflowCompletionDisplayEntry,
) {
  return entry.summary;
}

export function workflowCompletionAlerts(
  entry: WorkflowCompletionDisplayEntry,
) {
  return entry.alerts;
}

export function workflowCompletionResultPreview(
  entry: WorkflowCompletionDisplayEntry,
) {
  return entry.resultPreview;
}

export function buildExpandedWorkflowCompletion(
  display: WorkflowCompletionDisplay,
) {
  const reports = display.entries.map((entry) => entry.expanded);
  if (display.omittedEntries) {
    reports.push(
      `${display.omittedEntries} additional workflow completion(s) omitted from this display projection; their full evidence remains in workflow artifacts and model-visible delivery context.`,
    );
  }
  return reports.join("\n\n");
}
