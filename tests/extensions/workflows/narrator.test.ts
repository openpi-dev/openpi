import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentRecord,
  appendLog,
  createUsageReader,
  MAX_LOG_ENTRIES,
  MAX_LOG_TEXT,
  sanitizeLine,
  sanitizeWorkflowDisplayLine,
  sanitizeWorkflowDisplayText,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";
import { runWorkflowSandbox } from "../../../extensions/workflows/sandbox.ts";

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

test("active workflow previews and errors cannot inject terminal controls", () => {
  const input =
    "preview\u001b]52;c;clipboard\u0007\nerror\u001b[31mred\u001b[0m";
  assert.equal(sanitizeWorkflowDisplayText(input), "preview\nerrorred");
  assert.equal(sanitizeWorkflowDisplayText("abcdef", 3), "abc");
  assert.equal(
    sanitizeWorkflowDisplayLine("error\n\n\nnext\u001b]52;c;hidden\u0007"),
    "error next",
  );
  assert.equal(sanitizeWorkflowDisplayLine("a\n".repeat(20_000)).length, 2_000);
});

test("a log line is flattened into one safe terminal row", () => {
  // Scripts are model-authored, so an escape sequence here would repaint the
  // user's screen and a newline would break row layout.
  const dirty = "step \u001b[31m1\u001b[0m\ndone\ttidily\u202ereordered\u202c";
  const clean = sanitizeLine(dirty, MAX_LOG_TEXT);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(clean));
  assert.equal(clean, "step 1 done tidilyreordered");
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

test("a usage reading sums every agent's tokens including cache", () => {
  const read = createUsageReader([
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
  const snapshot = read();
  assert.equal(snapshot.input, 300);
  assert.equal(snapshot.output, 50);
  assert.equal(snapshot.total, 360);
  assert.equal(snapshot.cost, 0.75);
  assert.equal(snapshot.agents, 2);
});

test("a usage reading never goes backwards when an agent compacts", () => {
  // Each agent's usage is RECOMPUTED from its current message list, so a
  // child session that auto-compacts drops the tokens of the messages it
  // discarded and the sum falls. A script looping until a token target would
  // then run far past it while honestly reporting it stopped on budget —
  // measured at 400k actual against a 250k intended stop. The reading is a
  // monotonic lower bound instead.
  const agent = agentRecord({ input: 100_000, output: 5_000 });
  const read = createUsageReader([agent]);
  assert.equal(read().total, 105_000);

  // Compaction shrinks what the recompute can see.
  agent.usage.input = 20_000;
  assert.equal(read().total, 105_000, "the reading must not fall");

  agent.usage.input = 200_000;
  assert.equal(read().total, 205_000, "and must still track real growth");
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

test("usage() exposes the host's resolved call capacity", async () => {
  const result = await runSandbox(
    `
      const capacity = usage().limits;
      try { capacity.callsRemaining = 999; } catch { /* frozen */ }
      return {
        concurrency: capacity.concurrency,
        maxAgentCalls: capacity.maxAgentCalls,
        callsUsed: capacity.callsUsed,
        callsRemaining: capacity.callsRemaining,
      };
    `,
    {
      usageSnapshot: () => ({
        total: 1_000,
        limits: {
          concurrency: 8,
          maxAgentCalls: 128,
          callsUsed: 1,
          callsRemaining: 127,
        },
      }),
    },
  );
  assert.deepEqual(result, {
    concurrency: 8,
    maxAgentCalls: 128,
    callsUsed: 1,
    callsRemaining: 127,
  });
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

test("an oversized log line is dropped, never fatal to the run", async () => {
  // The byte gate used to call finish(), rejecting the whole run and
  // discarding every completed agent's output over one narration line. The
  // gate is also byte-based on a code-point-capped field, so the threshold
  // varied 4x by script: 8k ASCII passed where 3k emoji did not.
  const logs: string[] = [];
  const result = await runSandbox(
    `
      log("a".repeat(50000));
      log("🙂".repeat(5000));
      const r = await agent("real work");
      log("still alive");
      return r.output;
    `,
    { onLog: (text) => logs.push(text) },
  );
  assert.equal(result, "reply:real work", "the run must survive");
  assert.deepEqual(logs, ["still alive"]);
});

test("an oversized phase title is dropped, never fatal to the run", async () => {
  const phases: string[] = [];
  const result = await runSandbox(
    `
      phase("x".repeat(50000));
      phase("Scan");
      return (await agent("work")).output;
    `,
    { onPhase: (title) => phases.push(title) },
  );
  assert.equal(result, "reply:work");
  assert.deepEqual(phases, ["Scan"]);
});

test("a log flood is capped instead of killing the child with OOM", async () => {
  // log() is synchronous into process.send, which queues on the IPC pipe. A
  // tight loop never yields, so the queue grew until the 128MB heap aborted —
  // taking an hour of completed agent work with it. Measured: 1e6 logs
  // delivered ~2k lines and then SIGABRT.
  let logged = 0;
  const result = await runSandbox(
    `
      for (let i = 0; i < 200000; i++) log("progress " + i);
      return (await agent("survived")).output;
    `,
    { onLog: () => logged++ },
  );
  assert.equal(result, "reply:survived", "the run must survive the flood");
  assert.ok(logged > 0 && logged <= 10_000, `delivered ${logged}`);
});

test("a stage that throws says why instead of leaving a bare null", async () => {
  // Without this, a script bug, a deliberate skip, and a genuinely failed
  // agent are one indistinguishable null — and the "how many dropped" count
  // every script is told to report becomes a guess.
  const logs: Array<{ text: string; kind?: "pipeline-drop" }> = [];
  const result = await runSandbox(
    `
      return await pipeline(
        ["a", "b"],
        (item) => item,
        (prev) => { if (prev === "b") throw new Error("guard rejected b"); return prev; },
      );
    `,
    { onLog: (text, kind) => logs.push({ text, kind }) },
  );
  assert.deepEqual(result, ["a", null]);
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "pipeline-drop");
  assert.match(logs[0]?.text ?? "", /item 1 dropped/);
  assert.match(logs[0]?.text ?? "", /guard rejected b/);
});

test("a stage mutating its own input array cannot manufacture nulls", async () => {
  // mapLimited re-reads items[index] each iteration, so truncating the array
  // mid-run reported drops for items that had already been processed.
  const result = await runSandbox(
    `
      const items = ["a", "b", "c", "d"];
      return await pipeline(items, (item, _orig, index) => {
        if (index === 0) items.length = 1;
        return "done:" + item;
      });
    `,
  );
  assert.deepEqual(result, ["done:a", "done:b", "done:c", "done:d"]);
});
