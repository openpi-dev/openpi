import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  type EditorComponent,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  BelowEditorNavigationEditor,
  BelowEditorStripState,
} from "../../shared/below-editor-navigation.ts";
import {
  capabilitiesRequestedByPrompt,
  capabilityNameMentions,
} from "../../shared/capability-intent.ts";

const FOREGROUND_RESET = "\u001b[39m";

interface CapabilityKeywordColorOptions {
  readonly colorMode: "truecolor" | "256color";
  readonly light: boolean;
}

type Rgb = readonly [number, number, number];

const DARK_SHIMMER_PALETTE: readonly Rgb[] = [
  [210, 168, 255],
  [239, 220, 255],
  [178, 125, 244],
  [210, 168, 255],
];
const LIGHT_SHIMMER_PALETTE: readonly Rgb[] = [
  [130, 80, 223],
  [92, 42, 174],
  [161, 111, 239],
  [130, 80, 223],
];

export function isLightNamedTheme(name: string | undefined) {
  return name !== undefined && /(?:^|[-_])light(?:$|[-_])/iu.test(name);
}

/**
 * Claude-style lavender keyword color. The light variant preserves readable
 * contrast instead of mechanically reusing the bright dark-terminal swatch.
 */
export function colorCapabilityKeyword(
  text: string,
  options: CapabilityKeywordColorOptions,
  phase?: number,
) {
  const start = options.light
    ? options.colorMode === "truecolor"
      ? "\u001b[38;2;130;80;223m"
      : "\u001b[38;5;98m"
    : options.colorMode === "truecolor"
      ? "\u001b[38;2;210;168;255m"
      : "\u001b[38;5;183m";
  if (phase === undefined || options.colorMode !== "truecolor") {
    return `${start}${text}${FOREGROUND_RESET}`;
  }

  const palette = options.light ? LIGHT_SHIMMER_PALETTE : DARK_SHIMMER_PALETTE;
  const chars = [...text];
  const span = Math.max(chars.length - 1, 1);
  const normalized = ((phase % 1) + 1) % 1;
  const sample = (position: number) => {
    const scaled = ((((position + normalized) % 1) + 1) % 1) * palette.length;
    const index = Math.floor(scaled);
    const amount = scaled - index;
    const from = palette[index]!;
    const to = palette[(index + 1) % palette.length]!;
    return [
      Math.round(from[0] + (to[0] - from[0]) * amount),
      Math.round(from[1] + (to[1] - from[1]) * amount),
      Math.round(from[2] + (to[2] - from[2]) * amount),
    ];
  };
  return (
    chars
      .map((character, index) => {
        const [red, green, blue] = sample(index / span);
        return `\u001b[38;2;${red};${green};${blue}m${character}`;
      })
      .join("") + FOREGROUND_RESET
  );
}

export function highlightCapabilityNames(
  line: string,
  capabilities: readonly string[],
  highlight: (text: string) => string,
) {
  return highlightNameRanges(
    line,
    capabilityNameMentions(stripTerminalSequences(line)).filter((mention) =>
      capabilities.includes(mention.capability),
    ),
    highlight,
  );
}

function highlightNameRanges(
  line: string,
  mentions: readonly { start: number; end: number }[],
  highlight: (text: string) => string,
) {
  const plain = stripTerminalSequences(line);
  if (!mentions.length) return line;
  // Native editor SGR and cursor markers may sit inside a name. Preserve them
  // verbatim and color only the visible text pieces, never terminal bytes.
  const parts = line.split(/(\u001b\[[0-9;]*m|\u001b_pi:(?:c|\/?fc)\u0007)/u);
  if (parts.filter((_, index) => index % 2 === 0).join("") !== plain)
    return line;
  let offset = 0;
  return parts
    .map((part, index) => {
      if (index % 2 === 1) return part;
      let result = "";
      let cursor = 0;
      for (const mention of mentions) {
        const start = Math.max(mention.start - offset, 0);
        const end = Math.min(mention.end - offset, part.length);
        if (start >= end) continue;
        result += part.slice(cursor, start) + highlight(part.slice(start, end));
        cursor = end;
      }
      offset += part.length;
      return result + part.slice(cursor);
    })
    .join("");
}

/** Project original draft offsets from Pi's public cursor/padding and its
 * actual rendered rows. No layout helper, private state or row reclassification.
 * Unmatched geometry stops projection before border, completion or strip text. */
function highlightDraft(
  rows: string[],
  text: string,
  width: number,
  padding: number | undefined,
  cursor: { line: number; col: number } | undefined,
  highlight: (text: string) => string,
) {
  const mentions = capabilityNameMentions(text);
  if (!mentions.length) return rows;
  const plainRows = rows.map(stripTerminalSequences);
  // Plain source-only editors have an exact whole-input projection.
  if (plainRows.join("\n") === text) {
    let offset = 0;
    return rows.map((row, index) => {
      const start = offset;
      offset += plainRows[index]!.length + 1;
      return highlightNameRanges(
        row,
        mentions
          .map((mention) => ({
            start: Math.max(mention.start - start, 0),
            end: Math.min(mention.end - start, plainRows[index]!.length),
          }))
          .filter((mention) => mention.start < mention.end),
        highlight,
      );
    });
  }
  if (
    !cursor ||
    !Number.isInteger(width) ||
    width < 1 ||
    padding === undefined ||
    !Number.isFinite(padding) ||
    padding < 0 ||
    !Number.isInteger(cursor.line) ||
    !Number.isInteger(cursor.col)
  )
    return rows;
  const lines = text.split("\n");
  if (
    lines[cursor.line] === undefined ||
    cursor.col < 0 ||
    cursor.col > lines[cursor.line]!.length ||
    stripTerminalSequences(text) !== text
  )
    return rows;
  const pad = Math.min(
    Math.floor(padding),
    Math.max(0, Math.floor((width - 1) / 2)),
  );
  const contentWidth = Math.max(1, width - pad * 2);
  const layoutWidth = Math.max(1, contentWidth - (pad ? 0 : 1));
  let offset = 0;
  const starts = lines.map((line) => {
    const start = offset;
    offset += line.length + 1;
    return start;
  });
  const markers = rows.flatMap((row, index) => {
    const marker = row.indexOf(CURSOR_MARKER);
    const fakeCursor = row.indexOf("\u001b_pi:fc\u0007");
    const reverseCursor = row.indexOf("\u001b[7m");
    const position =
      marker >= 0 ? marker : fakeCursor >= 0 ? fakeCursor : reverseCursor;
    return position < 0
      ? []
      : [{ index, prefix: stripTerminalSequences(row.slice(0, position)) }];
  });
  if (markers.length !== 1) return rows;
  const anchor = markers[0]!;
  const cursorSource = starts[cursor.line]! + cursor.col;
  const sourceStart = cursorSource - (anchor.prefix.length - pad);
  const lineStart = starts[cursor.line]!;
  const lineEnd = lineStart + lines[cursor.line]!.length;
  if (
    sourceStart < lineStart ||
    sourceStart > cursorSource ||
    anchor.prefix !== " ".repeat(pad) + text.slice(sourceStart, cursorSource)
  )
    return rows;
  const expected = (value: string, extraCursor = 0) => {
    const occupied = visibleWidth(value) + extraCursor;
    return (
      " ".repeat(pad) +
      value +
      " ".repeat(
        extraCursor +
          Math.max(0, contentWidth - occupied) +
          Math.max(0, pad - (occupied > contentWidth ? 1 : 0)),
      )
    );
  };
  // Match only a bounded source segment against the actual native row. Padding
  // may match source whitespace; the longest exact span retains that whitespace.
  const matchSpan = (
    row: number,
    boundary: number,
    limit: number,
    forward: boolean,
    extraCursor = 0,
  ) => {
    const plain = plainRows[row];
    if (plain === undefined) return undefined;
    const available = Math.min(
      Math.abs(limit - boundary),
      Math.max(0, plain.length - pad * 2),
    );
    for (let length = available; length >= 0; length--) {
      const start = forward ? boundary : boundary - length;
      const end = forward ? boundary + length : boundary;
      const value = text.slice(start, end);
      if (
        visibleWidth(value) <= layoutWidth &&
        plain === expected(value, extraCursor)
      )
        return { start, end };
    }
    return undefined;
  };
  const current = matchSpan(
    anchor.index,
    sourceStart,
    lineEnd,
    true,
    cursorSource === lineEnd ? 1 : 0,
  );
  if (!current || current.end < cursorSource) return rows;
  const result = [...rows];
  const project = (row: number, span: { start: number; end: number }) => {
    const ranges = mentions
      .map((mention) => ({
        start: pad + Math.max(mention.start - span.start, 0),
        end: pad + Math.min(mention.end - span.start, span.end - span.start),
      }))
      .filter((mention) => mention.start < mention.end);
    result[row] = highlightNameRanges(rows[row]!, ranges, highlight);
  };
  project(anchor.index, current);
  let start = current.start;
  let logicalLine = cursor.line;
  for (let row = anchor.index - 1; row >= 0; row--) {
    if (start === starts[logicalLine]) {
      if (logicalLine === 0) break;
      logicalLine--;
      start = starts[logicalLine]! + lines[logicalLine]!.length;
    }
    const span = matchSpan(row, start, starts[logicalLine]!, false);
    if (!span || (span.start === span.end && lines[logicalLine]!.length !== 0))
      break;
    project(row, span);
    start = span.start;
  }
  let end = current.end;
  logicalLine = cursor.line;
  for (let row = anchor.index + 1; row < rows.length; row++) {
    if (end === starts[logicalLine]! + lines[logicalLine]!.length) {
      if (logicalLine === lines.length - 1) break;
      logicalLine++;
      end = starts[logicalLine]!;
    }
    const span = matchSpan(
      row,
      end,
      starts[logicalLine]! + lines[logicalLine]!.length,
      true,
    );
    if (!span || (span.start === span.end && lines[logicalLine]!.length !== 0))
      break;
    project(row, span);
    end = span.end;
  }

  return result;
}

/**
 * Transparent, pre-submit feedback for capability discovery. It colours only
 * names whose capability the shared classifier would load after submission;
 * it never changes editor text, Session history, or model context.
 */
export class CapabilityIntentHighlightEditor extends BelowEditorNavigationEditor {
  private readonly highlight: (text: string) => string;
  private readonly onShimmerActive?: (active: boolean) => void;

  constructor(
    base: EditorComponent,
    keybindings: KeybindingsManager,
    highlight: (text: string) => string,
    onShimmerActive?: (active: boolean) => void,
  ) {
    super(
      base,
      keybindings,
      new BelowEditorStripState(),
      () => false,
      () => undefined,
      () => undefined,
    );
    this.highlight = highlight;
    this.onShimmerActive = onShimmerActive;
  }

  override render(width: number) {
    const capabilities = capabilitiesRequestedByPrompt(this.getText());
    const active =
      capabilities.includes("delegate") || capabilities.includes("workflow");
    this.onShimmerActive?.(active);
    if (!active) {
      return super.render(width);
    }
    return highlightDraft(
      super.render(width),
      this.getText(),
      width,
      this.getPaddingX(),
      this.getCursor(),
      this.highlight,
    );
  }
}
