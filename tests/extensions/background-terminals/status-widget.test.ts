import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createBackgroundStatusWidget } from "../../../extensions/background-terminals/src/ui/status-widget.ts";

/** Stand-in theme that keeps color codes in the string, like a real theme does. */
const theme: Pick<Theme, "fg"> = {
  fg: (_color, text) => `\u001b[33m${text}\u001b[0m`,
};

test("background status line fits the viewport at every width", () => {
  for (const running of [1, 2, 8]) {
    const widget = createBackgroundStatusWidget(running, theme);
    // 44 is the width that produced the overflow crash in the field; 0 and 1
    // guard the degenerate cases a very narrow or split pane can report.
    for (const width of [80, 44, 20, 1, 0, 44, 80]) {
      const lines = widget.render(width);
      assert.equal(lines.length, 1);
      assert.ok(
        visibleWidth(lines[0]!) <= width,
        `running=${running}, width=${width} rendered ${visibleWidth(lines[0]!)} columns`,
      );
      if (width === 80) {
        assert.match(lines[0]!, new RegExp(`${running} background terminal`));
        assert.match(lines[0]!, /\/ps.*to view/);
      }
    }
  }
});
