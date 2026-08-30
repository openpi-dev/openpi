import assert from "node:assert/strict";
import test from "node:test";
import {
  evictOldestSettledRuns,
  MAX_SETTLED_RUNS,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";

function details(
  runId: string,
  startedAt: number,
  finishedAt: number,
  status: WorkflowDetails["status"] = "completed",
): WorkflowDetails {
  return {
    runId,
    background: true,
    status,
    startedAt,
    finishedAt,
    phases: [],
    agents: [],
  };
}

test("settled retention evicts the oldest terminal projection only", () => {
  const active = new Map([
    ["wf_active", details("wf_active", 1, 2, "running")],
  ]);
  const settled = new Map([
    ["wf_active", active.get("wf_active")!],
    ["wf_new", details("wf_new", 10, 30)],
    ["wf_old", details("wf_old", 20, 20)],
    ["wf_middle", details("wf_middle", 30, 25)],
  ]);

  const evicted = evictOldestSettledRuns(settled, 3);

  assert.deepEqual(evicted, ["wf_old"]);
  assert.deepEqual([...settled.keys()], ["wf_active", "wf_new", "wf_middle"]);
  assert.deepEqual([...active.keys()], ["wf_active"]);
  assert.equal(active.get("wf_active")?.status, "running");
});

test("settled retention enforces its default hard count bound", () => {
  const settled = new Map<string, WorkflowDetails>();
  for (let index = 0; index < MAX_SETTLED_RUNS + 3; index++) {
    const runId = `wf_${index.toString(16).padStart(2, "0")}`;
    settled.set(runId, details(runId, index, index));
  }

  const evicted = evictOldestSettledRuns(settled);

  assert.equal(settled.size, MAX_SETTLED_RUNS);
  assert.equal(evicted.length, 3);
  assert.deepEqual(evicted, ["wf_00", "wf_01", "wf_02"]);
});
