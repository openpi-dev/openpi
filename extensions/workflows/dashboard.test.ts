import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme, WorkflowDetails } from "./model.ts";

// runsDir() resolves against getAgentDir(), which reads this env var.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-workflows-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { loadRunEntries, WorkflowDashboard } = await import("./dashboard.ts");

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

test("direct workflow navigation drills right and returns left through every level", () => {
  writeRun("wf_navigation", Date.now() - 1_000);
  const details: WorkflowDetails = {
    runId: "wf_navigation",
    sessionId: SESSION,
    name: "navigation",
    description: "Exercise phase navigation",
    background: true,
    status: "running",
    startedAt: Date.now() - 1_000,
    phases: [{ title: "Draft" }, { title: "Review" }],
    currentPhase: "Draft",
    agents: [
      {
        index: 1,
        label: "writer",
        phase: "Draft",
        state: "running",
        startedAt: Date.now() - 900,
        preview: "",
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        transcript: [{ role: "user", text: "Write the draft" }],
      },
    ],
  };
  let closed = 0;
  const tui = {
    terminal: { rows: 30 },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const keys = {
    matches(data: string, binding: string) {
      return data === binding.replace("tui.editor.cursor", "").toLowerCase();
    },
    getKeys(binding: string) {
      const key = binding.split(".").at(-1) ?? binding;
      return [key.toLowerCase()];
    },
  } as unknown as KeybindingsManager;
  const dashboard = new WorkflowDashboard(
    tui,
    theme,
    keys,
    () => new Map([[details.runId, details]]),
    SESSION,
    new Set(),
    0,
    () => {
      closed += 1;
    },
    details.runId,
  );

  try {
    assert.match(dashboard.render(120).join("\n"), /Phases/);

    dashboard.handleInput("right");
    assert.match(dashboard.render(120).at(-1) ?? "", /select agent/);

    dashboard.handleInput("right");
    assert.match(dashboard.render(120).join("\n"), /Transcript/);

    dashboard.handleInput("left");
    assert.match(dashboard.render(120).at(-1) ?? "", /select agent/);

    dashboard.handleInput("left");
    assert.match(dashboard.render(120).at(-1) ?? "", /select phase/);

    dashboard.handleInput("left");
    assert.equal(closed, 1);
  } finally {
    dashboard.dispose();
  }
});

test("agent fields added after a run are not dropped when reading it back", () => {
  // normalizeDetails rebuilds each agent field by field, so any field it does
  // not name silently disappears on the disk round trip. These three came
  // later than the original set and are exactly the ones at risk.
  const runId = "wf_roundtrip";
  const dir = join(agentDir, "workflows", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workflow.json"),
    JSON.stringify({
      runId,
      sessionId: SESSION,
      status: "completed",
      startedAt: Date.now() - 1_000,
      finishedAt: Date.now(),
      phases: [],
      agents: [
        {
          index: 1,
          label: "impl",
          state: "done",
          startedAt: Date.now() - 900,
          preview: "",
          replayed: true,
          worktreeBranch: "pi/impl-1",
          worktreePath: "/repo/.git/pi-worktrees/impl-1",
        },
      ],
    }),
  );
  const entries = loadRunEntries(new Map(), SESSION, new Set([runId]));
  const agent = entries.find((e) => e.runId === runId)?.details.agents[0];
  assert.equal(agent?.replayed, true);
  assert.equal(agent?.worktreeBranch, "pi/impl-1");
  assert.equal(agent?.worktreePath, "/repo/.git/pi-worktrees/impl-1");
});
