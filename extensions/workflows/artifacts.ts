import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  boundedJournal,
  JOURNAL_MAX_BYTES,
  type JournalEntry,
  parseJournal,
  type WorkflowJournal,
  type WorkflowJournalAccumulator,
} from "./journal.ts";
import {
  refreshWorkflowGraph,
  type TranscriptEntry,
  type WorkflowDelivery,
  type WorkflowDetails,
} from "./model.ts";
import {
  encodeCompleteJson,
  safeStringify,
  truncateUtf8,
  writeFileAtomic,
} from "./serialization.ts";

export const JOURNAL_FILE = "journal.json";
export const WORKFLOW_COMMIT_FILE = ".workflow-commit.json";

const ARTIFACT_TRANSCRIPT_MAX_BYTES = 32 * 1024;
const ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;
const AGENT_RESULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
const WORKFLOW_MANIFEST_MAX_BYTES = 1024 * 1024;
const WORKFLOW_TRANSCRIPTS_MAX_BYTES = 2 * 1024 * 1024;
const WORKFLOW_COMMIT_MAX_BYTES = 3 * 1024 * 1024;
export const WORKFLOW_CHECKPOINT_INTERVAL_MS = 500;
const ENTRY_TRUNCATION_MARKER = "\n[entry truncated]";
const TRANSCRIPT_TRUNCATION_MARKER =
  "[artifact transcript truncated: older entries omitted]";

type WorkflowJournalSource =
  | readonly JournalEntry[]
  | WorkflowJournalAccumulator;

interface WorkflowArtifactWrite {
  name: typeof JOURNAL_FILE | "result.json" | "transcripts.json";
  content: string;
}

interface WorkflowCommitArtifact {
  name: WorkflowArtifactWrite["name"];
  bytes: number;
  sha256: string;
}

interface WorkflowCommitMarker {
  version: 1;
  runId: string;
  manifest: string;
  artifacts: WorkflowCommitArtifact[];
}

export type WorkflowCommitRecovery =
  | "none"
  | "recovered"
  | "already-committed"
  | "incomplete"
  | "invalid"
  | "failed";

const artifactLimits = new Map<WorkflowArtifactWrite["name"], number>([
  ["transcripts.json", WORKFLOW_TRANSCRIPTS_MAX_BYTES],
  ["result.json", WORKFLOW_MANIFEST_MAX_BYTES],
  [JOURNAL_FILE, JOURNAL_MAX_BYTES],
]);

function textBytes(text: string) {
  return Buffer.byteLength(text, "utf8");
}

function sha256(content: string | Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function removeWorkflowCommit(runDir: string, strict = false) {
  try {
    fs.unlinkSync(path.join(runDir, WORKFLOW_COMMIT_FILE));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    if (strict) throw error;
  }
}

function workflowCommitMarker(
  details: WorkflowDetails,
  manifest: string,
  artifacts: WorkflowArtifactWrite[],
): WorkflowCommitMarker {
  for (const { name, content } of artifacts) {
    const bytes = textBytes(content);
    const limit = artifactLimits.get(name);
    if (limit === undefined || bytes > limit) {
      throw new Error(`Workflow artifact ${name} exceeded its commit budget`);
    }
  }
  return {
    version: 1,
    runId: details.runId,
    manifest,
    artifacts: artifacts.map(({ name, content }) => ({
      name,
      bytes: textBytes(content),
      sha256: sha256(content),
    })),
  };
}

function serializeWorkflowCommitMarker(
  details: WorkflowDetails,
  manifest: string,
  artifacts: WorkflowArtifactWrite[],
) {
  const content = JSON.stringify(
    workflowCommitMarker(details, manifest, artifacts),
  );
  if (textBytes(content) > WORKFLOW_COMMIT_MAX_BYTES) {
    throw new Error(
      "Workflow artifact commit receipt exceeded its byte budget",
    );
  }
  return content;
}

function parseWorkflowCommitMarker(
  runDir: string,
): WorkflowCommitMarker | "none" | "invalid" {
  const markerPath = path.join(runDir, WORKFLOW_COMMIT_FILE);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(markerPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "none"
      : "invalid";
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size <= 0 ||
    stat.size > WORKFLOW_COMMIT_MAX_BYTES
  ) {
    return "invalid";
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return "invalid";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const record = raw as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.runId !== "string" ||
    record.runId !== path.basename(runDir) ||
    typeof record.manifest !== "string" ||
    textBytes(record.manifest) > WORKFLOW_MANIFEST_MAX_BYTES ||
    !Array.isArray(record.artifacts) ||
    record.artifacts.length < 1 ||
    record.artifacts.length > artifactLimits.size
  ) {
    return "invalid";
  }

  let manifest: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(record.manifest);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "invalid";
    }
    manifest = parsed as Record<string, unknown>;
  } catch {
    return "invalid";
  }
  if (
    manifest.runId !== record.runId ||
    !["completed", "failed", "aborted", "uncertain"].includes(
      String(manifest.status),
    ) ||
    manifest.transcriptArtifact !== "transcripts.json" ||
    (manifest.resultArtifact !== undefined &&
      manifest.resultArtifact !== "result.json")
  ) {
    return "invalid";
  }

  const artifacts: WorkflowCommitArtifact[] = [];
  const names = new Set<string>();
  for (const value of record.artifacts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return "invalid";
    }
    const artifact = value as Record<string, unknown>;
    if (
      typeof artifact.name !== "string" ||
      !artifactLimits.has(artifact.name as WorkflowArtifactWrite["name"]) ||
      names.has(artifact.name) ||
      typeof artifact.bytes !== "number" ||
      !Number.isInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes >
        (artifactLimits.get(artifact.name as WorkflowArtifactWrite["name"]) ??
          -1) ||
      typeof artifact.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(artifact.sha256)
    ) {
      return "invalid";
    }
    names.add(artifact.name);
    artifacts.push({
      name: artifact.name as WorkflowArtifactWrite["name"],
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    });
  }
  if (
    !names.has("transcripts.json") ||
    (manifest.resultArtifact === "result.json") !== names.has("result.json")
  ) {
    return "invalid";
  }
  return {
    version: 1,
    runId: record.runId,
    manifest: record.manifest,
    artifacts,
  };
}

function hasCommittedManifest(
  manifestPath: string,
  marker: WorkflowCommitMarker,
) {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const manifest = parsed as Record<string, unknown>;
    const markerManifest = JSON.parse(marker.manifest) as Record<
      string,
      unknown
    >;
    return (
      manifest.runId === marker.runId &&
      manifest.status === markerManifest.status &&
      manifest.transcriptArtifact === markerManifest.transcriptArtifact &&
      manifest.resultArtifact === markerManifest.resultArtifact
    );
  } catch {
    return false;
  }
}

/**
 * Complete a terminal artifact commit only when every prepared file matches
 * the exact bounded receipt written before the side-artifact sequence began.
 */
export function recoverPendingWorkflowCommit(
  runDir: string,
): WorkflowCommitRecovery {
  const marker = parseWorkflowCommitMarker(runDir);
  if (marker === "none" || marker === "invalid") return marker;

  for (const artifact of marker.artifacts) {
    const artifactPath = path.join(runDir, artifact.name);
    let stat: fs.Stats;
    let content: Buffer;
    try {
      stat = fs.lstatSync(artifactPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size !== artifact.bytes
      ) {
        return "incomplete";
      }
      content = fs.readFileSync(artifactPath);
    } catch {
      return "incomplete";
    }
    if (
      content.byteLength !== artifact.bytes ||
      sha256(content) !== artifact.sha256
    ) {
      return "incomplete";
    }
  }

  const manifestPath = path.join(runDir, "workflow.json");
  try {
    if (
      fs.existsSync(manifestPath) &&
      hasCommittedManifest(manifestPath, marker)
    ) {
      removeWorkflowCommit(runDir);
      return "already-committed";
    }
    writeFileAtomic(manifestPath, marker.manifest);
    removeWorkflowCommit(runDir);
    return "recovered";
  } catch {
    return "failed";
  }
}

function boundEntry(entry: TranscriptEntry, maxBytes: number) {
  if (textBytes(entry.text) <= maxBytes) return { ...entry };
  const markerBytes = textBytes(ENTRY_TRUNCATION_MARKER);
  const text =
    maxBytes > markerBytes
      ? `${truncateUtf8(entry.text, maxBytes - markerBytes)}${ENTRY_TRUNCATION_MARKER}`
      : truncateUtf8(ENTRY_TRUNCATION_MARKER, maxBytes);
  return { ...entry, text };
}

/** Keep the initial prompt plus the newest useful context within the artifact cap. */
export function boundedArtifactTranscript(
  transcript: TranscriptEntry[],
  options: { maxBytes?: number; entryMaxBytes?: number } = {},
) {
  if (transcript.length === 0) return [];
  const maxBytes = Math.max(
    256,
    options.maxBytes ?? ARTIFACT_TRANSCRIPT_MAX_BYTES,
  );
  const entryMaxBytes = Math.max(
    64,
    Math.min(
      maxBytes,
      options.entryMaxBytes ?? ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES,
    ),
  );
  const bounded = transcript.map((entry) => boundEntry(entry, entryMaxBytes));
  if (
    bounded.reduce((total, entry) => total + textBytes(entry.text), 0) <=
    maxBytes
  ) {
    return bounded;
  }

  const initialIndex = transcript.findIndex((entry) => entry.role === "user");
  const initial = boundEntry(
    transcript[initialIndex >= 0 ? initialIndex : 0],
    Math.min(entryMaxBytes, maxBytes - textBytes(TRANSCRIPT_TRUNCATION_MARKER)),
  );
  const marker: TranscriptEntry = {
    role: "toolResult",
    name: "transcript",
    text: TRANSCRIPT_TRUNCATION_MARKER,
  };
  let remaining = maxBytes - textBytes(initial.text) - textBytes(marker.text);
  const tail: TranscriptEntry[] = [];

  for (
    let index = transcript.length - 1;
    index >= 0 && remaining > 0;
    index--
  ) {
    if (index === initialIndex || (initialIndex < 0 && index === 0)) continue;
    const entry = boundEntry(
      transcript[index],
      Math.min(entryMaxBytes, remaining),
    );
    tail.push(entry);
    remaining -= textBytes(entry.text);
  }

  tail.reverse();
  return [initial, marker, ...tail];
}

function writeRunFile(runDir: string, name: string, content: string) {
  writeFileAtomic(path.join(runDir, name), content);
}

export function persistWorkflowTerminalState(
  runDir: string,
  details: WorkflowDetails,
) {
  const terminalManifest: WorkflowDetails = {
    ...details,
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
  delete terminalManifest.result;
  delete terminalManifest.resultArtifact;
  delete terminalManifest.transcriptArtifact;
  writeRunFile(
    runDir,
    "workflow.json",
    safeStringify(terminalManifest, { maxBytes: 1024 * 1024 }),
  );
}

/** Persist one successful child result before any handoff/context projection. */
export function persistWorkflowAgentResult(
  runDir: string,
  index: number,
  result: { output: string; structured?: unknown },
) {
  // Artifact references are persisted as portable workflow paths. The host
  // filesystem join happens in writeRunFile; handoff validation and replay
  // consumers intentionally use `/` regardless of the platform.
  const artifact = `agent-results/agent-${String(index).padStart(4, "0")}.json`;
  const encoded = encodeCompleteJson(
    {
      output: result.output,
      ...(result.structured !== undefined
        ? { structured: result.structured }
        : {}),
    },
    {
      maxBytes: AGENT_RESULT_ARTIFACT_MAX_BYTES,
      maxDepth: 32,
      maxNodes: 100_000,
      maxStringBytes: AGENT_RESULT_ARTIFACT_MAX_BYTES,
    },
  );
  if (!encoded.ok) {
    throw new Error(
      `Agent result artifact exceeded the ${AGENT_RESULT_ARTIFACT_MAX_BYTES}-byte budget (${encoded.limit} limit at ${encoded.path})`,
    );
  }
  writeRunFile(runDir, artifact, encoded.json);
  return artifact;
}

export function persistWorkflowJson(
  runDir: string,
  details: WorkflowDetails,
  journal?: WorkflowJournalSource,
) {
  refreshWorkflowGraph(details);
  const transcripts = Object.fromEntries(
    details.agents.map((agent) => [
      agent.index,
      boundedArtifactTranscript(agent.transcript),
    ]),
  );

  // Publish terminal execution facts before dependent side artifacts. If a
  // later artifact write fails, readers still see an explained terminal run
  // instead of the previous `running` manifest. The final manifest below adds
  // the artifact references once every dependent file has committed.
  const terminal = details.status !== "running";
  if (terminal) {
    // A retry supersedes an older unfinished receipt before it publishes a new
    // terminal fact. Failing to remove it must stop the new commit rather than
    // let a concurrent reader promote stale artifact identities.
    removeWorkflowCommit(runDir, true);
    persistWorkflowTerminalState(runDir, details);
  }

  const artifactWrites: WorkflowArtifactWrite[] = [
    {
      name: "transcripts.json",
      content: safeStringify(transcripts, {
        maxBytes: WORKFLOW_TRANSCRIPTS_MAX_BYTES,
      }),
    },
  ];
  // Written alongside the rest so it inherits atomic write, 500ms coalescing,
  // and the final flush. Only present once a call has actually succeeded.
  // Accumulators already enforce the cap incrementally and can assemble the
  // canonical JSON from their cached entry fragments. Plain arrays retain the
  // compatibility path through boundedJournal; plain JSON.stringify is
  // deliberate because safeStringify would swap an over-cap value for a
  // preview stub, silently turning the journal into something unusable.
  if (
    journal &&
    (journal.length > 0 || ("toJson" in journal && journal.dropped > 0))
  ) {
    const content =
      "toJson" in journal
        ? journal.toJson()
        : JSON.stringify(boundedJournal(journal).journal, null, 2);
    artifactWrites.push({ name: JOURNAL_FILE, content });
  }
  if (details.result !== undefined) {
    artifactWrites.push({
      name: "result.json",
      content: safeStringify(details.result, {
        maxBytes: WORKFLOW_MANIFEST_MAX_BYTES,
      }),
    });
  }
  const compact: WorkflowDetails = {
    ...details,
    ...(details.result !== undefined
      ? { result: "[stored in result.json]", resultArtifact: "result.json" }
      : {}),
    transcriptArtifact: "transcripts.json",
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
  const manifest = safeStringify(compact, {
    maxBytes: WORKFLOW_MANIFEST_MAX_BYTES,
  });

  if (terminal) {
    writeRunFile(
      runDir,
      WORKFLOW_COMMIT_FILE,
      serializeWorkflowCommitMarker(details, manifest, artifactWrites),
    );
  }
  for (const artifact of artifactWrites) {
    writeRunFile(runDir, artifact.name, artifact.content);
  }
  writeRunFile(runDir, "workflow.json", manifest);
  if (terminal) removeWorkflowCommit(runDir);
}

/**
 * Update only the durable delivery receipt. Completion delivery may retain a
 * compact memory projection after the run has been evicted, so rewriting the
 * whole details object here would risk replacing exact result artifacts with
 * that projection.
 */
export function persistWorkflowDeliveryState(
  runDir: string,
  delivery: WorkflowDelivery,
) {
  recoverPendingWorkflowCommit(runDir);
  const file = path.join(runDir, "workflow.json");
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid persisted workflow details: ${file}`);
  }
  const next = { ...(raw as Record<string, unknown>), delivery };
  writeFileAtomic(file, JSON.stringify(next));
}

/** Coalesce live checkpoints while keeping final persistence synchronous. */
export function createWorkflowPersistence(
  runDir: string,
  details: WorkflowDetails,
  options: {
    intervalMs?: number;
    persist?: (
      runDir: string,
      details: WorkflowDetails,
      journal?: WorkflowJournalSource,
    ) => void;
    /** Read at write time so callers only have to append to their journal. */
    journal?: () => WorkflowJournalSource;
  } = {},
) {
  const intervalMs = Math.max(
    0,
    options.intervalMs ?? WORKFLOW_CHECKPOINT_INTERVAL_MS,
  );
  const persist = options.persist ?? persistWorkflowJson;
  const readJournal = options.journal;
  let lastPersistedAt = Date.now();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const savePending = () => {
    timer = undefined;
    if (!dirty) return;
    try {
      persist(runDir, details, readJournal?.());
      dirty = false;
      lastPersistedAt = Date.now();
    } catch {
      // Final flush retries and reports persistence failures synchronously.
    }
  };

  return {
    checkpoint(options: { immediate?: boolean } = {}) {
      dirty = true;
      if (options.immediate) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        savePending();
        return;
      }
      if (timer) return;
      const delay = Math.max(0, intervalMs - (Date.now() - lastPersistedAt));
      if (delay === 0) {
        savePending();
        return;
      }
      timer = setTimeout(savePending, delay);
    },
    flush() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      persist(runDir, details, readJournal?.());
      dirty = false;
      lastPersistedAt = Date.now();
    },
  };
}

/**
 * Read a prior run's replay journal. Any failure (missing run, unreadable or
 * malformed file) yields undefined: resume is an optimization and must never
 * turn into a new way for a run to fail.
 */
export function loadJournal(runDir: string): WorkflowJournal | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path.join(runDir, JOURNAL_FILE), "r");
    const initialSize = fs.fstatSync(descriptor).size;
    if (initialSize > JOURNAL_MAX_BYTES) return undefined;

    // Read at most one byte beyond the cap. The descriptor pins the inspected
    // file, while the extra byte catches growth after fstat without ever
    // allocating or parsing an unbounded journal.
    const bytes = Buffer.allocUnsafe(initialSize + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = fs.readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (read === 0) break;
      length += read;
    }
    // Filling the extra byte means the file changed after inspection. Reject
    // that race even when the new size would still fit the ordinary cap.
    if (length === bytes.length) return undefined;
    const raw = bytes.toString("utf8", 0, length);
    return parseJournal(JSON.parse(raw));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Loading a replay cache is optional and always fails open to a miss.
      }
    }
  }
}
