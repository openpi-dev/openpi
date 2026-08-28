import { link, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import {
  createSessionPreviewCache,
  measureSessionPreviewBytes,
  previewCacheKey,
} from "../extensions/sessions/preview-cache.ts";
import { loadSessionPreviewData } from "../extensions/sessions/preview-loader.ts";
import {
  buildSessionPreview,
  type PreviewMessageLike,
  type SessionInfoLike,
} from "../extensions/sessions/sessions.ts";

const MIB = 1024 * 1024;
const HEARTBEAT_MS = 5;

function readOption(name: string) {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return process.argv
    .find((arg) => arg.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function parsePositiveIntegers(raw: string | undefined, fallback: number[]) {
  if (!raw) return fallback;
  const parsed = raw
    .split(",")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  if (parsed.length === 0)
    throw new Error(`Invalid positive integer list: ${raw}`);
  return parsed;
}

const sizesMiB = parsePositiveIntegers(readOption("--sizes"), [10, 100, 500]);
const cacheCount = parsePositiveIntegers(readOption("--cache-count"), [20])[0]!;

async function createFixture(directory: string, sizeMiB: number) {
  const path = join(directory, `session-${sizeMiB}mib.jsonl`);
  const handle = await open(path, "w");
  const targetBytes = sizeMiB * MIB;
  const payload = "x".repeat(4096);
  let written = 0;
  let parentId: string | null = null;
  let index = 0;

  try {
    const header = `${JSON.stringify({
      type: "session",
      version: 3,
      id: `benchmark-${sizeMiB}`,
      timestamp: new Date(0).toISOString(),
      cwd: directory,
    })}\n`;
    await handle.write(header);
    written += Buffer.byteLength(header);

    let batch = "";
    while (written + Buffer.byteLength(batch) < targetBytes) {
      const id = `m${index}`;
      batch += `${JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date(index + 1).toISOString(),
        message: {
          role: index % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: payload }],
          timestamp: index + 1,
          ...(index % 2 === 0
            ? {}
            : { provider: "benchmark", model: "benchmark", usage: {} }),
        },
      })}\n`;
      parentId = id;
      index++;
      if (Buffer.byteLength(batch) >= MIB) {
        await handle.write(batch);
        written += Buffer.byteLength(batch);
        batch = "";
      }
    }
    if (batch) {
      await handle.write(batch);
      written += Buffer.byteLength(batch);
    }
  } finally {
    await handle.close();
  }
  return { path, bytes: written, messages: index };
}

function sessionInfo(path: string, messages: number): SessionInfoLike {
  return {
    id: path,
    cwd: "/tmp/openpi-preview-benchmark",
    modified: new Date(0),
    firstMessage: "benchmark",
    path,
    messageCount: messages,
  };
}

async function measureLoad(path: string) {
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  let peakHeap = baseline.heapUsed;
  let peakRss = baseline.rss;
  let maxStallMs = 0;
  let expectedHeartbeat = performance.now() + HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxStallMs = Math.max(maxStallMs, now - expectedHeartbeat);
    expectedHeartbeat = now + HEARTBEAT_MS;
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakRss = Math.max(peakRss, memory.rss);
  }, HEARTBEAT_MS);

  const started = performance.now();
  try {
    const data = await loadSessionPreviewData(path);
    await yieldImmediate();
    globalThis.gc?.();
    const settled = process.memoryUsage();
    return {
      wallMs: performance.now() - started,
      maxStallMs,
      heapPeakDeltaMiB: (peakHeap - baseline.heapUsed) / MIB,
      heapAfterGcDeltaMiB: (settled.heapUsed - baseline.heapUsed) / MIB,
      rssPeakDeltaMiB: (peakRss - baseline.rss) / MIB,
      bytesRead: data.bytesRead,
      retainedBytes: data.retainedBytes,
      messages: data.messages.length,
      totalMessages: data.totalMessages,
      data,
    };
  } finally {
    clearInterval(heartbeat);
  }
}

const directory = await mkdtemp(
  join(tmpdir(), "openpi-session-preview-benchmark-"),
);
try {
  const fixtures = [];
  for (const sizeMiB of sizesMiB) {
    const fixture = await createFixture(directory, sizeMiB);
    fixtures.push(fixture);
    const result = await measureLoad(fixture.path);
    console.log(
      JSON.stringify({
        phase: "cold",
        sizeMiB,
        fileBytes: fixture.bytes,
        wallMs: Number(result.wallMs.toFixed(1)),
        maxStallMs: Number(result.maxStallMs.toFixed(1)),
        heapPeakDeltaMiB: Number(result.heapPeakDeltaMiB.toFixed(1)),
        heapAfterGcDeltaMiB: Number(result.heapAfterGcDeltaMiB.toFixed(1)),
        rssPeakDeltaMiB: Number(result.rssPeakDeltaMiB.toFixed(1)),
        bytesRead: result.bytesRead,
        retainedBytes: result.retainedBytes,
        messages: result.messages,
        totalMessages: result.totalMessages,
      }),
    );
  }

  const cacheFixture =
    fixtures.find((fixture) => fixture.bytes >= 100 * MIB) ?? fixtures.at(-1)!;
  const cache = createSessionPreviewCache();
  for (let index = 0; index < cacheCount; index++) {
    const path = join(directory, `cache-${index}.jsonl`);
    await link(cacheFixture.path, path);
    const data = await loadSessionPreviewData(path);
    const preview = buildSessionPreview(
      sessionInfo(path, data.totalMessages),
      data.messages as PreviewMessageLike[],
      {
        totalMessages: data.totalMessages,
        truncatedBytes: data.truncatedBytes,
      },
    );
    cache.set(
      previewCacheKey(data.identity),
      preview,
      measureSessionPreviewBytes(preview),
    );
  }
  globalThis.gc?.();
  console.log(
    JSON.stringify({
      phase: "cache",
      visits: cacheCount,
      sourceFileBytes: cacheFixture.bytes,
      entries: cache.entries,
      bytes: cache.bytes,
      evictions: cache.evictions,
      heapUsedMiB: Number((process.memoryUsage().heapUsed / MIB).toFixed(1)),
      rssMiB: Number((process.memoryUsage().rss / MIB).toFixed(1)),
    }),
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
