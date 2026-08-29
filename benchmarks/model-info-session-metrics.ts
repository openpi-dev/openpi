import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { createSessionMetricsTracker } from "../extensions/model-info/session-metrics.ts";

type BenchmarkResult = {
  implementation: "full-scan" | "prefix-tracker";
  entries: number;
  toolLoops: number;
  refreshes: number;
  visits: number;
  coldStartVisits: number;
  totalMs: number;
  meanRefreshMs: number;
  p95RefreshMs: number;
};

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parsePositiveIntegers(raw: string | undefined, fallback: number[]) {
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (parsed.length === 0) {
    throw new Error(`Invalid positive integer list: ${raw}`);
  }
  return parsed;
}

function usage(index: number): Usage {
  return {
    input: 100 + index,
    output: 20,
    cacheRead: 50 + index,
    cacheWrite: 10,
    totalTokens: 180 + index * 2,
    cost: {
      input: 0.001,
      output: 0.001,
      cacheRead: 0.0001,
      cacheWrite: 0.0001,
      total: 0.0022,
    },
  };
}

function userMessage(index: number): UserMessage {
  return {
    role: "user",
    content: `Initial benchmark entry ${index}`,
    timestamp: index,
  };
}

function assistantMessage(index: number, toolCall: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: toolCall
      ? [
          {
            type: "toolCall",
            id: `benchmark-call-${index}`,
            name: "benchmark",
            arguments: {},
          },
        ]
      : [{ type: "text", text: `Initial benchmark response ${index}` }],
    api: "openai-responses",
    provider: "openai",
    model: "benchmark",
    usage: usage(index),
    stopReason: toolCall ? "toolUse" : "stop",
    timestamp: index,
  };
}

function toolResultMessage(index: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: `benchmark-call-${index}`,
    toolName: "benchmark",
    content: [{ type: "text", text: "benchmark result" }],
    isError: false,
    timestamp: index,
  };
}

function appendInitialEntries(manager: SessionManager, entries: number) {
  for (let index = 0; index < entries; index++) {
    manager.appendMessage(
      index % 2 === 0 ? userMessage(index) : assistantMessage(index, false),
    );
  }
}

function appendToolLoop(manager: SessionManager, index: number) {
  manager.appendMessage(assistantMessage(index, true));
  manager.appendMessage(toolResultMessage(index));
}

function entryUsage(entry: ReturnType<SessionManager["getBranch"]>[number]) {
  if (entry.type === "message") {
    return entry.message.role === "assistant" ||
      entry.message.role === "toolResult"
      ? entry.message.usage
      : undefined;
  }
  return entry.type === "compaction" || entry.type === "branch_summary"
    ? entry.usage
    : undefined;
}

function fullActiveBranchMetrics(
  entries: ReturnType<SessionManager["getBranch"]>,
) {
  let cost = 0;
  let cacheRead = 0;
  let promptTokens = 0;
  for (const entry of entries) {
    const currentUsage = entryUsage(entry);
    if (!currentUsage) continue;
    cost += currentUsage.cost.total;
    cacheRead += currentUsage.cacheRead;
    promptTokens +=
      currentUsage.input + currentUsage.cacheRead + currentUsage.cacheWrite;
  }
  return {
    cost,
    cachePercent: promptTokens > 0 ? (cacheRead / promptTokens) * 100 : null,
  };
}

function measure<T>(samples: number[], operation: () => T) {
  const started = performance.now();
  const result = operation();
  samples.push(performance.now() - started);
  return result;
}

function p95(samples: number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function summarize(
  implementation: BenchmarkResult["implementation"],
  entries: number,
  toolLoops: number,
  visits: number,
  coldStartVisits: number,
  samples: number[],
): BenchmarkResult {
  const totalMs = samples.reduce((total, sample) => total + sample, 0);
  return {
    implementation,
    entries,
    toolLoops,
    refreshes: samples.length,
    visits,
    coldStartVisits,
    totalMs: Number(totalMs.toFixed(3)),
    meanRefreshMs: Number((totalMs / samples.length).toFixed(3)),
    p95RefreshMs: Number(p95(samples).toFixed(3)),
  };
}

function runScenario(entries: number, toolLoops: number) {
  const fullScanManager = SessionManager.inMemory(
    "/tmp/openpi-model-info-full-scan-benchmark",
  );
  const trackerManager = SessionManager.inMemory(
    "/tmp/openpi-model-info-prefix-tracker-benchmark",
  );
  appendInitialEntries(fullScanManager, entries);
  appendInitialEntries(trackerManager, entries);

  const fullScanSamples: number[] = [];
  let fullScanVisits = 0;
  const fullScan = () =>
    measure(fullScanSamples, () => {
      const branch = fullScanManager.getBranch();
      fullScanVisits += branch.length;
      return fullActiveBranchMetrics(branch);
    });

  let trackerVisits = 0;
  const trackerManagerView = {
    getSessionId: () => trackerManager.getSessionId(),
    getLeafId: () => trackerManager.getLeafId(),
    getEntry: (id: string) => {
      trackerVisits += 1;
      return trackerManager.getEntry(id);
    },
  };
  const tracker = createSessionMetricsTracker();
  const trackerSamples: number[] = [];
  const syncTracker = () =>
    measure(trackerSamples, () => tracker.sync(trackerManagerView));

  let trackerMetrics = syncTracker();
  const trackerColdStartVisits = trackerVisits;
  const fullScanMetrics = fullScan();
  const fullScanColdStartVisits = fullScanVisits;
  assert.deepEqual(trackerMetrics, fullScanMetrics);

  for (let index = 0; index < toolLoops; index++) {
    // message_end refreshes before Pi persists the assistant response.
    fullScan();
    appendToolLoop(fullScanManager, index);
    appendToolLoop(trackerManager, index);
    // turn_end follows persistence for every assistant/tool-result loop.
    trackerMetrics = syncTracker();
    assert.deepEqual(fullScan(), trackerMetrics);
  }

  // agent_settled only performs an ordinary refresh, so the tracker is not
  // synchronized again; its cached totals remain the current session state.
  assert.deepEqual(fullScan(), trackerMetrics);

  return [
    summarize(
      "full-scan",
      entries,
      toolLoops,
      fullScanVisits,
      fullScanColdStartVisits,
      fullScanSamples,
    ),
    summarize(
      "prefix-tracker",
      entries,
      toolLoops,
      trackerVisits,
      trackerColdStartVisits,
      trackerSamples,
    ),
  ];
}

const entryCounts = parsePositiveIntegers(
  readOption("--entries"),
  [1_000, 10_000, 100_000],
);
const toolLoopCounts = parsePositiveIntegers(
  readOption("--tool-loops"),
  [1, 10, 100],
);

for (const entries of entryCounts) {
  for (const toolLoops of toolLoopCounts) {
    for (const result of runScenario(entries, toolLoops)) {
      console.log(JSON.stringify(result));
    }
  }
}
