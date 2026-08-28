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
import { stripVTControlCharacters } from "node:util";
import {
  initTheme,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { SPINNER_INTERVAL_MS } from "../../../extensions/shared/spinner.ts";
import type {
  Theme,
  WorkflowDetails,
} from "../../../extensions/workflows/model.ts";
import { safeStringify } from "../../../extensions/workflows/serialization.ts";

// runsDir() resolves against getAgentDir(), which reads this env var.
const agentDir = mkdtempSync(join(tmpdir(), "my-pi-setup-workflows-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
initTheme("dark", false);

const {
  buildWorkflowReport,
  loadRunEntries,
  normalizePersistedWorkflowDetails,
  recoverStaleWorkflowDetails,
  workflowGraphSummary,
  WorkflowDashboard,
} = await import("../../../extensions/workflows/dashboard.ts");

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

test("unknown or missing persisted states fail closed without breaking known aliases", () => {
  for (const state of [undefined, "future-state"]) {
    const restored = normalizePersistedWorkflowDetails("wf_unknown", {
      ...(state === undefined ? {} : { status: state }),
      agents: [
        {
          index: 1,
          label: "unknown",
          ...(state === undefined ? {} : { state }),
        },
      ],
      phases: [],
    });
    assert.equal(restored?.status, "uncertain");
    assert.equal(restored?.agents[0]?.state, "uncertain");
  }

  const legacy = normalizePersistedWorkflowDetails("wf_legacy_aliases", {
    status: "completed",
    agents: [
      { index: 1, label: "done", state: "completed" },
      { index: 2, label: "failed", state: "failed" },
    ],
    phases: [],
  });
  assert.equal(legacy?.status, "completed");
  assert.deepEqual(
    legacy?.agents.map((agent) => agent.state),
    ["done", "error"],
  );

  const unknownAgent = normalizePersistedWorkflowDetails("wf_unknown_agent", {
    status: "completed",
    agents: [{ index: 1, label: "unknown" }],
    phases: [],
  });
  assert.equal(unknownAgent?.status, "uncertain");
  assert.equal(unknownAgent?.agents[0]?.state, "uncertain");
});

test("an oversized workflow truncation stub cannot become completed", () => {
  const stub = JSON.parse(
    safeStringify(
      { status: "completed", payload: "x".repeat(2_000) },
      { maxBytes: 256 },
    ),
  );
  assert.equal(stub.truncated, true);
  assert.equal(
    normalizePersistedWorkflowDetails("wf_truncated", stub)?.status,
    "uncertain",
  );
});

test("a terminal persisted run cannot retain running agents", () => {
  const restored = normalizePersistedWorkflowDetails("wf_contradictory", {
    status: "completed",
    agents: [{ index: 1, label: "still running", state: "running" }],
    phases: [],
  });
  assert.equal(restored?.status, "uncertain");
  assert.equal(restored?.agents[0]?.state, "uncertain");
});

test("persisted transcripts retain exact tool call identities", () => {
  const details = normalizePersistedWorkflowDetails("wf_tools", {
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    phases: [],
    agents: [
      {
        index: 0,
        label: "worker",
        state: "completed",
        transcript: [
          {
            role: "tool",
            name: "read",
            toolCallId: "call-a",
            text: "a.ts",
          },
          {
            role: "tool",
            name: "read",
            toolCallId: "call-b",
            text: "b.ts",
          },
          {
            role: "toolResult",
            name: "read",
            toolCallId: "call-b",
            text: "beta",
          },
          {
            role: "toolResult",
            name: "read",
            toolCallId: "call-a",
            text: "alpha",
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    details?.agents[0]?.transcript.map((entry) => entry.toolCallId),
    ["call-a", "call-b", "call-b", "call-a"],
  );
});

test("stale recovery reconciles the run and every active agent", () => {
  const details = normalizePersistedWorkflowDetails("wf_stale", {
    status: "running",
    startedAt: 10,
    delivery: {
      id: "workflow:wf_stale:terminal",
      state: "held-for-inline",
      attempts: 0,
      updatedAt: 10,
    },
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

  assert.equal(details.status, "uncertain");
  assert.equal(details.finishedAt, 100);
  assert.equal(details.delivery?.state, "pending");
  assert.match(details.delivery?.lastError ?? "", /owner process ended/);
  assert.equal(details.agents[0]?.state, "uncertain");
  assert.equal(details.agents[0]?.finishedAt, 100);
  assert.equal(details.agents[1]?.state, "done");
  assert.equal(details.graph?.nodes[0]?.state, "uncertain");
});

test("stale pre-V2 runs gain a stable delivery identity while terminal legacy runs do not replay", () => {
  const stale = normalizePersistedWorkflowDetails("wf_legacy", {
    status: "running",
    startedAt: 10,
    agents: [],
    phases: [],
  })!;
  recoverStaleWorkflowDetails(stale, 100);
  assert.equal(stale.status, "uncertain");
  assert.equal(stale.delivery?.id, "workflow:wf_legacy");
  assert.equal(stale.delivery?.state, "pending");

  const terminal = normalizePersistedWorkflowDetails("wf_old_done", {
    status: "completed",
    startedAt: 10,
    finishedAt: 20,
    agents: [],
    phases: [],
  })!;
  recoverStaleWorkflowDetails(terminal, 100);
  assert.equal(terminal.delivery, undefined);
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
        transcript: [
          { role: "user", text: "Write the draft" },
          {
            role: "tool",
            name: "bash",
            text: '{"command":"git status\u001b]52;c;clipboard\u0007"}',
          },
        ],
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
    const transcript = dashboard.render(120).join("\n");
    assert.equal(transcript.split("\n").length, 30);
    assert.match(transcript, /writer/);
    assert.match(transcript, /git status/);
    assert.doesNotMatch(transcript, /╭|╮|Transcript/);
    assert.doesNotMatch(stripVTControlCharacters(transcript), /clipboard/);

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

test("Workflow transcript follows, pauses on its top row, and resumes", () => {
  const transcript = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant" as const,
    text: `line ${index}`,
  }));
  const details: WorkflowDetails = {
    runId: "wf_1234567890ab",
    sessionId: SESSION,
    name: "follow",
    background: false,
    status: "running",
    startedAt: Date.now() - 1_000,
    phases: [{ title: "Work" }],
    currentPhase: "Work",
    agents: [
      {
        index: 1,
        label: "worker",
        phase: "Work",
        state: "running",
        startedAt: Date.now() - 900,
        preview: "",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        transcript,
      },
    ],
  };
  writeRun(details.runId, details.startedAt);
  const dashboard = new WorkflowDashboard(
    {
      terminal: { rows: 20 },
      requestRender() {},
    } as unknown as TUI,
    {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
      italic: (text: string) => text,
    } as unknown as Theme,
    {
      matches(data: string, binding: string) {
        return data === binding.replace("tui.editor.cursor", "").toLowerCase();
      },
      getKeys: () => ["esc"],
    } as unknown as KeybindingsManager,
    () => new Map([[details.runId, details]]),
    SESSION,
    new Set(),
    0,
    () => {},
    details.runId,
  );

  try {
    dashboard.handleInput("right");
    dashboard.handleInput("right");
    const pinned = dashboard.render(80).join("\n");
    assert.match(pinned, /line 39/);
    assert.doesNotMatch(pinned, /line 0\b/);

    dashboard.handleInput("k");
    const paused = dashboard.render(80);
    const anchor = paused.find((line) => /line \d+/.test(line));
    assert.ok(anchor);
    assert.match(paused.join("\n"), /↓ \d+/);

    transcript.push(
      ...Array.from({ length: 5 }, (_, index) => ({
        role: "assistant" as const,
        text: `line ${40 + index}`,
      })),
    );
    assert.equal(
      dashboard.render(80).find((line) => /line \d+/.test(line)),
      anchor,
    );

    dashboard.handleInput("G");
    const resumed = dashboard.render(80).join("\n");
    assert.match(resumed, /line 44/);
    assert.doesNotMatch(resumed, /↓ \d+/);
  } finally {
    dashboard.dispose();
  }
});

test("live workflow dashboard repaints on the shared spinner cadence", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  writeRun("wf_123abc", Date.now());
  const details: WorkflowDetails = {
    runId: "wf_123abc",
    sessionId: SESSION,
    name: "spinner",
    status: "running",
    background: false,
    startedAt: Date.now(),
    phases: [],
    agents: [],
  };
  let renders = 0;
  const dashboard = new WorkflowDashboard(
    {
      terminal: { rows: 30 },
      requestRender() {
        renders += 1;
      },
    } as unknown as TUI,
    {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme,
    {
      matches: () => false,
      getKeys: () => ["esc"],
    } as unknown as KeybindingsManager,
    () => new Map([[details.runId, details]]),
    SESSION,
    new Set(),
    0,
    () => {},
  );
  try {
    t.mock.timers.tick(SPINNER_INTERVAL_MS - 1);
    assert.equal(renders, 0);
    t.mock.timers.tick(1);
    assert.equal(renders, 1);
  } finally {
    dashboard.dispose();
  }
});

test("settled child transcript does not repaint for another live run", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const settledId = "wf_aa1050";
  const liveId = "wf_bb1050";
  writeRun(settledId, Date.now() - 2_000, Date.now() - 1_000);
  writeRun(liveId, Date.now() - 500);
  const settled: WorkflowDetails = {
    runId: settledId,
    sessionId: SESSION,
    name: "settled",
    background: false,
    status: "completed",
    startedAt: Date.now() - 2_000,
    finishedAt: Date.now() - 1_000,
    phases: [{ title: "Work" }],
    agents: [
      {
        index: 1,
        label: "done",
        phase: "Work",
        state: "done",
        startedAt: Date.now() - 2_000,
        finishedAt: Date.now() - 1_000,
        preview: "complete",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
          turns: 1,
        },
        transcript: [{ role: "assistant", text: "complete" }],
      },
    ],
  };
  const live: WorkflowDetails = {
    runId: liveId,
    sessionId: SESSION,
    name: "live",
    background: false,
    status: "running",
    startedAt: Date.now() - 500,
    phases: [],
    agents: [],
  };
  let renders = 0;
  const dashboard = new WorkflowDashboard(
    {
      terminal: { rows: 20 },
      requestRender() {
        renders += 1;
      },
    } as unknown as TUI,
    {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as unknown as Theme,
    {
      matches(data: string, binding: string) {
        return data === binding.replace("tui.editor.cursor", "").toLowerCase();
      },
      getKeys: () => ["esc"],
    } as unknown as KeybindingsManager,
    () =>
      new Map([
        [settledId, settled],
        [liveId, live],
      ]),
    SESSION,
    new Set(),
    0,
    () => {},
    settledId,
  );
  try {
    dashboard.handleInput("right");
    dashboard.handleInput("right");
    renders = 0;
    t.mock.timers.tick(SPINNER_INTERVAL_MS * 2);
    assert.equal(renders, 0);
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
        { at: 1, text: "round 1: 3 found", kind: "pipeline-drop" },
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
  assert.equal(details?.logs?.[0]?.kind, "pipeline-drop");
  assert.ok(
    !/[\u0000-\u001f\u007f-\u009f]/.test(details?.logs?.[1]?.text ?? ""),
  );
  assert.equal(details?.logsDropped, 4);
});
