/**
 * OutputBuffer — bounded in-memory capture of one process stream.
 *
 * Newest output is always retained; when the retained size exceeds the cap,
 * whole chunks are evicted from the head and counted in `truncatedBytes`.
 * An optional spill callback receives every chunk (in order, before any
 * eviction) so the caller can keep a complete on-disk copy.
 *
 * Plain TS by design: this is push-based accumulation driven by node stream
 * 'data' callbacks, not stream transformation.
 */

import type { OutputView } from "./domain.ts";

export class OutputBuffer {
  private chunks: string[] = [];
  /** Bytes currently retained across `chunks`. */
  private retainedBytes = 0;
  /** Cached join of `chunks`; invalidated on push so 1Hz UI ticks are cheap. */
  private cachedText: string | undefined = "";
  /** Bumped on every push; lets the UI cache derived line layouts. */
  version = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  spillPath?: string;

  private readonly maxRetainedBytes: number;
  private readonly spill?: (chunk: string) => void;

  constructor(maxRetainedBytes: number, spill?: (chunk: string) => void) {
    this.maxRetainedBytes = maxRetainedBytes;
    this.spill = spill;
  }

  push(chunk: string) {
    if (chunk.length === 0) return;
    const bytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += bytes;
    this.spill?.(chunk);
    this.chunks.push(chunk);
    this.retainedBytes += bytes;
    while (
      this.retainedBytes > this.maxRetainedBytes &&
      this.chunks.length > 1
    ) {
      const evicted = this.chunks.shift();
      if (evicted === undefined) break;
      const evictedBytes = Buffer.byteLength(evicted, "utf8");
      this.retainedBytes -= evictedBytes;
      this.truncatedBytes += evictedBytes;
    }
    // A single chunk larger than the cap is kept whole rather than split:
    // eviction only ever drops entire chunks, never partial ones.
    this.cachedText = undefined;
    this.version++;
  }

  view(): OutputView {
    this.cachedText ??= this.chunks.join("");
    return {
      text: this.cachedText,
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
      spillPath: this.spillPath,
    };
  }
}
