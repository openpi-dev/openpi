import assert from "node:assert/strict";
import test from "node:test";
import {
  reconcileDashboardSelection,
  sanitizeSubagentDisplayLine,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("picker and takeover display text cannot inject terminal controls", () => {
  assert.equal(
    sanitizeSubagentDisplayLine(
      "review\u001b]52;c;clipboard\u0007\n\u001b[31mnow\u001b[0m",
    ),
    "review now",
  );
});

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});
