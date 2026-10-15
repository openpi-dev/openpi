/** Bounded synthetic seam measurement; no provider, Session or installed runtime. */
import { performance } from "node:perf_hooks";
import { ExecutionTimingLedger } from "../extensions/workflows/execution-timing.ts";
import {
  recordToolExecutionTiming,
  type ToolExecutionTiming,
} from "../extensions/workflows/runner.ts";

const calls = 20_000;
function sample(diagnostics: boolean) {
  const timings = new Map<string, ToolExecutionTiming>();
  const ledger = diagnostics ? new ExecutionTimingLedger() : undefined;
  const begin = performance.now();
  for (let index = 0; index < calls; index++) {
    const toolCallId = `fixture-${index}`;
    const start = {
      type: "tool_execution_start" as const,
      toolCallId,
      toolName: "read",
      args: {},
    };
    recordToolExecutionTiming(timings, start);
    ledger?.toolStart(toolCallId, "read");
    const end = {
      type: "tool_execution_end" as const,
      toolCallId,
      toolName: "read",
      result: { content: [], details: {} },
      isError: false,
    };
    recordToolExecutionTiming(timings, end);
    ledger?.toolEnd(toolCallId, "read", false);
  }
  ledger?.eventsEnded();
  const durationMs = performance.now() - begin;
  const snapshot = ledger?.snapshot("success");
  return { durationMs, retainedTimings: timings.size, snapshot };
}
sample(false);
sample(true);
const baseline: number[] = [];
const diagnostics: number[] = [];
for (let round = 0; round < 9; round++) {
  baseline.push(sample(false).durationMs);
  diagnostics.push(sample(true).durationMs);
}
const median = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
const baselineMs = median(baseline);
const diagnosticMs = median(diagnostics);
const capture = sample(true);
console.log(
  JSON.stringify(
    {
      protocol: "workflow-tool-event-seam-v1",
      calls,
      events: calls * 2,
      rounds: 9,
      runtime: process.version,
      platform: `${process.platform}/${process.arch}`,
      baselineMs,
      diagnosticMs,
      overheadMs: diagnosticMs - baselineMs,
      overheadMicrosecondsPerEvent:
        ((diagnosticMs - baselineMs) * 1000) / (calls * 2),
      retainedTimings: capture.retainedTimings,
      diagnosticBytes: Buffer.byteLength(JSON.stringify(capture.snapshot)),
      retainedEntries: capture.snapshot?.entries.length,
      paired: capture.snapshot?.summary.tools.paired,
      omittedEntries: capture.snapshot?.summary.tools.entriesOmitted,
    },
    null,
    2,
  ),
);
