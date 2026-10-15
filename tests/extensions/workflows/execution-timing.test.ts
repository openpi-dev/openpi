import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  persistWorkflowAgentTiming,
  persistWorkflowJson,
} from "../../../extensions/workflows/artifacts.ts";
import {
  decodeExecutionTimingSummary,
  ExecutionTimingLedger,
  invocationTiming,
  TIMING_ACTIVE_LIMIT,
  TIMING_ARTIFACT_MAX_BYTES,
  TIMING_ENTRY_LIMIT,
} from "../../../extensions/workflows/execution-timing.ts";
import {
  requestInvocation,
  transitionInvocation,
} from "../../../extensions/workflows/invocation-ledger.ts";
import {
  emptyUsage,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";

function clockFixture() {
  let time = 0;
  return {
    ledger: new ExecutionTimingLedger(1000, () => time),
    at: (next: number) => {
      time = next;
    },
  };
}

test("overlapping tool elapsed is additive but wall coverage is a union; residual stays unattributed", () => {
  const { ledger, at } = clockFixture();
  at(10);
  ledger.promptStarted();
  at(20);
  ledger.toolStart("a", "read");
  at(30);
  ledger.toolStart("b", "read");
  at(50);
  ledger.toolEnd("a", "read", false);
  at(70);
  ledger.toolEnd("b", "read", true);
  at(80);
  ledger.eventsEnded();
  at(100);
  const { summary, entries } = ledger.snapshot("failure");
  assert.equal(summary.toolDurationMs, 70);
  assert.equal(summary.toolWallMs, 50);
  assert.equal(summary.unattributedMs, 50);
  assert.equal(summary.startupMs, 10);
  assert.equal(summary.promptMs, 70);
  assert.equal(summary.cleanupMs, 20);
  assert.equal(summary.tools.paired, 2);
  assert.equal(summary.tools.errors, 1);
  assert.equal(summary.coverage, "complete-tool-events");
  assert.deepEqual(
    entries.map((entry) => entry.durationMs),
    [30, 40],
  );
});

test("runtime timeout/cancel boundaries remain distinct from error text and incomplete tools", () => {
  const { ledger, at } = clockFixture();
  ledger.toolStart("timeout", "bash");
  at(10);
  ledger.toolBoundary("timeout", "timeout");
  ledger.toolEnd("timeout", "bash", true);
  ledger.toolStart("cancel", "bash");
  at(15);
  ledger.toolBoundary("cancel", "cancelled");
  ledger.retry("auto_retry_start");
  ledger.retry("auto_retry_end");
  at(20);
  ledger.eventsEnded();
  at(30);
  const diagnostic = ledger.snapshot("uncertain");
  assert.equal(diagnostic.summary.tools.timedOut, 1);
  assert.equal(diagnostic.summary.tools.cancelled, 1);
  assert.equal(diagnostic.summary.tools.unclosedStarts, 1);
  assert.equal(diagnostic.summary.toolWallMs, 20);
  assert.equal(diagnostic.summary.tools.paired, 1);
  assert.equal(diagnostic.entries[0]?.outcome, "timeout");
  assert.equal(diagnostic.summary.coverage, "partial-tool-events");
  assert.deepEqual(diagnostic.summary.retries, { started: 1, ended: 1 });
});

test("sequential stress preserves aggregate coverage when detailed entries drop", () => {
  const { ledger, at } = clockFixture();
  for (let index = 0; index < 10_000; index++) {
    at(index * 2);
    ledger.toolStart(`call-${index}`, "read");
    at(index * 2 + 1);
    ledger.toolEnd(`call-${index}`, "read", false);
  }
  ledger.eventsEnded();
  const diagnostic = ledger.snapshot("success");
  assert.equal(diagnostic.summary.tools.paired, 10_000);
  assert.equal(diagnostic.summary.toolDurationMs, 10_000);
  assert.equal(diagnostic.summary.toolWallMs, 10_000);
  assert.equal(
    diagnostic.summary.tools.entriesOmitted,
    10_000 - TIMING_ENTRY_LIMIT,
  );
  assert.equal(diagnostic.summary.coverage, "complete-tool-events");
  assert.equal(diagnostic.entries.length, TIMING_ENTRY_LIMIT);
  assert.ok(
    Buffer.byteLength(JSON.stringify(diagnostic)) < TIMING_ARTIFACT_MAX_BYTES,
  );
});

test("concurrency and identifier budgets expose unknown coverage without retaining payloads", () => {
  const { ledger, at } = clockFixture();
  for (let index = 0; index < TIMING_ACTIVE_LIMIT + 2; index++)
    ledger.toolStart(String(index), "x".repeat(1000));
  ledger.toolStart("x".repeat(1000), "read");
  at(10);
  for (let index = 0; index < TIMING_ACTIVE_LIMIT + 2; index++)
    ledger.toolEnd(String(index), "read", false);
  ledger.toolEnd("x".repeat(1000), "read", false);
  const diagnostic = ledger.snapshot("success");
  assert.equal(diagnostic.summary.tools.trackingDropped, 3);
  assert.equal(diagnostic.summary.tools.unmatchedEnds, 3);
  assert.equal(diagnostic.summary.coverage, "partial-tool-events");
  assert.equal(diagnostic.summary.toolWallMs, 10);
  assert.equal(diagnostic.summary.tools.paired, TIMING_ACTIVE_LIMIT);
  assert.ok(
    Buffer.byteLength(JSON.stringify(diagnostic)) < TIMING_ARTIFACT_MAX_BYTES,
  );
});

test("bounded artifacts retain timing when transcript truncates and replay never claims fresh execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "openpi-timing-"));
  try {
    let invocation = requestInvocation({ runId: "wf-timing", callIndex: 1 }, 1);
    invocation = transitionInvocation(invocation, { status: "claimed", at: 5 });
    invocation = transitionInvocation(invocation, { status: "running", at: 8 });
    invocation = transitionInvocation(invocation, {
      status: "settled",
      outcome: "success",
      at: 100,
    });
    const { ledger, at } = clockFixture();
    ledger.toolStart("tool-1", "read");
    at(50);
    ledger.toolEnd("tool-1", "read", false);
    ledger.eventsEnded();
    const diagnostic = ledger.snapshot("success");
    const details: WorkflowDetails = {
      runId: "wf-timing",
      background: false,
      status: "completed",
      startedAt: 1,
      finishedAt: 100,
      phases: [],
      agents: [
        {
          index: 1,
          invocation,
          label: "fixture",
          state: "done",
          startedAt: 8,
          preview: "",
          usage: emptyUsage(),
          timing: diagnostic.summary,
          transcript: Array.from({ length: 100 }, () => ({
            role: "toolResult" as const,
            text: "private output".repeat(1000),
          })),
        },
      ],
    };
    const agent = details.agents[0]!;
    agent.timingArtifact = persistWorkflowAgentTiming(
      directory,
      agent,
      diagnostic.entries,
    );
    persistWorkflowJson(directory, details);
    const restored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as WorkflowDetails;
    assert.equal(restored.agents[0]?.timing?.toolDurationMs, 50);
    const artifact = readFileSync(
      join(directory, agent.timingArtifact),
      "utf8",
    );
    assert.ok(!artifact.includes("private output"));
    assert.equal(JSON.parse(artifact).invocation.admissionMs, 4);
    assert.equal(JSON.parse(artifact).invocation.childLifecycleMs, 92);
    assert.match(
      readFileSync(join(directory, "transcripts.json"), "utf8"),
      /older entries omitted/,
    );
    agent.invocation = transitionInvocation(
      requestInvocation({ runId: "wf-timing", callIndex: 1 }, 200),
      { status: "replayed", at: 201 },
    );
    delete agent.timing;
    persistWorkflowAgentTiming(directory, agent);
    const replay = JSON.parse(
      readFileSync(join(directory, agent.timingArtifact), "utf8"),
    );
    assert.equal(replay.invocation.provenance, "replay");
    assert.equal(replay.summary, undefined);
    assert.deepEqual(replay.entries, []);
    assert.equal(
      invocationTiming(agent.invocation).childLifecycleMs,
      undefined,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reload timing decoder rejects invalid budgets and strips unknown payloads", () => {
  const { ledger } = clockFixture();
  const summary = ledger.snapshot("success").summary;
  assert.deepEqual(
    decodeExecutionTimingSummary({
      ...summary,
      privateOutput: "secret",
      tools: { ...summary.tools, arguments: "secret" },
    }),
    summary,
  );
  assert.equal(
    decodeExecutionTimingSummary({ ...summary, toolWallMs: Infinity }),
    undefined,
  );
  assert.equal(
    decodeExecutionTimingSummary({
      ...summary,
      tools: { ...summary.tools, unclosedStarts: TIMING_ACTIVE_LIMIT + 1 },
    }),
    undefined,
  );
  assert.equal(
    decodeExecutionTimingSummary({ ...summary, provenance: "replay" }),
    undefined,
  );
});

test("escaped identifiers cannot exceed the retained detail byte budget", () => {
  const { ledger, at } = clockFixture();
  for (let index = 0; index < 100; index++) {
    const id = `${index}${"\u0001".repeat(200)}`;
    ledger.toolStart(id, "\u0002".repeat(128));
    at(index + 1);
    ledger.toolEnd(id, "read", false);
  }
  const diagnostic = ledger.snapshot("success");
  assert.ok(diagnostic.entries.length < TIMING_ENTRY_LIMIT);
  assert.ok(
    Buffer.byteLength(JSON.stringify(diagnostic)) < TIMING_ARTIFACT_MAX_BYTES,
  );
  assert.equal(diagnostic.summary.tools.paired, 100);
  assert.equal(diagnostic.summary.coverage, "complete-tool-events");
  assert.equal(
    diagnostic.summary.tools.entriesOmitted,
    100 - diagnostic.entries.length,
  );
});

test("no installed event observer is unobserved, not complete zero timing", () => {
  const { ledger } = clockFixture();
  ledger.eventsEnded();
  assert.equal(ledger.snapshot("failure").summary.coverage, "unobserved");
});

test("malformed persisted JSON timing fields reject without enum or numeric coercion", () => {
  const { ledger } = clockFixture();
  const summary = ledger.snapshot("success").summary;
  for (const malformed of [
    { outcome: ["success"] },
    { coverage: ["unobserved"] },
    { outcome: { toString: null } },
    { coverage: { toString: null } },
    { outcome: null },
    { coverage: false },
    { elapsedMs: { toString: null } },
    { elapsedMs: [0] },
    { tools: [] },
    { tools: { ...summary.tools, started: { toString: null } } },
    { retries: [] },
    { retries: { started: [0], ended: 0 } },
  ]) {
    const raw: unknown = JSON.parse(
      JSON.stringify({ ...summary, ...malformed }),
    );
    assert.doesNotThrow(() => {
      assert.equal(decodeExecutionTimingSummary(raw), undefined);
    });
  }
});
