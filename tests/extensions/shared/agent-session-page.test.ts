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
    assert.match(render(), /mouse row 59\b/);
    page.handleInput("g");
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
  assert.match(page.render(80).join("\n"), /wheel 59\b/);
  page.handleInput("g");
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

test("Direct and Workflow children use one read-only full-terminal page", (t) => {
  t.mock.method(Date, "now", () => 0);
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
  assert.deepEqual(directLines, workflowLines);
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

test("a busy child opens at the latest output, pauses and resumes following", () => {
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

  const render = () => stripVTControlCharacters(page.render(80).join("\n"));
  assert.match(render(), /existing 59/);
  assert.match(render(), /following/);
  rows.push("immediate tail");
  assert.match(render(), /immediate tail/);

  page.handleInput("up");
  const paused = render();
  assert.match(paused, /paused/);
  rows.push("hidden while paused");
  assert.equal(
    render().split("\n").slice(1, 17).join("\n"),
    paused.split("\n").slice(1, 17).join("\n"),
  );
  assert.doesNotMatch(render(), /hidden while paused/);
  page.handleInput("\x1b[F");
  assert.match(render(), /hidden while paused/);
  assert.match(render(), /following/);

  page.handleInput("up");
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

for (const status of ["done", "error", "uncertain"] as const) {
  test(`${status} history opens at its question; settlement does not reset a running page`, () => {
    let current: AgentSessionPageState = {
      ...state(),
      status,
      ...(status === "error" ? { errorText: "cancelled or failed" } : {}),
      document: {
        items: [
          { kind: "user", text: "original question" },
          {
            kind: "assistant",
            parts: [
              {
                type: "text",
                text: Array.from({ length: 60 }, (_, i) => `history ${i}`).join(
                  "\n\n",
                ),
              },
            ],
          },
        ],
      },
    };
    const source = { getState: () => current, close() {} };
    const history = new AgentSessionPage(tui(20), theme, keybindings, source);
    const text = stripVTControlCharacters(history.render(80).join("\n"));
    assert.match(text, /original question/);
    assert.doesNotMatch(text, /history 59/);
    current = { ...current, status: "running" };
    const watching = new AgentSessionPage(tui(20), theme, keybindings, source);
    assert.match(
      stripVTControlCharacters(watching.render(80).join("\n")),
      /history 59/,
    );
    current = { ...current, status };
    assert.match(
      stripVTControlCharacters(watching.render(80).join("\n")),
      /history 59/,
    );
  });
}

test("both child pages expand historical evidence through the configured host binding", () => {
  const legacy: AgentSessionPageState = {
    ...state(),
    status: "done",
    document: {
      items: [
        {
          kind: "toolResult",
          toolId: "old",
          name: "bash",
          isError: false,
          outputPreview: "retained preview",
        },
      ],
    },
  };
  const direct = new AgentSessionPage(tui(24), theme, keybindings, {
    getState: () => legacy,
    close() {},
  });
  const workflow = new AgentSessionPage(tui(24), theme, keybindings, {
    getState: () => legacy,
    close() {},
  });
  for (const page of [direct, workflow]) {
    assert.doesNotMatch(
      page.render(80).join("\n"),
      /native details unavailable/,
    );
    page.handleInput("app.tools.expand");
    const text = stripVTControlCharacters(page.render(80).join("\n"));
    assert.match(text, /native details unavailable/);
    assert.match(text, /Arguments preview unavailable/);
    assert.match(text, /retained preview/);
    page.handleInput("app.tools.expand");
    assert.doesNotMatch(
      page.render(80).join("\n"),
      /native details unavailable/,
    );
  }
  assert.deepEqual(direct.render(80), workflow.render(80));
});

test("a mounted child page measures only its supplied editor rows on each render", () => {
  let available = 12;
  const widths: number[] = [];
  const source = {
    getState: () => ({
      ...state(),
      document: {
        items: [
          {
            kind: "assistant" as const,
            parts: [
              {
                type: "text" as const,
                text: Array.from(
                  { length: 60 },
                  (_, i) => `viewport ${i}`,
                ).join("\n\n"),
              },
            ],
          },
        ],
      },
    }),
    close() {},
  };
  const page = new AgentSessionPage(
    tui(30),
    theme,
    keybindings,
    source,
    undefined,
    (width) => {
      widths.push(width);
      return available;
    },
  );
  const first = page.render(80);
  assert.equal(first.length, 12);
  assert.match(stripVTControlCharacters(first.join("\n")), /viewport 59/);
  available = 18;
  assert.equal(page.render(60).length, 18);
  assert.deepEqual(widths, [80, 60]);
  available = 0;
  assert.equal(page.render(60).length, 1);
  const defaultPage = new AgentSessionPage(tui(30), theme, keybindings, source);
  assert.equal(defaultPage.render(80).length, 30);
});

test("tiny child viewport exposes back first, bounds chrome and preserves paused position", (t) => {
  t.mock.method(Date, "now", () => 0);
  let available = 20;
  const source = {
    getState: () => ({
      ...state(),
      title: "中文标题\x1b[2J\x07",
      document: {
        items: [
          {
            kind: "assistant" as const,
            parts: [
              {
                type: "text" as const,
                text: Array.from({ length: 60 }, (_, i) => `tiny ${i}`).join(
                  "\n\n",
                ),
              },
            ],
          },
        ],
      },
    }),
    close() {},
  };
  const page = new AgentSessionPage(
    tui(30),
    theme,
    keybindings,
    source,
    undefined,
    () => available,
  );
  page.render(80);
  page.handleInput("up");
  const paused = page.render(80);
  for (available of [1, 2, 3]) {
    const lines = page.render(80);
    assert.equal(lines.length, available);
    assert.match(stripVTControlCharacters(lines[0]!), /^interrupt back/);
    assert.match(stripVTControlCharacters(lines[0]!), /running · 中文标题/);
    assert.doesNotMatch(lines.join("\n"), /\x1b\[2J|\x07/);
    const narrow = page.render(12);
    assert.equal(narrow.length, available);
    assert.ok(narrow.every((line) => visibleWidth(line) <= 12));
    assert.match(stripVTControlCharacters(narrow[0]!), /^interrupt/);
  }
  available = 20;
  assert.deepEqual(page.render(80), paused);
});

test("terminal-sized and unavailable child pages respect tiny row budgets", () => {
  for (const rows of [1, 2, 3]) {
    for (const getState of [state, () => undefined]) {
      const page = new AgentSessionPage(tui(rows), theme, keybindings, {
        getState,
        close() {},
      });
      const lines = page.render(40);
      assert.equal(lines.length, rows);
      assert.match(stripVTControlCharacters(lines[0]!), /^interrupt back/);
      assert.ok(lines.every((line) => visibleWidth(line) <= 40));
    }
  }
});
