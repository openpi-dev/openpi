/**
 * Resume journal: keying, replay bookkeeping, and the property that matters
 * most — replay must survive `pipeline()` issuing calls in a different order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentCallKey,
  boundedJournal,
  createReplayCache,
  JOURNAL_MAX_BYTES,
  JOURNAL_VERSION,
  parseJournal,
  type JournalEntry,
} from "../../../extensions/workflows/journal.ts";
import {
  runWorkflowSandbox,
  type SandboxAgentOptions,
  type SandboxAgentResult,
} from "../../../extensions/workflows/sandbox.ts";

test("the call key ignores display options and tracks semantic ones", () => {
  const base = agentCallKey("review a.ts", { schema: { type: "object" } });

  // label/phase only affect the UI; renaming one must not cost a cache hit.
  assert.equal(
    agentCallKey("review a.ts", {
      schema: { type: "object" },
      label: "different",
      phase: "Other",
    } as Parameters<typeof agentCallKey>[1]),
    base,
  );

  // Anything that changes what the agent produces must change the key.
  assert.notEqual(
    agentCallKey("review b.ts", { schema: { type: "object" } }),
    base,
  );
  assert.notEqual(agentCallKey("review a.ts", {}), base);
  assert.notEqual(
    agentCallKey("review a.ts", { schema: { type: "string" } }),
    base,
  );
  assert.notEqual(
    agentCallKey("review a.ts", { schema: { type: "object" }, model: "m" }),
    base,
  );
  assert.notEqual(
    agentCallKey("review a.ts", { schema: { type: "object" }, effort: "high" }),
    base,
  );
  const typed = agentCallKey("review a.ts", {
    schema: { type: "object" },
    execution: {
      agentType: {
        name: "reviewer",
        body: "Review read-only.",
        tools: ["read", "rg"],
      },
      model: "provider/reviewer",
      effort: "medium",
    },
  });
  assert.notEqual(typed, base);
  assert.notEqual(
    agentCallKey("review a.ts", {
      schema: { type: "object" },
      execution: {
        agentType: {
          name: "reviewer",
          body: "Review read-only.",
          tools: ["read", "rg"],
        },
        model: "other-provider/reviewer",
        effort: "medium",
      },
    }),
    typed,
    "a bare model resolving under a different parent provider must miss",
  );
});

test("canonical execution ignores equivalent raw model and effort spellings", () => {
  const execution = { model: "p/m", effort: "high" };
  assert.equal(
    agentCallKey("p", { model: "p/m", effort: "high", execution }),
    agentCallKey("p", {
      provider: "p",
      model: "m",
      effort: undefined,
      execution,
    }),
  );
});

test("the call key is stable across schema property order", () => {
  // Two spellings of the same schema are the same schema.
  assert.equal(
    agentCallKey("p", { schema: { type: "object", required: ["a"] } }),
    agentCallKey("p", { schema: { required: ["a"], type: "object" } }),
  );
});

test("repeated identical calls consume their own recorded results in order", () => {
  const key = agentCallKey("same", {});
  const cache = createReplayCache({
    version: JOURNAL_VERSION,
    entries: [
      { key, output: "first" },
      { key, output: "second" },
    ],
  });

  assert.equal(cache.take(key)?.output, "first");
  assert.equal(cache.take(key)?.output, "second");
  // A third occurrence is a genuine miss, not a silent re-serve of "second".
  assert.equal(cache.take(key), undefined);
  assert.equal(cache.replayed, 2);
});

test("an empty or absent journal yields a cache that always misses", () => {
  const cache = createReplayCache(undefined);
  assert.equal(cache.take(agentCallKey("x", {})), undefined);
  assert.equal(cache.replayed, 0);
  assert.equal(cache.available, 0);
});

test("a malformed or old journal degrades to no cache instead of throwing", () => {
  assert.equal(parseJournal(undefined), undefined);
  assert.equal(parseJournal("not an object"), undefined);
  // Version 1 journals predate side-effect-safe eligibility and project/
  // resource identity, so accepting one could replay a mutating old call.
  assert.equal(
    parseJournal({ version: 1, entries: [{ key: "old", output: "unsafe" }] }),
    undefined,
  );
  assert.equal(parseJournal({ version: 99, entries: [] }), undefined);
  assert.equal(parseJournal({ version: JOURNAL_VERSION }), undefined);

  // Individual bad entries are skipped, good ones survive.
  const parsed = parseJournal({
    version: JOURNAL_VERSION,
    entries: [
      { key: "a", output: "ok" },
      { key: "", output: "empty key" },
      { key: "b" },
      "junk",
      { key: "c", output: "structured", structured: { n: 1 } },
    ],
  });
  assert.deepEqual(parsed?.entries, [
    { key: "a", output: "ok" },
    { key: "c", output: "structured", structured: { n: 1 } },
  ]);
});

test("an oversized journal drops the oldest entries and reports how many", () => {
  const big = "x".repeat(64 * 1024);
  const entries: JournalEntry[] = Array.from({ length: 64 }, (_, i) => ({
    key: `k${i}`,
    output: big,
  }));

  const { journal, dropped } = boundedJournal(entries);

  assert.ok(dropped > 0, "fixture must exceed the cap");
  assert.equal(journal.entries.length, entries.length - dropped);
  // Newest survive: a re-run is likeliest to still want the latest results.
  assert.equal(journal.entries.at(-1)?.key, "k63");
  assert.ok(
    Buffer.byteLength(JSON.stringify(journal), "utf8") <= JOURNAL_MAX_BYTES,
  );
});

test("a bounded journal round-trips back into a working cache", () => {
  // Regression: sizing with safeStringify made this look under budget while
  // actually writing a `{truncated, preview}` stub, which parses back to
  // nothing — resume would silently stop working. The written bytes must
  // still parse into the entries they claim to hold.
  const big = "x".repeat(64 * 1024);
  const entries: JournalEntry[] = Array.from({ length: 64 }, (_, i) => ({
    key: `k${i}`,
    output: big,
  }));

  const { journal } = boundedJournal(entries);
  const written = JSON.stringify(journal, null, 2);
  assert.ok(Buffer.byteLength(written, "utf8") <= JOURNAL_MAX_BYTES);

  const reparsed = parseJournal(JSON.parse(written));
  assert.equal(reparsed?.entries.length, journal.entries.length);
  assert.ok(reparsed && reparsed.entries.length > 0, "must survive the trip");
  const cache = createReplayCache(reparsed);
  assert.equal(cache.take("k63")?.output, big);
});

// --- End-to-end through the real sandbox ----------------------------------

/**
 * Mirror what index.ts's agentFn does around each call: look the key up, and
 * journal successes. The keying and cache are the real modules and the script
 * runs in the real sandbox, so `pipeline()`'s real scheduling drives this.
 */
function replayingOnAgent(options: {
  journal?: JournalEntry[];
  collect: JournalEntry[];
  executed: string[];
  latency?: (prompt: string) => number;
}) {
  const cache = createReplayCache(
    options.journal
      ? { version: JOURNAL_VERSION, entries: options.journal }
      : undefined,
  );
  const onAgent = async (
    prompt: string,
    opts: SandboxAgentOptions,
  ): Promise<SandboxAgentResult> => {
    const key = agentCallKey(prompt, opts);
    const cached = cache.take(key);
    if (cached) {
      options.collect.push(cached);
      return { ok: true as const, output: cached.output };
    }
    options.executed.push(prompt);
    const delay = options.latency?.(prompt) ?? 0;
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    const output = `reply:${prompt}`;
    options.collect.push({ key, output });
    return { ok: true as const, output };
  };
  return { onAgent, cache };
}

function runWith(
  source: string,
  onAgent: Parameters<typeof runWorkflowSandbox>[0]["onAgent"],
  args?: unknown,
) {
  return runWorkflowSandbox({
    source,
    args,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onAgent,
    onPhase: () => {},
    onLog: () => {},
    usageSnapshot: () => ({ total: 0 }),
    maxConcurrency: 8,
    maxAgentCalls: 128,
  });
}

const TWO_STAGE = `
  return await pipeline(
    args.items,
    (item) => agent("s1:" + item),
    (previous, item) => agent("s2:" + item + ":" + previous.output),
  );
`;

test("a full replay executes no agents and reproduces the original result", async () => {
  const first = { collect: [] as JournalEntry[], executed: [] as string[] };
  const firstRun = replayingOnAgent(first);
  const original = await runWith(TWO_STAGE, firstRun.onAgent, {
    items: ["a", "b", "c"],
  });
  assert.equal(first.executed.length, 6);

  const second = {
    journal: first.collect,
    collect: [] as JournalEntry[],
    executed: [] as string[],
  };
  const secondRun = replayingOnAgent(second);
  const resumed = await runWith(TWO_STAGE, secondRun.onAgent, {
    items: ["a", "b", "c"],
  });

  assert.deepEqual(resumed, original);
  assert.deepEqual(second.executed, [], "no agent should have actually run");
  assert.equal(secondRun.cache.replayed, 6);
});

test("changing one prompt re-runs only what depends on it", async () => {
  const first = { collect: [] as JournalEntry[], executed: [] as string[] };
  await runWith(TWO_STAGE, replayingOnAgent(first).onAgent, {
    items: ["a", "b"],
  });
  assert.equal(first.executed.length, 4);

  // Item b's stage-1 prompt changes; a is untouched.
  const edited = `
    return await pipeline(
      args.items,
      (item) => agent(item === "b" ? "s1-edited:" + item : "s1:" + item),
      (previous, item) => agent("s2:" + item + ":" + previous.output),
    );
  `;
  const second = {
    journal: first.collect,
    collect: [] as JournalEntry[],
    executed: [] as string[],
  };
  await runWith(edited, replayingOnAgent(second).onAgent, {
    items: ["a", "b"],
  });

  // b's stage 1 changed, and b's stage 2 embeds that output so it changed too.
  // a's chain is untouched and replays entirely.
  assert.deepEqual(second.executed.sort(), [
    "s1-edited:b",
    "s2:b:reply:s1-edited:b",
  ]);
});

test("replay survives pipeline reordering calls between runs", async () => {
  // The reason keying is by content, not by ordinal. pipeline() has no barrier
  // between stages, so call order follows real agent latency. Here the two runs
  // issue the same calls in a DIFFERENT order; every one must still replay.
  const order1: string[] = [];
  const first = { collect: [] as JournalEntry[], executed: [] as string[] };
  const firstRun = replayingOnAgent({
    ...first,
    latency: (prompt) => (prompt === "s1:a" ? 60 : 5),
  });
  const original = await runWith(
    TWO_STAGE,
    async (prompt, opts) => {
      order1.push(prompt);
      return firstRun.onAgent(prompt, opts);
    },
    { items: ["a", "b", "c"] },
  );

  const order2: string[] = [];
  const second = {
    journal: first.collect,
    collect: [] as JournalEntry[],
    executed: [] as string[],
    // Invert which item is slow, so the issue order differs from run one.
    latency: (prompt: string) => (prompt === "s1:c" ? 60 : 5),
  };
  const secondRun = replayingOnAgent(second);
  const resumed = await runWith(
    TWO_STAGE,
    async (prompt, opts) => {
      order2.push(prompt);
      return secondRun.onAgent(prompt, opts);
    },
    { items: ["a", "b", "c"] },
  );

  assert.notDeepEqual(
    order1,
    order2,
    "fixture must actually reorder the calls, or it proves nothing",
  );
  assert.deepEqual(resumed, original, "every item kept its own result");
  assert.deepEqual(second.executed, []);
  assert.equal(secondRun.cache.replayed, 6);
});
