import {
  refreshWorkflowGraph,
  type TranscriptEntry,
  type WorkflowDetails,
} from "./model.ts";
import {
  boundedJournal,
  parseJournal,
  type JournalEntry,
  type WorkflowJournal,
} from "./journal.ts";
import {
  safeStringify,
  truncateUtf8,
  writeFileAtomic,
} from "./serialization.ts";
import * as fs from "node:fs";
import * as path from "node:path";

export const JOURNAL_FILE = "journal.json";

const ARTIFACT_TRANSCRIPT_MAX_BYTES = 32 * 1024;
const ARTIFACT_TRANSCRIPT_ENTRY_MAX_BYTES = 8 * 1024;
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
  try {
    const raw = fs.readFileSync(path.join(runDir, JOURNAL_FILE), "utf8");
    return parseJournal(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
