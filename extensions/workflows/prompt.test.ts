import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackgroundWorkflowFollowUp,
  buildBackgroundWorkflowLaunchResult,
  WORKFLOW_STATUS_TOOL_DESCRIPTION,
  WORKFLOW_STOP_TOOL_DESCRIPTION,
} from "./prompt.ts";

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
