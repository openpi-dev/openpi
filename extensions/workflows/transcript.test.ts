import assert from "node:assert/strict";
import test from "node:test";
import {
  defineTool,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { AgentToolRenderLedger } from "../shared/agent-tool-renderer.ts";
import { AgentTranscriptRenderer } from "../shared/agent-transcript.ts";
import type { SubagentSnapshot } from "../subagents/src/domain.ts";
import { subagentTranscriptDocument } from "../subagents/src/ui/transcript.ts";
import type { TranscriptEntry } from "./model.ts";
import {
  WorkflowTranscriptRenderer,
  workflowTranscriptDocument,
} from "./transcript.ts";
import { bindWorkflowToolRenderer } from "./tool-renderer.ts";

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
