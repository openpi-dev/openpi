import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_CALL_BACKSTOP_MARGIN, runWorkflowSandbox } from "./sandbox.ts";

function run(
  source: string,
  overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {},
) {
  const abort = new AbortController();
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    signal: abort.signal,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    onLog: () => {},
    usageSnapshot: () => ({ total: 0 }),
    maxConcurrency: 8,
    maxAgentCalls: 128,
    ...overrides,
  });
}

test("sandbox exposes only workflow capabilities and validates results", async () => {
  const phases: string[] = [];
  let active = 0;
  let peak = 0;
  const result = await run(
    `
      phase("Gather");
      const replies = await parallel([
        () => agent("one"),
        () => agent("two"),
      ], { concurrency: 99 });
      return {
        replies: replies.map((reply) => reply.output),
        processType: typeof process,
        requireType: typeof require,
        fetchType: typeof fetch,
      };
    `,
    {
      maxConcurrency: 2,
      onPhase: (title) => phases.push(title),
      onAgent: async (prompt) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: true, output: `reply:${prompt}` };
      },
    },
  );
  assert.deepEqual(result, {
    replies: ["reply:one", "reply:two"],
    processType: "undefined",
    requireType: "undefined",
    fetchType: "undefined",
  });
  assert.deepEqual(phases, ["Gather"]);
  assert.equal(peak, 2);
});

test("sandbox result serialization handles cycles and bigint", async () => {
  const result = await run(`
    const value = { count: 7n };
    value.self = value;
    return value;
  `);
  assert.deepEqual(result, { count: "7n", self: "[circular]" });
});

test("sandbox rejects unawaited agent calls", async () => {
  let calls = 0;
  await assert.rejects(
    run(`agent("orphan"); return "done";`, {
      onAgent: async () => {
        calls++;
        return { ok: true, output: "unexpected" };
      },
    }),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox source cannot escape the host accounting wrapper", async () => {
  let calls = 0;
  await assert.rejects(
    run(
      `}), agent("orphan"), Promise.resolve("bypass"); (async function () {`,
      {
        onAgent: async () => {
          calls++;
          return { ok: true, output: "unexpected" };
        },
      },
    ),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox VM still rejects non-yielding synchronous code", async () => {
  await assert.rejects(run(`while (true) {}`), /timed out/);
});

test("workflow agent invocations have no per-request wall timer", async () => {
  let signalAborted = false;
  const result = await run(`return (await agent("delayed")).output;`, {
    onAgent: async (_prompt, _options, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      signalAborted = signal.aborted;
      return { ok: true, output: "completed" };
    },
  });

  assert.equal(result, "completed");
  assert.equal(signalAborted, false);
});

test("workflow cancellation aborts a pending agent request", async () => {
  const controller = new AbortController();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let requestAborted = false;
  const pending = run(`return await agent("pending");`, {
    signal: controller.signal,
    onAgent: async (_prompt, _options, signal) => {
      startedResolve?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { ok: false, output: "", error: "Agent was aborted" };
    },
  });

  await started;
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(pending, /Workflow was aborted/);
  assert.equal(requestAborted, true);
});

test("the sandbox budget is the configured budget, not a lower hidden one", async () => {
  const source = `
    let n = 0;
    for (let i = 0; i < 40; i++) n += (await agent("x")).output.length;
    return n;
  `;
  // A run configured for 128 calls must not die at some other number.
  const generous = await run(source, { maxAgentCalls: 128 });
  assert.equal(typeof generous, "number");

  await assert.rejects(
    run(source, { maxAgentCalls: 5 }),
    /agent request budget/,
  );
});

test("the sandbox hard cap sits a fixed margin above the configured budget", async () => {
  // The sandbox is only the outer backstop; it must not fatally kill the run
  // at exactly the configured budget (that is the controller's graceful job).
  // Fire exactly budget + margin calls: all succeed. One more trips the cap.
  const budget = 4;
  const atCap = budget + AGENT_CALL_BACKSTOP_MARGIN;
  const okSource = `
    for (let i = 0; i < ${atCap}; i++) await agent("x");
    return "done";
  `;
  assert.equal(await run(okSource, { maxAgentCalls: budget }), "done");

  const overSource = `
    for (let i = 0; i < ${atCap + 1}; i++) await agent("x");
    return "done";
  `;
  await assert.rejects(
    run(overSource, { maxAgentCalls: budget }),
    /agent request budget/,
  );
});

test("parallel() settles a throwing thunk to null without failing the batch", async () => {
  const result = await run(
    `
      const results = await parallel([
        () => agent("ok"),
        () => { throw new Error("bad thunk"); },
        async () => { const r = await agent("also-ok"); return r.output; },
      ]);
      return results.map((r) =>
        r === null ? "NULL" : typeof r === "string" ? r : r.output,
      );
    `,
    { onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }) },
  );
  assert.deepEqual(result, ["reply:ok", "NULL", "reply:also-ok"]);
});

test("pipeline() advances each item independently, with no barrier between stages", async () => {
  // The point of pipeline over parallel: a fast item must be allowed to finish
  // its whole chain while a slow sibling is still in stage one.
  const order: string[] = [];
  const result = await run(
    `
      return await pipeline(
        args.files,
        (file) => agent("s1:" + file),
        (previous, file, index) => agent("s2:" + file + ":" + index + ":" + previous.output),
      );
    `,
    {
      args: { files: ["slow", "fast"] },
      onAgent: async (prompt) => {
        order.push(`start ${prompt}`);
        await new Promise((resolve) =>
          setTimeout(resolve, prompt === "s1:slow" ? 60 : 5),
        );
        order.push(`end ${prompt}`);
        return { ok: true, output: prompt };
      },
    },
  );

  // Results stay in input order even though completion order differs.
  assert.deepEqual(
    (result as Array<{ output: string }>).map((entry) => entry.output),
    ["s2:slow:0:s1:slow", "s2:fast:1:s1:fast"],
  );
  // Stage args are (previousResult, originalItem, index): the second stage
  // could only build these labels if all three arrived.
  assert.ok(order.includes("start s2:fast:1:s1:fast"));
  assert.ok(
    order.indexOf("start s2:fast:1:s1:fast") < order.indexOf("end s1:slow"),
    `fast reached stage two only after the slow item finished stage one:\n${order.join("\n")}`,
  );
});

test("pipeline() drops a throwing item to null and skips its remaining stages", async () => {
  const reached: string[] = [];
  const result = await run(
    `
      return await pipeline(
        ["good", "bad"],
        (item) => { if (item === "bad") throw new Error("stage one failed"); return item; },
        async (item) => (await agent("s2:" + item)).output,
      );
    `,
    {
      onAgent: async (prompt) => {
        reached.push(prompt);
        return { ok: true, output: prompt };
      },
    },
  );

  assert.deepEqual(result, ["s2:good", null]);
  // The failed item must not continue: no stage-two agent call for "bad".
  assert.deepEqual(reached, ["s2:good"]);
});

test("pipeline() honors the concurrency cap and an empty input", async () => {
  let active = 0;
  let peak = 0;
  const result = await run(
    `
      const done = await pipeline(
        [1, 2, 3, 4, 5, 6],
        (n) => agent("a" + n),
        (previous) => agent("b" + previous.output),
      );
      const empty = await pipeline([], (x) => x);
      return { count: done.length, empty };
    `,
    {
      maxConcurrency: 2,
      onAgent: async (prompt) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { ok: true, output: prompt };
      },
    },
  );

  assert.deepEqual(result, { count: 6, empty: [] });
  // In-flight chains are capped too: the host counts an agent call against the
  // run budget when it is submitted, so releasing every chain at once would
  // spend the budget on merely-queued calls.
  assert.equal(peak, 2);
});

test("pipeline() rejects a non-array input and non-function stages", async () => {
  await assert.rejects(
    run(`return await pipeline("not-an-array", (x) => x);`),
    /pipeline\(\) expects an array/,
  );
  await assert.rejects(
    run(`return await pipeline([1], "not-a-function");`),
    /pipeline\(\) stages must be functions/,
  );
});

test("pipeline() with no stages returns the items unchanged", async () => {
  // Degenerate but well-defined: zero stages is the identity, not an error.
  assert.deepEqual(await run(`return await pipeline([1, 2]);`), [1, 2]);
});

test("a promise handed to workflow code cannot reach the host realm", async () => {
  // .then() used to return a host-realm promise, whose constructor chain leads
  // to the host Function and therefore past the context's codeGeneration ban.
  const escaped = await run(`
    const chained = agent("x").then(() => 0);
    await chained;
    try {
      const F = chained.constructor.constructor;
      return typeof F("return process")();
    } catch {
      return "denied";
    }
  `);
  assert.equal(escaped, "denied");
});

test("isolation reaches the host verbatim, per agent call", async () => {
  // The sandbox is where a script-authored option could silently vanish, so
  // pin that isolation survives the IPC boundary and stays per-call.
  const seen: unknown[] = [];
  await run(
    `
      await agent("isolated", { isolation: "worktree" });
      await agent("shared");
      return null;
    `,
    {
      onAgent: async (_prompt, options) => {
        seen.push(options.isolation);
        return { ok: true, output: "" };
      },
    },
  );
  assert.deepEqual(seen, ["worktree", undefined]);
});

test("replayed calls raise the backstop instead of killing a resumed run", async () => {
  // A replay costs no controller budget but still sends one agent IPC message.
  // Sized on the assumption that the controller always rejects first, the
  // backstop fired after only MARGIN new calls and killed the child mid-run —
  // losing the aggregate that resuming exists to preserve. Measured before the
  // fix: a 128-entry journal plus 9 new calls was fatal with 120 of the run's
  // real budget untouched.
  const budget = 4;
  const replayable = 20;
  const newCalls = budget;
  const source = `
    for (let i = 0; i < ${replayable + newCalls}; i++) await agent("x" + i);
    return "aggregate";
  `;
  assert.equal(
    await run(source, {
      maxAgentCalls: budget,
      extraAgentRequests: replayable,
    }),
    "aggregate",
  );

  // The backstop still exists: without the allowance the same script dies.
  await assert.rejects(
    run(source, { maxAgentCalls: budget }),
    /exceeded its agent request budget/,
  );
});
