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
import { buildWorkflowCompletionDisplay } from "../../../extensions/workflows/completion-projection.ts";
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

test("batch completion foregrounds abnormal evidence within width", () => {
  const { message } = captureRenderers();
  const failed = finishedWorkflow({
    runId: "wf_failed",
    name: "failed\u001b]52;c;clipboard\u0007",
    status: "failed",
    error: "top-level failure",
    logs: [
      { at: 1, text: "ordinary log" },
      { at: 2, text: "pipeline: item 2 dropped — stage failed" },
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
  assert.match(collapsed, /Retained worktree \[writer\]/);
  assert.match(collapsed, /workflow ok-run/);
  assert.doesNotMatch(collapsed, /ordinary log|Run dir:|Delivery id:/);
  assert.doesNotMatch(collapsed, /\]52|\u0007/);
  assert.ok(rows.every((row) => visibleWidth(row) <= 56));
});
