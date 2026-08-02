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
  let carry = "";
  let done = false;
  return {
    push(chunk, stream) {
      if (done || !chunk) return undefined;
      const text = carry + chunk;
      const match = pattern.exec(text);
      if (!match) {
        // Retain a bounded tail so a match split across chunks still lands.
        carry =
          text.length > WATCH_CARRY_MAX_BYTES
            ? text.slice(-WATCH_CARRY_MAX_BYTES)
            : text;
        return undefined;
      }
      done = true;
      carry = "";
      // Report the containing line, not the whole buffer: the model wants the
      // log line that matched, not every byte since the watch started.
      const start = text.lastIndexOf("\n", match.index) + 1;
      const endIndex = text.indexOf("\n", match.index);
      const end = endIndex === -1 ? text.length : endIndex;
      return { line: text.slice(start, end).trim(), stream };
    },
  };
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
