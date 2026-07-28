import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderTaskRows, renderTaskWidget, renderToolResult } from "./ui.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
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
  assert.match(lines[0]!, /ctrl\+shift\+t hide/);
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
