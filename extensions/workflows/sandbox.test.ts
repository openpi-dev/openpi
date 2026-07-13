import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_TIMEOUT_MS, runWorkflowSandbox } from "./sandbox.ts";

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
    ...overrides,
  });
}

test("workflow agent timeout defaults to three minutes", () => {
  assert.equal(AGENT_TIMEOUT_MS, 3 * 60 * 1000);
});

test("sandbox exposes only workflow capabilities and validates results", async () => {
  const phases: string[] = [];
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
    { onPhase: (title) => phases.push(title) },
  );
  assert.deepEqual(result, {
    replies: ["reply:one", "reply:two"],
    processType: "undefined",
    requireType: "undefined",
    fetchType: "undefined",
  });
  assert.deepEqual(phases, ["Gather"]);
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

test("sandbox VM still rejects non-yielding synchronous code", async () => {
  await assert.rejects(run(`while (true) {}`), /timed out/);
});

test("an agent timeout is recoverable and does not fail the workflow", async () => {
  let slowCallAborted = false;
  const result = await run(
    `
      const timedOut = await agent("slow");
      const recovered = await agent("recovery");
      return { timedOut, recovered: recovered.output };
    `,
    {
      agentTimeoutMs: 25,
      onAgent: async (prompt, _options, signal) => {
        if (prompt === "recovery") {
          return { ok: true, output: "recovered" };
        }
        await new Promise<void>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              slowCallAborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return { ok: false, output: "", error: "Agent was aborted" };
      },
    },
  );

  assert.deepEqual(result, {
    timedOut: {
      ok: false,
      output: "",
      error: "Agent invocation timed out after 25ms",
    },
    recovered: "recovered",
  });
  assert.equal(slowCallAborted, true);
});
