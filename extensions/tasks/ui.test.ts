import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderTaskRows,
  renderTaskWidget,
  renderToolResult,
  TASK_WIDGET_LIMIT,
} from "./ui.ts";

// strikethrough is marked rather than dropped, so a test can assert which
// subjects got struck without matching real ANSI escapes.
const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
  strikethrough: (text: string) => `<s>${text}</s>`,
} as unknown as Theme;

test("renders status, detail, and auditable note labels", () => {
  const rows = renderTaskRows(
    [
      {
        id: 1,
        subject: "Verify restore",
        detail: "fork and pivot",
        status: "blocked",
        note: "Needs a clean fixture",
      },
      {
        id: 2,
        subject: "Ship tasks",
        status: "done",
        note: "15 tests passed",
      },
    ],
    theme,
    100,
  ).join("\n");
  assert.match(rows, /T1 \[blocked\] Verify restore/);
  assert.match(rows, /Blocked: Needs a clean fixture/);
  assert.match(rows, /Evidence: 15 tests passed/);
});

test("persistent task widget matches a compact Claude-style task panel", () => {
  const lines = renderTaskWidget(
    {
      version: 1,
      revision: 4,
      nextId: 5,
      items: [
        { id: 1, subject: "Finished setup", status: "done", note: "passed" },
        { id: 2, subject: "Implement task panel", status: "in_progress" },
        { id: 3, subject: "Verify rendering", status: "pending" },
        { id: 4, subject: "Dropped idea", status: "dropped", note: "unused" },
      ],
    },
    theme,
    100,
  );
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /◆ Tasks\s+1\/3/);
  assert.match(lines[0]!, /2 remaining/);
  assert.match(lines[0]!, /\/tasks/);
  assert.doesNotMatch(lines[0]!, /ctrl\+shift\+t/);
  assert.match(lines[1]!, /T2 Implement task panel/);
  assert.match(lines[2]!, /T3 Verify rendering/);
  assert.equal(lines.join("\n").includes("Finished setup"), false);
  assert.equal(lines.join("\n").includes("Dropped idea"), false);
  const narrow = renderTaskWidget(
    {
      version: 1,
      revision: 1,
      nextId: 3,
      items: [
        { id: 1, subject: "检查中文宽度与 ANSI 颜色", status: "in_progress" },
        { id: 2, subject: "Second task", status: "pending" },
      ],
    },
    theme,
    18,
  );
  assert.ok(narrow.every((line) => visibleWidth(line) <= 18));
  assert.deepEqual(
    renderTaskWidget(
      {
        version: 1,
        revision: 1,
        nextId: 2,
        items: [{ id: 1, subject: "Done", status: "done", note: "ok" }],
      },
      theme,
      100,
    ),
    [],
  );
});

test("task widget defaults to four items and Ctrl+Shift+T view shows all", () => {
  const snapshot = {
    version: 1 as const,
    revision: 1,
    nextId: 7,
    items: Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      subject: `Task ${index + 1}`,
      status: "pending" as const,
    })),
  };

  const collapsed = renderTaskWidget(snapshot, theme, 100);
  assert.equal(TASK_WIDGET_LIMIT, 4);
  assert.equal(collapsed.length, 6);
  assert.match(collapsed[0]!, /ctrl\+shift\+t show all/);
  assert.match(collapsed[4]!, /T4 Task 4/);
  assert.match(collapsed[5]!, /… 2 more tasks/);
  assert.doesNotMatch(collapsed.join("\n"), /T5 Task 5/);

  const expanded = renderTaskWidget(snapshot, theme, 100, true);
  assert.equal(expanded.length, 7);
  assert.match(expanded[0]!, /ctrl\+shift\+t collapse/);
  assert.match(expanded[6]!, /T6 Task 6/);
  assert.doesNotMatch(expanded.join("\n"), /more tasks/);
});

test("batch closure is visible in compact tool results", () => {
  const component = renderToolResult(
    {
      action: "update",
      items: [
        {
          id: 2,
          subject: "Verify",
          status: "done",
          note: "tests passed",
        },
      ],
      total: 0,
      revision: 3,
      batchClosed: true,
    },
    false,
    theme,
  );
  assert.match(
    component.render(100).join("\n"),
    /Batch complete.*starts at T1/,
  );
});

test("collapsed tool results remain bounded", () => {
  const component = renderToolResult(
    {
      action: "list",
      items: Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        subject: `Task ${index + 1}`,
        status: "pending" as const,
      })),
      total: 8,
      revision: 1,
    },
    false,
    theme,
  );
  const output = component.render(100).join("\n");
  assert.match(output, /… 3 more/);
  assert.match(output, /8 total · revision 1/);
});

test("settled subjects are struck through, live ones are not", () => {
  const rows = renderTaskRows(
    [
      { id: 1, subject: "Ship it", status: "done", note: "tests pass" },
      { id: 2, subject: "Abandon it", status: "dropped", note: "superseded" },
      { id: 3, subject: "Still going", status: "in_progress" },
      { id: 4, subject: "Not started", status: "pending" },
      { id: 5, subject: "Waiting", status: "blocked", note: "needs fixture" },
    ],
    theme,
    120,
  ).join("\n");
  // Struck: the two terminal states, and only the subject — the id, status
  // tag, and evidence line stay readable.
  assert.match(rows, /<s>Ship it<\/s>/);
  assert.match(rows, /<s>Abandon it<\/s>/);
  assert.doesNotMatch(rows, /<s>T\d/);
  assert.doesNotMatch(rows, /<s>tests pass/);
  // Not struck: anything still actionable, including blocked.
  for (const live of ["Still going", "Not started", "Waiting"]) {
    assert.doesNotMatch(rows, new RegExp(`<s>${live}</s>`));
  }
});
