/**
 * Pure matcher for `bg_watch`: scans a background terminal's streamed output
 * for a pattern, keeping a bounded carry so a match that straddles two chunks
 * is still found. Kept free of process/IO concerns so it can be tested
 * directly — the streaming path around it is the part that is hard to test.
 */

import {
  hasTerminalControls,
  sanitizeTerminalText,
} from "../../shared/terminal-text.ts";

/** Bound on retained tail. A match spanning more than this is not detected. */
export const WATCH_CARRY_MAX_BYTES = 4 * 1024;

export interface WatchMatch {
  /** The line (or bounded slice) containing the match. */
  line: string;
  /** Which stream produced it. */
  stream: "stdout" | "stderr";
}

export interface ChunkMatcher {
  /** Feed a chunk; returns the first match in it, or undefined. */
  push(chunk: string, stream: "stdout" | "stderr"): WatchMatch | undefined;
}

interface CapturedOutput {
  text: string;
  truncatedBytes: number;
}

/** Refuse a watch when prior eviction made terminal parse state unknowable. */
export function assertWatchableOutput(
  stdout: CapturedOutput,
  stderr: CapturedOutput,
) {
  if (stdout.truncatedBytes === 0 && stderr.truncatedBytes === 0) return;
  throw new Error(
    "Cannot safely arm a watch after older terminal output was dropped; inspect /ps or start a fresh terminal before watching for a signature.",
  );
}

/** Check retained output only when its control-string parse state is intact. */
export function matchCapturedOutput(
  matcher: ChunkMatcher,
  stdout: CapturedOutput,
  stderr: CapturedOutput,
) {
  // A head-truncated buffer can begin inside an OSC/DCS payload after its
  // opener was evicted. There is no safe way to infer that missing state, so
  // skip historical matching for that stream and watch future chunks instead.
  const stdoutHit =
    stdout.truncatedBytes === 0
      ? matcher.push(stdout.text, "stdout")
      : undefined;
  return (
    stdoutHit ??
    (stderr.truncatedBytes === 0
      ? matcher.push(stderr.text, "stderr")
      : undefined)
  );
}

const CONTROL_STRING_STARTS = [
  "\u001b]",
  "\u001bP",
  "\u001bX",
  "\u001b^",
  "\u001b_",
  "\u0090",
  "\u0098",
  "\u009d",
  "\u009e",
  "\u009f",
];
const OSC_END = /\u0007|\u001b\\|\u009c/;
const ST_STRING_END = /\u001b\\|\u009c/;

/** Keep an opener when a long split control string crosses the carry bound. */
function boundedRawCarry(text: string) {
  if (text.length <= WATCH_CARRY_MAX_BYTES) return text;
  let lastStart = -1;
  let opener = "";
  for (const candidate of CONTROL_STRING_STARTS) {
    const index = text.lastIndexOf(candidate);
    if (index > lastStart) {
      lastStart = index;
      opener = candidate;
    }
  }
  const terminator =
    opener === "\u001b]" || opener === "\u009d" ? OSC_END : ST_STRING_END;
  const open =
    lastStart >= 0 && !terminator.test(text.slice(lastStart + opener.length));
  return `${open ? opener : ""}${text.slice(-WATCH_CARRY_MAX_BYTES)}`;
}

/**
 * Build a one-shot matcher from the safe RegExp produced by
 * `compileWatchPattern`. It has no stateful flags, so each test is independent.
 * Returns undefined-forever after the first match: callers
 * disarm the watch, and this makes double-fire impossible even if they don't.
 */
export function createChunkMatcher(pattern: RegExp): ChunkMatcher {
  // One carry PER STREAM. A shared buffer would splice interleaved stdout and
  // stderr together, both missing real straddling matches and fabricating
  // matches from text that never appeared on either stream.
  const carries: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };
  let done = false;
  return {
    push(chunk, stream) {
      if (done || !chunk) return undefined;
      const rawText = carries[stream] + chunk;
      // Match only text that could actually be shown to the user. A readiness
      // word hidden inside an OSC clipboard payload must not wake the agent.
      const text = sanitizeTerminalText(rawText);
      const match = pattern.exec(text);
      if (!match) {
        // Retain raw text so a control string split across chunks can still be
        // removed as one unit before matching. Preserve its opener if its
        // payload itself is longer than the carry bound.
        carries[stream] = boundedRawCarry(rawText);
        return undefined;
      }
      done = true;
      carries.stdout = "";
      carries.stderr = "";
      // Report the containing line, not the whole buffer: the model wants the
      // log line that matched, not every byte since the watch started. Bound
      // it too — a process with no newlines (progress bars) would otherwise
      // smear kilobytes into the transcript.
      const start = text.lastIndexOf("\n", match.index) + 1;
      const endIndex = text.indexOf("\n", match.index);
      const end = endIndex === -1 ? text.length : endIndex;
      return {
        line: sanitizeLine(text.slice(start, end)),
        stream,
      };
    },
  };
}

/** Cap on the reported match line, so a newline-free stream cannot smear. */
export const WATCH_LINE_MAX_CHARS = 500;

/**
 * Strip ANSI/control bytes and bound the length. The matched line is injected
 * into the transcript, and the sibling terminal-result path already sanitizes;
 * passing raw escape sequences through would desync the renderer.
 */
function sanitizeLine(raw: string) {
  const stripped = sanitizeTerminalText(raw).trim();
  return stripped.length > WATCH_LINE_MAX_CHARS
    ? `${stripped.slice(0, WATCH_LINE_MAX_CHARS)}\u2026`
    : stripped;
}

/** Cap on a signature list; watches are match hints, not a regex engine. */
export const WATCH_PATTERN_MAX_CHARS = 200;

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile pipe-separated literal signatures. JavaScript regex executes
 * synchronously on the process-output hot path and has no timeout, so no
 * blacklist can make arbitrary regex safe from catastrophic backtracking.
 * Literal alternatives preserve the useful `Ready|ERROR|FAILED` contract and
 * make matching time linear in the bounded input.
 */
export function compileWatchPattern(pattern: string): RegExp {
  if (pattern.length > WATCH_PATTERN_MAX_CHARS) {
    throw new Error(
      `Watch pattern is too long (max ${WATCH_PATTERN_MAX_CHARS} chars); use short signatures like "Ready in|Traceback|ERROR".`,
    );
  }
  if (hasTerminalControls(pattern)) {
    throw new Error("Watch signatures cannot contain control characters.");
  }
  const alternatives = pattern.split("|");
  if (alternatives.some((alternative) => alternative.length === 0)) {
    throw new Error(
      'Watch signatures cannot be empty; use literals like "Ready in|Traceback|ERROR".',
    );
  }
  return new RegExp(alternatives.map(escapeRegExp).join("|"));
}
