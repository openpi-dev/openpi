import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendLog,
  MAX_LOG_ENTRIES,
  MAX_LOG_TEXT,
  sanitizeLine,
  usageSnapshot,
  type AgentRecord,
  type WorkflowDetails,
} from "./model.ts";
import { runWorkflowSandbox } from "./sandbox.ts";

function details(): WorkflowDetails {
  return {
    runId: "wf_test",
    background: false,
    status: "running",
    startedAt: 0,
    phases: [],
    agents: [],
  };
}

function agentRecord(overrides: Partial<AgentRecord["usage"]>): AgentRecord {
  return {
    index: 1,
    label: "a",
    state: "done",
    startedAt: 0,
    preview: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 1,
      ...overrides,
    },
    transcript: [],
  };
}

function runSandbox(
  source: string,
  overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {},
) {
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    onLog: () => {},
    usageSnapshot: () => ({ total: 0 }),
    maxConcurrency: 4,
    maxAgentCalls: 32,
    ...overrides,
  });
}

test("a log line is flattened into one safe terminal row", () => {
  // Scripts are model-authored, so an escape sequence here would repaint the
  // user's screen and a newline would break row layout.
  const dirty = "step \u001b[31m1\u001b[0m\ndone\ttidily";
  const clean = sanitizeLine(dirty, MAX_LOG_TEXT);
  // Control characters become spaces: the text survives, but it can no longer
  // move the cursor or start a new row.
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(clean));
  assert.equal(clean.replace(/\s+/g, " "), "step [31m1 [0m done tidily");
});

test("clipping a long line never splits a surrogate pair", () => {
  // Each emoji is two code units, so a code-unit slice at an odd length would
  // leave a lone surrogate that renders as a replacement glyph.
  const clipped = sanitizeLine("🙂".repeat(10), 3);
  assert.equal(clipped, "🙂🙂🙂");
  assert.ok(
    !/[\uD800-\uDFFF]/.test(clipped.replace(/[\u{10000}-\u{10FFFF}]/gu, "")),
  );
});

test("an empty or whitespace-only log line is dropped, not recorded", () => {
  const d = details();
  appendLog(d, "   \n\t  ", 1);
  appendLog(d, "", 2);
  assert.equal(d.logs, undefined);
});

test("the log keeps the newest lines and reports how many it dropped", () => {
  const d = details();
  const total = MAX_LOG_ENTRIES + 7;
  for (let i = 0; i < total; i++) appendLog(d, `line ${i}`, i);
  assert.equal(d.logs?.length, MAX_LOG_ENTRIES);
  // The tail is what a reader needs; a silent drop would read as "the script
  // went quiet", so the count has to survive.
  assert.equal(d.logsDropped, 7);
  assert.equal(d.logs?.[0]?.text, "line 7");
  assert.equal(d.logs?.at(-1)?.text, `line ${total - 1}`);
});

test("a usage snapshot sums every agent's tokens including cache", () => {
  const snapshot = usageSnapshot([
    agentRecord({
      input: 100,
      output: 20,
      cacheRead: 5,
      cacheWrite: 1,
      cost: 0.5,
    }),
    agentRecord({
      input: 200,
      output: 30,
      cacheRead: 0,
      cacheWrite: 4,
      cost: 0.25,
    }),
  ]);
  assert.equal(snapshot.input, 300);
  assert.equal(snapshot.output, 50);
  assert.equal(snapshot.total, 360);
  assert.equal(snapshot.cost, 0.75);
  assert.equal(snapshot.agents, 2);
});

test("log() reaches the host in order and phase() stays separate", async () => {
  const logs: string[] = [];
  const phases: string[] = [];
  await runSandbox(
    `
      phase("Scan");
      log("starting");
      const r = await agent("x");
      log("got " + r.output);
      log({ round: 2 });
      return null;
    `,
    {
      onLog: (text) => logs.push(text),
      onPhase: (title) => phases.push(title),
    },
  );
  assert.deepEqual(logs, ["starting", "got reply:x", '{"round":2}']);
  // log() must not pollute the phase list a run is judged against.
  assert.deepEqual(phases, ["Scan"]);
});

test("usage() advances as agents settle, so a post-await read sees them", async () => {
  // The host refreshes the child's snapshot on every agent result. A loop
  // condition evaluated right after `await agent(...)` must therefore include
  // that agent's spend, which is the entire point of the reading.
  let settled = 0;
  const readings = await runSandbox(
    `
      const before = usage().total;
      await agent("one");
      const afterOne = usage().total;
      await agent("two");
      return { before, afterOne, afterTwo: usage().total };
    `,
    {
      onAgent: async () => {
        settled++;
        return { ok: true, output: "ok" };
      },
      usageSnapshot: () => ({ total: settled * 1000, agents: settled }),
    },
  );
  assert.deepEqual(readings, { before: 0, afterOne: 1000, afterTwo: 2000 });
});

test("usage() degrades to a zero reading rather than failing the run", async () => {
  const result = await runSandbox(`return usage().total;`, {
    usageSnapshot: () => {
      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;
      return cyclic;
    },
  });
  assert.equal(result, 0);
});

test("the usage reading is frozen, so a script cannot fake its own totals", async () => {
  const result = await runSandbox(
    `
      const u = usage();
      try { u.total = 999999; } catch { /* strict-mode throw is also fine */ }
      return u.total;
    `,
    { usageSnapshot: () => ({ total: 42 }) },
  );
  assert.equal(result, 42);
});
