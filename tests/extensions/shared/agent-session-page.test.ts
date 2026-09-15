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

test("regular child page captures wheel scrolling only while focused", () => {
  const writes: string[] = [];
  const host = {
    mode: "regular",
    terminal: { rows: 20, write: (data: string) => writes.push(data) },
    requestRender() {},
  } as unknown as TUI;
  const rows = Array.from({ length: 60 }, (_, index) => `mouse row ${index}`);
  const page = new AgentSessionPage(host, theme, keybindings, {
    getState: () => ({
      id: "mouse",
      title: "mouse",
      status: "running",
      document: {
        items: [
          {
            kind: "assistant",
            parts: [{ type: "text", text: rows.join("\n\n") }],
          },
        ],
      },
    }),
    close() {},
  });
  const render = () => stripVTControlCharacters(page.render(80).join("\n"));
  try {
    assert.equal(writes.length, 0);
    page.focused = true;
    page.focused = true;
    assert.deepEqual(writes, ["\x1b[?1000h\x1b[?1006h"]);
    assert.match(render(), /mouse row 0\b/);
    page.handleInput("\x1b[<65;10;10M");
    assert.doesNotMatch(render(), /mouse row 0\b/);
    page.handleInput("\x1b[<64;10;10M");
    assert.match(render(), /mouse row 0\b/);
    // Wheel-up pauses following, even if output subsequently grows.
    rows.push("new tail");
    assert.match(render(), /mouse row 0\b/);
    page.handleInput("G");
    assert.match(render(), /new tail/);
    page.focused = false;
    assert.equal(writes.at(-1), "\x1b[?1000l\x1b[?1006l");
    page.focused = true;
  } finally {
    page.dispose();
  }
  assert.equal(writes.at(-1), "\x1b[?1000l\x1b[?1006l");
  const count = writes.length;
  page.dispose();
  page.focused = true;
  assert.equal(writes.length, count);
});

test("fullscreen child page uses host mouse dispatch without changing terminal modes", () => {
  const host = {
    mode: "fullscreen",
    terminal: {
      rows: 20,
      write() {
        assert.fail("fullscreen host owns mouse modes");
      },
    },
    requestRender() {},
  } as unknown as TUI;
  const page = new AgentSessionPage(host, theme, keybindings, {
    getState: () => ({
      ...state(),
      document: {
        items: [
          {
            kind: "assistant",
            parts: [
              {
                type: "text",
                text: Array.from({ length: 60 }, (_, i) => `wheel ${i}`).join(
                  "\n\n",
                ),
              },
            ],
          },
        ],
      },
    }),
    close() {},
  });
  page.focused = true;
  assert.match(page.render(80).join("\n"), /wheel 0\b/);
  const result = page.handleMouse({
    type: "wheel",
    button: "none",
    x: 10,
    y: 10,
    screenX: 10,
    screenY: 10,
    width: 80,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 6,
  });
  assert.equal(result?.handled, true);
  assert.doesNotMatch(page.render(80).join("\n"), /wheel 0\b/);
  page.dispose();
});

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

test("a child page reports output hidden in either direction", () => {
  // A /btw answer longer than one screen: the page opens at the beginning, so
  // the end is what sits off-screen and must be reported.
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
  // The question that prompted the answer is the first thing a reader sees.
  assert.match(openedText, /two questions/);
  assert.match(openedText, /answer line 0/);
  assert.match(openedText, /↓ \d+/);
  assert.doesNotMatch(openedText, /↑ \d+/);

  // Jumping to the end inverts which side is hidden, without resizing the page.
  page.handleInput("G");
  const atEnd = page.render(80);
  const atEndText = stripVTControlCharacters(atEnd.join("\n"));
  assert.equal(atEnd.length, 20);
  assert.match(atEndText, /answer line 59/);
  assert.match(atEndText, /↑ \d+/);
  assert.doesNotMatch(atEndText, /↓ \d+/);
});

test("a child page opens on the start of output that predates it", () => {
  // The reported /btw defect: two questions asked, and the answer to the first
  // was never visible because the page opened pinned to the transcript end.
  const answer = [
    "first heading",
    ...Array.from({ length: 15 }, (_, index) => `first detail ${index}`),
    "second heading",
    ...Array.from({ length: 15 }, (_, index) => `second detail ${index}`),
  ].join("\n\n");
  const state: AgentSessionPageState = {
    id: "btw-1",
    title: "by the way",
    status: "done",
    document: {
      items: [
        { kind: "user", text: "ask two things" },
        { kind: "assistant", parts: [{ type: "text", text: answer }] },
      ],
    },
  };

  const page = new AgentSessionPage(tui(30), theme, keybindings, {
    getState: () => state,
    close() {},
  });
  const text = stripVTControlCharacters(page.render(80).join("\n"));

  assert.match(text, /ask two things/);
  assert.match(text, /first heading/);
  assert.doesNotMatch(text, /second detail 14/);
});

test("a live child still follows output that arrives while it is watched", () => {
  // Anchoring at the start must not disable following for a running child.
  const rows = ["starting"];
  const page = new AgentSessionPage(tui(20), theme, keybindings, {
    getState: () => ({
      id: "sa-1",
      title: "live child",
      status: "running" as const,
      document: {
        items: rows.map((text) => ({
          kind: "assistant" as const,
          parts: [{ type: "text" as const, text }],
        })),
      },
    }),
    close() {},
  });

  page.render(80);
  for (let index = 0; index < 60; index += 1) rows.push(`streamed ${index}`);
  assert.match(
    stripVTControlCharacters(page.render(80).join("\n")),
    /streamed 59/,
  );
});

test("a busy child opens at the start and resumes following on demand", () => {
  const rows = Array.from({ length: 60 }, (_, index) => `existing ${index}`);
  const page = new AgentSessionPage(tui(20), theme, keybindings, {
    getState: () => ({
      id: "sa-2",
      title: "busy child",
      status: "running" as const,
      document: {
        items: rows.map((text) => ({
          kind: "assistant" as const,
          parts: [{ type: "text" as const, text }],
        })),
      },
    }),
    close() {},
  });

  assert.match(
    stripVTControlCharacters(page.render(80).join("\n")),
    /existing 0/,
  );

  page.handleInput("G");
  rows.push("arrived while following");
  assert.match(
    stripVTControlCharacters(page.render(80).join("\n")),
    /arrived while following/,
  );
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
