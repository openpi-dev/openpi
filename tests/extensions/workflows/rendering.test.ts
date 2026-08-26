import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  initTheme,
  type AgentToolResult,
  type ExtensionAPI,
  type MessageRenderer,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SPINNER_INTERVAL_MS } from "../../../extensions/shared/spinner.ts";
import workflows from "../../../extensions/workflows/index.ts";
import type { WorkflowDetails } from "../../../extensions/workflows/model.ts";

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

test("workflow launch schema accepts only the positive wait policy", () => {
  const { workflow } = captureRenderers();
  const parameters = workflow.parameters as unknown as {
    properties?: Record<string, unknown>;
    additionalProperties?: boolean;
  };

  assert.ok(parameters.properties?.wait);
  assert.equal(parameters.properties?.background, undefined);
  assert.equal(parameters.additionalProperties, false);

  const toolCall = (args: Record<string, unknown>) => ({
    type: "toolCall" as const,
    id: "call-schema",
    name: "workflow",
    arguments: args,
  });
  const script = "return 1;";

  assert.deepEqual(
    validateToolArguments(workflow, toolCall({ script, wait: false })),
    { script, wait: false },
  );
  assert.throws(
    () =>
      validateToolArguments(workflow, toolCall({ script, background: true })),
    /Validation failed.*background/s,
  );
  assert.throws(
    () => validateToolArguments(workflow, toolCall({ script, detached: true })),
    /Validation failed.*detached/s,
  );
});

test("workflow call rendering labels an explicit inline wait", () => {
  const { workflow } = captureRenderers();
  assert.ok(workflow.renderCall);
  const args = {
    script: 'export const meta = { name: "inline" }; return 1;',
    wait: true,
  };

  const component = workflow.renderCall(args, theme, {
    args,
    toolCallId: "call-inline-wait",
    invalidate() {},
    lastComponent: undefined,
    state: {},
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  });

  assert.match(component.render(100).join("\n"), /workflow inline \(wait\)/);
});

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
