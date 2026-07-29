import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { WorkflowDetails } from "./model.ts";

// runsDir() resolves against getAgentDir(), which reads this env var.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-workflows-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { loadRunEntries } = await import("./dashboard.ts");

const SESSION = "session-1";

function writeRun(
  runId: string,
  startedAt: number,
  finishedAt = startedAt + 1_000,
) {
  const dir = join(agentDir, "workflows", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workflow.json"),
    JSON.stringify({
      runId,
      sessionId: SESSION,
      name: runId,
      status: "completed",
      startedAt,
      finishedAt,
      agents: [],
      phases: [],
    }),
  );
}

test("the dashboard reports the current request, not the session's history", () => {
  writeRun("wf_old", 1_000);
  writeRun("wf_new", 5_000);

  const all = loadRunEntries(new Map(), SESSION, new Set());
  assert.deepEqual(
    all.map((entry) => entry.runId),
    ["wf_new", "wf_old"],
  );

  const thisTurn = loadRunEntries(new Map(), SESSION, new Set(), 4_000);
  assert.deepEqual(
    thisTurn.map((entry) => entry.runId),
    ["wf_new"],
  );
});

test("a run still executing stays visible even if it began earlier", () => {
  writeRun("wf_live", 1_000);
  const live = {
    runId: "wf_live",
    sessionId: SESSION,
    name: "wf_live",
    status: "running",
    startedAt: 1_000,
    agents: [],
    phases: [],
  } as unknown as WorkflowDetails;

  const runIds = loadRunEntries(
    new Map([["wf_live", live]]),
    SESSION,
    new Set(),
    4_000,
  ).map((entry) => entry.runId);
  assert.ok(runIds.includes("wf_live"));
  assert.ok(!runIds.includes("wf_old"));
});

test("a background run that settles during this request is reported by it", () => {
  // Started under the previous request, finished under this one.
  writeRun("wf_spanning", 1_000, 5_000);

  const runIds = loadRunEntries(new Map(), SESSION, new Set(), 4_000).map(
    (entry) => entry.runId,
  );
  assert.ok(runIds.includes("wf_spanning"));
});
