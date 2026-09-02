import type {
  AgentRecord,
  AgentUsage,
  WorkflowDetails,
  WorkflowMemoryProjection,
} from "./model.ts";
import { toSerializable } from "./serialization.ts";

/** Defaults apply only to settled session-memory projections. Disk is canonical. */
export const DEFAULT_WORKFLOW_SETTLED_MAX_RUNS = 32;
export const DEFAULT_WORKFLOW_SETTLED_MAX_BYTES = 2 * 1024 * 1024;

const MAX_PHASES = 32;
const MAX_LOGS = 8;
const MAX_NAME_BYTES = 512;
const MAX_DESCRIPTION_BYTES = 1_024;
const MAX_LABEL_BYTES = 256;
const MAX_PREVIEW_BYTES = 512;
const MAX_ERROR_BYTES = 1_024;

export interface WorkflowSettledRunRetentionOptions {
  /** Maximum number of settled projections retained in this session. */
  readonly maxRuns?: number;
  /** Maximum serialized UTF-8 bytes retained by all projections. */
  readonly maxBytes?: number;
}

export interface WorkflowRetentionStats {
  /** These counters describe only the current process/session epoch. */
  readonly scope: "current-session";
  readonly retainedRuns: number;
  readonly retainedBytes: number;
  /** Cumulative runs removed by count/byte pressure in this session. */
  readonly evictedRuns: number;
  /** Compatibility alias for evictedRuns. */
  readonly settledRunsEvicted: number;
  /** Serialized bytes belonging to projections removed by pressure. */
  readonly evictedBytes: number;
}

function utf8Head(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function bounded(value: string | undefined, maxBytes: number) {
  return value === undefined ? undefined : utf8Head(value, maxBytes);
}

function jsonBytes(value: unknown) {
  const serialized = JSON.stringify(toSerializable(value));
  if (serialized === undefined)
    throw new Error("Workflow projection is not serializable");
  return Buffer.byteLength(serialized, "utf8");
}

function validateLimit(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function finite(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function compactUsage(usage: AgentUsage) {
  return {
    input: finite(usage.input) ?? 0,
    output: finite(usage.output) ?? 0,
    cacheRead: finite(usage.cacheRead) ?? 0,
    cacheWrite: finite(usage.cacheWrite) ?? 0,
    cost: finite(usage.cost) ?? 0,
    ...(finite(usage.contextTokens) !== undefined
      ? { contextTokens: usage.contextTokens }
      : {}),
    turns: finite(usage.turns) ?? 0,
  };
}

function compactInvocation(agent: AgentRecord) {
  const invocation = agent.invocation;
  if (!invocation) return undefined;
  return {
    identity: {
      runId: invocation.identity.runId,
      callIndex: invocation.identity.callIndex,
    },
    intentState: invocation.intentState,
    admissionState: invocation.admissionState,
    executionState: invocation.executionState,
    ...(invocation.outcome ? { outcome: invocation.outcome } : {}),
    requestedAt: invocation.requestedAt,
    ...(invocation.claimedAt !== undefined
      ? { claimedAt: invocation.claimedAt }
      : {}),
    ...(invocation.runningAt !== undefined
      ? { runningAt: invocation.runningAt }
      : {}),
    ...(invocation.terminalAt !== undefined
      ? { terminalAt: invocation.terminalAt }
      : {}),
  };
}

function compactAgent(
  agent: AgentRecord,
  display: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    index: agent.index,
    ...(agent.callId ? { callId: agent.callId } : {}),
    ...(agent.invocation ? { invocation: compactInvocation(agent) } : {}),
    label: bounded(agent.label, MAX_LABEL_BYTES) ?? "agent",
    ...(agent.phase ? { phase: bounded(agent.phase, MAX_LABEL_BYTES) } : {}),
    state: agent.state,
    ...(agent.model ? { model: bounded(agent.model, MAX_LABEL_BYTES) } : {}),
    ...(agent.contextWindow !== undefined
      ? { contextWindow: agent.contextWindow }
      : {}),
    startedAt: agent.startedAt,
    ...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
    usage: compactUsage(agent.usage),
    transcript: [],
  };

  // These are recovery references, not display text. Truncating them would
  // turn an otherwise recoverable artifact into an unusable path.
  if (agent.resultArtifact) result.resultArtifact = agent.resultArtifact;
  if (agent.resultRef) result.resultRef = agent.resultRef;

  if (!display) return result;
  if (agent.preview) result.preview = bounded(agent.preview, MAX_PREVIEW_BYTES);
  if (agent.error) result.error = bounded(agent.error, MAX_ERROR_BYTES);
  if (agent.replayed) result.replayed = true;
  if (agent.operatorKey) result.operatorKey = agent.operatorKey;
  if (agent.inputCallIds?.length)
    result.inputCallIds = agent.inputCallIds.slice(0, 32);
  if (agent.worktreeBranch) result.worktreeBranch = agent.worktreeBranch;
  if (agent.worktreePath) result.worktreePath = agent.worktreePath;
  if (agent.worktreeHandoffArtifact)
    result.worktreeHandoffArtifact = agent.worktreeHandoffArtifact;
  if (agent.worktreeCleanup) {
    result.worktreeCleanup = {
      removed: agent.worktreeCleanup.removed,
      branchDeleted: agent.worktreeCleanup.branchDeleted,
      branch: agent.worktreeCleanup.branch,
      detached: agent.worktreeCleanup.detached,
      ...(agent.worktreeCleanup.reason
        ? { reason: bounded(agent.worktreeCleanup.reason, MAX_ERROR_BYTES) }
        : {}),
    };
  }
  if (agent.acceptance) {
    result.acceptance = {
      status: agent.acceptance.status,
      errors: agent.acceptance.errors
        .slice(0, 4)
        .map((error) => bounded(error, MAX_ERROR_BYTES)),
      criteria: agent.acceptance.criteria.slice(0, 16).map((criterion) => ({
        id: bounded(criterion.id, MAX_LABEL_BYTES),
        status: criterion.status,
        evidence: criterion.evidence
          .slice(0, 4)
          .map((evidence) => bounded(evidence, MAX_PREVIEW_BYTES)),
        ...(criterion.note
          ? { note: bounded(criterion.note, MAX_ERROR_BYTES) }
          : {}),
      })),
    };
  }
  return result;
}

function omissionMetadata(
  details: WorkflowDetails,
  agentLimit: number,
  logLimit: number,
): WorkflowMemoryProjection["omitted"] {
  return {
    agents: Math.max(0, details.agents.length - agentLimit),
    logs:
      Math.max(0, (details.logs?.length ?? 0) - logLimit) +
      (details.logsDropped ?? 0),
    transcriptEntries: details.agents.reduce(
      (total, agent) => total + agent.transcript.length,
      0,
    ),
    result: details.result !== undefined,
    graph: details.graph !== undefined,
  };
}

function makeProjection(
  details: WorkflowDetails,
  cap: number,
  agents: readonly Record<string, unknown>[],
  logs: readonly unknown[],
  agentLimit: number,
  logLimit: number,
) {
  const phases = details.phases.slice(0, MAX_PHASES).map((phase) => ({
    title: bounded(phase.title, MAX_LABEL_BYTES) ?? "phase",
    ...(phase.detail
      ? { detail: bounded(phase.detail, MAX_DESCRIPTION_BYTES) }
      : {}),
  }));
  const omitted = omissionMetadata(details, agentLimit, logLimit);
  const candidate: Record<string, unknown> = {
    runId: details.runId,
    ...(details.sessionId ? { sessionId: details.sessionId } : {}),
    ...(details.name ? { name: bounded(details.name, MAX_NAME_BYTES) } : {}),
    ...(details.description
      ? { description: bounded(details.description, MAX_DESCRIPTION_BYTES) }
      : {}),
    background: details.background,
    status: details.status,
    startedAt: details.startedAt,
    ...(details.finishedAt !== undefined
      ? { finishedAt: details.finishedAt }
      : {}),
    phases,
    ...(details.currentPhase
      ? { currentPhase: bounded(details.currentPhase, MAX_LABEL_BYTES) }
      : {}),
    agents,
    ...(logs.length > 0 ? { logs } : {}),
    ...(details.logsDropped ? { logsDropped: details.logsDropped } : {}),
    ...(details.delivery
      ? {
          delivery: {
            id: details.delivery.id,
            state: details.delivery.state,
            attempts: details.delivery.attempts,
            updatedAt: details.delivery.updatedAt,
            ...(details.delivery.deliveredAt !== undefined
              ? { deliveredAt: details.delivery.deliveredAt }
              : {}),
            ...(details.delivery.lastError
              ? {
                  lastError: bounded(
                    details.delivery.lastError,
                    MAX_ERROR_BYTES,
                  ),
                }
              : {}),
          },
        }
      : {}),
    ...(details.result !== undefined || details.resultArtifact
      ? {
          result: details.resultArtifact
            ? "[stored in result.json]"
            : "[result omitted from memory]",
          ...(details.resultArtifact
            ? { resultArtifact: details.resultArtifact }
            : {}),
        }
      : {}),
    ...(details.transcriptArtifact
      ? { transcriptArtifact: details.transcriptArtifact }
      : {}),
    ...(details.resumedFrom ? { resumedFrom: details.resumedFrom } : {}),
    ...(details.resumeNote
      ? { resumeNote: bounded(details.resumeNote, MAX_ERROR_BYTES) }
      : {}),
    ...(details.error
      ? { error: bounded(details.error, MAX_ERROR_BYTES) }
      : {}),
    ...(details.graph ? { graphOmitted: true } : {}),
  };

  const sourceBytes = jsonBytes(details);
  const projectedBytes = jsonBytes(candidate);
  const omittedBytes = Math.max(0, sourceBytes - projectedBytes);
  const metadata = (bytes: number): WorkflowMemoryProjection => ({
    kind: "settled",
    maxBytes: cap,
    bytes,
    truncated:
      omittedBytes > 0 ||
      omitted.agents > 0 ||
      omitted.logs > 0 ||
      omitted.transcriptEntries > 0 ||
      omitted.result ||
      omitted.graph,
    omitted,
  });

  return { candidate, metadata };
}

/**
 * Build a detached settled-run projection. It intentionally never copies
 * transcripts or arbitrary result values; those remain in the run artifacts.
 */
export function projectWorkflowDetails(
  details: WorkflowDetails,
  maxBytes = DEFAULT_WORKFLOW_SETTLED_MAX_BYTES,
): WorkflowDetails | undefined {
  const cap = validateLimit(maxBytes, "maxBytes");
  if (cap === 0) return undefined;

  let display = true;
  let agentLimit = details.agents.length;
  let logLimit = Math.min(MAX_LOGS, details.logs?.length ?? 0);
  let agents = details.agents.map((agent) => compactAgent(agent, display));
  let logs = (details.logs ?? []).slice(-logLimit).map((log) => ({
    at: log.at,
    text: bounded(log.text, MAX_PREVIEW_BYTES) ?? "",
  }));

  const removeOptionalFields = () => {
    display = false;
    agents = details.agents.map((agent) => compactAgent(agent, false));
    logs = [];
    logLimit = 0;
  };

  const dropAgent = () => {
    if (agents.length === 0) return false;
    // Keep the oldest and newest identities preferentially while pressure
    // removes middle display rows. Lifecycle facts for retained rows survive.
    const index = agents.length > 1 ? Math.floor(agents.length / 2) : 0;
    agents = [...agents.slice(0, index), ...agents.slice(index + 1)];
    agentLimit--;
    return true;
  };

  const dropRootOptional = (candidate: Record<string, unknown>) => {
    for (const key of [
      "description",
      "resumeNote",
      "error",
      "currentPhase",
      "name",
      "sessionId",
      "logsDropped",
      "logs",
      "graphOmitted",
      "result",
    ]) {
      if (key in candidate) {
        delete candidate[key];
        return true;
      }
    }
    return false;
  };

  let candidate: Record<string, unknown> | undefined;
  let projection: WorkflowMemoryProjection | undefined;
  for (let pass = 0; pass < details.agents.length + 32; pass++) {
    const built = makeProjection(
      details,
      cap,
      agents,
      logs,
      agentLimit,
      logLimit,
    );
    candidate = built.candidate;
    projection = built.metadata(0);
    candidate.memoryProjection = projection;
    let bytes = jsonBytes(candidate);
    if (bytes <= cap) {
      // The byte count is itself part of the projection. Iterate until the
      // decimal width of that field stabilizes.
      for (let i = 0; i < 4; i++) {
        candidate.memoryProjection = built.metadata(bytes);
        const next = jsonBytes(candidate);
        if (next === bytes) break;
        bytes = next;
      }
      candidate.memoryProjection = built.metadata(bytes);
      bytes = jsonBytes(candidate);
      if (bytes <= cap) return candidate as unknown as WorkflowDetails;
    }

    if (display) {
      removeOptionalFields();
      continue;
    }
    if (dropAgent()) continue;
    if (dropRootOptional(candidate)) continue;

    // The exact run id and terminal identity are non-negotiable. A caller
    // using an impossibly small test budget gets an explicit non-retained run
    // rather than a projection that cannot be addressed or measured safely.
    const minimal: Record<string, unknown> = {
      runId: details.runId,
      background: details.background,
      status: details.status,
      startedAt: details.startedAt,
      ...(details.finishedAt !== undefined
        ? { finishedAt: details.finishedAt }
        : {}),
      phases: [],
      agents: [],
      ...(details.resultArtifact
        ? { resultArtifact: details.resultArtifact }
        : {}),
      ...(details.transcriptArtifact
        ? { transcriptArtifact: details.transcriptArtifact }
        : {}),
    };
    const minimalProjection = makeProjection(
      details,
      cap,
      [],
      [],
      0,
      0,
    ).metadata(0);
    minimal.memoryProjection = minimalProjection;
    const minimalBytes = jsonBytes(minimal);
    if (minimalBytes <= cap) {
      minimal.memoryProjection = { ...minimalProjection, bytes: minimalBytes };
      if (jsonBytes(minimal) <= cap)
        return minimal as unknown as WorkflowDetails;
    }
    return undefined;
  }
  return undefined;
}

export function measureWorkflowDetailsBytes(details: WorkflowDetails) {
  return jsonBytes(details);
}

interface RetainedEntry {
  readonly details: WorkflowDetails;
  readonly bytes: number;
}

/** Count- and byte-bounded insertion-ordered store for settled projections. */
export class WorkflowSettledRunRetention {
  readonly maxRuns: number;
  readonly maxBytes: number;
  private readonly entries = new Map<string, RetainedEntry>();
  private totalBytes = 0;
  private totalEvictedRuns = 0;
  private totalEvictedBytes = 0;

  constructor(options: WorkflowSettledRunRetentionOptions = {}) {
    this.maxRuns = validateLimit(
      options.maxRuns ?? DEFAULT_WORKFLOW_SETTLED_MAX_RUNS,
      "maxRuns",
    );
    this.maxBytes = validateLimit(
      options.maxBytes ?? DEFAULT_WORKFLOW_SETTLED_MAX_BYTES,
      "maxBytes",
    );
  }

  set(details: WorkflowDetails) {
    const previous = this.entries.get(details.runId);
    if (previous) {
      this.entries.delete(details.runId);
      this.totalBytes -= previous.bytes;
    }
    const projection = projectWorkflowDetails(details, this.maxBytes);
    if (!projection) {
      // Keep a previously valid projection addressable when an unusually small
      // configured budget cannot represent a later update. The canonical file
      // remains the recovery source either way.
      if (previous) {
        this.entries.set(details.runId, previous);
        this.totalBytes += previous.bytes;
      } else {
        this.totalEvictedRuns++;
      }
      return undefined;
    }
    const bytes = measureWorkflowDetailsBytes(projection);
    this.entries.set(details.runId, { details: projection, bytes });
    this.totalBytes += bytes;
    while (
      this.entries.size > this.maxRuns ||
      this.totalBytes > this.maxBytes
    ) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      const entry = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (!entry) continue;
      this.totalBytes -= entry.bytes;
      this.totalEvictedRuns++;
      this.totalEvictedBytes += entry.bytes;
    }
    return this.entries.get(details.runId)?.details;
  }

  get(runId: string) {
    return this.entries.get(runId)?.details;
  }

  has(runId: string) {
    return this.entries.has(runId);
  }

  delete(runId: string) {
    const entry = this.entries.get(runId);
    if (!entry) return false;
    this.entries.delete(runId);
    this.totalBytes -= entry.bytes;
    return true;
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Clear retained projections without changing current-session counters. */
  reset() {
    this.clear();
  }

  /** Start a new session accounting epoch. */
  resetStats() {
    this.totalEvictedRuns = 0;
    this.totalEvictedBytes = 0;
  }

  /** Clear projections and start a new session accounting epoch. */
  resetSession() {
    this.clear();
    this.resetStats();
  }

  keys() {
    return this.entries.keys();
  }

  values() {
    return [...this.entries.values()].map((entry) => entry.details).values();
  }

  entriesArray() {
    return [...this.entries.entries()].map(
      ([id, entry]) => [id, entry.details] as const,
    );
  }

  get size() {
    return this.entries.size;
  }

  get retainedBytes() {
    return this.totalBytes;
  }

  get evictedRuns() {
    return this.totalEvictedRuns;
  }

  get settledRunsEvicted() {
    return this.totalEvictedRuns;
  }

  get evictedBytes() {
    return this.totalEvictedBytes;
  }

  get stats(): WorkflowRetentionStats {
    return {
      scope: "current-session",
      retainedRuns: this.entries.size,
      retainedBytes: this.totalBytes,
      evictedRuns: this.totalEvictedRuns,
      settledRunsEvicted: this.totalEvictedRuns,
      evictedBytes: this.totalEvictedBytes,
    };
  }

  getStats() {
    return this.stats;
  }
}

export function createWorkflowSettledRunRetention(
  options: WorkflowSettledRunRetentionOptions = {},
) {
  return new WorkflowSettledRunRetention(options);
}
