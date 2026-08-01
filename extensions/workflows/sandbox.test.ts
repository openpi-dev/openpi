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
