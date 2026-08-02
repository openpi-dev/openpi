import { stripVTControlCharacters } from "node:util";
import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";

// Native Write/Edit renderings include their title and context rows. Three
// visible rows keep the operation identifiable while making repeated file
// mutations substantially quieter than Claude Code's default preview.
export const FILE_MUTATION_PREVIEW_LINES = 3;
export const BASH_OUTPUT_PREVIEW_LINES = 1;

function expandHint(hidden: number) {
  return `… ${hidden} more line${hidden === 1 ? "" : "s"} · ${keyHint("app.tools.expand", "to expand")}`;
}

/** Keep a long command identifiable without allowing it to wrap for many rows. */
export function singleLineRenderedComponent(
  component: Component,
  theme: Theme,
): Component {
  return {
    render(width) {
      const lines = component.render(width);
      if (lines.length <= 1) return lines;
      if (width <= 2) return [truncateToWidth(lines[0] ?? "", width, "")];
      return [
        truncateToWidth(lines[0] ?? "", width - 2, "") + theme.fg("dim", " …"),
      ];
    },
    invalidate() {
      component.invalidate();
    },
  };
}

/** Preserve one output row, warnings, and final timing in compact Bash mode. */
export function compactBashRenderedComponent(
  component: Component,
  theme: Theme,
  maximum = BASH_OUTPUT_PREVIEW_LINES,
): Component {
  return {
    render(width) {
      const rendered = component.render(width);
      const visible = rendered.filter(
        (line) => stripVTControlCharacters(line).trim().length > 0,
      );
      let nativeHidden = 0;
      const content: string[] = [];
      const metadata: string[] = [];
      let status: string | undefined;
      for (const line of visible) {
        const plain = stripVTControlCharacters(line).trim();
        const hiddenMatch = plain.match(/\(?([0-9]+) earlier lines,/);
        if (hiddenMatch) {
          nativeHidden += Number(hiddenMatch[1]);
        } else if (/^(Took|Elapsed)\s/.test(plain)) {
          status = line;
        } else if (/^\[(Full output|Truncated):/.test(plain)) {
          metadata.push(line);
        } else {
          content.push(line);
        }
      }
      const preview = content.slice(0, maximum);
      const hidden =
        nativeHidden + Math.max(0, content.length - preview.length);
      return [
        ...preview,
        ...(hidden > 0 ? [theme.fg("dim", expandHint(hidden))] : []),
        ...metadata,
        ...(status ? [status] : []),
      ];
    },
    invalidate() {
      component.invalidate();
    },
  };
}

export function compactRenderedComponent(
  component: Component,
  theme: Theme,
  maximum = FILE_MUTATION_PREVIEW_LINES,
  background?: (text: string) => string,
): Component {
  return {
    render(width) {
      const lines = component.render(width);
      if (lines.length <= maximum) return lines;
      const hidden = lines.length - maximum;
      const hint = theme.fg("dim", expandHint(hidden));
      const paddedHint =
        hint + " ".repeat(Math.max(0, width - visibleWidth(hint)));
      return [
        ...lines.slice(0, maximum),
        background ? background(paddedHint) : hint,
      ];
    },
    invalidate() {
      component.invalidate();
    },
  };
}
