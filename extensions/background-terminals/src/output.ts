/**
 * OutputBuffer — bounded in-memory capture of one process stream.
 *
 * Newest output is always retained; when the retained size exceeds the cap,
 * whole chunks are evicted from the head and counted in `truncatedBytes`.
 * Eviction advances a head index and compacts the dead prefix in batches so a
 * chatty stream of small chunks does not slide a full array on every push.
 * A single chunk larger than the cap itself is trimmed to its tail (on a
 * UTF-8 boundary) so retention is strictly bounded even for one giant write.
 * An optional spill callback receives every chunk (in order, before any
 * eviction) so the caller can keep a complete on-disk copy.
 *
 * Plain TS by design: this is push-based accumulation driven by node stream
 * 'data' callbacks, not stream transformation.
 */

import { TerminalTextSanitizer } from "../../shared/terminal-text.ts";
import type { OutputView } from "./domain.ts";

export class OutputBuffer {
  private chunks: string[] = [];
  private chunkStart = 0;
  private modelSafeChunks: string[] = [];
  private modelSafeStart = 0;
  /** Bytes currently retained across live `chunks`. */
  private retainedBytes = 0;
  private modelSafeRetainedBytes = 0;
  /** Cached join of live chunks; invalidated on push so 1Hz UI ticks are cheap. */
  private cachedText: string | undefined = "";
  private cachedModelSafeText: string | undefined = "";
  /** Bumped on every push; lets the UI cache derived line layouts. */
  version = 0;
  totalBytes = 0;
  truncatedBytes = 0;
  /** UTF-16 code units dropped from the head of the retained text. */
  truncatedChars = 0;
  /** UTF-16 code units currently retained. */
  retainedChars = 0;
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
    let chars = chunk.length;
    this.totalBytes += bytes;
    const spillAccepted = this.spill?.(chunk) !== false;
    if (bytes > this.maxRetainedBytes) {
      // A single pathological chunk larger than the whole cap: everything
      // retained so far precedes it in the stream, so evict all of it, then
      // keep only the chunk's tail (cut on a UTF-8 code point boundary).
      // Retention stays strictly bounded even for one giant write, and the
      // retained view stays contiguous (no hole in the middle).
      this.truncatedBytes += this.retainedBytes;
      this.truncatedChars += this.retainedChars;
      this.chunks = [];
      this.chunkStart = 0;
      this.retainedBytes = 0;
      this.retainedChars = 0;
      const raw = Buffer.from(chunk, "utf8");
      let start = raw.length - this.maxRetainedBytes;
      while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
      const dropped = raw.subarray(0, start).toString("utf8");
      this.truncatedBytes += start;
      this.truncatedChars += dropped.length;
      chunk = raw.subarray(start).toString("utf8");
      bytes = raw.length - start;
      chars = chunk.length;
    }
    this.chunks.push(chunk);
    this.retainedBytes += bytes;
    this.retainedChars += chars;
    while (
      this.retainedBytes > this.maxRetainedBytes &&
      this.chunks.length - this.chunkStart > 1
    ) {
      const evicted = this.chunks[this.chunkStart];
      if (evicted === undefined) break;
      this.chunkStart++;
      const evictedBytes = Buffer.byteLength(evicted, "utf8");
      this.retainedBytes -= evictedBytes;
      this.retainedChars -= evicted.length;
      this.truncatedBytes += evictedBytes;
      this.truncatedChars += evicted.length;
    }
    this.compactRaw();
    this.cachedText = undefined;
    this.version++;
    return spillAccepted;
  }

  view(): OutputView {
    const self = this;
    return {
      get text() {
        return self.retainedText();
      },
      get modelSafeText() {
        return self.retainedModelSafeText();
      },
      totalBytes: this.totalBytes,
      truncatedBytes: this.truncatedBytes,
      truncatedChars: this.truncatedChars,
      retainedChars: this.retainedChars,
      spillPath: this.spillPath,
      slice: (from, to) => self.sliceRetained(from, to),
    };
  }

  /** Code-unit slice of the retained text. `to` defaults to the retained end. */
  sliceRetained(from: number, to = this.retainedChars) {
    if (from < 0) from = 0;
    if (to > this.retainedChars) to = this.retainedChars;
    if (from >= to) return "";
    if (from === 0 && to === this.retainedChars) return this.retainedText();
    // A tail slice walks from the end so a new chunk does not scan the head.
    if (from >= this.retainedChars - from) {
      return this.sliceFromEnd(from, to);
    }
    return this.sliceFromStart(from, to);
  }

  private retainedText() {
    this.cachedText ??= this.joinLive(this.chunks, this.chunkStart);
    return this.cachedText;
  }

  private retainedModelSafeText() {
    this.cachedModelSafeText ??= this.joinLive(
      this.modelSafeChunks,
      this.modelSafeStart,
    );
    return this.cachedModelSafeText;
  }

  private joinLive(chunks: string[], start: number) {
    if (start === 0) return chunks.join("");
    if (start >= chunks.length) return "";
    return chunks.slice(start).join("");
  }

  private sliceFromStart(from: number, to: number) {
    const parts: string[] = [];
    let offset = 0;
    for (let index = this.chunkStart; index < this.chunks.length; index++) {
      const chunk = this.chunks[index];
      if (chunk === undefined) break;
      const next = offset + chunk.length;
      if (next > from && offset < to) {
        const start = Math.max(0, from - offset);
        const end = Math.min(chunk.length, to - offset);
        parts.push(this.piece(chunk, start, end));
      }
      if (next >= to) break;
      offset = next;
    }
    return this.joinParts(parts);
  }

  private sliceFromEnd(from: number, to: number) {
    const parts: string[] = [];
    let skipAfter = this.retainedChars - to;
    let need = to - from;
    for (
      let index = this.chunks.length - 1;
      index >= this.chunkStart;
      index--
    ) {
      const chunk = this.chunks[index];
      if (chunk === undefined) break;
      if (skipAfter >= chunk.length) {
        skipAfter -= chunk.length;
        continue;
      }
      const end = chunk.length - skipAfter;
      skipAfter = 0;
      const start = Math.max(0, end - need);
      parts.push(this.piece(chunk, start, end));
      need -= end - start;
      if (need === 0) break;
    }
    parts.reverse();
    return this.joinParts(parts);
  }

  private piece(chunk: string, start: number, end: number) {
    if (start === 0 && end === chunk.length) return chunk;
    return chunk.slice(start, end);
  }

  private joinParts(parts: string[]) {
    if (parts.length === 0) return "";
    if (parts.length === 1) return parts[0] ?? "";
    return parts.join("");
  }

  /**
   * Drop a long dead prefix in one copy. Until then, eviction is an index
   * increment rather than `shift()` of every retained chunk.
   */
  private compactRaw() {
    if (this.chunkStart < 1024 || this.chunkStart * 2 < this.chunks.length) {
      return;
    }
    this.chunks = this.chunks.slice(this.chunkStart);
    this.chunkStart = 0;
  }

  private compactModelSafe() {
    if (
      this.modelSafeStart < 1024 ||
      this.modelSafeStart * 2 < this.modelSafeChunks.length
    ) {
      return;
    }
    this.modelSafeChunks = this.modelSafeChunks.slice(this.modelSafeStart);
    this.modelSafeStart = 0;
  }

  private retainModelSafeText(text: string) {
    if (text.length === 0) return;
    let bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxRetainedBytes) {
      this.modelSafeChunks = [];
      this.modelSafeStart = 0;
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
      this.modelSafeChunks.length - this.modelSafeStart > 1
    ) {
      const evicted = this.modelSafeChunks[this.modelSafeStart];
      if (evicted === undefined) break;
      this.modelSafeStart++;
      this.modelSafeRetainedBytes -= Buffer.byteLength(evicted, "utf8");
    }
    this.compactModelSafe();
    this.cachedModelSafeText = undefined;
  }
}
