import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

/**
 * One-line status widget shown above the editor while at least one background
 * terminal is running.
 *
 * The TUI measures every rendered line against the current viewport width and
 * throws when one is wider, so this component must respect the width it is
 * given. The line carries ANSI color codes, so it is truncated by visible
 * width: measuring it in code units counts escape sequences as columns and
 * would cut the wrong amount of text. Truncating on each render (instead of
 * caching a fixed string) keeps a terminal that was resized narrower safe.
 */
export function createBackgroundStatusWidget(
  running: number,
  theme: Pick<Theme, "fg">,
) {
  const line =
    theme.fg("warning", "■ ") +
    theme.fg(
      "text",
      `${running} background terminal${running === 1 ? "" : "s"} running`,
    ) +
    theme.fg("dim", " • ") +
    theme.fg("accent", "/ps") +
    theme.fg("dim", " to view");
  return {
    render: (width: number) => [truncateToWidth(line, width)],
    invalidate: () => {},
  };
}
