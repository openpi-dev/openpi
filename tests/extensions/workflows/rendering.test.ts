import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentToolResult,
  type ExtensionAPI,
  initTheme,
  type MessageRenderer,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SPINNER_INTERVAL_MS } from "../../../extensions/shared/spinner.ts";
import {
  buildWorkflowCompletionDisplay,
  isWorkflowCompletionDisplay,
} from "../../../extensions/workflows/completion-projection.ts";
import workflows from "../../../extensions/workflows/index.ts";
import {
  emptyUsage,
  type WorkflowDetails,
} from "../../../extensions/workflows/model.ts";

initTheme("dark", false);

const theme = new Proxy(
  {},
  {
    get: (_target, property) =>
      property === "fg" || property === "bg"
        ? (_color: string, text: string) => text
        : (text: string) => text,
  },
) as Theme;

function runningWorkflow(): WorkflowDetails {
  return {
    runId: "wf_render",
    name: "render-check",
    status: "running",
    background: false,
    startedAt: 0,
    phases: [],
    agents: [],
  };
}

function finishedWorkflow(
  overrides: Partial<WorkflowDetails> = {},
): WorkflowDetails {
  return {
    runId: "wf_finished",
    name: "render-check",
    status: "completed",
    background: true,
    startedAt: 0,
    finishedAt: 293_000,
    phases: [{ title: "audit" }],
    agents: [
      {
        index: 1,
        label: "reviewer",
        state: "done",
        startedAt: 0,
        finishedAt: 293_000,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
    ],
    logs: [{ at: 1, text: "ordinary diagnostic log" }],
    result: { verdict: "ship it" },
    ...overrides,
  };
}

function captureRenderers() {
  const tools = new Map<string, ToolDefinition>();
  const messages = new Map<string, MessageRenderer>();
  const pi = {
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerMessageRenderer(type: string, renderer: MessageRenderer) {
      messages.set(type, renderer);
    },
    registerCommand() {},
    on() {},
    getThinkingLevel: () => "off",
    getActiveTools: () => [],
    setActiveTools() {},
    sendMessage() {},
  } as unknown as ExtensionAPI;
  workflows(pi);
  const workflow = tools.get("workflow");
  const message = messages.get("workflow-result");
  assert.ok(workflow?.renderResult);
  assert.ok(message);
  return { workflow, message };
}

test("workflow tool errors with malformed details fall back to plain text", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { workflow } = captureRenderers();
  const renderResult = workflow.renderResult!;
  const errorText = "Workflow script failed to parse: Unexpected token (1:7)";
  let invalidations = 0;
  const context = {
    args: {},
    toolCallId: "call-parse-error",
    invalidate: () => {
      invalidations += 1;
    },
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: true,
  } as Parameters<typeof renderResult>[3];

  for (const details of [{}, { runId: "wf_incomplete", agents: [] }]) {
    const component = renderResult(
      {
        content: [{ type: "text", text: errorText }],
        details,
      } as unknown as AgentToolResult<WorkflowDetails>,
      { expanded: false, isPartial: false },
      theme,
      context,
    );

    assert.equal(component.render(100).join("\n").trimEnd(), errorText);
  }
  t.mock.timers.tick(SPINNER_INTERVAL_MS);
  assert.equal(invalidations, 0);
});

test("running workflow cards request and render each shared spinner frame", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  const { workflow } = captureRenderers();
  const renderResult = workflow.renderResult!;

  for (const expanded of [false, true]) {
    const details = runningWorkflow();
    const result: AgentToolResult<WorkflowDetails> = {
      content: [{ type: "text", text: "running" }],
      details,
    };
    let invalidations = 0;
    const context = {
      args: {},
      toolCallId: `call-${expanded}`,
      invalidate: () => {
        invalidations += 1;
      },
      lastComponent: undefined,
      state: {},
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded,
      showImages: false,
      isError: false,
    } as Parameters<typeof renderResult>[3];
    const component = renderResult(
      result,
      { expanded, isPartial: true },
      theme,
      context,
    );
    const first = component.render(100)[0];

    t.mock.timers.tick(SPINNER_INTERVAL_MS);

    const next = component.render(100)[0];
    assert.equal(invalidations, 1, `expanded=${expanded}`);
    assert.notEqual(first, next, `expanded=${expanded}`);

    details.status = "completed";
    t.mock.timers.tick(SPINNER_INTERVAL_MS);
    assert.equal(invalidations, 2, `terminal repaint expanded=${expanded}`);
    t.mock.timers.tick(SPINNER_INTERVAL_MS);
    assert.equal(invalidations, 2, `timer stopped expanded=${expanded}`);
    assert.match(component.render(100)[0] ?? "", /✓/);
  }
});

test("running workflow result messages let the glyph carry the state", () => {
  const { message } = captureRenderers();
  const component = message(
    {
      role: "custom",
      customType: "workflow-result",
      content: "still working",
      display: true,
      details: runningWorkflow(),
      timestamp: Date.now(),
    },
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(component);
  const rendered = component.render(100).join("\n");
  assert.match(rendered, /workflow render-check/);
  assert.doesNotMatch(rendered, /\brunning\b/);
});

test("single completion keeps success diagnostics behind expansion", () => {
  const { message } = captureRenderers();
  const details = finishedWorkflow();
  const display = buildWorkflowCompletionDisplay([
    {
      deliveryId: "workflow:wf_finished:terminal",
      details,
      runDir: "/tmp/wf_finished",
    },
  ]);
  assert.equal(display.runId, details.runId);
  const component = message(
    {
      role: "custom",
      customType: "workflow-result",
      content:
        'Background workflow "render-check" (wf_finished) finished.\n\nfull model payload',
      display: true,
      details: display,
      timestamp: Date.now(),
    },
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(component);
  const collapsed = component.render(120).join("\n");
  assert.equal((collapsed.match(/render-check/g) ?? []).length, 1);
  assert.equal((collapsed.match(/1\/1 agents/g) ?? []).length, 1);
  assert.equal((collapsed.match(/4m53s/g) ?? []).length, 1);
  assert.match(collapsed, /Result:.*ship it/);
  assert.doesNotMatch(
    collapsed,
    /Background workflow|Run dir:|Log:|Agents:|Delivery id:/,
  );
  assert.doesNotMatch(collapsed, /ordinary diagnostic log/);

  const expanded = message(
    {
      role: "custom",
      customType: "workflow-result",
      content: "model-only transport wrapper",
      display: true,
      details: buildWorkflowCompletionDisplay([
        {
          deliveryId: "workflow:wf_finished:terminal",
          details,
          runDir: "/tmp/wf_finished",
        },
      ]),
      timestamp: Date.now(),
    },
    { expanded: true, outputPad: 0 },
    theme,
  );
  assert.ok(expanded);
  const full = expanded.render(120).join("\n");
  assert.match(full, /Run dir: \/tmp\/wf_finished/);
  assert.match(full, /^Log: *$/m);
  assert.match(full, /^Agents: *$/m);
  assert.match(full, /Delivery id: workflow:wf_finished:terminal/);
  assert.doesNotMatch(full, /model-only transport wrapper|Background workflow/);
});

test("malformed completion display fails closed to sanitized message content", () => {
  const { message } = captureRenderers();
  const body = "fallback body\u001b]52;c;clipboard\u0007";
  const component = message(
    {
      role: "custom",
      customType: "workflow-result",
      content: body,
      display: true,
      details: {
        version: 1,
        entries: [
          {
            deliveryId: "delivery-bad",
            runDir: "/tmp/wf_bad",
            details: { runId: "wf_bad", agents: [null] },
          },
        ],
      },
      timestamp: Date.now(),
    },
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(component);
  const rendered = component.render(100).join("\n");
  assert.equal(rendered.trimEnd(), "fallback body");
  assert.doesNotMatch(rendered, /[\u001b\u0007]/);
});

test("completion display is a bounded operator projection, not runtime state", () => {
  const entries = Array.from({ length: 64 }, (_, runIndex) => {
    const runId = `wf_${runIndex.toString(16).padStart(4, "0")}`;
    return {
      deliveryId: `delivery-${runIndex}-${"d".repeat(1_000)}`,
      runDir: `/tmp/${runId}`,
      details: finishedWorkflow({
        runId,
        name: `batch-${runIndex}-${"n".repeat(1_000)}`,
        agents: Array.from({ length: 128 }, (_, agentIndex) => ({
          index: agentIndex + 1,
          label: `agent-${agentIndex}-${"a".repeat(500)}`,
          state: agentIndex % 17 === 0 ? ("error" as const) : ("done" as const),
          startedAt: 0,
          finishedAt: 293_000,
          error: agentIndex % 17 === 0 ? "failed" : undefined,
          preview: "p".repeat(2_000),
          usage: emptyUsage(),
          transcript: [
            { role: "assistant" as const, text: "t".repeat(10_000) },
          ],
        })),
        logs: Array.from({ length: 100 }, (_, index) => ({
          at: index,
          text: `log-${index}-${"l".repeat(300)}`,
        })),
        result: { evidence: "r".repeat(100_000) },
      }),
    };
  });
  const display = buildWorkflowCompletionDisplay(entries);
  const encoded = JSON.stringify(display);
  assert.ok(Buffer.byteLength(encoded, "utf8") <= 64 * 1024);
  assert.equal(isWorkflowCompletionDisplay(display), true);
  assert.doesNotMatch(encoded, /"details"|"agents"|"logs"|"transcript"/);
  assert.ok(display.entries.every((entry) => entry.expanded.length > 0));
  assert.equal(
    isWorkflowCompletionDisplay({
      ...display,
      entries: display.entries.map((entry) => ({
        ...entry,
        details: { agents: [null] },
      })),
    }),
    false,
  );
});

test("batch completion foregrounds abnormal evidence within width", () => {
  const { message } = captureRenderers();
  const failed = finishedWorkflow({
    runId: "wf_failed",
    name: "failed\u001b]52;c;clipboard\u0007",
    status: "failed",
    error: "top-level failure",
    logs: [
      { at: 1, text: "ordinary log" },
      { at: 2, text: "coverage complete: no items dropped" },
      {
        at: 3,
        text: "pipeline: item 2 dropped — stage failed",
        kind: "pipeline-drop",
      },
      { at: 4, text: "项目被丢弃：上游结果为空" },
    ],
    logsDropped: 3,
    agents: [
      {
        index: 1,
        label: "owner-lost",
        state: "uncertain",
        startedAt: 0,
        finishedAt: 293_000,
        preview: "",
        usage: emptyUsage(),
        transcript: [],
      },
      {
        index: 2,
        label: "writer",
        state: "error",
        startedAt: 0,
        finishedAt: 293_000,
        error: "failed",
        preview: "",
        usage: emptyUsage(),
        worktreePath: "/repo/.git/pi-worktrees/writer",
        worktreeHandoffArtifact: "worktrees/writer.json",
        worktreeCleanup: {
          removed: false,
          branchDeleted: false,
          branch: "pi/writer",
          detached: false,
          reason: "uncommitted changes",
        },
        transcript: [],
      },
    ],
  });
  const completed = finishedWorkflow({
    runId: "wf_ok",
    name: "ok-run",
    startedAt: 292_000,
    finishedAt: 293_000,
    agents: [
      {
        index: 1,
        label: "writer-ok",
        state: "done",
        startedAt: 292_000,
        finishedAt: 293_000,
        preview: "",
        usage: emptyUsage(),
        worktreeBranch: "pi/writer-ok",
        worktreeHandoffArtifact: "worktrees/writer-ok.json",
        worktreeCleanup: {
          removed: true,
          branchDeleted: false,
          branch: "pi/writer-ok",
          detached: false,
          commits: 1,
        },
        transcript: [],
      },
    ],
  });
  const component = message(
    {
      role: "custom",
      customType: "workflow-result",
      content: "full batch model payload",
      display: true,
      details: buildWorkflowCompletionDisplay([
        { deliveryId: "delivery-failed", details: failed, runDir: "/tmp/f" },
        { deliveryId: "delivery-ok", details: completed, runDir: "/tmp/o" },
      ]),
      timestamp: Date.now(),
    },
    { expanded: false, outputPad: 0 },
    theme,
  );
  assert.ok(component);
  const rows = component.render(56);
  const collapsed = rows.join("\n");
  assert.match(collapsed, /workflow failed/);
  assert.match(collapsed, /Failed agents: writer/);
  assert.match(collapsed, /Uncertain agents: owner-lost/);
  assert.match(collapsed, /3 earlier log line\(s\) dropped/);
  assert.match(collapsed, /Dropped work: pipeline: item 2 dropped/);
  assert.match(collapsed, /Dropped work: 项目被丢弃/);
  assert.doesNotMatch(collapsed, /Dropped work: coverage complete/);
  assert.match(collapsed, /Retained worktree \[writer\]/);
  assert.match(collapsed, /workflow ok-run/);
  assert.match(collapsed, /Worktree handoff \[writer-ok\]/);
  assert.doesNotMatch(collapsed, /ordinary log|Run dir:|Delivery id:/);
  assert.doesNotMatch(collapsed, /\]52|\u0007/);
  assert.ok(rows.every((row) => visibleWidth(row) <= 56));
  assert.match(
    component.render(120).join("\n"),
    /Worktree handoff \[writer-ok\]: 1 commit on pi\/writer-ok; worktrees\/writer-ok.json/,
  );
  for (const width of [1, 2, 3, 4, 8, 12]) {
    assert.ok(
      component.render(width).every((row) => visibleWidth(row) <= width),
      `width ${width}`,
    );
  }
});
