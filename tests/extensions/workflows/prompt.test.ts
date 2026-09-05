import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  type AgentRecord,
  emptyUsage,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildProjectedWorkflowCompletionBatch,
  buildProjectedWorkflowCompletionBatches,
  buildProjectedWorkflowResultMessage,
  buildWorkflowResultMessage,
  buildWorkflowStatusSummary,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_STATUS_TOOL_DESCRIPTION,
  WORKFLOW_STOP_TOOL_DESCRIPTION,
  WORKFLOW_TOOL_DESCRIPTION,
} from "../../../extensions/workflows/prompt.ts";

test("background follow-up uses a sentence lead-in, not the old bracket form", () => {
  const msg = buildBackgroundWorkflowFollowUp({
    runId: "wf_abc123",
    name: "reliability-review",
    status: "completed",
    result: "Workflow completed — 3/3 agents ok.",
  });
  // Sentence-shaped like the subagent/terminal completion messages.
  assert.match(
    msg,
    /^Background workflow "reliability-review" \(wf_abc123\) finished\./,
  );
  assert.doesNotMatch(msg, /^\[/); // not the old "[Background workflow …]" bracket
  assert.ok(msg.includes("Workflow completed — 3/3 agents ok."));

  // A non-completed status surfaces the status verb verbatim.
  const failed = buildBackgroundWorkflowFollowUp({
    runId: "wf_def456",
    status: "failed",
    result: "boom",
  });
  assert.match(failed, /^Background workflow wf_def456 \(wf_def456\) failed\./);
});

test("completion batches share one bounded fair projection budget", () => {
  const entries = Array.from({ length: 64 }, (_, index) => {
    const details: WorkflowDetails = {
      runId: `wf_${index.toString(16).padStart(4, "0")}`,
      status: "completed",
      background: true,
      startedAt: 1,
      finishedAt: 2,
      phases: [],
      agents: [],
      result: {
        identity: `run-${index}`,
        evidence: "x".repeat(8_000),
        verdict: `tail-${index}`,
      },
    };
    return {
      deliveryId: `delivery-${index}`,
      details,
      runDir: `/tmp/${details.runId}`,
    };
  });
  const projected = buildProjectedWorkflowCompletionBatch(entries, {
    tokens: 10_000,
    contextWindow: 100_000,
  });
  assert.ok(Buffer.byteLength(projected, "utf8") <= 48 * 1024);
  for (let index = 0; index < entries.length; index++) {
    assert.match(
      projected,
      new RegExp(`wf_${index.toString(16).padStart(4, "0")}`),
    );
    assert.match(projected, new RegExp(`delivery-${index}(?:"|\\b)`));
  }
});

test("oversized completion batches split into bounded messages without losing delivery facts", () => {
  const entries = Array.from({ length: 128 }, (_, index) => {
    const details: WorkflowDetails = {
      runId: `wf_large_${index.toString(16).padStart(4, "0")}`,
      status: "completed",
      background: true,
      startedAt: 1,
      finishedAt: 2,
      phases: [],
      agents: [],
      result: { evidence: "x".repeat(8_000) },
    };
    return {
      deliveryId: `delivery-large-${index}-${"d".repeat(600)}`,
      details,
      runDir: `/tmp/${details.runId}`,
    };
  });

  const batches = buildProjectedWorkflowCompletionBatches(entries, {
    tokens: 10_000,
    contextWindow: 100_000,
  });

  assert.ok(batches.length > 1);
  for (const batch of batches) {
    assert.ok(Buffer.byteLength(batch.content, "utf8") <= 48 * 1024);
  }
  for (const entry of entries) {
    assert.equal(
      batches.filter((batch) =>
        batch.content.includes(JSON.stringify(entry.deliveryId)),
      ).length,
      1,
    );
  }
});

test("completion batching keeps small and large deliveries grouped", () => {
  const makeEntry = (index: number, evidenceLength = 200) => {
    const details: WorkflowDetails = {
      runId: `wf_grouped_${index}`,
      status: "completed",
      background: true,
      startedAt: 1,
      finishedAt: 2,
      phases: [],
      agents: [],
      result: { evidence: "x".repeat(evidenceLength) },
    };
    return {
      deliveryId: `delivery-grouped-${index}`,
      details,
      runDir: `/tmp/${details.runId}/${"r".repeat(600)}`,
    };
  };

  const smallEntries = [0, 1, 2].map((index) => makeEntry(index));
  const smallBatches = buildProjectedWorkflowCompletionBatches(smallEntries);
  assert.equal(smallBatches.length, 1);
  assert.deepEqual(
    smallBatches[0]?.entries.map((entry) => entry.deliveryId),
    smallEntries.map((entry) => entry.deliveryId),
  );

  const largeEntries = Array.from({ length: 128 }, (_, index) =>
    makeEntry(index, 8_000),
  );
  const largeBatches = buildProjectedWorkflowCompletionBatches(largeEntries, {
    tokens: 10_000,
    contextWindow: 100_000,
  });
  assert.ok(largeBatches.length < largeEntries.length / 2);
  for (const entry of largeEntries) {
    assert.equal(
      largeBatches.filter((batch) =>
        batch.entries.some(
          (candidate) => candidate.deliveryId === entry.deliveryId,
        ),
      ).length,
      1,
    );
  }
});

test("model completion payload retains durable evidence independently of the renderer", () => {
  const details: WorkflowDetails = {
    runId: "wf_evidence",
    name: "evidence",
    status: "completed",
    background: true,
    startedAt: 0,
    finishedAt: 1_000,
    phases: [{ title: "inspect" }],
    agents: [
      {
        index: 1,
        label: "reviewer",
        state: "done",
        startedAt: 0,
        finishedAt: 1_000,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
    logs: [{ at: 1, text: "durable diagnostic" }],
    result: { verdict: "keep this result" },
  };
  const payload = buildProjectedWorkflowCompletionBatch([
    {
      deliveryId: "workflow:wf_evidence:terminal",
      details,
      runDir: "/tmp/wf_evidence",
    },
  ]);
  assert.match(payload, /^Workflow completion delivery facts/);
  assert.match(payload, /Background workflow "evidence"/);
  assert.match(payload, /Run dir: \/tmp\/wf_evidence/);
  assert.match(payload, /^Log:$/m);
  assert.match(payload, /^Agents:$/m);
  assert.match(payload, /keep this result/);
  assert.match(payload, /Delivery id: workflow:wf_evidence:terminal/);
  assert.match(payload, /duplicate|do not repeat it verbatim/i);
});

test("uncertain agents are never described as settled failures", () => {
  const details: WorkflowDetails = {
    runId: "wf_uncertain",
    status: "uncertain",
    background: true,
    startedAt: 1,
    finishedAt: 2,
    phases: [],
    agents: [
      {
        index: 1,
        label: "owner-lost",
        state: "uncertain",
        startedAt: 1,
        finishedAt: 2,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
  };
  const summary = buildWorkflowStatusSummary(details, "/tmp/wf_uncertain");
  assert.match(summary, /0\/1 agents settled/);
  assert.match(summary, /1 uncertain/);
  assert.doesNotMatch(summary, /1 failed/);
});

test("launch result advertises the model-facing lifecycle tools", () => {
  const msg = buildBackgroundWorkflowLaunchResult({
    runId: "wf_abc123",
    name: "audit",
    runDir: "/tmp/wf_abc123",
  });
  assert.ok(msg.includes('workflow_status(runId: "wf_abc123")'));
  assert.ok(msg.includes('workflow_stop(runId: "wf_abc123")'));
});

test("lifecycle tool descriptions state their scope and non-blocking nature", () => {
  assert.match(WORKFLOW_STOP_TOOL_DESCRIPTION, /Cancel a running workflow/);
  assert.doesNotMatch(WORKFLOW_STOP_TOOL_DESCRIPTION, /interrupting the turn/);
  assert.match(WORKFLOW_STATUS_TOOL_DESCRIPTION, /without blocking/);
  assert.match(WORKFLOW_STATUS_TOOL_DESCRIPTION, /Does not wait/);
});

function agentRecord(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    index: 1,
    label: "impl",
    state: "done",
    startedAt: 0,
    finishedAt: 1000,
    preview: "",
    usage: emptyUsage(),
    transcript: [],
    ...overrides,
  };
}

function details(agents: AgentRecord[]): WorkflowDetails {
  return {
    runId: "wf_abc123",
    background: false,
    status: "completed",
    startedAt: 0,
    finishedAt: 1000,
    phases: [],
    agents,
  };
}

test("result message names where isolated work ended up", () => {
  // Isolated work lands on a branch or in a kept directory, never in the
  // working tree, so a message that omits it strands the child's output.
  const msg = buildWorkflowResultMessage(
    details([
      agentRecord({ label: "committed", worktreeBranch: "pi/committed-1" }),
      agentRecord({
        index: 2,
        label: "dirty",
        worktreeBranch: "pi/dirty-2",
        worktreePath: "/repo/.git/pi-worktrees/dirty-2",
      }),
      agentRecord({ index: 3, label: "plain" }),
    ]),
    "/tmp/wf_abc123",
  );
  assert.match(msg, /committed to branch pi\/committed-1/);
  assert.match(msg, /kept at .*dirty-2 \(uncommitted changes\)/);
  // A non-isolated agent contributes no worktree line.
  assert.doesNotMatch(msg, /\[plain\].*worktree/);
});

test("result message labels deprecated acceptance as model self-attestation", () => {
  const msg = buildWorkflowResultMessage(
    details([
      agentRecord({
        state: "error",
        error: "Acceptance rejected",
        acceptance: {
          status: "rejected",
          criteria: [{ id: "tests", status: "rejected", evidence: [] }],
          errors: [],
        },
      }),
    ]),
    "/tmp/wf_abc123",
  );
  assert.match(msg, /deprecated model self-attestation rejected/);
});

test("result message stays quiet when nothing was isolated", () => {
  const msg = buildWorkflowResultMessage(
    details([agentRecord({})]),
    "/tmp/wf_abc123",
  );
  assert.doesNotMatch(msg, /Isolated worktrees/);
});

test("workflow status text cannot replay terminal controls from artifacts", () => {
  const restored = details([
    agentRecord({
      label: "impl\u001b]52;c;clipboard\u0007",
      error: "failed\u001b[31m\u001b[0m",
    }),
  ]);
  restored.name = "audit\u001b]52;c;clipboard\u0007";
  restored.logs = [{ at: 1, text: "log\u001b[2J" }];
  restored.result = { text: "result\u001b]52;c;clipboard\u0007" };
  const message = buildWorkflowResultMessage(restored, "/tmp/wf_abc123");
  assert.doesNotMatch(message, /[\u001b\u0007]/);
  assert.match(message, /^Workflow "audit" completed/);
});

test("result message carries the script's narration and what it dropped", () => {
  // log() lines are often the only record of work the return value omits, so
  // the model's copy of the run has to include them.
  const withLogs: WorkflowDetails = {
    ...details([agentRecord({})]),
    logs: [
      { at: 1, text: "round 1: 3 found" },
      { at: 2, text: "round 2: nothing new, stopping" },
    ],
    logsDropped: 5,
  };
  const msg = buildWorkflowResultMessage(withLogs, "/tmp/wf_abc123");
  assert.match(msg, /^Log:$/m);
  assert.match(msg, /round 2: nothing new, stopping/);
  // A silent truncation would read as "the script only said this much".
  assert.match(msg, /5 earlier line\(s\) dropped/);

  const quiet = buildWorkflowResultMessage(
    details([agentRecord({})]),
    "/tmp/wf_abc123",
  );
  assert.doesNotMatch(quiet, /^Log:$/m);
});

test("model projection follows parent headroom and preserves head, tail, and recovery", () => {
  const large = details(
    Array.from({ length: 64 }, (_, index) =>
      agentRecord({ index: index + 1, label: `agent-${index + 1}` }),
    ),
  );
  large.logs = Array.from({ length: 100 }, (_, index) => ({
    at: index,
    text: `log-${index + 1}: ${"x".repeat(1_500)}`,
  }));
  large.result = { verdict: "tail-verdict", evidence: "y".repeat(30_000) };

  const projected = buildProjectedWorkflowResultMessage(
    large,
    "/tmp/wf_abc123",
    { tokens: 99_900, contextWindow: 100_000 },
  );
  assert.ok(Buffer.byteLength(projected, "utf8") <= 8 * 1024);
  assert.match(projected, /^Workflow/);
  assert.match(projected, /tail-verdict|bounded result artifact/);
  assert.match(projected, /Full workflow evidence is available/);
});

test("the resident workflow prompt stays compact while the Skill carries the full guide", async () => {
  assert.ok(Buffer.byteLength(WORKFLOW_TOOL_DESCRIPTION, "utf8") < 3_000);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /workflows Skill/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /check.*\.ok/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /pipeline\(\)/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /isolation: ['"]worktree['"]/);
  assert.doesNotMatch(WORKFLOW_TOOL_DESCRIPTION, /reliability-review/);
  assert.match(
    WORKFLOW_PROMPT_GUIDELINES.join("\n"),
    /select a matching agent_type.*do not hardcode that role's model/,
  );

  const skill = await readFile(
    new URL("../../../skills/workflows/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(skill, /maxItems:\s*32/);
  assert.match(skill, /capacity\.callsRemaining < 1/);
  assert.match(skill, /capacity\.callsRemaining - 1/);
  const reference = await readFile(
    new URL("../../../skills/workflows/REFERENCE.md", import.meta.url),
    "utf8",
  );
  const examples = await readFile(
    new URL("../../../skills/workflows/EXAMPLES.md", import.meta.url),
    "utf8",
  );
  assert.match(skill, /^---\r?\nname: workflows\r?\n/);
  assert.match(skill, /Use when .*multi-phase/i);
  assert.match(reference, /operator/);
  assert.match(reference, /result refs/);
  assert.match(reference, /resume_from_run_id/);
  assert.match(reference, /same workflow run/i);
  assert.match(examples, /reliability-review/);
  assert.match(examples, /usage\(\)/);
});
