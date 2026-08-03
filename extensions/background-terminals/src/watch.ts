/**
 * Pure matcher for `bg_watch`: scans a background terminal's streamed output
 * for a pattern, keeping a bounded carry so a match that straddles two chunks
 * is still found. Kept free of process/IO concerns so it can be tested
 * directly — the streaming path around it is the part that is hard to test.
 */

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

/**
 * Build a one-shot matcher. `pattern` is a JS regex source; it is compiled
 * without flags that would make it stateful (no /g), so each test is
 * independent. Returns undefined-forever after the first match: callers
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
      const text = carries[stream] + chunk;
      const match = pattern.exec(text);
      if (!match) {
        // Retain a bounded tail so a match split across chunks still lands.
        carries[stream] =
          text.length > WATCH_CARRY_MAX_BYTES
            ? text.slice(-WATCH_CARRY_MAX_BYTES)
            : text;
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
  const stripped = raw
    // CSI escape sequences (colors, cursor moves).
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC sequences (title, hyperlinks, clipboard) up to BEL or ST.
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    // Remaining C0 controls except tab, plus DEL.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .trim();
  return stripped.length > WATCH_LINE_MAX_CHARS
    ? `${stripped.slice(0, WATCH_LINE_MAX_CHARS)}\u2026`
    : stripped;
}

/** Cap on the pattern source; a watch pattern is a signature, not a grammar. */
export const WATCH_PATTERN_MAX_CHARS = 200;

/**
 * A quantifier applied to a group that itself contains a quantifier — the
 * classic catastrophic-backtracking shape, e.g. `(a+)+`, `(a*)*`, `(a+)*`.
 * `exec` runs synchronously on the terminal output hot path, so we reject
 * these at compile time rather than risk wedging the event loop on an
 * adversarial stream.
 */
const NESTED_QUANTIFIER = /\([^)]*[+*][^)]*\)[+*]/;

/** Compile a user/model-supplied pattern, failing with a clear message. */
export function compileWatchPattern(pattern: string): RegExp {
  if (pattern.length > WATCH_PATTERN_MAX_CHARS) {
    throw new Error(
      `Watch pattern is too long (max ${WATCH_PATTERN_MAX_CHARS} chars); use a short signature like "Ready in|Traceback|ERROR".`,
    );
  }
  if (NESTED_QUANTIFIER.test(pattern)) {
    throw new Error(
      'Watch pattern has a nested quantifier (e.g. (a+)+) that risks catastrophic backtracking; simplify it to a plain signature like "Ready in|Traceback|ERROR".',
    );
  }
  try {
    // No /g: a stateful lastIndex would make repeated push() calls skip.
    return new RegExp(pattern);
  } catch (error) {
    throw new Error(
      `Invalid watch pattern: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
