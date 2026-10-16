import assert from "node:assert/strict";
import test from "node:test";
import { projectToolEvidence } from "../../web/protocol/evidence.ts";
import { WEB_SESSION_FORK_SNAPSHOT } from "../../web/protocol/session-fork.ts";
import { projectEntry, projectMessage } from "../../web/protocol/types.ts";

const source = {
  sessionId: "source",
  sessionPath: "/tmp/source.jsonl",
  entryId: "source-leaf",
};
const snapshot = {
  kind: "persisted-prefix",
  capturedAt: 1791849600000,
  interrupted: true,
};
const boundary = {
  id: "boundary",
  parentId: "source-leaf",
  timestamp: "2026-10-13T00:00:00.000Z",
  type: "custom_message" as const,
  customType: WEB_SESSION_FORK_SNAPSHOT,
  display: false,
  content: "Hidden context for the model, not a tool receipt.",
  details: { source, snapshot },
};

test("native fork boundary projects bounded display evidence without a fake outcome or model instruction", () => {
  const projected = projectEntry(boundary);
  assert.deepEqual(projected, {
    type: "custom_message",
    id: "boundary",
    parentId: "source-leaf",
    timestamp: boundary.timestamp,
    forkSnapshotBoundary: {
      sourceEntryId: "source-leaf",
      capturedAt: snapshot.capturedAt,
    },
  });
  assert.equal(projected.turnTiming, undefined);
  assert.equal(projected.message, undefined);
  assert.ok(!JSON.stringify(projected).includes(boundary.content));
});

test("boundary-like text, a visible custom message, and malformed native metadata do not seal a turn", () => {
  const projected = projectEntry({
    ...boundary,
    customType: "ordinary-message",
  });
  assert.equal(projected.forkSnapshotBoundary, undefined);
  assert.equal(
    projectEntry({ ...boundary, display: true }).forkSnapshotBoundary,
    undefined,
  );
  for (const details of [
    null,
    { source },
    { source: { ...source, entryId: "" }, snapshot },
    { source: { ...source, sessionPath: "relative.jsonl" }, snapshot },
    { source: { ...source, sessionId: "x".repeat(129) }, snapshot },
    { source, snapshot: { ...snapshot, interrupted: false } },
    { source, snapshot: { ...snapshot, kind: "live" } },
    { source, snapshot: { ...snapshot, capturedAt: -1 } },
    {
      source,
      snapshot: { ...snapshot, capturedAt: Number.MAX_SAFE_INTEGER + 1 },
    },
  ]) {
    assert.equal(
      projectEntry({ ...boundary, details }).forkSnapshotBoundary,
      undefined,
    );
  }
});

const marker = { version: 1, source, snapshot, toolCallId: "pending-tool" };
const synthetic = {
  role: "toolResult",
  toolCallId: "pending-tool",
  toolName: "bash",
  isError: true,
  content: [
    {
      type: "text",
      text: "Snapshot boundary: this tool had no persisted result.",
    },
  ],
  details: { openpiForkSnapshot: marker },
};

test("the exact synthetic tool marker preserves native isError but never invents terminal or test evidence", () => {
  for (const name of ["bash", "read", "write", "edit", "bg_status"]) {
    const result = projectMessage({
      ...synthetic,
      toolName: name,
      content: [
        {
          type: "text",
          text: "# tests 1\n# pass 0\n# fail 1\nCommand exited with code 7",
        },
      ],
      details: { ...synthetic.details, status: "failed", exitCode: 7 },
    });
    assert.equal(result.forkSnapshotToolResult, true);
    assert.equal(result.isError, true);
    assert.equal(result.terminalReceipt, undefined);
    const view = projectToolEvidence(
      {
        type: "toolCall",
        id: "pending-tool",
        name,
        arguments: "{}",
      },
      result,
      "running",
    );
    assert.equal(view.state, "unknown");
    assert.equal(view.processState, "unknown");
    assert.equal(view.tests, undefined);
    assert.equal(view.exitCode, undefined);
    assert.equal(view.signal, undefined);
    assert.equal(view.diff, undefined);
    assert.equal(view.numberLines, false);
    assert.equal(JSON.parse(view.rawResult).isError, true);
  }
});

test("a real failed tool containing identical text or an invalid marker remains failed", () => {
  for (const value of [
    { ...synthetic, details: undefined },
    { ...synthetic, role: "assistant" },
    { ...synthetic, toolCallId: "different-tool" },
    { ...synthetic, toolCallId: "" },
    ...[
      { ...marker, version: 2 },
      { ...marker, source: { ...source, sessionPath: "relative.jsonl" } },
      { ...marker, source: { ...source, entryId: "" } },
      { ...marker, snapshot: { ...snapshot, interrupted: false } },
      { ...marker, snapshot: { ...snapshot, capturedAt: Infinity } },
      { ...marker, snapshot: { ...snapshot, kind: "live" } },
    ].map((openpiForkSnapshot) => ({
      ...synthetic,
      details: { openpiForkSnapshot },
    })),
  ]) {
    const result = projectMessage(value);
    assert.equal(result.forkSnapshotToolResult, undefined);
    assert.equal(
      projectToolEvidence(
        { type: "toolCall", name: "bash", arguments: "{}" },
        result,
      ).state,
      "failed",
    );
  }
  const returned = projectMessage({ ...synthetic, isError: false });
  assert.equal(returned.forkSnapshotToolResult, undefined);
  assert.equal(
    projectToolEvidence(
      { type: "toolCall", name: "bash", arguments: "{}" },
      returned,
    ).state,
    "returned",
  );
});

test("validated snapshot identity survives details truncation and is never inferred from a projected-looking flag", () => {
  const bounded = projectMessage({
    ...synthetic,
    details: { oversized: "x".repeat(100_000), ...synthetic.details },
  });
  assert.ok(bounded.truncation?.details);
  assert.equal(bounded.forkSnapshotToolResult, true);
  const spoofed = projectMessage({
    ...synthetic,
    details: undefined,
    forkSnapshotToolResult: true,
  });
  assert.equal(spoofed.forkSnapshotToolResult, undefined);
});
