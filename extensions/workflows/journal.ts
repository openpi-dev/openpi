/**
 * Resume journal: cache agent results by call content so a re-run can replay
 * the calls that did not change.
 *
 * Keying is by content, NOT by call ordinal, and that is load-bearing.
 * `pipeline()` deliberately has no barrier between stages, so the order in
 * which agent calls are issued depends on how long each agent actually took:
 *
 *   stage1 latencies {a:40,b:5,c:20} -> s1:a#1 s1:b#2 s1:c#3 s2:b#4 s2:c#5 s2:a#6
 *   stage1 latencies {a:5,b:40,c:20} -> s1:a#1 s1:b#2 s1:c#3 s2:a#4 s2:c#5 s2:b#6
 *
 * Same script, same args, but #4 is a different call each time. Replaying by
 * ordinal would hand one item's cached result to another — a silently wrong
 * answer, which is worse than no resume at all. Hashing the content makes
 * replay order-independent.
 *
 * It also means non-determinism in a script (`Date.now()` in a prompt) can only
 * cost cache hits, never correctness: a changed prompt simply misses.
 */

import { createHash } from "node:crypto";

/** Cap on the whole journal artifact; oldest entries are dropped first. */
export const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
// Version 1 did not record side-effect eligibility or cwd/resource identity.
// Reject it rather than risk replaying an old write-capable call.
export const JOURNAL_VERSION = 2;

/** The replay payload: exactly the fields a script observes from agent(). */
export interface JournalEntry {
  readonly key: string;
  readonly output: string;
  readonly structured?: unknown;
}

export interface WorkflowJournal {
  readonly version: number;
  readonly entries: readonly JournalEntry[];
}

interface EncodedJournalEntry {
  readonly entry: JournalEntry;
  /** The entry formatted at the indentation used inside the journal array. */
  readonly json: string;
  readonly bytes: number;
}

const JOURNAL_PREFIX = `{
  "version": ${JOURNAL_VERSION},
  "entries": [
`;
const JOURNAL_SUFFIX = "\n  ]\n}";
const JOURNAL_SEPARATOR = ",\n";
const JOURNAL_EMPTY = JSON.stringify(
  { version: JOURNAL_VERSION, entries: [] },
  null,
  2,
);
const JOURNAL_PREFIX_BYTES = Buffer.byteLength(JOURNAL_PREFIX, "utf8");
const JOURNAL_SUFFIX_BYTES = Buffer.byteLength(JOURNAL_SUFFIX, "utf8");
const JOURNAL_SEPARATOR_BYTES = Buffer.byteLength(JOURNAL_SEPARATOR, "utf8");
const JOURNAL_EMPTY_BYTES = Buffer.byteLength(JOURNAL_EMPTY, "utf8");

function encodeJournalEntry(entry: JournalEntry): EncodedJournalEntry {
  // JSON.stringify on an array serializes an undefined element as null. The
  // public type only permits objects, but retaining that fallback keeps this
  // helper's behavior total if a malformed caller reaches it at runtime.
  const json = JSON.stringify(entry, null, 2) ?? "null";
  const indented = `    ${json.replaceAll("\n", "\n    ")}`;
  return {
    entry,
    json: indented,
    bytes: Buffer.byteLength(indented, "utf8"),
  };
}

function journalBytes(entryCount: number, entryBytes: number) {
  if (entryCount === 0) return JOURNAL_EMPTY_BYTES;
  return (
    JOURNAL_PREFIX_BYTES +
    entryBytes +
    JOURNAL_SUFFIX_BYTES +
    (entryCount - 1) * JOURNAL_SEPARATOR_BYTES
  );
}

/**
 * Incrementally bounded journal storage for a running Workflow.
 *
 * Each entry is encoded once when appended. The active queue uses a head
 * cursor, so dropping old entries only subtracts their already-known byte
 * contribution. `toJson()` assembles the complete canonical artifact without
 * re-stringifying each entry or repeatedly measuring the whole suffix.
 */
export interface WorkflowJournalAccumulator {
  readonly bytes: number;
  readonly dropped: number;
  readonly length: number;
  append(entry: JournalEntry): void;
  toJournal(): WorkflowJournal;
  toJson(): string;
}

export function createJournalAccumulator(
  maxBytes = JOURNAL_MAX_BYTES,
): WorkflowJournalAccumulator {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < JOURNAL_EMPTY_BYTES) {
    throw new RangeError(
      `Journal byte budget must be at least ${JOURNAL_EMPTY_BYTES} bytes`,
    );
  }

  let queue: Array<EncodedJournalEntry | undefined> = [];
  let head = 0;
  let entryBytes = 0;
  let dropped = 0;

  const activeLength = () => queue.length - head;
  const activeBytes = () => journalBytes(activeLength(), entryBytes);

  const compact = () => {
    // Release the encoded payload immediately when it is evicted. Compact the
    // sparse prefix only occasionally so eviction remains amortized O(1).
    if (head === queue.length) {
      queue = [];
      head = 0;
      return;
    }
    if (head >= 64 && head * 2 >= queue.length) {
      queue = queue.slice(head);
      head = 0;
    }
  };

  return {
    get bytes() {
      return activeBytes();
    },
    get dropped() {
      return dropped;
    },
    get length() {
      return activeLength();
    },
    append(entry) {
      const encoded = encodeJournalEntry(entry);
      queue.push(encoded);
      entryBytes += encoded.bytes;

      while (activeLength() > 0 && activeBytes() > maxBytes) {
        const oldest = queue[head];
        if (!oldest) break;
        queue[head] = undefined;
        head++;
        entryBytes -= oldest.bytes;
        dropped++;
      }
      compact();
    },
    toJournal() {
      const entries: JournalEntry[] = [];
      for (let index = head; index < queue.length; index++) {
        const encoded = queue[index];
        if (encoded) entries.push(encoded.entry);
      }
      return {
        version: JOURNAL_VERSION,
        entries,
      };
    },
    toJson() {
      if (activeLength() === 0) return JOURNAL_EMPTY;
      const entries: string[] = [];
      for (let index = head; index < queue.length; index++) {
        const encoded = queue[index];
        if (encoded) entries.push(encoded.json);
      }
      return JOURNAL_PREFIX + entries.join(JOURNAL_SEPARATOR) + JOURNAL_SUFFIX;
    },
  };
}

/**
 * Only semantic options change what an agent produces, so only these are
 * hashed. Callers pass their whole options object; `label` and `phase` are
 * display only, and renaming a label must not invalidate an identical call.
 */
interface KeyedCallOptions {
  /** Canonical model/effort and resolved Agent Type semantics. */
  readonly execution?: unknown;
  readonly schema?: unknown;
  readonly model?: unknown;
  readonly provider?: unknown;
  readonly effort?: unknown;
}

/** Content hash identifying one agent call for replay. */
export function agentCallKey(
  prompt: string,
  options: Readonly<KeyedCallOptions> = {},
) {
  const canonical = options.execution !== undefined;
  const payload = stableSerialize({
    prompt,
    execution: options.execution,
    schema: options.schema,
    // Callers without a canonical execution snapshot retain the legacy key.
    model:
      !canonical && typeof options.model === "string"
        ? options.model
        : undefined,
    provider:
      !canonical && typeof options.provider === "string"
        ? options.provider
        : undefined,
    effort:
      !canonical && typeof options.effort === "string"
        ? options.effort
        : undefined,
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  // Key order must not affect the hash: two schemas that differ only in
  // property order are the same schema.
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${parts.join(",")}}`;
}

/**
 * Replay lookup over a prior run's journal. A key can legitimately repeat (a
 * script calling the same prompt twice), so each key keeps its own cursor and
 * the Nth occurrence consumes the Nth recorded result.
 */
export function createReplayCache(journal: WorkflowJournal | undefined) {
  const byKey = new Map<string, JournalEntry[]>();
  for (const entry of journal?.entries ?? []) {
    const bucket = byKey.get(entry.key);
    if (bucket) bucket.push(entry);
    else byKey.set(entry.key, [entry]);
  }
  const cursors = new Map<string, number>();
  let replayed = 0;

  return {
    /** Consume the next cached result for this key, or undefined on a miss. */
    take(key: string) {
      const bucket = byKey.get(key);
      if (!bucket) return undefined;
      const cursor = cursors.get(key) ?? 0;
      const entry = bucket[cursor];
      if (!entry) return undefined;
      cursors.set(key, cursor + 1);
      replayed++;
      return entry;
    },
    /** How many calls this run has replayed so far. */
    get replayed() {
      return replayed;
    },
    /** Entries available from the source run. */
    get available() {
      return journal?.entries.length ?? 0;
    },
  };
}

export type ReplayCache = ReturnType<typeof createReplayCache>;

/**
 * Trim to the artifact cap by dropping the OLDEST entries, so a long run keeps
 * the results a re-run is most likely to still want. Reports what was dropped:
 * silent truncation would read as a naturally poor hit rate.
 *
 * Sized with plain JSON.stringify, NOT safeStringify: the latter replaces an
 * over-cap value with a `{truncated, preview}` stub, which is always small, so
 * measuring with it would always look under budget and then hand the writer a
 * journal that serializes to a useless preview string.
 */
export function boundedJournal(entries: readonly JournalEntry[]) {
  const accumulator = createJournalAccumulator();
  for (const entry of entries) accumulator.append(entry);
  return {
    journal: accumulator.toJournal(),
    dropped: accumulator.dropped,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lenient parse: resume is an optimization, so anything unreadable degrades to
 * "no cache" rather than failing the run.
 */
export function parseJournal(value: unknown): WorkflowJournal | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== JOURNAL_VERSION) return undefined;
  if (!Array.isArray(value.entries)) return undefined;
  const entries: JournalEntry[] = [];
  for (const raw of value.entries) {
    if (!isRecord(raw)) continue;
    if (typeof raw.key !== "string" || !raw.key) continue;
    if (typeof raw.output !== "string") continue;
    entries.push({
      key: raw.key,
      output: raw.output,
      ...(raw.structured !== undefined ? { structured: raw.structured } : {}),
    });
  }
  return { version: JOURNAL_VERSION, entries };
}
