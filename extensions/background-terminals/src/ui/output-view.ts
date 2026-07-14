/**
 * Output rendering for the /ps detail view: turns a captured stream's text
 * into sanitized, wrapped display lines. Sanitization happens here — at
 * render time, never at capture time — because raw ANSI/control characters
 * desync the TUI renderer and smear the overlay.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Strip raw ANSI codes, expand tabs, and drop control chars. Terminal-expanded
 * tabs (and stray escapes) make lines wider than the width we declare to the
 * TUI, which desyncs the renderer.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(ANSI_PATTERN, "")
    .replaceAll("\t", "  ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Split, sanitize, and wrap a stream's text into display lines. */
export function buildOutputLines(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Carriage-return progress lines (npm, cargo): keep only the final state.
    const lastSegment = raw.split("\r").at(-1) ?? "";
    const clean = sanitizeText(lastSegment);
    if (clean.length === 0) {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(clean, safeWidth));
  }
  // Drop one trailing empty line from a trailing "\n" so the tail pin sits
  // on the last real output line.
  if (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Cache of wrapped lines keyed by (buffer version, width): a chatty process
 * bumps the version per chunk, but renders between chunks (1Hz elapsed ticks,
 * scrolling) must not re-wrap megabytes.
 */
export function createOutputLineCache() {
  let key: string | undefined;
  let lines: string[] = [];
  return {
    get(text: string, version: number, width: number) {
      const nextKey = `${version}:${width}`;
      if (key !== nextKey) {
        key = nextKey;
        lines = buildOutputLines(text, width);
      }
      return lines;
    },
  };
}
