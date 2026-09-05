/**
 * Fold very long user messages in the transcript display.
 *
 * A pasted log, stack trace, or whole file can wipe out several screens of
 * chat. When a finalized user message exceeds the fold thresholds, the
 * display keeps a short preview of the prose and of each fenced code block
 * and closes with a marker line stating how much was folded.
 *
 * A fold that would hide nothing (or almost nothing) is skipped and the
 * message rendered in full: hiding a handful of lines costs a marker row
 * while saving almost no screen space, and char-heavy messages with few
 * long lines do not shrink on screen when logical lines are removed —
 * folding must hide at least MIN_FOLDED_LINES lines to earn its keep.
 *
 * This is display-only. The transformer runs through Pi's
 * `registerMarkdownTransformer` hook, which changes only what the TUI
 * renders: the session file and the model context keep the full message
 * untouched, so the model always receives the complete paste. The pure
 * `foldUserMessage` helper never mutates its input and has no side effects.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Fold a user message longer than this many lines. */
const MAX_LINES = 20;
/** Fold a user message longer than this many characters. */
const MAX_CHARS = 1_200;
/** Prose lines kept when a message is folded. */
const PROSE_PREVIEW_LINES = 12;
/** Content lines kept per fenced code block when a message is folded. */
const BLOCK_PREVIEW_LINES = 4;
/** Character budget for the prose part of a folded message. */
const PROSE_PREVIEW_CHARS = 1_200;
/** Total rendered lines before the fold marker, across prose and code blocks. */
const MAX_PREVIEW_LINES = 20;
/** Only fold when at least this many lines would be hidden. */
const MIN_FOLDED_LINES = 8;

type Segment =
  | { kind: "prose"; lines: string[] }
  | { kind: "code"; open: string; content: string[]; close: string };

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Parse an opening code fence (CommonMark §4.5): which character it uses and
 * how long it is. A backtick fence's info string may not contain backticks.
 */
function openFence(line: string) {
  const match = FENCE_OPEN.exec(line);
  if (!match) return undefined;
  const fence = match[1];
  if (fence[0] === "`" && line.slice(match[0].length).includes("`")) {
    return undefined;
  }
  return { char: fence[0], length: fence.length };
}

/**
 * A closing fence must use the same character as the opening fence and be at
 * least as long: a ``` line does not close a ```` block, and backticks never
 * close a tilde block.
 */
function isCloseFence(line: string, open: { char: string; length: number }) {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);
  return (
    match !== null &&
    match[1][0] === open.char &&
    match[1].length >= open.length
  );
}

function countLines(markdown: string) {
  const parts = markdown.split("\n");
  // A trailing newline ends the last line; it does not open a new one.
  return parts.at(-1) === "" ? parts.length - 1 : parts.length;
}

function splitLines(markdown: string) {
  const lines = markdown.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function parseSegments(lines: string[]): Segment[] {
  const segments: Segment[] = [];
  let prose: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = openFence(lines[i]);
    if (!fence) {
      prose.push(lines[i]);
      i += 1;
      continue;
    }
    if (prose.length > 0) {
      segments.push({ kind: "prose", lines: prose });
      prose = [];
    }
    const open = lines[i];
    const content: string[] = [];
    let close: string | undefined;
    let j = i + 1;
    while (j < lines.length && close === undefined) {
      if (isCloseFence(lines[j], fence)) close = lines[j];
      else content.push(lines[j]);
      j += 1;
    }
    if (close === undefined) {
      // Unterminated fence: the block runs to the end of the message. Keep it
      // as a code block with a synthesized closing fence so a folded preview
      // never leaks an unclosed fence into the TUI.
      segments.push({
        kind: "code",
        open,
        content,
        close: fence.char.repeat(fence.length),
      });
      return segments;
    }
    segments.push({ kind: "code", open, content, close });
    i = j;
  }
  if (prose.length > 0) segments.push({ kind: "prose", lines: prose });
  return segments;
}

/**
 * Return the Markdown Pi should render instead of a long user message.
 * Messages at or below both thresholds — and messages whose fold would
 * hide fewer than MIN_FOLDED_LINES lines — are returned unchanged. Pure:
 * the input string is never modified, and the model still sees the original.
 */
export function foldUserMessage(markdown: string): string {
  const totalLines = countLines(markdown);
  if (totalLines <= MAX_LINES && markdown.length <= MAX_CHARS) return markdown;

  const preview: string[] = [];
  let proseLinesLeft = PROSE_PREVIEW_LINES;
  let proseCharsLeft = PROSE_PREVIEW_CHARS;
  let linesShown = 0;

  for (const segment of parseSegments(splitLines(markdown))) {
    const remainingLines = MAX_PREVIEW_LINES - preview.length;
    if (remainingLines <= 0) break;
    if (segment.kind === "code") {
      if (segment.content.length === 0) {
        if (remainingLines < 2) break;
        preview.push(segment.open, segment.close);
        linesShown += 2;
        continue;
      }
      // A partial block needs opening/closing fences plus an ellipsis. If that
      // cannot fit, stop before the block instead of emitting broken Markdown.
      if (remainingLines < 3) break;
      let shown = Math.min(
        segment.content.length,
        BLOCK_PREVIEW_LINES,
        remainingLines - 2,
      );
      const truncated = () => shown < segment.content.length;
      while (truncated() && shown + 3 > remainingLines) shown -= 1;
      preview.push(segment.open, ...segment.content.slice(0, shown));
      if (truncated()) preview.push("…");
      preview.push(segment.close);
      linesShown += 2 + shown;
      continue;
    }
    for (const line of segment.lines) {
      if (proseLinesLeft <= 0 || preview.length >= MAX_PREVIEW_LINES) break;
      const cost = line.length + (preview.length > 0 ? 1 : 0);
      if (preview.length > 0 && cost > proseCharsLeft) break;
      if (preview.length === 0 && line.length > proseCharsLeft) {
        // A single giant first line is the only case that cuts mid-line.
        preview.push(`${line.slice(0, proseCharsLeft)}…`);
        proseLinesLeft = 0;
        proseCharsLeft = 0;
        break;
      }
      preview.push(line);
      linesShown += 1;
      proseLinesLeft -= 1;
      proseCharsLeft -= cost;
    }
  }

  const foldedLines = totalLines - linesShown;
  if (foldedLines < MIN_FOLDED_LINES) {
    // Folding must earn its keep. Hiding fewer lines than MIN_FOLDED_LINES
    // costs a marker row, hides content, and saves almost nothing on screen
    // (char-heavy messages with few long lines wrap regardless), so render
    // the message in full instead.
    return markdown;
  }
  const noun = foldedLines === 1 ? "line" : "lines";
  preview.push(
    `… folded ${foldedLines} ${noun} · full content was sent to the model`,
  );
  return preview.join("\n");
}

/**
 * The registered transformer: fold only finalized user messages and leave
 * assistant text, thinking blocks, and streaming updates untouched.
 */
export function transformUserMarkdown(
  markdown: string,
  context: { messageType: string; isStreaming: boolean },
): string {
  if (context.messageType !== "user" || context.isStreaming) return markdown;
  try {
    return foldUserMessage(markdown);
  } catch {
    // Display-only: a folding bug must never break rendering.
    return markdown;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerMarkdownTransformer(transformUserMarkdown);
}
