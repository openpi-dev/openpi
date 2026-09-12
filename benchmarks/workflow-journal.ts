import { performance } from "node:perf_hooks";
import {
  createJournalAccumulator,
  JOURNAL_MAX_BYTES,
} from "../extensions/workflows/journal.ts";

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv
    .find((argument) => argument.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parseCounts(raw: string | undefined) {
  const counts = (raw ?? "128,512,1024")
    .split(",")
    .map((value) => Number.parseInt(value, 10));
  if (counts.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error("--counts must contain positive integers");
  }
  return counts;
}

function parsePositiveInteger(raw: string | undefined, fallback: number) {
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("--entry-bytes must be a positive integer");
  }
  return value;
}

function heapUsed() {
  return process.memoryUsage().heapUsed;
}

function cpuMicros(previous: NodeJS.CpuUsage) {
  const usage = process.cpuUsage(previous);
  return usage.user + usage.system;
}

const entryBytes = parsePositiveInteger(readOption("--entry-bytes"), 64 * 1024);

for (const count of parseCounts(readOption("--counts"))) {
  globalThis.gc?.();
  const beforeHeap = heapUsed();
  const beforeCpu = process.cpuUsage();
  const accumulator = createJournalAccumulator();
  const output = "x".repeat(entryBytes);
  const appendStarted = performance.now();
  for (let index = 0; index < count; index++) {
    accumulator.append({
      key: `benchmark-${index}`,
      output,
      ...(index % 4 === 0 ? { structured: { index, status: "accepted" } } : {}),
    });
  }
  const appendMs = performance.now() - appendStarted;
  const appendCpuMicros = cpuMicros(beforeCpu);
  const afterAppendHeap = heapUsed();

  const flushStarted = performance.now();
  const flushCpuStart = process.cpuUsage();
  const json = accumulator.toJson();
  const flushMs = performance.now() - flushStarted;
  const flushCpuMicros = cpuMicros(flushCpuStart);
  const afterFlushHeap = heapUsed();

  console.log(
    JSON.stringify({
      count,
      entryBytes,
      maxBytes: JOURNAL_MAX_BYTES,
      retained: accumulator.length,
      dropped: accumulator.dropped,
      bytes: accumulator.bytes,
      serializedBytes: Buffer.byteLength(json, "utf8"),
      appendMs: Number(appendMs.toFixed(3)),
      appendCpuMicros,
      flushMs: Number(flushMs.toFixed(3)),
      flushCpuMicros,
      appendHeapDelta: afterAppendHeap - beforeHeap,
      flushHeapDelta: afterFlushHeap - afterAppendHeap,
      gcAvailable: typeof globalThis.gc === "function",
    }),
  );
}
