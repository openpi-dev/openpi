import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  BASH_OUTPUT_PREVIEW_LINES,
  compactBashRenderedComponent,
  compactRenderedComponent,
  FILE_MUTATION_PREVIEW_LINES,
  singleLineRenderedComponent,
} from "./render.ts";

initTheme("dark", false);

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

function component(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate() {},
  };
}

test("keeps short file mutation renderings unchanged", () => {
  const lines = ["edit file.ts", "+ one line"];
  assert.deepEqual(
    compactRenderedComponent(component(lines), theme).render(80),
    lines,
  );
});

test("bounds long file mutation renderings and exposes the expand hint", () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const rendered = compactRenderedComponent(component(lines), theme).render(80);

  assert.equal(rendered.length, FILE_MUTATION_PREVIEW_LINES + 1);
  assert.deepEqual(
    rendered.slice(0, FILE_MUTATION_PREVIEW_LINES),
    lines.slice(0, FILE_MUTATION_PREVIEW_LINES),
  );
  assert.match(rendered.at(-1) ?? "", /17 more lines/);
  assert.match(rendered.at(-1) ?? "", /expand/);
});

test("renders the file-mutation fold hint inside its status background", () => {
  const lines = Array.from({ length: 6 }, (_, index) => `line ${index + 1}`);
  const rendered = compactRenderedComponent(
    component(lines),
    theme,
    3,
    (text) => `<green>${text}</green>`,
  ).render(40);

  assert.match(rendered.at(-1) ?? "", /^<green>… 3 more lines.*<\/green>$/);
});

test("collapses wrapped Bash commands to one visual row", () => {
  const rendered = singleLineRenderedComponent(
    component(["$ very long command", "continued", "continued again"]),
    theme,
  ).render(80);

  assert.deepEqual(rendered, ["$ very long command …"]);
});

test("compact Bash output preserves one row, warnings, and final timing", () => {
  const lines = [
    "",
    "... (12 earlier lines, Ctrl+O to expand)",
    "first",
    "second",
    "[Truncated: showing 2 of 20 lines]",
    "Took 1.2s",
  ];
  const rendered = compactBashRenderedComponent(component(lines), theme).render(
    80,
  );

  assert.equal(rendered[0], "first");
  assert.match(rendered[1] ?? "", /13 more lines.*expand/);
  assert.equal(rendered[2], "[Truncated: showing 2 of 20 lines]");
  assert.equal(rendered[3], "Took 1.2s");
  assert.equal(BASH_OUTPUT_PREVIEW_LINES, 1);
});
