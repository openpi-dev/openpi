import type { WebGitReviewFile, WebGitReviewFileStatus } from "./types.ts";

export const WEB_TURN_CHANGES_ENTRY = "openpi-web-turn-changes";
export const WEB_MAX_TURN_CHANGE_RECORD_BYTES = 256 * 1024;
export const WEB_MAX_TURN_CHANGE_FILES = 200;

export type WebTurnChangesFile = Pick<
  WebGitReviewFile,
  "path" | "previousPath" | "status" | "additions" | "deletions"
>;

export interface WebTurnChanges {
  version: 1;
  sessionId: string;
  promptEntryId: string;
  /** A temporal workspace comparison, not proof of which process wrote a file. */
  state: "complete" | "partial" | "unavailable";
  fileCount: number | null;
  files: WebTurnChangesFile[];
  additions: number;
  deletions: number;
}

export interface WebTurnChangesDetail extends Omit<WebTurnChanges, "files"> {
  files: WebGitReviewFile[];
}

export type WebTurnChangesResult =
  | { ok: true; changes: WebTurnChangesDetail }
  | { ok: false; reason: "unavailable" | "not_found" | "identity_changed" };

const fileStatuses = new Set<WebGitReviewFileStatus>([
  "added", "modified", "deleted", "renamed", "copied", "untracked", "unknown",
]);

function boundedId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 500;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate persisted evidence before exposing it to an untrusted Web reader. */
export function readTurnChangesDetail(value: unknown): WebTurnChangesDetail | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !boundedId(record.sessionId) ||
    !boundedId(record.promptEntryId) ||
    !["complete", "partial", "unavailable"].includes(String(record.state)) ||
    !count(record.additions) || !count(record.deletions) ||
    !Array.isArray(record.files) || record.files.length > WEB_MAX_TURN_CHANGE_FILES ||
    !(record.fileCount === null || count(record.fileCount))
  ) return undefined;

  const files: WebGitReviewFile[] = [];
  let bytes = 0;
  for (const item of record.files) {
    if (!item || typeof item !== "object") return undefined;
    const file = item as Record<string, unknown>;
    if (
      typeof file.path !== "string" || !file.path || file.path.length > 2_000 || file.path.includes("\0") ||
      !(file.previousPath === undefined || (typeof file.previousPath === "string" && file.previousPath.length <= 2_000)) ||
      !fileStatuses.has(file.status as WebGitReviewFileStatus) ||
      typeof file.diff !== "string" ||
      typeof file.diffTruncated !== "boolean" ||
      !count(file.additions) || !count(file.deletions)
    ) return undefined;
    bytes += new TextEncoder().encode(file.path).byteLength + new TextEncoder().encode(file.diff).byteLength;
    if (bytes > WEB_MAX_TURN_CHANGE_RECORD_BYTES) return undefined;
    files.push({
      path: file.path,
      ...(typeof file.previousPath === "string" ? { previousPath: file.previousPath } : {}),
      status: file.status as WebGitReviewFileStatus,
      diff: file.diff,
      diffTruncated: file.diffTruncated,
      diffLoaded: true,
      additions: file.additions,
      deletions: file.deletions,
    });
  }
  if (
    (record.state === "complete" && (record.fileCount !== files.length || files.some((file) => file.diffTruncated))) ||
    (record.state !== "complete" && record.fileCount !== null)
  ) return undefined;
  return {
    version: 1,
    sessionId: record.sessionId as string,
    promptEntryId: record.promptEntryId as string,
    state: record.state as WebTurnChanges["state"],
    fileCount: record.fileCount as number | null,
    files,
    additions: record.additions as number,
    deletions: record.deletions as number,
  };
}

export function summarizeTurnChanges(detail: WebTurnChangesDetail): WebTurnChanges {
  return {
    ...detail,
    files: detail.files.map(({ path, previousPath, status, additions, deletions }) => ({
      path,
      ...(previousPath ? { previousPath } : {}),
      status,
      additions,
      deletions,
    })),
  };
}
