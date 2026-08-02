import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  compactRenderedComponent,
  FILE_MUTATION_PREVIEW_LINES,
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
  assert.match(rendered.at(-1) ?? "", /15 more lines/);
  assert.match(rendered.at(-1) ?? "", /expand/);
});
