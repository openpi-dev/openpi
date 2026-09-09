import assert from "node:assert/strict";
import test from "node:test";
import type {
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  defineTool,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { withActivityRenderer } from "../../../extensions/file-mutation-display/render.ts";
import {
  AgentSessionPage,
  type AgentSessionPageState,
} from "../../../extensions/shared/agent-session-page.ts";
import { AgentToolRenderLedger } from "../../../extensions/shared/agent-tool-renderer.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
} as Theme;

const keybindings = {
  matches(data: string, binding: string) {
    return data === binding.replace("tui.editor.cursor", "").toLowerCase();
  },
  getKeys(binding: string) {
    return [binding.split(".").at(-1)?.toLowerCase() ?? binding];
  },
} as unknown as KeybindingsManager;

function tui(rows: number) {
  return { terminal: { rows }, requestRender() {} } as unknown as TUI;
}

function state(): AgentSessionPageState {
  return {
    id: "child-1",
    title: "child session",
    status: "running",
    metadata: ["model", "12%/100k"],
    document: {
      items: [
        { kind: "user", text: "Inspect the page" },
        { kind: "assistant", parts: [{ type: "text", text: "## Result" }] },
      ],
    },
  };
}

function bashState() {
  const toolRenderer = new AgentToolRenderLedger();
  const toolId = "bash-1";
  const command = "printf command-marker";
  const output = "output-marker\nsecond output line";
  toolRenderer.start(
    toolId,
    "bash",
    { command },
    defineTool(withActivityRenderer(createBashToolDefinition("/workspace"))),
  );
  toolRenderer.end(
    toolId,
    "bash",
    { content: [{ type: "text", text: output }] },
    false,
  );
  return {
    id: "child-bash",
    title: "bash evidence",
    status: "done" as const,
    document: {
      toolRenderer,
      cwd: "/workspace",
      items: [
        {
          kind: "assistant" as const,
          parts: [
            {
              type: "toolCall" as const,
              toolId,
              name: "bash",
              argsPreview: JSON.stringify({ command }),
            },
          ],
        },
        {
          kind: "toolResult" as const,
          toolId,
          name: "bash",
          isError: false,
          outputPreview: output,
        },
      ],
    },
  };
}

test("Direct and Workflow children use one read-only full-terminal page", () => {
  const direct = new AgentSessionPage(tui(18), theme, keybindings, {
    getState: state,
    close() {},
  });
  const workflow = new AgentSessionPage(tui(18), theme, keybindings, {
    getState: state,
    close() {},
  });

  const directLines = direct.render(60);
  const workflowLines = workflow.render(60);
  for (const lines of [directLines, workflowLines]) {
    assert.equal(lines.length, 18);
    assert.ok(lines.every((line) => visibleWidth(line) <= 60));
    assert.match(lines.join("\n"), /Inspect the page/);
    assert.match(lines.join("\n"), /Result/);
    assert.doesNotMatch(lines.join("\n"), /╭|╮|Transcript/);
  }
});

test("a read-only Workflow child returns left without stealing a parent session", () => {
  let closed = 0;
  const page = new AgentSessionPage(tui(18), theme, keybindings, {
    getState: state,
    close: () => {
      closed += 1;
    },
  });

  page.handleInput("left");
  assert.equal(closed, 1);
});

test("a child page toggles shared compact tool rows into Pi-native evidence", () => {
  let renders = 0;
  const page = new AgentSessionPage(
    {
      terminal: { rows: 24 },
      requestRender() {
        renders += 1;
      },
    } as unknown as TUI,
    theme,
    keybindings,
    { getState: bashState, close() {} },
  );
  const render = () => stripVTControlCharacters(page.render(100).join("\n"));

  const compact = render();
  assert.match(compact, /Ran\s+printf command-marker/);
  assert.doesNotMatch(compact, /output-marker/);
  assert.match(compact, /expand\s+expand tools/);

  page.handleInput("app.tools.expand");
  const expanded = render();
  assert.equal(renders, 1);
  assert.match(expanded, /output-marker/);
  assert.match(expanded, /second output line/);
  assert.match(expanded, /expand\s+collapse tools/);

  page.handleInput("app.tools.expand");
  const collapsedAgain = render();
  assert.equal(renders, 2);
  assert.match(collapsedAgain, /Ran\s+printf command-marker/);
  assert.doesNotMatch(collapsedAgain, /output-marker/);
});

test("a child page inherits an expanded parent state on its first render", () => {
  const page = new AgentSessionPage(
    tui(24),
    theme,
    keybindings,
    { getState: bashState, close() {} },
    { toolsExpanded: true },
  );

  assert.match(
    stripVTControlCharacters(page.render(100).join("\n")),
    /output-marker/,
  );
});

test("a child page reports an answer's opening scrolled above the viewport", () => {
  // A /btw answer longer than one screen: the page follows the end, so the
  // opening is off-screen and the reader must be told it exists.
  const long: AgentSessionPageState = {
    id: "btw-1",
    title: "by the way",
    status: "done",
    document: {
      items: [
        { kind: "user", text: "two questions" },
        {
          kind: "assistant",
          parts: [
            {
              type: "text",
              text: Array.from(
                { length: 60 },
                (_, index) => `answer line ${index}`,
              ).join("\n\n"),
            },
          ],
        },
      ],
    },
  };

  const page = new AgentSessionPage(tui(20), theme, keybindings, {
    getState: () => long,
    close() {},
  });
  const opened = page.render(80);
  const openedText = stripVTControlCharacters(opened.join("\n"));

  // The overlay still owns exactly the terminal rows it was given.
  assert.equal(opened.length, 20);
  assert.match(openedText, /↑ \d+/);
  assert.doesNotMatch(openedText, /↓ \d+/);

  // Jumping to the top inverts which side is hidden, without resizing the page.
  page.handleInput("g");
  const atTop = page.render(80);
  const atTopText = stripVTControlCharacters(atTop.join("\n"));
  assert.equal(atTop.length, 20);
  assert.match(atTopText, /answer line 0/);
  assert.match(atTopText, /↓ \d+/);
  assert.doesNotMatch(atTopText, /↑ \d+/);
});

test("a child page whose transcript fits shows no overflow markers", () => {
  const page = new AgentSessionPage(tui(24), theme, keybindings, {
    getState: state,
    close() {},
  });

  const text = stripVTControlCharacters(page.render(60).join("\n"));
  assert.doesNotMatch(text, /↑ \d+/);
  assert.doesNotMatch(text, /↓ \d+/);
});
