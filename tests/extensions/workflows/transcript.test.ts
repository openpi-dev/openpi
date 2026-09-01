import assert from "node:assert/strict";
import test from "node:test";
import {
  createBashToolDefinition,
  defineTool,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { withActivityRenderer } from "../../../extensions/file-mutation-display/render.ts";
import { AgentToolRenderLedger } from "../../../extensions/shared/agent-tool-renderer.ts";
import { AgentTranscriptRenderer } from "../../../extensions/shared/agent-transcript.ts";
import type { SubagentSnapshot } from "../../../extensions/subagents/src/domain.ts";
import { subagentTranscriptDocument } from "../../../extensions/subagents/src/ui/transcript.ts";
import type { TranscriptEntry } from "../../../extensions/workflows/model.ts";
import {
  WorkflowTranscriptRenderer,
  workflowTranscriptDocument,
} from "../../../extensions/workflows/transcript.ts";
import { bindWorkflowToolRenderer } from "../../../extensions/workflows/tool-renderer.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

function directSnapshot(): SubagentSnapshot {
  return {
    id: "sa-1",
    origin: "model",
    backend: "pi",
    title: "shared fixture",
    prompt: "shared fixture",
    cwd: "/repo",
    status: "done",
    createdAt: 0,
    settledAt: 1,
    meta: { backend: "pi" },
    usage: {},
    transcriptVersion: 0,
    transcript: [
      { kind: "user", text: "请检查 **状态**" },
      {
        kind: "assistant",
        parts: [
          { type: "text", text: "先列出：\n\n- one\n- two" },
          { type: "thinking", text: "核对 `git status`" },
          {
            type: "toolCall",
            toolId: "call-1",
            name: "bash",
            argsPreview: '{"command":"git status"}',
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: "call-1",
        name: "bash",
        isError: false,
        outputPreview: "clean",
      },
    ],
    liveTools: [],
    queued: [],
    finalText: "先列出",
    turns: 1,
  };
}

function workflowEntries(): TranscriptEntry[] {
  return [
    { role: "user", text: "请检查 **状态**" },
    { role: "assistant", text: "先列出：\n\n- one\n- two" },
    { role: "thinking", text: "核对 `git status`" },
    {
      role: "tool",
      name: "bash",
      toolCallId: "call-1",
      text: '{"command":"git status"}',
    },
    {
      role: "toolResult",
      name: "bash",
      toolCallId: "call-1",
      text: "clean",
    },
  ];
}

test("Direct and Workflow adapters render one equivalent conversation body", () => {
  const direct = directSnapshot();
  const workflow = workflowEntries();

  assert.deepEqual(
    subagentTranscriptDocument(direct),
    workflowTranscriptDocument(workflow, direct.cwd),
  );
  assert.deepEqual(
    new AgentTranscriptRenderer().render(
      subagentTranscriptDocument(direct),
      36,
      theme,
      { now: 0 },
    ),
    new WorkflowTranscriptRenderer().render(workflow, direct.cwd, 36, theme, {
      now: 0,
    }),
  );
});

test("Workflow children use the same native renderer as Direct children", () => {
  const definition = defineTool({
    name: "future_tool",
    label: "Future Tool",
    description: "synthetic future extension tool",
    parameters: Type.Object({ value: Type.String() }),
    execute: async () => ({
      content: [{ type: "text", text: "unused" }],
      details: undefined,
    }),
    renderCall: (args) => new Text(`native future ${args.value}`, 0, 0),
    renderResult: () => new Text("native result", 0, 0),
  });
  const renderer = new AgentToolRenderLedger();
  renderer.start("future-1", "future_tool", { value: "works" }, definition);
  renderer.end(
    "future-1",
    "future_tool",
    { content: [{ type: "text", text: "done" }] },
    false,
  );
  const workflow = bindWorkflowToolRenderer(
    [
      {
        role: "tool" as const,
        name: "future_tool",
        toolCallId: "future-1",
        text: '{"value":"works"}',
      },
      {
        role: "toolResult" as const,
        name: "future_tool",
        toolCallId: "future-1",
        text: "done",
      },
    ],
    renderer,
  );
  const direct: SubagentSnapshot = {
    ...directSnapshot(),
    transcript: [
      {
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            toolId: "future-1",
            name: "future_tool",
            argsPreview: '{"value":"works"}',
          },
        ],
      },
      {
        kind: "toolResult",
        toolId: "future-1",
        name: "future_tool",
        isError: false,
        outputPreview: "done",
      },
    ],
  };

  const directLines = new AgentTranscriptRenderer().render(
    subagentTranscriptDocument(direct, renderer),
    80,
    theme,
    { now: 0 },
  );
  const workflowLines = new WorkflowTranscriptRenderer().render(
    workflow,
    direct.cwd,
    80,
    theme,
    { now: 0 },
  );
  assert.deepEqual(workflowLines, directLines);
  assert.match(workflowLines.join("\n"), /native future works/);
  assert.match(workflowLines.join("\n"), /native result/);
});

test("Direct and Workflow children share compact and expanded Pi tool evidence", () => {
  const toolId = "bash-1";
  const command = "printf shared-command";
  const output = "shared-output\nsecond shared line";
  const renderer = new AgentToolRenderLedger();
  renderer.start(
    toolId,
    "bash",
    { command },
    defineTool(withActivityRenderer(createBashToolDefinition("/workspace"))),
  );
  renderer.end(
    toolId,
    "bash",
    { content: [{ type: "text", text: output }] },
    false,
  );
  const direct: SubagentSnapshot = {
    ...directSnapshot(),
    cwd: "/workspace",
    transcript: [
      {
        kind: "assistant",
        parts: [
          {
            type: "toolCall",
            toolId,
            name: "bash",
            argsPreview: JSON.stringify({ command }),
          },
        ],
      },
      {
        kind: "toolResult",
        toolId,
        name: "bash",
        isError: false,
        outputPreview: output,
      },
    ],
  };
  const workflow = bindWorkflowToolRenderer(
    [
      {
        role: "tool" as const,
        name: "bash",
        toolCallId: toolId,
        text: JSON.stringify({ command }),
      },
      {
        role: "toolResult" as const,
        name: "bash",
        toolCallId: toolId,
        text: output,
      },
    ],
    renderer,
  );

  for (const expanded of [false, true]) {
    const directLines = new AgentTranscriptRenderer().render(
      subagentTranscriptDocument(direct, renderer),
      100,
      theme,
      { now: 0, expanded },
    );
    const workflowLines = new WorkflowTranscriptRenderer().render(
      workflow,
      direct.cwd,
      100,
      theme,
      { now: 0, expanded },
    );
    assert.deepEqual(workflowLines, directLines);
    const rendered = stripVTControlCharacters(workflowLines.join("\n"));
    assert.match(rendered, /printf shared-command/);
    if (expanded) {
      assert.match(rendered, /shared-output/);
      assert.match(rendered, /second shared line/);
    } else {
      assert.doesNotMatch(rendered, /shared-output/);
    }
  }
});

test("old Workflow transcript entries without call ids remain renderable", () => {
  const lines = new WorkflowTranscriptRenderer().render(
    [
      { role: "tool", name: "read", text: '{"path":"/repo/a.ts"}' },
      { role: "toolResult", name: "read", text: "contents" },
    ],
    "/repo",
    40,
    theme,
    { now: 0 },
  );

  assert.deepEqual(lines, ["", "   Read     a.ts  "]);
});

test("explicit results consume pending calls before legacy id fallback", () => {
  const lines = new WorkflowTranscriptRenderer().render(
    [
      {
        role: "tool",
        name: "read",
        toolCallId: "explicit",
        text: '{"path":"a.ts"}',
      },
      {
        role: "toolResult",
        name: "read",
        toolCallId: "explicit",
        text: "alpha",
      },
      { role: "tool", name: "read", text: '{"path":"b.ts"}' },
      { role: "toolResult", name: "read", text: "beta" },
    ],
    undefined,
    80,
    theme,
    { now: 0 },
  );

  assert.deepEqual(lines, [
    "",
    "   Read     a.ts  ",
    "",
    "   Read     b.ts  ",
  ]);
});
