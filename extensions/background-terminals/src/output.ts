/**
 * OutputBuffer — bounded in-memory capture of one process stream.
 *
 * Newest output is always retained; when the retained size exceeds the cap,
 * whole chunks are evicted from the head and counted in `truncatedBytes`.
 * A single chunk larger than the cap itself is trimmed to its tail (on a
 * UTF-8 boundary) so retention is strictly bounded even for one giant write.
 * An optional spill callback receives every chunk (in order, before any
 * eviction) so the caller can keep a complete on-disk copy.
 *
 * Plain TS by design: this is push-based accumulation driven by node stream
 * 'data' callbacks, not stream transformation.
 */

import type { OutputView } from "./domain.ts";
import { TerminalTextSanitizer } from "../../shared/terminal-text.ts";

export class OutputBuffer {
  private chunks: string[] = [];
  private modelSafeChunks: string[] = [];
  /** Bytes currently retained across `chunks`. */
  private retainedBytes = 0;
  private modelSafeRetainedBytes = 0;
  /** Cached join of `chunks`; invalidated on push so 1Hz UI ticks are cheap. */
  private cachedText: string | undefined = "";
  private cachedModelSafeText: string | undefined = "";
  /** Bumped on every push; lets the UI cache derived line layouts. */
  version = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  spillPath?: string;

  private readonly maxRetainedBytes: number;
  private readonly spill?: (chunk: string) => unknown;
  private readonly modelSanitizer = new TerminalTextSanitizer();

  constructor(maxRetainedBytes: number, spill?: (chunk: string) => unknown) {
    this.maxRetainedBytes = maxRetainedBytes;
    this.spill = spill;
  }

  push(chunk: string) {
    if (chunk.length === 0) return true;
    this.retainModelSafeText(this.modelSanitizer.push(chunk));
    let bytes = Buffer.byteLength(chunk, "utf8");
    this.totalBytes += bytes;
    const spillAccepted = this.spill?.(chunk) !== false;
    if (bytes > this.maxRetainedBytes) {
      // A single pathological chunk larger than the whole cap: everything
      // retained so far precedes it in the stream, so evict all of it, then
      // keep only the chunk's tail (cut on a UTF-8 code point boundary).
      // Retention stays strictly bounded even for one giant write, and the
      // retained view stays contiguous (no hole in the middle).
      this.truncatedBytes += this.retainedBytes;
      this.chunks = [];
      this.retainedBytes = 0;
      const raw = Buffer.from(chunk, "utf8");
      let start = raw.length - this.maxRetainedBytes;
      while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
      this.truncatedBytes += start;
      chunk = raw.subarray(start).toString("utf8");
      bytes = raw.length - start;
    }
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
    this.cachedText = undefined;
    this.version++;
    return spillAccepted;
  }

  view(): OutputView {
    this.cachedText ??= this.chunks.join("");
    this.cachedModelSafeText ??= this.modelSafeChunks.join("");
    return {
      text: this.cachedText,
      modelSafeText: this.cachedModelSafeText,
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
      spillPath: this.spillPath,
    };
  }

  private retainModelSafeText(text: string) {
    if (text.length === 0) return;
    let bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxRetainedBytes) {
      this.modelSafeChunks = [];
      this.modelSafeRetainedBytes = 0;
      const raw = Buffer.from(text, "utf8");
      let start = raw.length - this.maxRetainedBytes;
      while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
      text = raw.subarray(start).toString("utf8");
      bytes = raw.length - start;
    }
    this.modelSafeChunks.push(text);
    this.modelSafeRetainedBytes += bytes;
    while (
      this.modelSafeRetainedBytes > this.maxRetainedBytes &&
      this.modelSafeChunks.length > 1
    ) {
      const evicted = this.modelSafeChunks.shift();
      if (evicted === undefined) break;
      this.modelSafeRetainedBytes -= Buffer.byteLength(evicted, "utf8");
    }
    this.cachedModelSafeText = undefined;
  }
}
