/**
 * Output rendering for the /ps detail view: turns a captured stream's text
 * into sanitized, wrapped display lines. Sanitization happens here — at
 * render time, never at capture time — because raw ANSI/control characters
 * desync the TUI renderer and smear the overlay.
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../../shared/terminal-text.ts";

/** Shared terminal sanitizer, retained under the local rendering API name. */
export const sanitizeText = sanitizeTerminalText;

/** Split, sanitize, and wrap a stream's text into display lines. */
export function buildOutputLines(text: string, width: number) {
  const safeWidth = Math.max(10, width);
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    // Carriage-return progress lines (npm, cargo): keep only the final state.
    const segments = raw.split("\r");
    const finalSegment = segments.at(-1) ?? "";
    const lastSegment =
      finalSegment || [...segments].reverse().find((segment) => segment) || "";
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
