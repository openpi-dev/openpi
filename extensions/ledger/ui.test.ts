import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderLedgerRows, renderToolResult } from "./ui.ts";

const theme = {
  fg: (_name: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("renders status, detail, and auditable note labels", () => {
  const rows = renderLedgerRows(
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
        subject: "Ship ledger",
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
