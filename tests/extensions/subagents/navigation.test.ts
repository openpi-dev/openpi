import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { BelowEditorStripState } from "../../../extensions/shared/below-editor-navigation.ts";
import {
  normalizeSubagentTitle,
  subagentStripEntryKey,
  selectSubagentStripEntry,
  SubagentStripWidget,
} from "../../../extensions/subagents/navigation.ts";
import { SPINNER_INTERVAL_MS } from "../../../extensions/shared/spinner.ts";
import type { SubagentSnapshot } from "../../../extensions/subagents/src/domain.ts";

function snapshot(
  id: string,
  status: SubagentSnapshot["status"],
  createdAt: number,
  settledAt?: number,
): SubagentSnapshot {
  return {
    id,
    origin: "model",
    backend: "pi",
    title: `${id}\u001b]52;c;payload\u0007`,
    prompt: "inspect",
    cwd: "/repo",
    status,
    createdAt,
    ...(settledAt === undefined ? {} : { settledAt }),
    meta: { backend: "pi", modelLabel: "openai-codex/gpt-5.6-sol" },
    usage: { tokens: 1_000, contextWindow: 10_000 },
    transcriptVersion: 0,
    transcript: [],
    liveTools: [],
    queued: [],
    finalText: "",
    turns: 0,
  };
}

const markingTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Theme;

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("subagent titles are sanitized and bounded at ingress", () => {
  assert.equal(
    normalizeSubagentTitle(" review\u001b]52;c;payload\u0007\nnow "),
    "review now",
  );
  assert.equal(normalizeSubagentTitle("\u001b[31m\u001b[0m"), "subagent");
  assert.equal(normalizeSubagentTitle("x".repeat(200)).length, 160);
});

test("strip selection prefers newest running, then newest unread settled", () => {
  const entries = [
    snapshot("done", "done", 1, 5),
    snapshot("running-old", "running", 2),
    snapshot("running-new", "running", 3),
  ];
  assert.equal(
    selectSubagentStripEntry(entries, 0)?.snapshot.id,
    "running-new",
  );
  assert.equal(
    selectSubagentStripEntry(
      [snapshot("old", "done", 1, 5), snapshot("new", "error", 2, 8)],
      6,
    )?.snapshot.id,
    "new",
  );
  assert.equal(
    selectSubagentStripEntry([snapshot("old", "done", 1, 5)], 6),
    undefined,
  );
});

test("subagent strip repaint key changes only when its selected status changes", () => {
  const running = snapshot("sa-1", "running", 1);
  const updatedUsage = {
    ...running,
    usage: { tokens: 2_000, contextWindow: 10_000 },
  };
  const settled = snapshot("sa-1", "done", 1, 2);

  assert.equal(
    subagentStripEntryKey({
      snapshot: running,
      counts: { running: 1, done: 0, failed: 0 },
    }),
    subagentStripEntryKey({
      snapshot: updatedUsage,
      counts: { running: 1, done: 0, failed: 0 },
    }),
  );
  assert.notEqual(
    subagentStripEntryKey({
      snapshot: running,
      counts: { running: 1, done: 0, failed: 0 },
    }),
    subagentStripEntryKey({
      snapshot: settled,
      counts: { running: 0, done: 1, failed: 0 },
    }),
  );
});

test("subagent strip matches Workflow's bounded one-line affordance", () => {
  const strip = new BelowEditorStripState();
  const entry = selectSubagentStripEntry(
    [snapshot("sa-1", "running", Date.now() - 2_000)],
    0,
  );
  const widget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    theme,
    strip,
    () => entry,
  );
  try {
    const idle = widget.render(100);
    assert.equal(idle.length, 1);
    assert.match(idle[0]!, /sa-1/);
    assert.doesNotMatch(idle[0]!, /payload/);
    assert.match(idle[0]!, /↓ to manage/);

    strip.focused = true;
    const focused = widget.render(54);
    assert.equal(focused.length, 1);
    assert.ok(visibleWidth(focused[0]!) <= 54);
    assert.match(focused[0]!, /enter open/);

    for (const width of [1, 8, 20]) {
      const narrow = widget.render(width);
      assert.equal(narrow.length, 1);
      assert.ok(visibleWidth(narrow[0]!) <= width);
    }
  } finally {
    widget.dispose();
  }
});

test("a lone subagent needs no count: glyph and name carry the state", () => {
  const strip = new BelowEditorStripState();
  const render = (status: SubagentSnapshot["status"]) => {
    const entry = selectSubagentStripEntry(
      [
        snapshot(
          "sa-1",
          status,
          Date.now() - 2_000,
          status === "running" ? undefined : Date.now(),
        ),
      ],
      0,
    );
    const widget = new SubagentStripWidget(
      { requestRender() {} } as unknown as TUI,
      markingTheme,
      strip,
      () => entry,
    );
    try {
      return widget.render(400)[0]!;
    } finally {
      widget.dispose();
    }
  };

  // One active subagent: the glyph and its name already say what a "1 running"
  // count would repeat, and hints recede furthest of all.
  const running = render("running");
  assert.match(running, /sa-1/);
  assert.doesNotMatch(running, /1 running/);
  assert.match(running, /<dim>↓ to manage<\/dim>/);

  // Once settled, the glyph takes the outcome's colour.
  assert.match(render("error"), /<error>✗<\/error>/);
  assert.match(render("done"), /<success>✓<\/success>/);
});

test("several active subagents aggregate instead of naming just one", () => {
  const entry = selectSubagentStripEntry(
    [
      snapshot("sa-1", "running", Date.now() - 4_000),
      snapshot("sa-2", "running", Date.now() - 2_000),
    ],
    0,
  );
  const widget = new SubagentStripWidget(
    { requestRender() {} } as unknown as TUI,
    markingTheme,
    new BelowEditorStripState(),
    () => entry,
  );
  try {
    const rendered = widget.render(400)[0]!;
    assert.match(rendered, /subagents/);
    assert.match(rendered, /<muted>2 running<\/muted>/);
    assert.doesNotMatch(rendered, /sa-1|sa-2/);
  } finally {
    widget.dispose();
  }
});

test("settled subagent strip does not request renders while idle", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entry = selectSubagentStripEntry(
    [snapshot("sa-1", "done", Date.now() - 2_000, Date.now() - 1_000)],
    0,
  );
  let renders = 0;
  const widget = new SubagentStripWidget(
    {
      requestRender() {
        renders += 1;
      },
    } as unknown as TUI,
    theme,
    new BelowEditorStripState(),
    () => entry,
  );
  try {
    t.mock.timers.tick(60_000);
    assert.equal(renders, 0);
  } finally {
    widget.dispose();
  }
});

test("subagent strip stops repainting after its entry settles", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let current = snapshot("sa-1", "running", Date.now() - 2_000);
  let renders = 0;
  const widget = new SubagentStripWidget(
    {
      requestRender() {
        renders += 1;
      },
    } as unknown as TUI,
    theme,
    new BelowEditorStripState(),
    () => ({
      snapshot: current,
      counts: {
        running: current.status === "running" ? 1 : 0,
        done: 0,
        failed: 0,
      },
    }),
  );
  try {
    t.mock.timers.tick(500);
    assert.equal(renders, 1);
    current = snapshot("sa-1", "done", current.createdAt, Date.now());
    t.mock.timers.tick(500);
    assert.equal(renders, 2);
    t.mock.timers.tick(SPINNER_INTERVAL_MS * 10);
    assert.equal(renders, 2);

    current = snapshot("sa-1", "running", current.createdAt);
    widget.render(100);
    t.mock.timers.tick(500);
    assert.equal(renders, 3);
  } finally {
    widget.dispose();
  }
});
