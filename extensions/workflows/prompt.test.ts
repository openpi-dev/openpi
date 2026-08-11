import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  buildWorkflowResultMessage,
  WORKFLOW_PROMPT_GUIDELINES,
  WORKFLOW_STATUS_TOOL_DESCRIPTION,
  WORKFLOW_STOP_TOOL_DESCRIPTION,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./prompt.ts";
import { emptyUsage, type AgentRecord, type WorkflowDetails } from "./model.ts";

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
  assert.match(
    WORKFLOW_STOP_TOOL_DESCRIPTION,
    /Cancel a running background workflow/,
  );
  assert.match(
    WORKFLOW_STOP_TOOL_DESCRIPTION,
    /Only background runs need this/,
  );
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

test("result message surfaces explicit acceptance state", () => {
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
  assert.match(msg, /acceptance rejected/);
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

test("the tool description teaches log() and usage() as distinct from phase()", () => {
  // The description is the only place the model learns these exist.
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /• log\(message\)/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /acceptance\?/);
  assert.match(
    WORKFLOW_TOOL_DESCRIPTION,
    /Unlike phase\(\), it does not touch/,
  );
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /• usage\(\)/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /agent_type\?/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /operator\?/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /inputs\?/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /result ref/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /same workflow run/i);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /not.*cross-restart/i);
  assert.match(
    WORKFLOW_TOOL_DESCRIPTION,
    /same named preset and enforced capabilities as subagent_spawn/,
  );
  assert.match(
    WORKFLOW_TOOL_DESCRIPTION,
    /explicit model.*type-file model.*configured built-in role model.*parent model/,
  );
  assert.match(
    WORKFLOW_TOOL_DESCRIPTION,
    /explicit effort.*type default.*parent effort/,
  );
  assert.match(
    WORKFLOW_PROMPT_GUIDELINES.join("\n"),
    /select a matching agent_type.*do not hardcode that role's model/,
  );
  // usage() reports; it does not enforce. Saying otherwise would invite a
  // script to rely on a limit that does not exist.
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /reading, not a limit/);
  // The worked example should actually use them, not just describe them.
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /^log\(`done — /m);
});
