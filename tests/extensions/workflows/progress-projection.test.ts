import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { AgentProgressProjection } from "../../../extensions/workflows/progress-projection.ts";

type AgentMessage = AgentSession["messages"][number];

const usage = (totalTokens: number) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
});

function assistant(text: string, totalTokens: number, timestamp = 1_000) {
  return {
    role: "assistant",
    content: [{ type: "text" as const, text }],
    api: "openai-responses",
    provider: "fixture",
    model: "fixture",
    usage: usage(totalTokens),
    stopReason: "stop" as const,
    timestamp,
  } satisfies AgentMessage;
}

test("incremental projection preserves occurrences and is compaction-aware", () => {
  const first = assistant("first", 100);
  const projection = new AgentProgressProjection([first], 100);
  const second = assistant("second", 200, 2_000);
  const result = {
    role: "toolResult" as const,
    toolCallId: "call-2",
    toolName: "read",
    content: [{ type: "text" as const, text: "result" }],
    isError: false,
    timestamp: 2_100,
  } satisfies AgentMessage;

  projection.append(second);
  projection.append(second);
  projection.append(result);
  const incremental = projection.snapshot();
  assert.equal(incremental.preview, "second");
  assert.equal(incremental.usage.turns, 3);
  assert.equal(
    incremental.transcript.filter((entry) => entry.text === "second").length,
    2,
  );
  assert.ok((incremental.usage.contextTokens ?? 0) > 200);

  const retained = assistant("retained", 50, 3_000);
  projection.replace([retained], null);
  const compacted = projection.snapshot();
  assert.equal(compacted.preview, "retained");
  assert.equal(compacted.usage.turns, 1);
  assert.equal(compacted.usage.contextTokens, undefined);
  assert.equal(
    compacted.transcript.some((entry) => entry.text === "first"),
    false,
  );

  const recovered = assistant("recovered", 80, 4_000);
  projection.append(recovered);
  assert.equal(projection.snapshot().usage.contextTokens, 80);
});

test("bounded transcript preserves the first and newest entries", () => {
  const messages: AgentMessage[] = Array.from({ length: 205 }, (_, index) => ({
    role: "user" as const,
    content: `message ${index}`,
    timestamp: index,
  }));
  const transcript = new AgentProgressProjection(messages).snapshot()
    .transcript;

  assert.equal(transcript.length, 201);
  assert.equal(transcript[0]?.text, "message 0");
  assert.equal(
    transcript.some((entry) => entry.text === "message 1"),
    false,
  );
  assert.equal(transcript.at(-2)?.text, "message 204");
  assert.match(transcript.at(-1)?.text ?? "", /retained 200 of 205 entries/);
});

test("tool timings remain keyed by call identity after incremental ingestion", () => {
  const call = {
    ...assistant("", 10),
    content: [
      {
        type: "toolCall" as const,
        id: "call-a",
        name: "read",
        arguments: { path: "fixture" },
      },
    ],
    stopReason: "toolUse" as const,
  } satisfies AgentMessage;
  const projection = new AgentProgressProjection();
  projection.append(call);

  const transcript = projection.snapshot(
    new Map([["call-a", { startedAt: 10, finishedAt: 25, durationMs: 15 }]]),
  ).transcript;

  assert.deepEqual(
    transcript.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
      toolCallId,
      startedAt,
      finishedAt,
      durationMs,
    })),
    [
      {
        toolCallId: "call-a",
        startedAt: 10,
        finishedAt: 25,
        durationMs: 15,
      },
    ],
  );
});

test("transcript byte limits preserve UTF-8 boundaries and explicit markers", () => {
  const oversized = new AgentProgressProjection([
    { role: "user", content: "界".repeat(10_000), timestamp: 1 },
  ]).snapshot().transcript;
  const [prefix = "", marker] = (oversized[0]?.text ?? "").split(
    "\n[transcript entry truncated]",
  );
  assert.equal(marker, "");
  assert.ok(Buffer.byteLength(prefix, "utf8") <= 16 * 1024);
  assert.equal(prefix.endsWith("界"), true);

  const manyLargeMessages: AgentMessage[] = Array.from(
    { length: 20 },
    (_, index) => ({
      role: "user" as const,
      content: String(index % 10).repeat(16 * 1024),
      timestamp: index,
    }),
  );
  const bounded = new AgentProgressProjection(manyLargeMessages).snapshot()
    .transcript;
  const retained = bounded.filter((entry) => entry.name !== "transcript");
  assert.equal(retained.length, 16);
  assert.ok(
    retained.reduce(
      (bytes, entry) => bytes + Buffer.byteLength(entry.text, "utf8"),
      0,
    ) <=
      256 * 1024,
  );
  assert.match(bounded.at(-1)?.text ?? "", /retained 16 of 20 entries/);
});
