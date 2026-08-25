import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  hintLine,
  overflowNote,
  panelFrame,
  screenTitleLine,
} from "../../../extensions/shared/screen-chrome.ts";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => text,
} as unknown as Parameters<typeof hintLine>[0];

const plain = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Parameters<typeof hintLine>[0];

test("keys read brighter than what they do, and a notice takes the line", () => {
  const line = hintLine(
    theme,
    [["esc", "close"], ["x", ""], ["", "3-9/40"], undefined],
    120,
  );
  assert.match(line, /<muted>esc<\/muted> <dim>close<\/dim>/);
  // A bare key is still a key; a keyless segment is plain status text.
  assert.match(line, /<muted>x<\/muted>/);
  assert.match(line, /<dim>3-9\/40<\/dim>/);
  assert.equal(
    hintLine(theme, [["esc", "close"]], 120, "report saved"),
    "<accent> report saved</accent>",
  );
});

test("the frame is padded to an exact height and never exceeds its width", () => {
  const lines = panelFrame(plain, {
    label: "agents · 1/3 settled",
    rows: ["one", "two"],
    width: 40,
    height: 6,
  });
  assert.equal(lines.length, 6);
  for (const line of lines) assert.equal(visibleWidth(line), 40);
  // A narrow frame still closes: the label is what gives way, not the border.
  for (const width of [4, 10, 20]) {
    const narrow = panelFrame(plain, {
      label: "a very long panel label",
      rows: [],
      width,
      height: 3,
    });
    assert.equal(narrow.length, 3);
    for (const line of narrow) assert.equal(visibleWidth(line), width);
  }
});

test("pre-styled labels and metas are passed through, not repainted", () => {
  // A task census colours each state itself; wrapping it in one more colour
  // would only apply up to its first inner reset. Real SGR runs, not the fake
  // theme's tags: detection keys on ESC, so tags alone would never take the
  // pass-through branch and this test would pass on a repainting version.
  const census = "\u001b[32m3 done\u001b[0m";
  assert.equal(
    panelFrame(theme, {
      label: census,
      rows: [],
      width: 40,
      height: 3,
    })[0]!.includes(`<muted> ${census} </muted>`),
    false,
  );
  assert.match(
    panelFrame(theme, { label: census, rows: [], width: 40, height: 3 })[0]!,
    /\u001b\[32m3 done\u001b\[0m/,
  );
  const titled = screenTitleLine(theme, "Tasks", census, 40);
  assert.match(titled, /\u001b\[32m3 done\u001b\[0m/);
  assert.equal(titled.includes(`<dim>${census}</dim>`), false);
  assert.match(screenTitleLine(theme, "Tasks", "4 items", 40), /<dim>4 items</);
});

test("a title line stays on one bounded row at any width", () => {
  for (const width of [3, 12, 30, 80]) {
    const line = screenTitleLine(
      plain,
      "Background terminals",
      "9 running",
      width,
    );
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
    assert.equal(line.includes("\n"), false);
  }
  assert.ok(visibleWidth(overflowNote(plain, 3, 12, "below")) <= 12);
});
