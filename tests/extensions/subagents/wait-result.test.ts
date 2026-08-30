import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildWaitResultPreview,
  renderWaitResultPreview,
} from "../../../extensions/subagents/src/ui/wait-result.ts";

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
        { id: "sa-1", title: "review", status: "done", elapsed: "2s" },
        { id: "sa-2", title: "tests", status: "error", elapsed: "5s" },
      ],
    },
    theme,
  );
  const lines = preview.split("\n");

  assert.ok(lines.length <= 4);
  assert.match(preview, /1 failed · 2 subagents settled/);
  assert.match(preview, /sa-1 · review · done · 2s/);
  assert.match(preview, /sa-2 · tests · error · 5s/);
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

test("wait result preview exposes artifact save failures", () => {
  const preview = buildWaitResultPreview(
    "## sa-1 finished\n\npartial result",
    {
      results: [
        {
          id: "sa-1",
          title: "review",
          status: "done",
          elapsed: "2s",
          artifactSaveFailed: true,
        },
      ],
    },
    theme,
  );

  assert.match(preview, /artifact not saved/);
});

test("narrow wait result preview keeps artifact warning understandable", () => {
  const rendered = renderWaitResultPreview(
    "partial result",
    {
      results: [
        {
          id: "sa-1",
          title: "review",
          status: "done",
          elapsed: "2s",
          artifactSaveFailed: true,
        },
      ],
    },
    theme,
  ).render(32);

  assert.ok(rendered.every((line) => visibleWidth(line) <= 32));
  assert.match(rendered.join("\n"), /artifact not saved/);
});

test("compact preview keeps a failed result visible beyond the status row limit", () => {
  const rendered = renderWaitResultPreview(
    "",
    {
      results: Array.from({ length: 6 }, (_, index) => ({
        id: `sa-${index + 1}`,
        title: `task ${index + 1}`,
        status: index === 4 ? "error" : "done",
      })),
    },
    theme,
  ).render(120);
  const preview = rendered.join("\n");

  assert.match(preview, /1 failed · 6 subagents settled/);
  assert.match(preview, /sa-5 · task 5 · error/);
});

test("compact preview surfaces uncertain worktree recovery state", () => {
  const preview = buildWaitResultPreview(
    "partial result",
    {
      results: [
        {
          id: "sa-1",
          title: "implementation",
          status: "error",
          outcome: "interrupted",
          worktreeBranch: "pi/impl-1",
          fullResultSaved: true,
        },
      ],
    },
    theme,
  );

  assert.match(preview, /uncertain/);
  assert.match(preview, /worktree handoff · pi\/impl-1/);
  assert.match(preview, /full result saved/);
});
