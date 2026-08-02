import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// Native Write/Edit renderings include their title and context rows. Five
// visible rows leaves room for roughly three content/diff lines, matching the
// compact scanability of Claude Code without hiding the operation itself.
export const FILE_MUTATION_PREVIEW_LINES = 5;

export function compactRenderedComponent(
  component: Component,
  theme: Theme,
  maximum = FILE_MUTATION_PREVIEW_LINES,
): Component {
  return {
    render(width) {
      const lines = component.render(width);
      if (lines.length <= maximum) return lines;
      const hidden = lines.length - maximum;
      return [
        ...lines.slice(0, maximum),
        theme.fg(
          "dim",
          `… ${hidden} more line${hidden === 1 ? "" : "s"} · ${keyHint("app.tools.expand", "to expand")}`,
        ),
      ];
    },
    invalidate() {
      component.invalidate();
    },
  };
}
