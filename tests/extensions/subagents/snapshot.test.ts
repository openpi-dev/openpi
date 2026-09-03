import assert from "node:assert/strict";
import test from "node:test";
import type {
  ResultArtifactRef,
  SubagentSnapshot,
} from "../../../extensions/subagents/src/domain.ts";
import {
  measureSubagentSnapshotBytes,
  measureSubagentSnapshotsBytes,
  projectSubagentSnapshot,
  projectSubagentSnapshots,
  projectSubagentSnapshotsFromPrevious,
  truncateUtf8Head,
  truncateUtf8Tail,
} from "../../../extensions/subagents/src/snapshot.ts";

function snapshot(id: string, overrides: Partial<SubagentSnapshot> = {}) {
  return {
    id,
    origin: "model" as const,
    backend: "pi" as const,
    title: `Agent ${id}`,
    prompt: "Inspect the repository and report the result.",
    cwd: "C:/work/openpi",
    status: "done" as const,
    createdAt: 1,
    settledAt: 2,
    meta: { backend: "pi" as const, modelLabel: "test/model" },
    usage: { tokens: 10, contextWindow: 1000 },
    transcriptVersion: 0,
    transcript: [
      { kind: "user" as const, text: "Inspect this" },
      {
        kind: "assistant" as const,
        parts: [{ type: "text" as const, text: "The result is ready." }],
      },
    ],
    liveTools: [],
    queued: [],
    finalText: "BEGIN\nThe exact final result is here.\nEND",
    turns: 1,
    ...overrides,
  } satisfies SubagentSnapshot;
}

test("UTF-8 head and tail truncation never split a multibyte character", () => {
  const emoji = "😀";
  assert.deepEqual(
    [1, 2, 3, 4].map((n) => truncateUtf8Head(emoji, n)),
    ["", "", "", emoji],
  );
  for (let n = 0; n <= 6; n++) {
    assert.equal(truncateUtf8Head(`a${emoji}b`, n).includes("�"), false);
    assert.equal(truncateUtf8Tail(`a${emoji}b`, n).includes("�"), false);
  }
  assert.equal(
    truncateUtf8Head(`${"a".repeat(4093)}${emoji}`, 4096),
    "a".repeat(4093),
  );
  const value = "开头" + "中".repeat(20) + "结尾";
  for (const limit of [1, 2, 3, 4, 7, 11, 23]) {
    const head = truncateUtf8Head(value, limit);
    const tail = truncateUtf8Tail(value, limit);
    assert.ok(Buffer.byteLength(head, "utf8") <= limit);
    assert.ok(Buffer.byteLength(tail, "utf8") <= limit);
    assert.doesNotMatch(`${head}${tail}`, /�/);
  }
  assert.equal(truncateUtf8Tail(value, 6), "结尾");
});

test("a giant agent is bounded in serialized UTF-8 bytes and marked", () => {
  const source = snapshot("giant", {
    finalText: `开头\n${"中间证据\n".repeat(20_000)}最终结论`,
    transcript: Array.from({ length: 100 }, (_, index) => ({
      kind: "user" as const,
      text: `消息 ${index}`,
    })),
  });
  const projected = projectSubagentSnapshot(source, 4096);
  assert.ok(projected);
  assert.ok(measureSubagentSnapshotBytes(projected) <= 4096);
  assert.equal(projected.id, "giant");
  assert.equal(projected.status, "done");
  assert.equal(projected.snapshot?.truncated, true);
  assert.ok((projected.snapshot?.omittedBytes ?? 0) > 0);
  assert.match(projected.finalText, /^开头/);
  assert.match(projected.finalText, /最终结论$/);
});

test("aggregate projection gives every agent identity under one UTF-8 cap", () => {
  const source = [
    snapshot("giant", { finalText: "中".repeat(100_000) }),
    ...["medium-1", "medium-2", "medium-3"].map((id) =>
      snapshot(id, { finalText: "证据".repeat(10_000) }),
    ),
  ];
  const projected = projectSubagentSnapshots(source, 12_000);
  assert.ok(projected);
  assert.ok(measureSubagentSnapshotsBytes(projected) <= 12_000);
  assert.deepEqual(
    projected.map((entry) => [entry.id, entry.status]),
    source.map((entry) => [entry.id, entry.status]),
  );
  assert.ok(projected.every((entry) => entry.snapshot?.truncated));
});

test("projection is detached and leaves its source transcript intact", () => {
  const source = snapshot("source", {
    transcript: Array.from({ length: 80 }, (_, index) => ({
      kind: "user" as const,
      text: `message ${index}`,
    })),
    finalText: `BEGIN\n${"evidence\n".repeat(10_000)}END`,
  });
  const originalTranscript = source.transcript;
  const projected = projectSubagentSnapshot(source, 4096);

  assert.ok(projected);
  assert.equal(source.transcript, originalTranscript);
  assert.equal(source.transcript.length, 80);
  assert.notEqual(projected.transcript, source.transcript);
  assert.notEqual(projected.finalText, source.finalText);
});

test("reprojecting does not inflate omission statistics", () => {
  const source = snapshot("repeat", {
    finalText: "首" + "中".repeat(20_000) + "尾",
  });
  const first = projectSubagentSnapshot(source, 4096);
  assert.ok(first);
  const second = projectSubagentSnapshot(first, 4096);
  assert.ok(second);
  assert.deepEqual(second.snapshot?.omitted, first.snapshot?.omitted);
  assert.equal(second.snapshot?.omittedBytes, first.snapshot?.omittedBytes);
  assert.equal(
    measureSubagentSnapshotBytes(second),
    measureSubagentSnapshotBytes(first),
  );
});

test("artifact references remain exact while display text is projected", () => {
  const artifactRef: ResultArtifactRef = {
    version: 1,
    digest: "a".repeat(64),
  };
  const projected = projectSubagentSnapshot(
    snapshot("artifact", {
      resultArtifact: artifactRef,
      finalText: "中".repeat(20_000),
    }),
    4096,
  );
  assert.ok(projected);
  assert.deepEqual(projected.resultArtifact, artifactRef);
  assert.equal(projected.snapshot?.truncated, true);
});

test("projection rebuild failures keep bounded stale display data and current terminal facts", () => {
  const previous = projectSubagentSnapshot(
    snapshot("stale", {
      status: "running",
      outcome: undefined,
      transcript: [{ kind: "user", text: "old activity" }],
      finalText: "old display result",
      transcriptVersion: 1,
    }),
    4096,
  );
  assert.ok(previous);
  const current = snapshot("stale", {
    status: "error",
    outcome: "failed",
    errorText: "new terminal error",
    transcript: [
      { kind: "user", text: "old activity" },
      { kind: "user", text: "new activity" },
    ],
    finalText: "new terminal result",
    transcriptVersion: 2,
  });
  const fallback = projectSubagentSnapshotsFromPrevious(
    [current],
    [previous],
    4096,
    "projection rebuild failed",
  );
  assert.ok(fallback);
  assert.equal(fallback[0]?.status, "error");
  assert.equal(fallback[0]?.outcome, "failed");
  assert.equal(fallback[0]?.errorText, "new terminal error");
  assert.equal(fallback[0]?.transcriptVersion, 2);
  assert.equal(fallback[0]?.snapshot?.projectionStale, true);
  assert.equal(
    fallback[0]?.snapshot?.projectionError,
    "projection rebuild failed",
  );
  assert.ok(measureSubagentSnapshotsBytes(fallback) <= 4096);
});

test("projection fails when the minimum identity cannot fit", () => {
  const source = snapshot("agent-with-an-identity-that-is-too-large", {
    title: "标题".repeat(100),
  });
  assert.equal(projectSubagentSnapshot(source, 32), undefined);
  assert.equal(projectSubagentSnapshots([source], 32), undefined);
});
