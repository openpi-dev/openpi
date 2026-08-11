import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme, WorkflowDetails } from "./model.ts";

// runsDir() resolves against getAgentDir(), which reads this env var.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-workflows-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
  buildWorkflowReport,
  loadRunEntries,
  normalizePersistedWorkflowDetails,
  recoverStaleWorkflowDetails,
  workflowGraphSummary,
  WorkflowDashboard,
} = await import("./dashboard.ts");

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

test("persisted nonterminal invocation facts are projected as uncertain", () => {
  const restored = normalizePersistedWorkflowDetails("wf_dead", {
    status: "running",
    startedAt: 10,
    agents: [
      {
        index: 1,
        label: "writer",
        state: "running",
        startedAt: 11,
        invocation: {
          identity: { runId: "wf_dead", callIndex: 1 },
          intentState: "requested",
          admissionState: "claimed",
          executionState: "running",
          requestedAt: 11,
          claimedAt: 12,
          runningAt: 13,
        },
      },
    ],
    phases: [],
  });

  assert.equal(restored?.agents[0]?.invocation?.executionState, "uncertain");
  assert.equal(restored?.agents[0]?.invocation?.outcome, "uncertain");
});

test("stale recovery reconciles the run and every active agent", () => {
  const details = normalizePersistedWorkflowDetails("wf_stale", {
    status: "running",
    startedAt: 10,
    agents: [
      {
        index: 1,
        callId: "wf_stale:1",
        label: "running",
        state: "running",
        startedAt: 11,
      },
      {
        index: 2,
        callId: "wf_stale:2",
        label: "done",
        state: "done",
        startedAt: 11,
      },
    ],
    phases: [],
  })!;

  recoverStaleWorkflowDetails(details, 100);

  assert.equal(details.status, "aborted");
  assert.equal(details.finishedAt, 100);
  assert.equal(details.agents[0]?.state, "error");
  assert.equal(details.agents[0]?.finishedAt, 100);
  assert.equal(details.agents[1]?.state, "done");
  assert.equal(details.graph?.nodes[0]?.state, "error");
});

test("persisted usage is normalized to finite nonnegative numbers", () => {
  const details = normalizePersistedWorkflowDetails("wf_usage", {
    status: "completed",
    startedAt: 10,
    agents: [
      {
        index: 1,
        label: "corrupt",
        state: "done",
        startedAt: 11,
        usage: {
          input: Infinity,
          output: -1,
          cacheRead: "12",
          cacheWrite: null,
          cost: "boom",
          contextTokens: 512,
          turns: NaN,
        },
      },
    ],
    phases: [],
  });

  assert.deepEqual(details?.agents[0]?.usage, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 512,
    turns: 0,
  });
});

test("saved reports expose the bounded derived graph as observability", () => {
  const details = normalizePersistedWorkflowDetails("wf_graph_report", {
    status: "completed",
    startedAt: 10,
    agents: [
      {
        index: 1,
        callId: "wf_graph_report:1",
        label: "scan",
        state: "done",
        startedAt: 11,
      },
      {
        index: 2,
        callId: "wf_graph_report:2",
        inputCallIds: ["wf_graph_report:1"],
        label: "verify",
        state: "done",
        startedAt: 12,
      },
    ],
    phases: [],
  })!;

  details.graph!.omitted = { nodes: 2, edges: 3, diagnostics: 1 };
  const report = buildWorkflowReport(details);
  assert.match(report, /## Derived graph/);
  assert.match(report, /scan → verify/);
  assert.match(report, /observability only/);
  assert.match(report, /2 nodes, 3 edges, 1 diagnostics omitted/);
  assert.match(
    workflowGraphSummary(details.graph!),
    /2 nodes, 3 edges, 1 diagnostics omitted/,
  );
});

test("the dashboard reports the current request, not the session's history", () => {
  writeRun("wf_a1", 1_000);
  writeRun("wf_b2", 5_000);

  const all = loadRunEntries(new Map(), SESSION, new Set());
  assert.deepEqual(
    all.map((entry) => entry.runId),
    ["wf_b2", "wf_a1"],
  );

  const thisTurn = loadRunEntries(new Map(), SESSION, new Set(), 4_000);
  assert.deepEqual(
    thisTurn.map((entry) => entry.runId),
    ["wf_b2"],
  );
});

test("restored run directories require a generated safe id", () => {
  writeRun("wf_\u001b]52;c;clipboard\u0007", 9_000);
  const runIds = loadRunEntries(new Map(), SESSION, new Set()).map(
    (entry) => entry.runId,
  );
  assert.ok(!runIds.some((runId) => runId.includes("clipboard")));
});

test("a run still executing stays visible even if it began earlier", () => {
  writeRun("wf_c3", 1_000);
  const live = {
    runId: "wf_c3",
    sessionId: SESSION,
    name: "wf_c3",
    status: "running",
    startedAt: 1_000,
    agents: [],
    phases: [],
  } as unknown as WorkflowDetails;

  const runIds = loadRunEntries(
    new Map([["wf_c3", live]]),
    SESSION,
    new Set(),
    4_000,
  ).map((entry) => entry.runId);
  assert.ok(runIds.includes("wf_c3"));
  assert.ok(!runIds.includes("wf_a1"));
});

test("a background run that settles during this request is reported by it", () => {
  // Started under the previous request, finished under this one.
  writeRun("wf_d4", 1_000, 5_000);

  const runIds = loadRunEntries(new Map(), SESSION, new Set(), 4_000).map(
    (entry) => entry.runId,
  );
  assert.ok(runIds.includes("wf_d4"));
});

test("an ambiguous short suffix cannot open either run in the dashboard", () => {
  writeRun("wf_11111111beef", Date.now() - 2_000);
  writeRun("wf_22222222beef", Date.now() - 1_000);
  const tui = {
    terminal: { rows: 30 },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const keys = {
    matches: () => false,
    getKeys: () => ["esc"],
  } as unknown as KeybindingsManager;
  const dashboard = new WorkflowDashboard(
    tui,
    theme,
    keys,
    () => new Map(),
    SESSION,
    new Set(),
    0,
    () => {},
    "beef",
  );

  try {
    const rendered = dashboard.render(120).join("\n");
    assert.match(rendered, /Runs/);
    assert.match(rendered, /ambiguous/i);
    assert.doesNotMatch(rendered, /Phases/);
  } finally {
    dashboard.dispose();
  }
});

test("direct workflow navigation drills right and returns left through every level", () => {
  writeRun("wf_e5", Date.now() - 1_000);
  const details: WorkflowDetails = {
    runId: "wf_e5",
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

function saveReport(runId: string) {
  writeRun(runId, Date.now() - 1_000);
  const tui = {
    terminal: { rows: 30 },
    requestRender() {},
  } as unknown as TUI;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const keys = {
    matches: () => false,
    getKeys: () => ["esc"],
  } as unknown as KeybindingsManager;
  const dashboard = new WorkflowDashboard(
    tui,
    theme,
    keys,
    () => new Map(),
    SESSION,
    new Set(),
    0,
    () => {},
    runId,
  );
  dashboard.handleInput("s");
  dashboard.dispose();
  return join(agentDir, "workflows", runId, "report.md");
}

test("a newly created dashboard report is private", () => {
  const report = saveReport("wf_600001");
  assert.equal(statSync(report).mode & 0o777, 0o600);
});

test("overwriting a dashboard report restores private mode atomically", () => {
  const runId = "wf_600002";
  const report = join(agentDir, "workflows", runId, "report.md");
  writeRun(runId, Date.now() - 1_000);
  writeFileSync(report, "old report", { mode: 0o644 });
  chmodSync(report, 0o644);

  assert.equal(saveReport(runId), report);
  assert.equal(statSync(report).mode & 0o777, 0o600);
  assert.notEqual(readFileSync(report, "utf8"), "old report");
});

test("agent fields added after a run are not dropped when reading it back", () => {
  // normalizeDetails rebuilds each agent field by field, so any field it does
  // not name silently disappears on the disk round trip. These three came
  // later than the original set and are exactly the ones at risk.
  const runId = "wf_f6";
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

test("narrator lines survive the disk round trip and are re-sanitized", () => {
  // Same field-by-field hazard as above, plus one more: this file was written
  // by an earlier run, so its text is read back as untrusted data rather than
  // as something this process just produced.
  const runId = "wf_a7";
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
      agents: [],
      logs: [
        { at: 1, text: "round 1: 3 found" },
        { at: 2, text: "round 2:\u001b[31m red\u001b[0m\nsecond row" },
        { at: 3 },
        "not an entry",
      ],
      logsDropped: 4,
    }),
  );
  const details = loadRunEntries(new Map(), SESSION, new Set([runId])).find(
    (e) => e.runId === runId,
  )?.details;
  assert.equal(details?.logs?.length, 2);
  assert.equal(details?.logs?.[0]?.text, "round 1: 3 found");
  assert.ok(
    !/[\u0000-\u001f\u007f-\u009f]/.test(details?.logs?.[1]?.text ?? ""),
  );
  assert.equal(details?.logsDropped, 4);
});
