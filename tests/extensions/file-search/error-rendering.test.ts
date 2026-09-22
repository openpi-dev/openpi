import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  initTheme,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import fileSearch from "../../../extensions/file-search/index.ts";
import gitRead from "../../../extensions/git-read/index.ts";

initTheme("dark", false);

function registeredTools() {
  const tools: ToolDefinition[] = [];
  const pi = {
    on() {},
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;
  // Registration is lazy: no binary resolution, install, or Session starts.
  fileSearch(pi);
  gitRead(pi);
  return tools;
}

function componentFor(tool: ToolDefinition, args: Record<string, unknown>) {
  return new ToolExecutionComponent(
    tool.name,
    `call-${tool.name}`,
    args,
    { showImages: false },
    tool,
    { requestRender() {} } as TUI,
    process.cwd(),
  );
}

function visible(component: ToolExecutionComponent) {
  return component.render(140).map(stripVTControlCharacters).join("\n");
}

for (const tool of registeredTools()) {
  test(`${tool.name} preserves empty success and partial search status`, () => {
    const component = componentFor(tool, { pattern: "needle" });
    component.updateResult({ content: [], isError: false }, true);
    if (tool.name === "fd" || tool.name === "rg") {
      assert.match(visible(component), /Searching/);
    }
    component.updateResult({
      content: [{ type: "text", text: "" }],
      details: {
        command: "read",
        matchCount: 0,
        outputLines: 0,
        lineCount: 0,
        truncated: false,
      },
      isError: false,
    });
    assert.doesNotMatch(visible(component), /failed|undefined/);
    if (tool.name === "fd") assert.match(visible(component), /No files found/);
    if (tool.name === "rg")
      assert.match(visible(component), /No matches found/);
  });

  test(`${tool.name} preserves failed result evidence in both display modes`, () => {
    const component = componentFor(tool, { pattern: "needle" });
    for (const details of [undefined, {}]) {
      const result = {
        content: [
          {
            type: "text" as const,
            text: "Permission denied\n\u001b]0;spoofed-title\u0007Try a readable path",
          },
        ],
        details,
        isError: true,
      };
      const before = JSON.stringify(result);
      component.updateResult(result);
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        const output = visible(component);
        assert.match(output, /failed/i);
        assert.match(output, /Permission denied/);
        assert.match(output, /Try a readable path/);
        assert.doesNotMatch(output, /spoofed-title|undefined|No .* found/);
      }
      assert.equal(
        JSON.stringify(result),
        before,
        "projection must not mutate evidence",
      );
    }
  });

  test(`${tool.name} bounds long error previews and preserves success artifacts`, () => {
    const component = componentFor(tool, { pattern: "needle" });
    component.updateResult({
      content: [
        {
          type: "text",
          text: Array.from({ length: 25 }, (_, i) => `error-line-${i}`).join(
            "\n",
          ),
        },
      ],
      isError: true,
    });
    assert.match(visible(component), /error-line-19/);
    assert.doesNotMatch(visible(component), /error-line-20/);
    assert.match(visible(component), /5 more lines/);
    component.updateResult({
      content: [{ type: "text", text: "success-output" }],
      details: {
        command: "read",
        matchCount: 1,
        outputLines: 1,
        lineCount: 1,
        truncated: true,
        fullOutputPath: "/tmp/proof/output.txt",
      },
      isError: false,
    });
    assert.match(visible(component), /truncated/);
    assert.doesNotMatch(visible(component), /failed|success-output/);
    component.setExpanded(true);
    assert.match(visible(component), /success-output/);
    assert.match(visible(component), /Full output: \/tmp\/proof\/output.txt/);
  });
}

test("native Agent execution errors reach the real Git tool renderer", async () => {
  const definitions = registeredTools().filter((tool) =>
    tool.name.startsWith("git_"),
  );
  const argsFor = (name: string) =>
    name === "git_diff"
      ? { from: "openpi-test-nonexistent-revision" }
      : { revision: "openpi-test-nonexistent-revision" };
  let requested = false;
  const agent = new Agent({
    initialState: {
      tools: definitions.map((tool) => ({
        ...tool,
        execute: (id, args, signal, update) =>
          tool.execute(id, args, signal, update, {
            cwd: process.cwd(),
          } as ExtensionContext),
      })),
    },
    streamFn() {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: requested
          ? [{ type: "text", text: "done" }]
          : definitions.map((tool) => ({
              type: "toolCall",
              id: `call-${tool.name}`,
              name: tool.name,
              arguments: argsFor(tool.name),
            })),
        api: "openai-completions",
        provider: "synthetic",
        model: "synthetic",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: requested ? "stop" : "toolUse",
        timestamp: Date.now(),
      };
      requested = true;
      stream.push({
        type: "done",
        reason: message.stopReason as "stop" | "toolUse",
        message,
      });
      stream.end();
      return stream;
    },
  });
  await agent.prompt("Run synthetic read-only failure fixtures.");
  const results = agent.state.messages.filter(
    (message) => message.role === "toolResult",
  );
  assert.equal(results.length, definitions.length);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /unknown revision|bad revision|not a git repository/,
    );
    const definition = definitions.find(
      (tool) => tool.name === result.toolName,
    )!;
    const component = componentFor(definition, argsFor(definition.name));
    component.updateResult(result);
    assert.match(visible(component), /failed/i);
    assert.match(
      visible(component),
      /unknown revision|bad revision|not a git repository/,
    );
  }
});
