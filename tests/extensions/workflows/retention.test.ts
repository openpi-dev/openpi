import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  persistWorkflowDeliveryState,
  persistWorkflowJson,
} from "../../../extensions/workflows/artifacts.ts";
import {
  WorkflowSettledRunRetention,
  measureWorkflowDetailsBytes,
  projectWorkflowDetails,
} from "../../../extensions/workflows/retention.ts";
import {
  emptyUsage,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";

function details(runId: string, label = "worker"): WorkflowDetails {
  return {
    runId,
    sessionId: "retention-test",
    background: true,
    status: "completed",
    startedAt: 1,
    finishedAt: 2,
    phases: [],
    agents: [
      {
        index: 1,
        label,
        state: "done",
        startedAt: 1,
        finishedAt: 2,
        preview: "completed",
        usage: emptyUsage(),
        transcript: [{ role: "assistant", text: "完整结果" }],
      },
    ],
  };
}

test("retention evicts by count and exposes compatible statistics", () => {
  const retention = new WorkflowSettledRunRetention({ maxRuns: 2 });
  retention.set(details("wf_1"));
  retention.set(details("wf_2"));
  retention.set(details("wf_3"));

  assert.equal(retention.size, 2);
  assert.equal(retention.get("wf_1"), undefined);
  assert.equal(retention.evictedRuns, 1);
  assert.equal(retention.settledRunsEvicted, 1);
  assert.equal(retention.stats.settledRunsEvicted, retention.stats.evictedRuns);
});

test("retention evicts by aggregate UTF-8 bytes and never exceeds the cap", () => {
  const first = projectWorkflowDetails(details("wf_字", "甲"), 100_000)!;
  const retention = new WorkflowSettledRunRetention({
    maxRuns: 10,
    maxBytes: measureWorkflowDetailsBytes(first),
  });
  retention.set(details("wf_字", "甲"));
  retention.set(details("wf_二", "乙"));

  assert.ok(retention.retainedBytes <= retention.maxBytes);
  assert.ok(retention.evictedRuns >= 1);
  assert.ok(retention.evictedBytes > 0);
  assert.ok(
    retention.get("wf_字") === undefined ||
      retention.get("wf_二") === undefined,
  );
});

test("projection byte accounting is UTF-8 safe and preserves exact references", () => {
  const source = details("wf_引用", "中文代理");
  source.resultArtifact = "result-这是一个不能被截断的精确引用.json";
  source.transcriptArtifact = "transcripts-这是一个不能被截断的精确引用.json";
  source.agents[0]!.resultRef = "result-ref-这是一个精确引用";
  const projection = projectWorkflowDetails(source, 100_000);

  assert.ok(projection);
  assert.equal(projection?.resultArtifact, source.resultArtifact);
  assert.equal(projection?.transcriptArtifact, source.transcriptArtifact);
  assert.equal(projection?.agents[0]?.resultRef, source.agents[0]?.resultRef);
  assert.equal(
    Buffer.byteLength(JSON.stringify(projection), "utf8"),
    projection?.memoryProjection?.bytes,
  );
});

test("projection byte accounting accepts bigint and cyclic workflow values", () => {
  const source = details("wf_non_json_values");
  const cyclic: Record<string, unknown> = { count: 1n };
  cyclic.self = cyclic;
  source.result = cyclic;

  const projection = projectWorkflowDetails(source, 100_000);

  assert.ok(projection);
  assert.equal(projection?.result, "[result omitted from memory]");
  assert.doesNotThrow(() => measureWorkflowDetailsBytes(source));
  assert.doesNotThrow(() => new WorkflowSettledRunRetention().set(source));
});

test("replacement does not count a failed projection as a new eviction", () => {
  const initial = details("wf_replace");
  const initialProjection = projectWorkflowDetails(initial, 100_000)!;
  const retention = new WorkflowSettledRunRetention({
    maxRuns: 1,
    maxBytes: measureWorkflowDetailsBytes(initialProjection),
  });
  retention.set(initial);
  const before = retention.stats;
  const original = retention.get("wf_replace");
  assert.ok(original);

  const updated = {
    ...initial,
    transcriptArtifact: "x".repeat(retention.maxBytes),
  };
  assert.equal(retention.set(updated), undefined);
  assert.equal(retention.get("wf_replace"), original);
  assert.deepEqual(retention.stats, before);
});

test("zero limits are valid and invalid limits fail fast", () => {
  assert.equal(new WorkflowSettledRunRetention({ maxRuns: 0 }).maxRuns, 0);
  const zeroBytes = new WorkflowSettledRunRetention({ maxBytes: 0 });
  assert.equal(zeroBytes.maxBytes, 0);
  assert.equal(zeroBytes.set(details("wf_zero")), undefined);
  assert.equal(zeroBytes.evictedRuns, 1);
  for (const options of [
    { maxRuns: -1 },
    { maxRuns: 1.5 },
    { maxRuns: Number.NaN },
    { maxBytes: Number.POSITIVE_INFINITY },
    { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    assert.throws(
      () => new WorkflowSettledRunRetention(options),
      /non-negative safe integer/,
    );
  }
});

test("reset separates retained memory from current-session statistics", () => {
  const retention = new WorkflowSettledRunRetention({ maxRuns: 1 });
  retention.set(details("wf_1"));
  retention.set(details("wf_2"));
  assert.equal(retention.evictedRuns, 1);

  retention.reset();
  assert.equal(retention.size, 0);
  assert.equal(retention.evictedRuns, 1);
  retention.resetStats();
  assert.equal(retention.evictedRuns, 0);
  assert.equal(retention.evictedBytes, 0);
});

test("projection and delivery metadata cannot overwrite canonical artifacts", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "pi-workflow-retention-artifacts-"),
  );
  try {
    const source = details("wf_canonical");
    source.result = { answer: "完整中文结果", nested: { value: 42 } };
    persistWorkflowJson(directory, source);
    const before = readFileSync(join(directory, "workflow.json"), "utf8");
    const projection = projectWorkflowDetails(source, 512)!;
    assert.notEqual(projection, source);
    persistWorkflowDeliveryState(directory, {
      id: "workflow:wf_canonical:terminal",
      state: "delivered",
      attempts: 1,
      updatedAt: 3,
      deliveredAt: 3,
    });
    const stored = JSON.parse(
      readFileSync(join(directory, "workflow.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(stored.result, "[stored in result.json]");
    assert.equal(stored.resultArtifact, "result.json");
    assert.deepEqual(stored.delivery, {
      id: "workflow:wf_canonical:terminal",
      state: "delivered",
      attempts: 1,
      updatedAt: 3,
      deliveredAt: 3,
    });
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "result.json"), "utf8")),
      source.result,
    );
    assert.notEqual(
      readFileSync(join(directory, "workflow.json"), "utf8"),
      before,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
