import * as fs from "node:fs";
import * as path from "node:path";
import {
  boundedJournal,
  JOURNAL_MAX_BYTES,
  type JournalEntry,
  parseJournal,
  type WorkflowJournal,
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

const ARTIFACT_TRANSCRIPT_MAX_BYTES = 32 * 1024;
const ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;
const AGENT_RESULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024;
export const WORKFLOW_CHECKPOINT_INTERVAL_MS = 500;
const ENTRY_TRUNCATION_MARKER = "\n[entry truncated]";
const TRANSCRIPT_TRUNCATION_MARKER =
  "[artifact transcript truncated: older entries omitted]";

function textBytes(text: string) {
  return Buffer.byteLength(text, "utf8");
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
  journal?: readonly JournalEntry[],
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
  if (details.status !== "running") {
    persistWorkflowTerminalState(runDir, details);
  }

  writeRunFile(
    runDir,
    "transcripts.json",
    safeStringify(transcripts, { maxBytes: 2 * 1024 * 1024 }),
  );
  // Written alongside the rest so it inherits atomic write, 500ms coalescing,
  // and the final flush. Only present once a call has actually succeeded.
  // boundedJournal has already brought this under the cap, and plain
  // JSON.stringify is deliberate: safeStringify would swap an over-cap value
  // for a preview stub, silently turning the journal into something unusable.
  if (journal && journal.length > 0) {
    writeRunFile(
      runDir,
      JOURNAL_FILE,
      JSON.stringify(boundedJournal(journal).journal, null, 2),
    );
  }
  if (details.result !== undefined) {
    writeRunFile(
      runDir,
      "result.json",
      safeStringify(details.result, { maxBytes: 1024 * 1024 }),
    );
  }
  const compact: WorkflowDetails = {
    ...details,
    ...(details.result !== undefined
      ? { result: "[stored in result.json]", resultArtifact: "result.json" }
      : {}),
    transcriptArtifact: "transcripts.json",
    agents: details.agents.map((agent) => ({ ...agent, transcript: [] })),
  };
  writeRunFile(
    runDir,
    "workflow.json",
    safeStringify(compact, { maxBytes: 1024 * 1024 }),
  );
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
      journal?: readonly JournalEntry[],
    ) => void;
    /** Read at write time so callers only have to append to their own array. */
    journal?: () => readonly JournalEntry[];
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
