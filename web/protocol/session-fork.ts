import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { WebHistoryAnchor } from "./types.ts";

/** Fork provenance stays on the native branch, not in a second Session registry. */
export const WEB_SESSION_FORK = "openpi-web-session-fork";
export const WEB_SESSION_FORK_SNAPSHOT = "openpi-web-fork-snapshot";

export interface WebSessionForkSnapshot {
  kind: "persisted-prefix";
  capturedAt: number;
  interrupted: boolean;
}

/** Synthetic model-context boundary, never evidence of a real tool failure. */
export interface WebSessionForkToolBoundary {
  version: 1;
  source: WebHistoryAnchor;
  snapshot: WebSessionForkSnapshot & { interrupted: true };
  toolCallId: string;
}

export interface WebSessionForkWorktree {
  path: string;
  branch?: string;
  baseSha: string;
  sourceRoot: string;
}

export interface WebSessionForkMetadata {
  version: 1;
  sessionId: string;
  source: WebHistoryAnchor;
  environment: "local" | "worktree";
  cwd: string;
  /** Original UI project; cwd remains the actual directory used by Pi. */
  workspacePath: string;
  worktree?: WebSessionForkWorktree;
  snapshot?: WebSessionForkSnapshot;
}

function bounded(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function absolutePath(value: unknown): value is string {
  return bounded(value, 4096) && (/^\//u.test(value) || /^[a-z]:[\\/]/iu.test(value) || /^\\\\/u.test(value));
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** A native branch boundary is display evidence, never a completed/cancelled turn. */
export function readForkSnapshotBoundary(entry: SessionEntry) {
  if (entry.type !== "custom_message" || entry.customType !== WEB_SESSION_FORK_SNAPSHOT || entry.display !== false)
    return undefined;
  const details: unknown = entry.details;
  if (!object(details) || !object(details.source) || !object(details.snapshot) ||
    !bounded(details.source.sessionId, 128) || !absolutePath(details.source.sessionPath) ||
    !bounded(details.source.entryId, 128) || details.snapshot.kind !== "persisted-prefix" ||
    details.snapshot.interrupted !== true || typeof details.snapshot.capturedAt !== "number" ||
    !Number.isSafeInteger(details.snapshot.capturedAt) || details.snapshot.capturedAt < 0) return undefined;
  return { sourceEntryId: details.source.entryId, capturedAt: details.snapshot.capturedAt };
}

/** Only the native synthetic result marker can make isError a missing result. */
export function isForkSnapshotToolBoundary(message: unknown) {
  if (!object(message) || message.role !== "toolResult" || message.isError !== true ||
    !bounded(message.toolCallId, 500) || !object(message.details)) return false;
  const marker = message.details.openpiForkSnapshot;
  return object(marker) && marker.version === 1 && marker.toolCallId === message.toolCallId &&
    object(marker.source) && bounded(marker.source.sessionId, 128) && absolutePath(marker.source.sessionPath) &&
    bounded(marker.source.entryId, 128) && object(marker.snapshot) && marker.snapshot.kind === "persisted-prefix" &&
    marker.snapshot.interrupted === true && typeof marker.snapshot.capturedAt === "number" &&
    Number.isSafeInteger(marker.snapshot.capturedAt) && marker.snapshot.capturedAt >= 0;
}

/** Display provenance only. It never grants filesystem or worktree authority. */
export function readSessionFork(entries: readonly SessionEntry[], sessionId: string, cwd: string) {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== "custom" || entry.customType !== WEB_SESSION_FORK) continue;
    const data: unknown = entry.data;
    if (!object(data) || data.sessionId !== sessionId) continue;
    if (data.version !== 1 || data.cwd !== cwd || !absolutePath(data.cwd) || !absolutePath(data.workspacePath) ||
      (data.environment !== "local" && data.environment !== "worktree") || !object(data.source) ||
      !bounded(data.source.sessionId, 128) || data.source.sessionId === sessionId ||
      !absolutePath(data.source.sessionPath) || !bounded(data.source.entryId, 128)) return undefined;
    let worktree: WebSessionForkWorktree | undefined;
    if (data.worktree !== undefined) {
      const value = data.worktree;
      if (!object(value) || !absolutePath(value.path) || !absolutePath(value.sourceRoot) ||
        (value.branch !== undefined && !bounded(value.branch, 255)) || typeof value.baseSha !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value.baseSha) ||
        !(cwd === value.path || cwd.startsWith(`${value.path}/`) || cwd.startsWith(`${value.path}\\`))) return undefined;
      worktree = { path: value.path, ...(value.branch === undefined ? {} : { branch: value.branch }), baseSha: value.baseSha, sourceRoot: value.sourceRoot };
    }
    if (data.environment === "worktree" && !worktree) return undefined;
    let snapshot: WebSessionForkSnapshot | undefined;
    if (data.snapshot !== undefined) {
      const value = data.snapshot;
      if (!object(value) || value.kind !== "persisted-prefix" || typeof value.capturedAt !== "number" ||
        !Number.isSafeInteger(value.capturedAt) || value.capturedAt < 0 || typeof value.interrupted !== "boolean") return undefined;
      snapshot = { kind: value.kind, capturedAt: value.capturedAt, interrupted: value.interrupted };
    }
    return {
      version: 1,
      sessionId,
      source: { sessionId: data.source.sessionId, sessionPath: data.source.sessionPath, entryId: data.source.entryId },
      environment: data.environment,
      cwd,
      workspacePath: data.workspacePath,
      ...(worktree ? { worktree } : {}),
      ...(snapshot ? { snapshot } : {}),
    } satisfies WebSessionForkMetadata;
  }
  return undefined;
}
