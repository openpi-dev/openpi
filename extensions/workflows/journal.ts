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
export const JOURNAL_VERSION = 1;

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

/**
 * Only these four options change what an agent produces, so only these are
 * hashed. Callers pass their whole options object; `label` and `phase` are
 * display only, and renaming a label must not invalidate an identical call.
 */
interface KeyedCallOptions {
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
  const payload = stableSerialize({
    prompt,
    schema: options.schema,
    model: typeof options.model === "string" ? options.model : undefined,
    provider:
      typeof options.provider === "string" ? options.provider : undefined,
    effort: typeof options.effort === "string" ? options.effort : undefined,
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
  const size = (kept: readonly JournalEntry[]) =>
    Buffer.byteLength(
      JSON.stringify({ version: JOURNAL_VERSION, entries: kept }, null, 2),
      "utf8",
    );

  let kept = [...entries];
  let dropped = 0;
  while (kept.length > 0 && size(kept) > JOURNAL_MAX_BYTES) {
    kept = kept.slice(1);
    dropped++;
  }
  return { journal: { version: JOURNAL_VERSION, entries: kept }, dropped };
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
