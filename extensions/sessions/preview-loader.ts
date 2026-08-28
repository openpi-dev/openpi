import type { BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { scheduler } from "node:timers/promises";
import {
  sessionEntryToContextMessages,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";

export const PREVIEW_MAX_MESSAGES = 80;
export const PREVIEW_MAX_RETAINED_BYTES = 1024 * 1024;
export const PREVIEW_MAX_LINE_BYTES = 8 * 1024 * 1024;
export const PREVIEW_READ_CHUNK_BYTES = 256 * 1024;
export const PREVIEW_MAX_HEADER_SCAN_BYTES = 1024 * 1024;

export type PreviewContextMessage = ReturnType<
  typeof sessionEntryToContextMessages
>[number];

export interface PreviewFileIdentity {
  path: string;
  device: string;
  inode: string;
  size: number;
  mtimeNs: string;
}

export interface SessionPreviewData {
  messages: PreviewContextMessage[];
  totalMessages: number;
  bytesRead: number;
  retainedBytes: number;
  truncatedBytes: number;
  identity: PreviewFileIdentity;
}

interface LoadSessionPreviewOptions {
  signal?: AbortSignal;
  onRead?: (bytesRead: number) => void;
}

interface ParsedLine {
  offset: number;
  value: Record<string, unknown>;
}

interface MessageSegment {
  messagesNewestFirst: MessageEnvelope[];
  projectedCount: number;
  retainedBytes: number;
  retentionClosed: boolean;
}

interface MessageEnvelope {
  message: PreviewContextMessage;
  originalBytes: number;
  retainedBytes: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

function previewFormatError(path: string, offset: number, reason: string) {
  return new Error(
    `Session preview ${reason} at byte offset ${offset}: ${path}`,
  );
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Session preview loading was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError(signal);
}

function decodeLine(path: string, bytes: Buffer, offset: number) {
  const withoutCarriageReturn =
    bytes.at(-1) === 0x0d ? bytes.subarray(0, -1) : bytes;
  if (withoutCarriageReturn.length === 0) return undefined;
  if (withoutCarriageReturn.length > PREVIEW_MAX_LINE_BYTES) {
    throw previewFormatError(path, offset, "line exceeds 8388608 bytes");
  }

  let text: string;
  try {
    text = decoder.decode(withoutCarriageReturn);
  } catch {
    throw previewFormatError(path, offset, "contains invalid UTF-8");
  }
  if (!text.trim()) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw previewFormatError(path, offset, "contains malformed JSONL");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw previewFormatError(path, offset, "entry is not a JSON object");
  }
  return value as Record<string, unknown>;
}

async function* readLinesReverse(
  handle: FileHandle,
  path: string,
  size: number,
  signal: AbortSignal | undefined,
  onRead: (bytes: number) => void,
): AsyncGenerator<ParsedLine> {
  let position = size;
  let pending = Buffer.alloc(0);

  while (position > 0) {
    throwIfAborted(signal);
    const start = Math.max(0, position - PREVIEW_READ_CHUNK_BYTES);
    const chunk = Buffer.allocUnsafe(position - start);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, start);
    if (bytesRead !== chunk.length) {
      throw new Error(
        `Session file changed while preview was loading: ${path}`,
      );
    }
    onRead(bytesRead);
    const combined = Buffer.concat([chunk, pending]);
    let lineEnd = combined.length;

    for (let index = combined.length - 1; index >= 0; index--) {
      if (combined[index] !== 0x0a) continue;
      const offset = start + index + 1;
      const value = decodeLine(
        path,
        combined.subarray(index + 1, lineEnd),
        offset,
      );
      if (value) yield { offset, value };
      lineEnd = index;
    }

    pending = Buffer.from(combined.subarray(0, lineEnd));
    if (pending.length > PREVIEW_MAX_LINE_BYTES) {
      throw previewFormatError(path, start, "line exceeds 8388608 bytes");
    }
    position = start;
    await scheduler.yield();
  }

  const value = decodeLine(path, pending, 0);
  if (value) yield { offset: 0, value };
}

async function* readLinesForward(
  handle: FileHandle,
  path: string,
  size: number,
  signal: AbortSignal | undefined,
  onRead: (bytes: number) => void,
): AsyncGenerator<ParsedLine> {
  let position = 0;
  let pending = Buffer.alloc(0);
  let pendingOffset = 0;

  while (position < size) {
    throwIfAborted(signal);
    const readLength = Math.min(PREVIEW_READ_CHUNK_BYTES, size - position);
    const chunk = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(chunk, 0, readLength, position);
    if (bytesRead !== readLength) {
      throw new Error(
        `Session file changed while preview was loading: ${path}`,
      );
    }
    onRead(bytesRead);
    const combined = Buffer.concat([pending, chunk]);
    let lineStart = 0;

    for (let index = 0; index < combined.length; index++) {
      if (combined[index] !== 0x0a) continue;
      const offset = pendingOffset + lineStart;
      const value = decodeLine(
        path,
        combined.subarray(lineStart, index),
        offset,
      );
      if (value) yield { offset, value };
      lineStart = index + 1;
    }

    pending = Buffer.from(combined.subarray(lineStart));
    pendingOffset = position + readLength - pending.length;
    if (pending.length > PREVIEW_MAX_LINE_BYTES) {
      throw previewFormatError(
        path,
        pendingOffset,
        "line exceeds 8388608 bytes",
      );
    }
    position += readLength;
    await scheduler.yield();
  }

  const value = decodeLine(path, pending, pendingOffset);
  if (value) yield { offset: pendingOffset, value };
}

function fileIdentity(path: string, stats: BigIntStats): PreviewFileIdentity {
  return {
    path,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: Number(stats.size),
    mtimeNs: stats.mtimeNs.toString(),
  };
}

function previewFileChangedError(path: string) {
  return new Error(`Session file changed while preview was loading: ${path}`);
}

function samePreviewFileIdentity(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function finalizePreviewFileIdentity(
  path: string,
  handle: FileHandle,
  before: BigIntStats,
) {
  let after: BigIntStats;
  let currentPath: BigIntStats;
  try {
    [after, currentPath] = await Promise.all([
      handle.stat({ bigint: true }),
      stat(path, { bigint: true }),
    ]);
  } catch {
    throw previewFileChangedError(path);
  }
  if (
    !samePreviewFileIdentity(before, after) ||
    !samePreviewFileIdentity(after, currentPath)
  ) {
    throw previewFileChangedError(path);
  }
  return fileIdentity(path, currentPath);
}

export async function readPreviewFileIdentity(path: string) {
  return fileIdentity(path, await stat(path, { bigint: true }));
}

function validateIndexedEntry(
  path: string,
  line: ParsedLine,
): SessionEntry & Record<string, unknown> {
  const { value } = line;
  if (typeof value.id !== "string") {
    throw previewFormatError(path, line.offset, "entry has no string id");
  }
  if (value.parentId !== null && typeof value.parentId !== "string") {
    throw previewFormatError(path, line.offset, "entry has invalid parentId");
  }
  return value as SessionEntry & Record<string, unknown>;
}

function validateHeader(path: string, line: ParsedLine) {
  const value = line.value;
  if (value.type !== "session" || typeof value.id !== "string") {
    throw previewFormatError(path, line.offset, "has no valid session header");
  }
  const version = value.version ?? 1;
  if (
    !Number.isInteger(version) ||
    Number(version) < 1 ||
    Number(version) > 3
  ) {
    throw previewFormatError(
      path,
      line.offset,
      "uses an unsupported session version",
    );
  }
  return {
    header: value as unknown as SessionHeader,
    version: Number(version),
  };
}

async function readSessionHeader(
  handle: FileHandle,
  path: string,
  size: number,
  signal: AbortSignal | undefined,
  onRead: (bytes: number) => void,
) {
  const scanBytes = Math.min(size, PREVIEW_MAX_HEADER_SCAN_BYTES);
  for await (const line of readLinesForward(
    handle,
    path,
    scanBytes,
    signal,
    onRead,
  )) {
    return { line, ...validateHeader(path, line) };
  }
  if (size > scanBytes) {
    throw previewFormatError(path, scanBytes, "header exceeds 1048576 bytes");
  }
  throw previewFormatError(path, 0, "has no valid session header");
}

function normalizeEntryForVersion(
  entry: SessionEntry & Record<string, unknown>,
  version: number,
) {
  if (version > 2 || entry.type !== "message") return entry;
  const rawMessage = entry.message as unknown;
  if (
    typeof rawMessage !== "object" ||
    rawMessage === null ||
    !("role" in rawMessage) ||
    rawMessage.role !== "hookMessage"
  ) {
    return entry;
  }
  return {
    ...entry,
    message: { ...rawMessage, role: "custom" },
  } as SessionEntry & Record<string, unknown>;
}

function createMessageSegment(): MessageSegment {
  return {
    messagesNewestFirst: [],
    projectedCount: 0,
    retainedBytes: 0,
    retentionClosed: false,
  };
}

function measurePreviewPayload(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Array.isArray(value)) {
    return (
      8 + value.reduce((total, item) => total + measurePreviewPayload(item), 0)
    );
  }
  if (typeof value !== "object" || value === null) return 8;
  return (
    8 +
    Object.entries(value).reduce(
      (total, [key, nested]) =>
        total + Buffer.byteLength(key, "utf8") + measurePreviewPayload(nested),
      0,
    )
  );
}

function truncateUtf8(value: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint), "utf8") <= maxBytes) {
      low = midpoint;
    } else {
      high = midpoint - 1;
    }
  }
  let end = low;
  const code = value.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return value.slice(0, Math.max(0, end));
}

interface ProjectionBudget {
  remaining: number;
  retained: number;
  omitted: number;
}

function boundPreviewValue(value: unknown, budget: ProjectionBudget): unknown {
  if (typeof value === "string") {
    const originalBytes = Buffer.byteLength(value, "utf8");
    if (originalBytes <= budget.remaining) {
      budget.remaining -= originalBytes;
      budget.retained += originalBytes;
      return value;
    }
    if (budget.remaining <= 0) {
      budget.omitted += originalBytes;
      return "";
    }

    let marker = `… ${originalBytes} bytes omitted from preview`;
    let kept = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const markerBytes = Buffer.byteLength(marker, "utf8");
      kept = truncateUtf8(value, Math.max(0, budget.remaining - markerBytes));
      const keptBytes = Buffer.byteLength(kept, "utf8");
      marker = `… ${originalBytes - keptBytes} bytes omitted from preview`;
    }
    const boundedMarker = truncateUtf8(
      marker,
      Math.max(0, budget.remaining - Buffer.byteLength(kept, "utf8")),
    );
    const projected = `${kept}${boundedMarker}`;
    const retained = Buffer.byteLength(projected, "utf8");
    budget.remaining -= retained;
    budget.retained += retained;
    budget.omitted += originalBytes - Buffer.byteLength(kept, "utf8");
    return projected;
  }

  if (Array.isArray(value)) {
    if (budget.remaining < 8) {
      budget.omitted += measurePreviewPayload(value);
      return [];
    }
    budget.remaining -= 8;
    budget.retained += 8;
    const bounded: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      if (budget.remaining <= 0) {
        for (let omitted = index; omitted < value.length; omitted++) {
          budget.omitted += measurePreviewPayload(value[omitted]);
        }
        break;
      }
      const remainingBeforeItem = budget.remaining;
      const projected = boundPreviewValue(value[index], budget);
      if (projected === undefined && budget.remaining === remainingBeforeItem) {
        for (let omitted = index + 1; omitted < value.length; omitted++) {
          budget.omitted += measurePreviewPayload(value[omitted]);
        }
        break;
      }
      bounded.push(projected);
    }
    return bounded;
  }
  if (typeof value !== "object" || value === null) {
    if (budget.remaining < 8) {
      budget.omitted += 8;
      return undefined;
    }
    budget.remaining -= 8;
    budget.retained += 8;
    return value;
  }

  if (budget.remaining < 8) {
    budget.omitted += measurePreviewPayload(value);
    return {};
  }
  budget.remaining -= 8;
  budget.retained += 8;

  const bounded: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const keyBytes = Buffer.byteLength(key, "utf8");
    if (keyBytes > budget.remaining) {
      budget.omitted += keyBytes + measurePreviewPayload(nested);
      continue;
    }
    budget.remaining -= keyBytes;
    budget.retained += keyBytes;
    bounded[key] = boundPreviewValue(nested, budget);
  }
  return bounded;
}

function boundPreviewMessage(message: PreviewContextMessage, maxBytes: number) {
  const budget: ProjectionBudget = {
    remaining: Math.max(0, maxBytes),
    retained: 0,
    omitted: 0,
  };
  const bounded = boundPreviewValue(message, budget) as PreviewContextMessage;
  return {
    message: bounded,
    retainedBytes: budget.retained,
    omittedBytes: budget.omitted,
  };
}

function appendProjectedNewestFirst(
  segment: MessageSegment,
  projected: PreviewContextMessage[],
) {
  segment.projectedCount += projected.length;
  for (let index = projected.length - 1; index >= 0; index--) {
    if (segment.retentionClosed) continue;
    const message = projected[index]!;
    if (segment.messagesNewestFirst.length >= PREVIEW_MAX_MESSAGES) {
      segment.retentionClosed = true;
      continue;
    }
    const originalBytes = measurePreviewPayload(message);
    const bounded = boundPreviewMessage(
      message,
      PREVIEW_MAX_RETAINED_BYTES - segment.retainedBytes,
    );
    segment.messagesNewestFirst.push({
      message: bounded.message,
      originalBytes,
      retainedBytes: bounded.retainedBytes,
    });
    segment.retainedBytes += bounded.retainedBytes;
    if (bounded.omittedBytes > 0) segment.retentionClosed = true;
  }
}

function appendProjectedForward(
  segment: MessageSegment,
  projected: PreviewContextMessage[],
) {
  segment.projectedCount += projected.length;
  for (const message of projected) {
    const originalBytes = measurePreviewPayload(message);
    const bounded = boundPreviewMessage(message, PREVIEW_MAX_RETAINED_BYTES);
    segment.messagesNewestFirst.unshift({
      message: bounded.message,
      originalBytes,
      retainedBytes: bounded.retainedBytes,
    });
    segment.retainedBytes += bounded.retainedBytes;
    while (
      segment.messagesNewestFirst.length > PREVIEW_MAX_MESSAGES ||
      segment.retainedBytes > PREVIEW_MAX_RETAINED_BYTES
    ) {
      const evicted = segment.messagesNewestFirst.pop();
      if (!evicted) break;
      segment.retainedBytes -= evicted.retainedBytes;
    }
  }
}

function retainNewestMessages(messages: MessageEnvelope[]) {
  const retainedNewestFirst: PreviewContextMessage[] = [];
  let retainedBytes = 0;
  let truncatedBytes = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (retainedNewestFirst.length >= PREVIEW_MAX_MESSAGES) break;
    const envelope = messages[index]!;
    const bounded = boundPreviewMessage(
      envelope.message,
      PREVIEW_MAX_RETAINED_BYTES - retainedBytes,
    );
    retainedNewestFirst.push(bounded.message);
    retainedBytes += bounded.retainedBytes;
    truncatedBytes += Math.max(
      0,
      envelope.originalBytes - bounded.retainedBytes,
    );
    if (
      bounded.omittedBytes > 0 ||
      retainedBytes >= PREVIEW_MAX_RETAINED_BYTES
    ) {
      break;
    }
  }
  return {
    messages: retainedNewestFirst.reverse(),
    retainedBytes,
    truncatedBytes,
  };
}

interface LegacyCompaction {
  entryIndex: number;
  firstKeptEntryIndex: number | undefined;
}

function projectLegacyEntry(value: Record<string, unknown>) {
  const entry = normalizeEntryForVersion(
    value as SessionEntry & Record<string, unknown>,
    1,
  );
  return sessionEntryToContextMessages(entry);
}

async function loadLegacyPreview(
  handle: FileHandle,
  path: string,
  size: number,
  signal: AbortSignal | undefined,
  onRead: (bytes: number) => void,
) {
  const allMessages = createMessageSegment();
  let latestCompaction: LegacyCompaction | undefined;
  let entryIndex = -1;
  let sawHeader = false;

  for await (const line of readLinesForward(
    handle,
    path,
    size,
    signal,
    onRead,
  )) {
    entryIndex++;
    if (line.value.type === "session") {
      if (sawHeader || entryIndex !== 0) {
        throw previewFormatError(
          path,
          line.offset,
          "has multiple session headers",
        );
      }
      sawHeader = true;
      validateHeader(path, line);
      continue;
    }
    if (!sawHeader) {
      throw previewFormatError(
        path,
        line.offset,
        "has no valid session header",
      );
    }

    if (line.value.type === "compaction") {
      const firstKept = line.value.firstKeptEntryIndex;
      if (firstKept !== undefined && !Number.isInteger(firstKept)) {
        throw previewFormatError(
          path,
          line.offset,
          "compaction has invalid firstKeptEntryIndex",
        );
      }
      latestCompaction = {
        entryIndex,
        firstKeptEntryIndex:
          typeof firstKept === "number" && firstKept >= 1
            ? firstKept
            : undefined,
      };
    }
    appendProjectedForward(allMessages, projectLegacyEntry(line.value));
  }

  if (!sawHeader) {
    throw previewFormatError(path, 0, "has no valid session header");
  }
  if (!latestCompaction) {
    const retained = retainNewestMessages(
      [...allMessages.messagesNewestFirst].reverse(),
    );
    return {
      messages: retained.messages,
      totalMessages: allMessages.projectedCount,
      retainedBytes: retained.retainedBytes,
      truncatedBytes: retained.truncatedBytes,
    };
  }

  const compactionMessages = createMessageSegment();
  const preCompaction = createMessageSegment();
  const postCompaction = createMessageSegment();
  const firstKept = latestCompaction.firstKeptEntryIndex;
  const hasKeptRange =
    firstKept !== undefined && firstKept < latestCompaction.entryIndex;
  entryIndex = -1;

  for await (const line of readLinesForward(
    handle,
    path,
    size,
    signal,
    onRead,
  )) {
    entryIndex++;
    if (entryIndex === 0) continue;
    const projected = projectLegacyEntry(line.value);
    if (entryIndex === latestCompaction.entryIndex) {
      appendProjectedNewestFirst(compactionMessages, projected);
    } else if (
      hasKeptRange &&
      entryIndex >= firstKept &&
      entryIndex < latestCompaction.entryIndex
    ) {
      appendProjectedForward(preCompaction, projected);
    } else if (entryIndex > latestCompaction.entryIndex) {
      appendProjectedForward(postCompaction, projected);
    }
  }

  const ordered = [
    ...[...compactionMessages.messagesNewestFirst].reverse(),
    ...[...preCompaction.messagesNewestFirst].reverse(),
    ...[...postCompaction.messagesNewestFirst].reverse(),
  ];
  const retained = retainNewestMessages(ordered);
  return {
    messages: retained.messages,
    totalMessages:
      compactionMessages.projectedCount +
      preCompaction.projectedCount +
      postCompaction.projectedCount,
    retainedBytes: retained.retainedBytes,
    truncatedBytes: retained.truncatedBytes,
  };
}

export async function loadSessionPreviewData(
  path: string,
  options: LoadSessionPreviewOptions = {},
): Promise<SessionPreviewData> {
  throwIfAborted(options.signal);
  const handle = await open(path, "r");
  let bytesRead = 0;
  const recordRead = (count: number) => {
    bytesRead += count;
    options.onRead?.(count);
  };

  try {
    const before = await handle.stat({ bigint: true });
    const discoveredHeader = await readSessionHeader(
      handle,
      path,
      Number(before.size),
      options.signal,
      recordRead,
    );
    if (discoveredHeader.version === 1) {
      const legacy = await loadLegacyPreview(
        handle,
        path,
        Number(before.size),
        options.signal,
        recordRead,
      );
      throwIfAborted(options.signal);
      const identity = await finalizePreviewFileIdentity(path, handle, before);
      return {
        ...legacy,
        bytesRead,
        identity,
      };
    }
    const postCompaction = createMessageSegment();
    const preCompaction = createMessageSegment();
    let compactionMessages: MessageSegment | undefined;
    let compactionFirstKeptId: string | undefined;
    let foundFirstKept = false;
    let expectedId: string | null | undefined;
    let headerLine: ParsedLine | undefined;
    let earliestLine: ParsedLine | undefined;

    for await (const line of readLinesReverse(
      handle,
      path,
      Number(before.size),
      options.signal,
      recordRead,
    )) {
      earliestLine = line;
      if (line.value.type === "session") {
        if (headerLine) {
          throw previewFormatError(
            path,
            line.offset,
            "has multiple session headers",
          );
        }
        headerLine = line;
        continue;
      }

      const entry = normalizeEntryForVersion(
        validateIndexedEntry(path, line),
        discoveredHeader.version,
      );
      const isActive =
        expectedId === undefined ||
        (expectedId !== null && entry.id === expectedId);
      if (!isActive) continue;
      expectedId = entry.parentId;

      const projected = sessionEntryToContextMessages(entry);
      if (!compactionMessages && entry.type === "compaction") {
        compactionMessages = createMessageSegment();
        appendProjectedNewestFirst(compactionMessages, projected);
        compactionFirstKeptId = entry.firstKeptEntryId;
        continue;
      }
      if (!compactionMessages) {
        appendProjectedNewestFirst(postCompaction, projected);
        continue;
      }
      if (!foundFirstKept) {
        appendProjectedNewestFirst(preCompaction, projected);
        if (entry.id === compactionFirstKeptId) foundFirstKept = true;
      }
    }

    if (!headerLine || earliestLine !== headerLine) {
      throw previewFormatError(path, 0, "has no valid session header");
    }
    if (expectedId !== undefined && expectedId !== null) {
      throw previewFormatError(
        path,
        headerLine.offset,
        "active lineage references a missing parent",
      );
    }
    const reverseHeader = validateHeader(path, headerLine);
    if (reverseHeader.version !== discoveredHeader.version) {
      throw new Error(
        `Session file changed while preview was loading: ${path}`,
      );
    }

    throwIfAborted(options.signal);
    const identity = await finalizePreviewFileIdentity(path, handle, before);

    const orderedMessages = compactionMessages
      ? [
          ...[...compactionMessages.messagesNewestFirst].reverse(),
          ...(foundFirstKept
            ? [...preCompaction.messagesNewestFirst].reverse()
            : []),
          ...[...postCompaction.messagesNewestFirst].reverse(),
        ]
      : [...postCompaction.messagesNewestFirst].reverse();
    const retained = retainNewestMessages(orderedMessages);
    const totalMessages = compactionMessages
      ? compactionMessages.projectedCount +
        postCompaction.projectedCount +
        (foundFirstKept ? preCompaction.projectedCount : 0)
      : postCompaction.projectedCount;

    return {
      messages: retained.messages,
      totalMessages,
      bytesRead,
      retainedBytes: retained.retainedBytes,
      truncatedBytes: retained.truncatedBytes,
      identity,
    };
  } finally {
    await handle.close();
  }
}
