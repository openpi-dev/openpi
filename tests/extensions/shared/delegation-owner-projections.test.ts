import assert from "node:assert/strict";
import test from "node:test";
import { subagentCompletion } from "../../../extensions/subagents/src/completion.ts";
import { delegationCompletionText } from "../../../extensions/shared/delegation-completion.ts";
import type { SubagentSnapshot } from "../../../extensions/subagents/src/domain.ts";
import { workflowAgentCompletion } from "../../../extensions/workflows/agent-completion.ts";
import {
  compactWorkflowToolDetails,
  emptyUsage,
  type AgentRecord,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";
import {
  buildWorkflowResultMessage,
  buildWorkflowStatusSummary,
} from "../../../extensions/workflows/prompt.ts";
import { projectWorkflowDetails } from "../../../extensions/workflows/retention.ts";
import { normalizePersistedWorkflowDetails } from "../../../extensions/workflows/dashboard.ts";
import {
  createJournalAccumulator,
  createReplayCache,
  JOURNAL_VERSION,
  parseJournal,
} from "../../../extensions/workflows/journal.ts";

const direct: SubagentSnapshot = {
  id: "sa-1",
  origin: "model",
  backend: "pi",
  title: "test",
  prompt: "test",
  cwd: "/shared",
  status: "done",
  outcome: "completed",
  createdAt: 0,
  meta: { backend: "pi", sessionFilePath: "/evidence/child.jsonl" },
  usage: {},
  transcriptVersion: 3,
  runGeneration: 2,
  completionGeneration: 2,
  evidence: {
    generation: 2,
    sessionId: "12345678-1234-1234-1234-123456789abc",
    sessionPath: "/evidence/child.jsonl",
    startEntryId: "start",
    endEntryId: "end",
    finalEntryId: "end",
    sealed: true,
    parentBound: true,
    structured: { status: "not-run" },
  },
  runTranscriptStart: 2,
  transcript: [
    { kind: "toolResult", toolId: "old", name: "bash", isError: false },
    { kind: "user", text: "follow-up" },
    { kind: "toolResult", toolId: "new", name: "bash", isError: false },
  ],
  liveTools: [],
  queued: [],
  finalText: "tests passed",
  turns: 2,
};

test("Direct receipts scope normalized observations to a distinguishable execution", () => {
  const receipt = subagentCompletion(direct);
  assert.equal(receipt.identity.executionId, "sa-1:run:2");
  assert.deepEqual(
    receipt.observed.tools.items.map((item) => item.callId),
    ["new"],
  );
  assert.equal(receipt.verification.status, "unknown");
  assert.equal(receipt.workspace.attribution, "unknown");
  assert.equal(receipt.modelClaimed.textRef, receipt.observed.evidenceRef);
  assert.equal(JSON.stringify(receipt).includes("tests passed"), false);
  assert.equal(
    subagentCompletion({ ...direct, executionUncertain: true }).observed
      .outcome,
    "uncertain",
  );
  const legacy = subagentCompletion({
    ...direct,
    runGeneration: undefined,
    runTranscriptStart: undefined,
  });
  assert.equal(legacy.identity.executionId, "unknown");
  assert.deepEqual(legacy.observed.tools.items, []);
});

test("Direct completion references do not disclose canonical private evidence paths", () => {
  for (const root of [
    "/Users/private-host/.pi",
    "C:\\Users\\private-host\\.pi",
  ]) {
    const sessionFilePath = `${root}/sessions/child.jsonl`;
    const artifactPath = `${root}/artifacts/structured.json`;
    const snap = {
      ...direct,
      meta: { ...direct.meta, sessionFilePath },
      evidence: {
        ...direct.evidence!,
        structured: {
          status: "saved" as const,
          path: artifactPath,
          digest: "content-digest",
        },
      },
      structuredResult: {
        value: { verdict: "pass" },
        json: '{"verdict":"pass"}',
        byteLength: 18,
        artifactPath,
      },
    };
    const receipt = subagentCompletion(snap);
    const projection =
      JSON.stringify(receipt) + delegationCompletionText(receipt);
    assert.equal(projection.includes(root), false);
    assert.equal(projection.includes(sessionFilePath), false);
    assert.equal(projection.includes(artifactPath), false);
    assert.match(
      receipt.observed.evidenceRef ?? "",
      /^direct:[a-f0-9-]+:run:2$/,
    );
    assert.match(
      receipt.modelClaimed.structuredRef ?? "",
      /^direct:[a-f0-9-]+:run:2$/,
    );
    assert.equal(
      receipt.observed.tools.evidenceRef,
      receipt.observed.evidenceRef,
    );
    assert.deepEqual(subagentCompletion(snap), receipt);
    assert.equal(
      subagentCompletion({
        ...snap,
        meta: { ...snap.meta, sessionFilePath: `${sessionFilePath}.other` },
      }).observed.evidenceRef,
      receipt.observed.evidenceRef,
    );
    // The owner retains the canonical paths; the receipt is only a projection.
    assert.equal(snap.meta.sessionFilePath, sessionFilePath);
    assert.equal(snap.structuredResult.artifactPath, artifactPath);
  }
  const missing = subagentCompletion({
    ...direct,
    evidence: undefined,
    meta: { backend: "pi" },
  });
  assert.equal(missing.observed.evidenceRef, undefined);
  assert.equal(missing.modelClaimed.textRef, undefined);
});

test("Direct evidence and claims require current-generation settlement provenance", () => {
  const previous = subagentCompletion(direct);
  for (const snap of [
    { ...direct, status: "running" as const },
    { ...direct, runGeneration: 3 },
    { ...direct, completionGeneration: undefined },
  ]) {
    const receipt = subagentCompletion({
      ...snap,
      structuredResult: {
        value: { verdict: "pass" },
        json: '{"verdict":"pass"}',
        byteLength: 18,
        artifactPath: "/private/old-result.json",
      },
    });
    assert.equal(receipt.observed.evidenceRef, undefined);
    assert.equal(receipt.modelClaimed.status, "unknown");
  }
  const next = subagentCompletion({
    ...direct,
    runGeneration: 3,
    completionGeneration: 3,
    evidence: { ...direct.evidence!, generation: 3 },
  });
  assert.notEqual(next.observed.evidenceRef, previous.observed.evidenceRef);
  assert.equal(next.observed.referenceKind, "owner-locator");
  assert.equal(next.modelClaimed.referenceKind, "owner-locator");
  assert.match(delegationCompletionText(next), /evidence=direct:/);
});

const agent: AgentRecord = {
  index: 1,
  callId: "wf-1:call:1",
  label: "test",
  state: "done",
  startedAt: 0,
  executionOutcome: "success",
  resultPersistence: "saved",
  resultHasText: true,
  isolation: "shared",
  requestedCwd: "/shared",
  effectiveCwd: "/shared",
  preview: "tests passed",
  usage: emptyUsage(),
  resultArtifact: "agent-results/agent-0001.json",
  transcript: [
    {
      role: "toolResult",
      text: "tests passed",
      name: "bash",
      toolCallId: "t-1",
      isError: false,
    },
  ],
};
test("Workflow transcript evidence is never a saved model result", () => {
  for (const record of [
    { ...agent, state: "running" as const },
    { ...agent, resultPersistence: "failed" as const },
    { ...agent, resultArtifact: undefined },
    { ...agent, resultPersistence: undefined },
    { ...agent, resultHasText: undefined },
    { ...agent, resultHasText: false },
  ]) {
    const receipt = workflowAgentCompletion("wf-1", record);
    assert.equal(receipt.modelClaimed.status, "unknown");
    assert.equal(receipt.modelClaimed.textRef, undefined);
    assert.equal(receipt.modelClaimed.structuredRef, undefined);
    assert.equal(
      receipt.observed.tools.evidenceRef,
      "wf-1/transcripts.json#/1",
    );
  }
  const structured = workflowAgentCompletion("wf-1", {
    ...agent,
    resultHasText: false,
    resultHasStructured: true,
  });
  assert.equal(structured.modelClaimed.textRef, undefined);
  assert.equal(
    structured.modelClaimed.structuredRef,
    "wf-1/agent-results/agent-0001.json",
  );
});

const workflow: WorkflowDetails = {
  runId: "wf-1",
  background: false,
  status: "completed",
  startedAt: 0,
  finishedAt: 1,
  phases: [],
  agents: [agent],
};

test("Workflow query, wait/delivery and bounded memory share the owner projection", () => {
  const receipt = workflowAgentCompletion(workflow.runId, agent);
  assert.equal(receipt.observed.tools.items[0]?.processExit.status, "unknown");
  assert.equal(receipt.observed.tools.evidenceRef, "wf-1/transcripts.json#/1");
  assert.equal(receipt.modelClaimed.structuredRef, undefined);
  assert.equal(receipt.verification.status, "unknown");
  const restored = normalizePersistedWorkflowDetails(
    workflow.runId,
    JSON.parse(JSON.stringify(workflow)),
  );
  assert.ok(restored?.agents[0]);
  assert.deepEqual(
    workflowAgentCompletion(workflow.runId, restored.agents[0]),
    receipt,
  );
  assert.deepEqual(
    compactWorkflowToolDetails(workflow).agents[0]?.completion,
    receipt,
  );
  const retained = projectWorkflowDetails(workflow);
  assert.ok(retained?.agents[0]);
  assert.deepEqual(
    workflowAgentCompletion(workflow.runId, retained.agents[0]),
    receipt,
  );
  const completionLine = buildWorkflowStatusSummary(workflow, "/runs/wf-1")
    .split("\n")
    .find((line) => line.startsWith("Completion evidence"));
  assert.ok(completionLine);
  assert.ok(
    buildWorkflowResultMessage(workflow, "/runs/wf-1").includes(completionLine),
  );
});

test("replay origin survives decoding and re-journaling, while legacy origin remains unknown", () => {
  const origin = {
    executionId: "wf-1:call:1",
    evidenceRef: "wf-1/agent-results/agent-0001.json",
  };
  const decoded = parseJournal({
    version: JOURNAL_VERSION,
    entries: [{ key: "key", output: "done", origin }],
  });
  const cached = createReplayCache(decoded).take("key");
  assert.ok(cached);
  const next = createJournalAccumulator();
  next.append(cached);
  const redecoded = parseJournal(JSON.parse(JSON.stringify(next.toJournal())));
  assert.deepEqual(createReplayCache(redecoded).take("key")?.origin, origin);
  const legacy = parseJournal({
    version: JOURNAL_VERSION,
    entries: [{ key: "key", output: "done" }],
  });
  assert.equal(createReplayCache(legacy).take("key")?.origin, undefined);
});

test("Workflow execution success is distinct from persistence failure and cancellation", () => {
  const failedSave = workflowAgentCompletion("wf-1", {
    ...agent,
    state: "error",
    resultPersistence: "failed",
    resultArtifact: undefined,
  });
  assert.equal(failedSave.observed.outcome, "success");
  assert.equal(failedSave.persistence.status, "failed");
  assert.equal(failedSave.modelClaimed.status, "unknown");
  const cancelled = workflowAgentCompletion("wf-1", {
    ...agent,
    state: "error",
    executionOutcome: "cancelled",
  });
  assert.equal(cancelled.observed.outcome, "cancelled");
  const replay = workflowAgentCompletion("wf-2", {
    ...agent,
    replayed: true,
    executionOutcome: "replayed",
    replayOrigin: "unknown",
  });
  assert.deepEqual(replay.replay, { newExecution: false, origin: "unknown" });
});
