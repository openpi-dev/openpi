import type { Stats } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const WEB_TRANSCRIPT_SEARCH_MAX_QUERY_CHARACTERS = 200;
export const WEB_TRANSCRIPT_SEARCH_MAX_FILES = 250;
export const WEB_TRANSCRIPT_SEARCH_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const WEB_TRANSCRIPT_SEARCH_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const WEB_TRANSCRIPT_SEARCH_MAX_LINE_BYTES = 256 * 1024;
export const WEB_TRANSCRIPT_SEARCH_MAX_RESULTS = 100;
export const WEB_TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES = 512;
export const WEB_TRANSCRIPT_SEARCH_MAX_DURATION_MS = 1_000;

const READ_CHUNK_BYTES = 64 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type WebTranscriptSearchSource = "web" | "terminal";
export type WebTranscriptMatchSource =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result";

export type WebTranscriptSearchPartialReason =
  | "file-limit"
  | "byte-limit"
  | "per-file-byte-limit"
  | "result-limit"
  | "time-limit"
  | "malformed-session"
  | "changed-session"
  | "unavailable-session"
  | "unauthorized-session";

export interface WebTranscriptSearchSession {
  id: string;
  path: string;
  cwd: string;
  modified: string;
  source: WebTranscriptSearchSource;
  archived?: boolean;
}

export interface WebTranscriptSearchLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxLineBytes: number;
  maxResults: number;
  maxSnippetBytes: number;
  maxDurationMs: number;
}

export interface WebTranscriptSearchMatch {
  sessionId: string;
  sessionPath: string;
  workspace: string;
  sessionSource: WebTranscriptSearchSource;
  messageId: string;
  turnId?: string;
  parentId?: string;
  timestamp?: string;
  source: WebTranscriptMatchSource;
  toolName?: string;
  snippet: string;
  snippetFormat: "plain-text";
  snippetTruncated: boolean;
  lineOffset: number;
}

export interface WebTranscriptSearchResponse {
  matches: WebTranscriptSearchMatch[];
  scannedFiles: number;
  scannedBytes: number;
  skippedFiles: number;
  malformedLines: number;
  partial: boolean;
  partialReasons: WebTranscriptSearchPartialReason[];
  limits: WebTranscriptSearchLimits;
}

export interface WebTranscriptSearchOptions {
  query: string;
  sessions: readonly WebTranscriptSearchSession[];
  allowedSessionRoots: readonly string[];
  allowedWorkspaces: readonly string[];
  includeArchived?: boolean;
  signal?: AbortSignal;
  limits?: Partial<WebTranscriptSearchLimits>;
  now?: () => number;
}

interface SearchEvidence {
  source: WebTranscriptMatchSource;
  text: string;
  toolName?: string;
}

interface FileScanResult {
  status: "ok";
  matches: WebTranscriptSearchMatch[];
  matchedBeyondLimit: boolean;
  malformedLines: number;
  bytes: number;
  truncated: boolean;
}

interface FileScanFailure {
  status: "changed" | "unavailable" | "time";
  bytes: number;
}

const defaultLimits: WebTranscriptSearchLimits = {
  maxFiles: WEB_TRANSCRIPT_SEARCH_MAX_FILES,
  maxTotalBytes: WEB_TRANSCRIPT_SEARCH_MAX_TOTAL_BYTES,
  maxFileBytes: WEB_TRANSCRIPT_SEARCH_MAX_FILE_BYTES,
  maxLineBytes: WEB_TRANSCRIPT_SEARCH_MAX_LINE_BYTES,
  maxResults: WEB_TRANSCRIPT_SEARCH_MAX_RESULTS,
  maxSnippetBytes: WEB_TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES,
  maxDurationMs: WEB_TRANSCRIPT_SEARCH_MAX_DURATION_MS,
};

function boundedLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Transcript search limits must be positive integers");
  }
  return Math.min(value, maximum);
}

function searchLimits(
  requested: Partial<WebTranscriptSearchLimits> | undefined,
) {
  return {
    maxFiles: boundedLimit(
      requested?.maxFiles,
      defaultLimits.maxFiles,
      WEB_TRANSCRIPT_SEARCH_MAX_FILES,
    ),
    maxTotalBytes: boundedLimit(
      requested?.maxTotalBytes,
      defaultLimits.maxTotalBytes,
      WEB_TRANSCRIPT_SEARCH_MAX_TOTAL_BYTES,
    ),
    maxFileBytes: boundedLimit(
      requested?.maxFileBytes,
      defaultLimits.maxFileBytes,
      WEB_TRANSCRIPT_SEARCH_MAX_FILE_BYTES,
    ),
    maxLineBytes: boundedLimit(
      requested?.maxLineBytes,
      defaultLimits.maxLineBytes,
      WEB_TRANSCRIPT_SEARCH_MAX_LINE_BYTES,
    ),
    maxResults: boundedLimit(
      requested?.maxResults,
      defaultLimits.maxResults,
      WEB_TRANSCRIPT_SEARCH_MAX_RESULTS,
    ),
    maxSnippetBytes: boundedLimit(
      requested?.maxSnippetBytes,
      defaultLimits.maxSnippetBytes,
      WEB_TRANSCRIPT_SEARCH_MAX_SNIPPET_BYTES,
    ),
    maxDurationMs: boundedLimit(
      requested?.maxDurationMs,
      defaultLimits.maxDurationMs,
      WEB_TRANSCRIPT_SEARCH_MAX_DURATION_MS,
    ),
  } satisfies WebTranscriptSearchLimits;
}

function abortError(signal: AbortSignal) {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Transcript search was cancelled.");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw abortError(signal);
}

function pathWithin(path: string, root: string) {
  const remainder = relative(root, path);
  return (
    remainder === "" ||
    (!remainder.startsWith(`..${sep}`) &&
      remainder !== ".." &&
      !isAbsolute(remainder))
  );
}

function normalizeSearchText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function queryTokens(query: string) {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("Transcript search query must not be empty");
  if (trimmed.length > WEB_TRANSCRIPT_SEARCH_MAX_QUERY_CHARACTERS) {
    throw new Error(
      `Transcript search query must not exceed ${WEB_TRANSCRIPT_SEARCH_MAX_QUERY_CHARACTERS} characters`,
    );
  }
  return normalizeSearchText(trimmed).split(/\s+/u);
}

function textContent(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const record = part as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string"
        ? [record.text]
        : [];
    })
    .join("\n");
}

function messageEvidence(message: unknown): SearchEvidence[] {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return [];
  }
  const record = message as Record<string, unknown>;
  const role = record.role;
  if (role === "user" || role === "assistant") {
    const evidence: SearchEvidence[] = [];
    const text = textContent(record.content);
    if (text) evidence.push({ source: role, text });
    if (role === "assistant" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        const tool = part as Record<string, unknown>;
        if (tool.type !== "toolCall" || typeof tool.name !== "string") continue;
        evidence.push({
          source: "tool_call",
          toolName: tool.name,
          text: tool.name,
        });
      }
    }
    return evidence;
  }
  if (role !== "toolResult") return [];
  const toolName = typeof record.toolName === "string" ? record.toolName : undefined;
  // Tool output can contain credentials, paths, or other private payloads.
  // Keep only the stable, non-secret tool identity searchable.
  const text = toolName ?? "";
  return text ? [{ source: "tool_result", text, ...(toolName ? { toolName } : {}) }] : [];
}

function safePlainText(value: string) {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function utf8Prefix(value: string, maxBytes: number) {
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
  while (low > 0 && /[\uD800-\uDBFF]/u.test(value[low - 1] ?? "")) low--;
  return value.slice(0, low);
}

function utf8Suffix(value: string, maxBytes: number) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(midpoint), "utf8") <= maxBytes) {
      high = midpoint;
    } else {
      low = midpoint + 1;
    }
  }
  while (low < value.length && /[\uDC00-\uDFFF]/u.test(value[low] ?? "")) low++;
  return value.slice(low);
}

function snippet(value: string, token: string, maxBytes: number) {
  const safe = safePlainText(value);
  if (Buffer.byteLength(safe, "utf8") <= maxBytes) {
    return { value: safe, truncated: false };
  }
  const normalized = normalizeSearchText(safe);
  const match = Math.max(0, normalized.indexOf(token));
  const before = safe.slice(0, match);
  const beforeContext = utf8Suffix(before, Math.floor(maxBytes / 3));
  const prefix = beforeContext.length < before.length ? "…" : "";
  const suffix = "…";
  const tailBudget = Math.max(
    1,
    maxBytes - Buffer.byteLength(prefix + beforeContext + suffix, "utf8"),
  );
  return {
    value: utf8Prefix(
      `${prefix}${beforeContext}${utf8Prefix(safe.slice(match), tailBudget)}${suffix}`,
      maxBytes,
    ),
    truncated: true,
  };
}

function timestamp(value: unknown) {
  const date =
    typeof value === "number" && Number.isFinite(value)
      ? new Date(value)
      : typeof value === "string"
        ? new Date(value)
        : undefined;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
}

function matchOrder(left: WebTranscriptSearchMatch, right: WebTranscriptSearchMatch) {
  const time = (Date.parse(right.timestamp ?? "") || 0) - (Date.parse(left.timestamp ?? "") || 0);
  if (time !== 0) return time;
  const path = left.sessionPath.localeCompare(right.sessionPath);
  if (path !== 0) return path;
  if (left.lineOffset !== right.lineOffset) return right.lineOffset - left.lineOffset;
  return left.source.localeCompare(right.source);
}

function retainMatch(
  matches: WebTranscriptSearchMatch[],
  match: WebTranscriptSearchMatch,
  maxResults: number,
) {
  matches.push(match);
  matches.sort(matchOrder);
  if (matches.length <= maxResults) return false;
  matches.pop();
  return true;
}

function sameIdentity(before: Stats, after: Stats) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs
  );
}

async function scanSessionFile(
  session: WebTranscriptSearchSession,
  canonicalPath: string,
  tokens: string[],
  byteBudget: number,
  limits: WebTranscriptSearchLimits,
  signal: AbortSignal | undefined,
  expired: () => boolean,
): Promise<FileScanResult | FileScanFailure> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let bytesConsumed = 0;
  try {
    const beforePath = await stat(canonicalPath);
    handle = await open(canonicalPath, "r");
    const before = await handle.stat();
    if (!sameIdentity(beforePath, before)) {
      return { status: "changed", bytes: bytesConsumed };
    }
    const readLimit = Math.min(before.size, byteBudget, limits.maxFileBytes);
    const matches: WebTranscriptSearchMatch[] = [];
    const turnByEntry = new Map<string, string>();
    let malformedLines = 0;
    let matchedBeyondLimit = false;
    let position = 0;
    let pending = Buffer.alloc(0);
    let pendingOffset = 0;
    let discardingLine = false;
    let headerSeen = false;
    let invalidHeader = false;

    const processLine = (bytes: Buffer, lineOffset: number) => {
      if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
      if (bytes.length === 0) return;
      if (bytes.length > limits.maxLineBytes) {
        malformedLines++;
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(bytes));
      } catch {
        malformedLines++;
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        malformedLines++;
        return;
      }
      const entry = value as Record<string, unknown>;
      if (!headerSeen) {
        headerSeen = true;
        if (entry.type !== "session" || entry.id !== session.id) {
          malformedLines++;
          invalidHeader = true;
        }
        return;
      }
      if (invalidHeader) return;
      if (
        typeof entry.id !== "string" ||
        (entry.parentId !== null && typeof entry.parentId !== "string")
      ) return;
      const parentId = typeof entry.parentId === "string" ? entry.parentId : undefined;
      const message = entry.message as Record<string, unknown> | undefined;
      const isUser = message?.role === "user";
      const turnId = isUser ? entry.id : parentId ? turnByEntry.get(parentId) : undefined;
      if (turnId) turnByEntry.set(entry.id, turnId);
      if (entry.type !== "message") return;
      for (const evidence of messageEvidence(entry.message)) {
        const searchable = normalizeSearchText(evidence.text);
        if (!tokens.every((token) => searchable.includes(token))) continue;
        const projected = snippet(evidence.text, tokens[0]!, limits.maxSnippetBytes);
        const matchTimestamp = timestamp(message?.timestamp ?? entry.timestamp);
        matchedBeyondLimit =
          retainMatch(
            matches,
            {
              sessionId: session.id,
              sessionPath: canonicalPath,
              workspace: resolve(session.cwd),
              sessionSource: session.source,
              messageId: entry.id,
              ...(turnId ? { turnId } : {}),
              ...(parentId ? { parentId } : {}),
              ...(matchTimestamp ? { timestamp: matchTimestamp } : {}),
              source: evidence.source,
              ...(evidence.toolName ? { toolName: evidence.toolName } : {}),
              snippet: projected.value,
              snippetFormat: "plain-text",
              snippetTruncated: projected.truncated,
              lineOffset,
            },
            limits.maxResults,
          ) || matchedBeyondLimit;
      }
    };

    while (position < readLimit) {
      throwIfAborted(signal);
      if (expired()) return { status: "time", bytes: bytesConsumed };
      const size = Math.min(READ_CHUNK_BYTES, readLimit - position);
      const chunk = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(chunk, 0, size, position);
      bytesConsumed += bytesRead;
      if (bytesRead !== size) {
        return { status: "changed", bytes: bytesConsumed };
      }
      const combined = Buffer.concat([pending, chunk]);
      let lineStart = 0;
      for (let index = 0; index < combined.length; index++) {
        if (combined[index] !== 0x0a) continue;
        if (expired()) return { status: "time", bytes: bytesConsumed };
        if (!discardingLine) {
          processLine(combined.subarray(lineStart, index), pendingOffset + lineStart);
        }
        discardingLine = false;
        lineStart = index + 1;
      }
      pending = Buffer.from(combined.subarray(lineStart));
      pendingOffset = position + bytesRead - pending.length;
      if (pending.length > limits.maxLineBytes) {
        malformedLines++;
        pending = Buffer.alloc(0);
        pendingOffset = position + bytesRead;
        discardingLine = true;
      }
      position += bytesRead;
    }
    if (!discardingLine && readLimit === before.size) {
      processLine(pending, pendingOffset);
    }
    if (!headerSeen) malformedLines++;
    let afterPath;
    try {
      afterPath = await stat(canonicalPath);
    } catch {
      return { status: "changed", bytes: bytesConsumed };
    }
    const after = await handle.stat();
    if (!sameIdentity(before, after) || !sameIdentity(after, afterPath)) {
      return { status: "changed", bytes: bytesConsumed };
    }
    return {
      status: "ok",
      matches: invalidHeader ? [] : matches,
      matchedBeyondLimit,
      malformedLines,
      bytes: bytesConsumed,
      truncated: readLimit < before.size,
    };
  } catch (error) {
    if (typeof (error as NodeJS.ErrnoException).code === "string") {
      return { status: "unavailable", bytes: bytesConsumed };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Search a caller-authorized Session catalog without discovering additional
 * paths. The catalog, content reads, retained matches, and wall time are all
 * bounded independently; Session files remain the source of truth.
 */
export async function searchWebTranscripts(
  options: WebTranscriptSearchOptions,
): Promise<WebTranscriptSearchResponse> {
  const tokens = queryTokens(options.query);
  const limits = searchLimits(options.limits);
  const now = options.now ?? Date.now;
  const startedAt = now();
  const expired = () => now() - startedAt >= limits.maxDurationMs;
  const reasons = new Set<WebTranscriptSearchPartialReason>();
  const matches: WebTranscriptSearchMatch[] = [];
  const requestedSessionRoots = options.allowedSessionRoots.map((root) =>
    resolve(root),
  );
  const sessionRoots = await Promise.all(
    requestedSessionRoots.map((root) => realpath(root)),
  );
  const workspaces = new Set(options.allowedWorkspaces.map((path) => resolve(path)));
  if (options.sessions.length > limits.maxFiles) reasons.add("file-limit");
  const sessions = options.sessions
    .slice(0, limits.maxFiles)
    .filter((session) => options.includeArchived === true || session.archived !== true)
    .sort((left, right) => {
      const modified = (Date.parse(right.modified) || 0) - (Date.parse(left.modified) || 0);
      return modified || left.path.localeCompare(right.path);
    });
  let scannedFiles = 0;
  let scannedBytes = 0;
  let skippedFiles = 0;
  let malformedLines = 0;

  for (const session of sessions) {
    throwIfAborted(options.signal);
    if (expired()) {
      reasons.add("time-limit");
      break;
    }
    if (!workspaces.has(resolve(session.cwd))) {
      skippedFiles++;
      reasons.add("unauthorized-session");
      continue;
    }
    const candidate = resolve(session.path);
    if (!requestedSessionRoots.some((root) => pathWithin(candidate, root))) {
      skippedFiles++;
      reasons.add("unauthorized-session");
      continue;
    }
    let info;
    let canonicalPath;
    try {
      info = await lstat(candidate);
      if (!info.isFile() || info.isSymbolicLink()) {
        skippedFiles++;
        reasons.add("unauthorized-session");
        continue;
      }
      canonicalPath = await realpath(candidate);
    } catch {
      skippedFiles++;
      reasons.add("unavailable-session");
      continue;
    }
    if (!sessionRoots.some((root) => pathWithin(canonicalPath, root))) {
      skippedFiles++;
      reasons.add("unauthorized-session");
      continue;
    }
    const remainingBytes = limits.maxTotalBytes - scannedBytes;
    if (remainingBytes <= 0) {
      reasons.add("byte-limit");
      break;
    }
    const scanned = await scanSessionFile(
      session,
      canonicalPath,
      tokens,
      remainingBytes,
      limits,
      options.signal,
      expired,
    );
    scannedBytes += scanned.bytes;
    if (scanned.status !== "ok") {
      if (scannedBytes >= limits.maxTotalBytes) reasons.add("byte-limit");
      if (scanned.status === "time") {
        reasons.add("time-limit");
        break;
      }
      skippedFiles++;
      reasons.add(
        scanned.status === "changed"
          ? "changed-session"
          : "unavailable-session",
      );
      continue;
    }
    scannedFiles++;
    malformedLines += scanned.malformedLines;
    if (scanned.malformedLines > 0) reasons.add("malformed-session");
    if (scanned.truncated) {
      reasons.add(
        scannedBytes >= limits.maxTotalBytes ? "byte-limit" : "per-file-byte-limit",
      );
    }
    if (scanned.matchedBeyondLimit) reasons.add("result-limit");
    for (const match of scanned.matches) {
      if (retainMatch(matches, match, limits.maxResults)) reasons.add("result-limit");
    }
  }

  return {
    matches,
    scannedFiles,
    scannedBytes,
    skippedFiles,
    malformedLines,
    partial: reasons.size > 0,
    partialReasons: [...reasons],
    limits,
  };
}
