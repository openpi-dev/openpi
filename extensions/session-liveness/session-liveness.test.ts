import assert from "node:assert/strict";
import test from "node:test";
import {
  getSessionLiveness,
  resetSessionLiveness,
  setRunningSubagents,
  setRunningWorkflows,
  subscribeSessionLiveness,
} from "../shared/session-liveness.ts";

test("liveness merges subagent and workflow counters", () => {
  resetSessionLiveness();
  assert.deepEqual(getSessionLiveness(), {
    active: false,
    detail: "",
    runningSubagents: 0,
    runningWorkflows: 0,
  });
  setRunningSubagents(2);
  assert.equal(getSessionLiveness().active, true);
  assert.equal(getSessionLiveness().detail, "2 subagent");
  setRunningWorkflows(1);
  assert.equal(getSessionLiveness().detail, "2 subagent · 1 workflow");
  setRunningSubagents(0);
  assert.equal(getSessionLiveness().detail, "1 workflow");
  setRunningWorkflows(0);
  assert.equal(getSessionLiveness().active, false);
});

test("subscribers are notified on change only", () => {
  resetSessionLiveness();
  const seen: string[] = [];
  subscribeSessionLiveness((s) => seen.push(s.detail));
  setRunningSubagents(1);
  setRunningSubagents(1); // no-op, no notification
  setRunningSubagents(0);
  assert.deepEqual(seen, ["", "1 subagent", ""]);
});
