import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Only the two paint calls this chrome makes, following the footer's precedent:
 * views that carry a narrowed theme object can use it without a cast.
 */
type Theme = Pick<ExtensionContext["ui"]["theme"], "fg" | "bold">;

/**
 * Some labels arrive already styled (a task census colours each state). Painting
 * a colour over them would apply only up to their first inner reset, leaving the
 * rest a different shade than the caller asked for, so pre-styled text is passed
 * through untouched.
 */
const isStyled = (text: string) => text.includes("\u001b");

/**
 * The chrome every full-screen OpenPI view shares: a title line, one bordered
 * panel, a hint line, and one way to say "there is more above/below".
 *
 * Several views had grown their own copy of this (`/subagents`,
 * `/workflows`, and the now-removed `/ps`), and they had drifted apart in the details you notice without
 * being able to name: one framed the body in `border`, another in
 * `borderMuted`; one wrote `... 3 more` and another `… 3 more`; hints were a
 * single dim run in which the keys you are supposed to press read exactly as
 * faint as the prose describing them. Fixing that in one place is also the only
 * way it stays fixed.
 */

/** Title left, quiet census right, with the same one-column inset as the panel. */
export function screenTitleLine(
  theme: Theme,
  title: string,
  meta: string,
  width: number,
) {
  const left = ` ${theme.bold(theme.fg("accent", title))}`;
  const right = meta ? `${isStyled(meta) ? meta : theme.fg("dim", meta)} ` : "";
  const rightWidth = visibleWidth(right);
  const fittedLeft = truncateToWidth(
    left,
    Math.max(0, width - rightWidth - 1),
    "…",
  );
  const pad = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
  return truncateToWidth(fittedLeft + " ".repeat(pad) + right, width, "");
}

/**
 * Bordered panel with an optional label set into the top edge, padded to an
 * exact height so a view's overlay never changes size as content streams in.
 */
export function panelFrame(
  theme: Theme,
  options: {
    label?: string;
    rows: readonly string[];
    width: number;
    height: number;
  },
) {
  const { label = "", rows, width, height } = options;
  const inner = Math.max(0, width - 2);
  const border = (text: string) => theme.fg("borderMuted", text);
  // The label rides the border rather than sitting above it, so it reads as
  // this panel's name instead of competing with the screen title.
  const clippedLabel = label
    ? truncateToWidth(` ${label} `, Math.max(0, inner - 2))
    : "";
  const labelText = clippedLabel
    ? isStyled(clippedLabel)
      ? clippedLabel
      : theme.fg("muted", clippedLabel)
    : "";
  const dashes = Math.max(0, inner - visibleWidth(labelText) - 1);
  const lines = [border("╭─") + labelText + border("─".repeat(dashes) + "╮")];
  const bodyHeight = Math.max(0, height - 2);
  for (let index = 0; index < bodyHeight; index += 1) {
    const clipped = truncateToWidth(rows[index] ?? "", inner, "…");
    const pad = Math.max(0, inner - visibleWidth(clipped));
    lines.push(border("│") + clipped + " ".repeat(pad) + border("│"));
  }
  lines.push(border("╰" + "─".repeat(inner) + "╯"));
  return lines;
}

/** One `keys label` pair of a hint line. */
export type ScreenHint = readonly [keys: string, label: string];

/**
 * Keys read one step brighter than what they do, so the line scans as a
 * keyboard legend instead of a sentence. A notice takes the whole line when
 * there is one: it is the answer to what you just pressed, and the legend can
 * wait a beat.
 */
export function hintLine(
  theme: Theme,
  hints: readonly (ScreenHint | undefined)[],
  width: number,
  notice?: string,
) {
  if (notice) {
    return truncateToWidth(theme.fg("accent", ` ${notice}`), width, "…");
  }
  const parts = hints
    .filter((hint): hint is ScreenHint => Boolean(hint))
    .map(([keys, label]) => {
      // An empty key slot is a plain status segment (a scroll position, say);
      // an empty label is a bare key. Both stay dimmer than a real key.
      if (!keys) return theme.fg("dim", label);
      if (!label) return theme.fg("muted", keys);
      return `${theme.fg("muted", keys)} ${theme.fg("dim", label)}`;
    });
  return truncateToWidth(
    ` ${parts.join(theme.fg("dim", " · "))}`,
    width,
    theme.fg("dim", "…"),
  );
}

/** Single vocabulary for a clipped list: `… 3 more agents`. */
export function overflowNote(
  theme: Theme,
  count: number,
  width: number,
  noun = "",
) {
  return truncateToWidth(
    theme.fg("dim", `   … ${count} more${noun ? ` ${noun}` : ""}`),
    width,
  );
}
