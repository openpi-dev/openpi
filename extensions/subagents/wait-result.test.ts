import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { buildWaitResultPreview } from "./src/ui/wait-result.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("wait result preview shows status only and keeps full output behind expand", () => {
  const content = [
    '## sa-1 "review" finished',
    "",
    ...Array.from({ length: 30 }, (_, index) => `finding ${index + 1}`),
  ].join("\n");
  const preview = buildWaitResultPreview(
    content,
    {
      results: [
        { id: "sa-1", title: "review", status: "done" },
        { id: "sa-2", title: "tests", status: "error" },
      ],
    },
    theme,
  );
  const lines = preview.split("\n");

  assert.ok(lines.length <= 4);
  assert.match(preview, /2 subagents settled · 1 failed/);
  assert.match(preview, /sa-1 · review · done/);
  assert.match(preview, /sa-2 · tests · error/);
  assert.match(preview, /Results passed to main agent/);
  assert.match(preview, /expand/);
  assert.doesNotMatch(preview, /finding 1/);
  assert.doesNotMatch(preview, /finding 30/);
});

test("wait result preview bounds status rows across large fan-out", () => {
  const preview = buildWaitResultPreview(
    "## sa-1 finished\n\nPASS",
    {
      results: Array.from({ length: 8 }, (_, index) => ({
        id: `sa-${index + 1}`,
        status: "done",
      })),
    },
    theme,
  );

  assert.match(preview, /8 subagents settled/);
  assert.match(preview, /… 4 more/);
  assert.doesNotMatch(preview, /sa-8/);
});
