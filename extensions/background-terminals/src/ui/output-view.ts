/**
 * Output rendering for the /ps detail view: turns a captured stream's text
 * into sanitized, wrapped display lines. Sanitization happens here — at
 * render time, never at capture time — because raw ANSI/control characters
 * desync the TUI renderer and smear the overlay.
 *
 * A steady stream used to re-split and re-wrap the whole retained buffer on
 * every version bump. The layout cache now replays only the appended tail
 * and the logical lines removed from the head. Width changes and
 * discontinuities still lay the retained text out once.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";
import type { OutputView } from "../domain.ts";

/** Shared terminal sanitizer, retained under the local rendering API name. */
export const sanitizeText = sanitizeTerminalText;

/** Split, sanitize, and wrap a stream's text into display lines. */
export function buildOutputLines(text: string, width: number) {
  const safeWidth = Math.max(10, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    out.push(...layoutLogicalLine(raw, safeWidth));
  }
  // Drop one trailing empty line from a trailing "\n" so the tail pin sits
  // on the last real output line.
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * One newline-delimited source line: keep the final carriage-return segment
 * (npm/cargo progress), then sanitize and wrap. Sanitization stays on this
 * path; incremental updates call it for the lines that actually changed.
 */
function layoutLogicalLine(raw: string, safeWidth: number) {
  const segments = raw.split("\r");
  const finalSegment = segments.at(-1) ?? "";
  const lastSegment =
    finalSegment || [...segments].reverse().find((segment) => segment) || "";
  const clean = sanitizeText(lastSegment);
  if (clean.length === 0) return [""];
  return wrapTextWithAnsi(clean, safeWidth);
}

/**
 * Carriage-return state collapsed to the segment that display keeps, so a
 * progress line does not retain every previous update.
 */
function collapseCarriageReturn(raw: string) {
  const segments = raw.split("\r");
  const finalSegment = segments.at(-1) ?? "";
  const effective =
    finalSegment || [...segments].reverse().find((segment) => segment) || "";
  return { effective, endsWithCR: raw.endsWith("\r") };
}

function minimalCarriageReturn(effective: string, endsWithCR: boolean) {
  return endsWithCR ? `${effective}\r` : effective;
}

/** Retained text addressed by absolute code-unit offsets, plus a version. */
export interface OutputLayoutSource {
  /** Monotonic identity. Unchanged versions reuse the laid-out lines. */
  readonly version: number;
  /** Code units dropped from the head of the stream's retained text. */
  readonly truncatedChars: number;
  /** Code units currently retained. */
  readonly retainedChars: number;
  /** Slice of the retained text. `to` defaults to `retainedChars`. */
  slice(from: number, to?: number): string;
  /** Full retained text. Read only when the layout cannot extend a delta. */
  text(): string;
}

export function toOutputLayoutSource(view: OutputView): OutputLayoutSource {
  return {
    version: view.totalBytes,
    truncatedChars: view.truncatedChars,
    retainedChars: view.retainedChars,
    slice: (from, to) => view.slice(from, to),
    text: () => view.text,
  };
}

interface LogicalLine {
  /** Source code units in this line, excluding the newline that follows it. */
  chars: number;
  displayCount: number;
}

/**
 * Cache of wrapped lines. Same version and width reuse the previous array.
 * A later version with a contiguous head-evict/tail-append updates only those
 * lines; anything else lays the retained text out again.
 */
export function createOutputLineCache() {
  let key: string | undefined;
  let lines: string[] = [];
  const layout = new IncrementalLayout();
  return {
    get(text: string, version: number, width: number) {
      const nextKey = `${version}:${width}`;
      if (key !== nextKey) {
        key = nextKey;
        lines = buildOutputLines(text, width);
      }
      return lines;
    },
    sync(source: OutputLayoutSource, width: number) {
      layout.sync(source, width);
    },
    get length() {
      return layout.length;
    },
    slice(start: number, end: number) {
      return layout.slice(start, end);
    },
  };
}

class IncrementalLayout {
  private logical: LogicalLine[] = [];
  private logicalHead = 0;
  private flat: string[] = [];
  private flatHead = 0;
  private sourceChars = 0;
  private truncatedChars = 0;
  private version = 0;
  private safeWidth = 0;
  private hasLayout = false;
  /** Raw display suffix of the open line, collapsed through carriage returns. */
  private openEffective = "";
  private openEndsWithCR = false;

  get length() {
    return this.visibleEnd() - this.flatHead;
  }

  slice(start: number, end: number) {
    const limit = this.visibleEnd();
    const from = Math.min(limit, this.flatHead + Math.max(0, start));
    const to = Math.min(limit, this.flatHead + Math.max(0, end));
    if (from >= to) return [];
    return this.flat.slice(from, to);
  }

  sync(source: OutputLayoutSource, width: number) {
    const safeWidth = Math.max(10, width);
    if (
      this.hasLayout &&
      this.version === source.version &&
      this.safeWidth === safeWidth
    ) {
      return;
    }
    const evicted = source.truncatedChars - this.truncatedChars;
    const contiguous =
      this.hasLayout &&
      this.safeWidth === safeWidth &&
      evicted >= 0 &&
      evicted <= this.sourceChars;
    if (!contiguous) {
      this.rebuild(source.text(), safeWidth, source);
      return;
    }
    const overlap = this.sourceChars - evicted;
    const appendedCount = source.retainedChars - overlap;
    if (appendedCount < 0) {
      this.rebuild(source.text(), safeWidth, source);
      return;
    }
    if (evicted > 0) this.evict(evicted, source);
    if (appendedCount > 0) {
      this.append(source.slice(overlap, overlap + appendedCount));
    }
    this.version = source.version;
    this.truncatedChars = source.truncatedChars;
    this.safeWidth = safeWidth;
    // A gap in the bookkeeping falls back to one full layout of this frame
    // rather than painting a drifted tail. The next frame can extend again.
    if (this.sourceChars !== source.retainedChars) {
      this.rebuild(source.text(), safeWidth, source);
    }
  }

  private rebuild(text: string, safeWidth: number, source: OutputLayoutSource) {
    this.safeWidth = safeWidth;
    this.logical = [];
    this.logicalHead = 0;
    this.flat = [];
    this.flatHead = 0;
    const parts = text.split("\n");
    for (const part of parts) this.addLogical(part);
    this.setOpen(parts[parts.length - 1] ?? "");
    this.sourceChars = text.length;
    this.truncatedChars = source.truncatedChars;
    this.version = source.version;
    this.hasLayout = true;
  }

  private evict(count: number, source: OutputLayoutSource) {
    let left = count;
    while (left > 0 && this.logicalCount() > 0) {
      const head = this.headLine();
      const hasSeparator = this.logicalCount() > 1;
      if (left < head.chars) {
        const raw = source.slice(0, head.chars - left);
        this.replaceHead(head, raw);
        if (!hasSeparator) this.setOpen(raw);
        left = 0;
        break;
      }
      left -= head.chars;
      if (!hasSeparator) {
        this.flat.length -= head.displayCount;
        this.logicalHead++;
        this.setOpen("");
        break;
      }
      if (left === 0) {
        this.replaceHead(head, "");
        left = 0;
        break;
      }
      left -= 1;
      this.flatHead += head.displayCount;
      this.logicalHead++;
      this.compact();
    }
    this.sourceChars -= count;
    if (this.logicalCount() === 0) this.resetEmpty();
  }

  private append(delta: string) {
    if (delta.length === 0) return;
    if (this.logicalCount() === 0) this.resetEmpty();
    const parts = delta.split("\n");
    const extension = parts[0] ?? "";
    const extended =
      minimalCarriageReturn(this.openEffective, this.openEndsWithCR) +
      extension;
    const open = this.openLine();
    open.chars += extension.length;
    this.replaceOpenDisplay(extended);
    this.setOpen(extended);
    for (let index = 1; index < parts.length; index++) {
      const part = parts[index] ?? "";
      this.addLogical(part);
      this.setOpen(part);
    }
    this.sourceChars += delta.length;
  }

  private addLogical(raw: string) {
    const display = layoutLogicalLine(raw, this.safeWidth);
    this.logical.push({ chars: raw.length, displayCount: display.length });
    for (const line of display) this.flat.push(line);
  }

  private replaceHead(head: LogicalLine, raw: string) {
    const display = layoutLogicalLine(raw, this.safeWidth);
    const at = this.flatHead;
    if (display.length === head.displayCount) {
      for (let index = 0; index < display.length; index++) {
        const line = display[index];
        if (line !== undefined) this.flat[at + index] = line;
      }
    } else {
      this.flat.splice(at, head.displayCount, ...display);
    }
    head.chars = raw.length;
    head.displayCount = display.length;
  }

  private replaceOpenDisplay(raw: string) {
    const open = this.openLine();
    this.flat.length -= open.displayCount;
    const display = layoutLogicalLine(raw, this.safeWidth);
    open.displayCount = display.length;
    for (const line of display) this.flat.push(line);
  }

  private setOpen(raw: string) {
    const collapsed = collapseCarriageReturn(raw);
    this.openEffective = collapsed.effective;
    this.openEndsWithCR = collapsed.endsWithCR;
  }

  private resetEmpty() {
    this.logical = [{ chars: 0, displayCount: 1 }];
    this.logicalHead = 0;
    this.flat = [""];
    this.flatHead = 0;
    this.openEffective = "";
    this.openEndsWithCR = false;
  }

  private logicalCount() {
    return this.logical.length - this.logicalHead;
  }

  private headLine() {
    const head = this.logical[this.logicalHead];
    if (head === undefined) throw new Error("missing head output line");
    return head;
  }

  private openLine() {
    const open = this.logical[this.logical.length - 1];
    if (open === undefined) throw new Error("missing open output line");
    return open;
  }

  private visibleEnd() {
    if (
      this.flat.length > this.flatHead &&
      this.flat[this.flat.length - 1] === ""
    ) {
      return this.flat.length - 1;
    }
    return this.flat.length;
  }

  private compact() {
    if (
      this.logicalHead >= 1024 &&
      this.logicalHead * 2 >= this.logical.length
    ) {
      this.logical = this.logical.slice(this.logicalHead);
      this.logicalHead = 0;
    }
    if (this.flatHead >= 1024 && this.flatHead * 2 >= this.flat.length) {
      this.flat = this.flat.slice(this.flatHead);
      this.flatHead = 0;
    }
  }
}
