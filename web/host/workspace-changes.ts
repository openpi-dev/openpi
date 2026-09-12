import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { sanitizeTerminalText } from "../../extensions/shared/terminal-text.ts";
import {
  WEB_MAX_WORKSPACE_CHANGE_DIFF_BYTES,
  WEB_MAX_WORKSPACE_CHANGE_FILES,
  WEB_MAX_WORKSPACE_CHANGE_TOTAL_DIFF_BYTES,
  type WebWorkspaceChange,
  type WebWorkspaceChanges,
  type WebWorkspaceChangeStatus,
} from "../protocol/types.ts";

const execFileAsync = promisify(execFile);
const GIT_COMMAND_TIMEOUT_MS = 10_000;
const STATUS_MAX_BYTES = 512 * 1024;
const COMMAND_ERROR = "Git could not read the current workspace.";
const DIFF_TRUNCATED_MARKER = "\n[diff truncated by the Web workspace budget]\n";

type GitCommandError = Error & {
  code?: number | string;
  signal?: NodeJS.Signals | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  failedToStart: boolean;
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

function textOutput(value: unknown) {
  return typeof value === "string"
    ? value
    : Buffer.isBuffer(value)
      ? value.toString("utf8")
      : "";
}

async function runGit(
  cwd: string,
  args: string[],
  maxBuffer: number,
  signal?: AbortSignal,
): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer,
      signal,
      timeout: GIT_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    return {
      code: 0,
      stdout: textOutput(result.stdout),
      stderr: textOutput(result.stderr),
      failedToStart: false,
      timedOut: false,
      truncated: false,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    const value = error as GitCommandError;
    const message = error instanceof Error ? error.message : COMMAND_ERROR;
    return {
      code: typeof value.code === "number" ? value.code : -1,
      stdout: textOutput(value.stdout),
      stderr: textOutput(value.stderr),
      failedToStart: value.code === "ENOENT",
      timedOut:
        value.code === "ETIMEDOUT" ||
        (value.signal === "SIGTERM" && /timed out/iu.test(message)),
      truncated: value.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      error: message,
    };
  }
}

function cleanPath(path: string) {
  return sanitizeTerminalText(path).replace(/[\r\n]/gu, " ");
}

function parseStatus(status: string): WebWorkspaceChangeStatus {
  if (status === "??") return "untracked";
  if (status.includes("U")) return "unmerged";
  if (status.includes("R")) return "renamed";
  if (status.includes("C")) return "copied";
  if (status.includes("A")) return "added";
  if (status.includes("D")) return "deleted";
  return "modified";
}

interface ChangedPath {
  path: string;
  previousPath?: string;
  status: WebWorkspaceChangeStatus;
  useNoIndex: boolean;
}

function parseChangedPaths(output: string, hasHead: boolean) {
  const completeBytes = output.lastIndexOf("\0");
  const records =
    completeBytes < 0
      ? []
      : output.slice(0, completeBytes + 1).split("\0");
  const paths: ChangedPath[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const statusCode = record.slice(0, 2);
    const path = record.slice(3);
    const status = parseStatus(statusCode);
    const isRename = status === "renamed" || status === "copied";
    const previousPath = isRename ? records[index + 1] : undefined;
    if (isRename && !previousPath) continue;
    if (isRename && previousPath !== undefined) index += 1;
    paths.push({
      path,
      ...(previousPath ? { previousPath } : {}),
      status,
      useNoIndex: statusCode === "??" || !hasHead,
    });
  }
  return paths;
}

function parseNumstat(output: string) {
  const line = output.split(/\r?\n/u).find(Boolean);
  if (!line) return undefined;
  const [added, deleted] = line.split("\t");
  const binary = added === "-" || deleted === "-";
  const parse = (value: string | undefined) =>
    /^\d+$/u.test(value ?? "") ? Number.parseInt(value!, 10) : null;
  return { additions: parse(added), deletions: parse(deleted), binary };
}

function boundDiff(value: string, maxBytes: number) {
  const safe = sanitizeTerminalText(value);
  if (Buffer.byteLength(safe) <= maxBytes)
    return { value: safe, truncated: false };
  const markerBytes = Buffer.byteLength(DIFF_TRUNCATED_MARKER);
  const prefix = new TextDecoder().decode(
    Buffer.from(safe).subarray(0, Math.max(0, maxBytes - markerBytes)),
  );
  return {
    value: `${prefix}${DIFF_TRUNCATED_MARKER}`,
    truncated: true,
  };
}

function unavailableChange(
  changedPath: ChangedPath,
  error: string,
  truncated = false,
): WebWorkspaceChange {
  return {
    path: cleanPath(changedPath.path),
    ...(changedPath.previousPath
      ? { previousPath: cleanPath(changedPath.previousPath) }
      : {}),
    status: changedPath.status,
    additions: null,
    deletions: null,
    binary: false,
    diff: "",
    diffStatus: "unavailable",
    truncated,
    error,
  };
}

async function loadChange(
  repoRoot: string,
  changedPath: ChangedPath,
  remainingDiffBytes: number,
  signal?: AbortSignal,
) {
  if (remainingDiffBytes <= 0) {
    return unavailableChange(
      changedPath,
      "Diff omitted after the Web workspace budget was reached.",
      true,
    );
  }

  const nullPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const diffArgs = changedPath.useNoIndex
    ? [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "--",
        nullPath,
        changedPath.path,
      ]
    : [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        changedPath.path,
      ];
  const statArgs = changedPath.useNoIndex
    ? ["diff", "--no-index", "--numstat", "--", nullPath, changedPath.path]
    : ["diff", "--numstat", "HEAD", "--", changedPath.path];
  const maxDiffBytes = Math.min(
    WEB_MAX_WORKSPACE_CHANGE_DIFF_BYTES,
    remainingDiffBytes,
  );
  const [diffResult, statResult] = await Promise.all([
    runGit(repoRoot, diffArgs, maxDiffBytes + 64 * 1024, signal),
    runGit(repoRoot, statArgs, 64 * 1024, signal),
  ]);
  const expectedCode = changedPath.useNoIndex ? 1 : 0;
  const diffReadable =
    diffResult.code === 0 || diffResult.code === expectedCode;
  const statReadable =
    statResult.code === 0 || statResult.code === expectedCode;
  if (!diffReadable && !diffResult.truncated) {
    return unavailableChange(
      changedPath,
      diffResult.timedOut ? "Diff reading timed out." : "Diff is unavailable; refresh to retry.",
    );
  }

  const stats = statReadable ? parseNumstat(statResult.stdout) : undefined;
  const binary =
    stats?.binary === true ||
    /Binary files .* differ/u.test(diffResult.stdout);
  if (binary) {
    return {
      path: cleanPath(changedPath.path),
      ...(changedPath.previousPath
        ? { previousPath: cleanPath(changedPath.previousPath) }
        : {}),
      status: changedPath.status,
      additions: null,
      deletions: null,
      binary: true,
      diff: "",
      diffStatus: "binary",
      truncated: false,
    } satisfies WebWorkspaceChange;
  }

  const bounded = boundDiff(diffResult.stdout, maxDiffBytes);
  return {
    path: cleanPath(changedPath.path),
    ...(changedPath.previousPath
      ? { previousPath: cleanPath(changedPath.previousPath) }
      : {}),
    status: changedPath.status,
    additions: stats?.additions ?? null,
    deletions: stats?.deletions ?? null,
    binary: false,
    diff: bounded.value,
    diffStatus: "text",
    truncated: bounded.truncated || diffResult.truncated,
    ...(statReadable ? {} : { error: "Line counts are unavailable." }),
  } satisfies WebWorkspaceChange;
}

function emptyTruncation(statusTruncated = false) {
  return {
    truncated: statusTruncated,
    filesOmitted: 0,
    statusTruncated,
    diffsTruncated: 0,
    maxFiles: WEB_MAX_WORKSPACE_CHANGE_FILES,
    maxDiffBytes: WEB_MAX_WORKSPACE_CHANGE_TOTAL_DIFF_BYTES,
  };
}

export async function loadWorkspaceChanges(
  cwd: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<WebWorkspaceChanges> {
  signal?.throwIfAborted();
  const checkedAt = new Date().toISOString();
  const rootResult = await runGit(
    cwd,
    ["rev-parse", "--show-toplevel"],
    64 * 1024,
    signal,
  );
  if (rootResult.failedToStart) {
    return {
      sessionId,
      cwd,
      checkedAt,
      status: "unavailable",
      baseline: undefined,
      files: [],
      truncation: emptyTruncation(),
      error: "Git is unavailable on the Web Host.",
    };
  }
  if (rootResult.code !== 0 || !rootResult.stdout.trim()) {
    const notRepository =
      rootResult.code !== 0 && /not a git repository/iu.test(rootResult.stderr);
    return {
      sessionId,
      cwd,
      checkedAt,
      status: notRepository ? "not-repository" : "unavailable",
      baseline: undefined,
      files: [],
      truncation: emptyTruncation(),
      ...(notRepository
        ? {}
        : { error: "Git could not determine the workspace repository." }),
    };
  }

  const repositoryRoot = resolve(rootResult.stdout.trim());
  const statusResult = await runGit(
    repositoryRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    STATUS_MAX_BYTES,
    signal,
  );
  if (statusResult.code !== 0 && !statusResult.truncated) {
    return {
      sessionId,
      cwd,
      repositoryRoot,
      checkedAt,
      status: "unavailable",
      baseline: undefined,
      files: [],
      truncation: emptyTruncation(statusResult.truncated),
      error: statusResult.timedOut
        ? "Git status reading timed out."
        : "Git status is unavailable; refresh to retry.",
    };
  }

  const headResult = await runGit(
    repositoryRoot,
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    64 * 1024,
    signal,
  );
  if (
    headResult.timedOut ||
    headResult.failedToStart ||
    (headResult.code !== 0 && headResult.code !== 1)
  ) {
    return {
      sessionId,
      cwd,
      repositoryRoot,
      checkedAt,
      status: "unavailable",
      baseline: undefined,
      files: [],
      truncation: emptyTruncation(statusResult.truncated),
      error: "Git could not determine the comparison baseline.",
    };
  }

  const hasHead = headResult.code === 0 && Boolean(headResult.stdout.trim());
  const baseline = hasHead
    ? { kind: "head" as const, commit: headResult.stdout.trim() }
    : { kind: "empty-tree" as const };
  const changedPaths = parseChangedPaths(statusResult.stdout, hasHead);
  const visiblePaths = changedPaths.slice(0, WEB_MAX_WORKSPACE_CHANGE_FILES);
  let remainingDiffBytes = WEB_MAX_WORKSPACE_CHANGE_TOTAL_DIFF_BYTES;
  const files: WebWorkspaceChange[] = [];
  let diffsTruncated = 0;
  for (const changedPath of visiblePaths) {
    const file = await loadChange(
      repositoryRoot,
      changedPath,
      remainingDiffBytes,
      signal,
    );
    files.push(file);
    remainingDiffBytes = Math.max(
      0,
      remainingDiffBytes - Buffer.byteLength(file.diff),
    );
    if (file.truncated) diffsTruncated += 1;
  }
  const filesOmitted = Math.max(0, changedPaths.length - visiblePaths.length);
  const truncation = {
    truncated:
      statusResult.truncated || filesOmitted > 0 || diffsTruncated > 0,
    filesOmitted,
    statusTruncated: statusResult.truncated,
    diffsTruncated,
    maxFiles: WEB_MAX_WORKSPACE_CHANGE_FILES,
    maxDiffBytes: WEB_MAX_WORKSPACE_CHANGE_TOTAL_DIFF_BYTES,
  };
  return {
    sessionId,
    cwd,
    repositoryRoot,
    checkedAt,
    status: files.length > 0 || statusResult.truncated ? "changed" : "clean",
    baseline,
    files,
    truncation,
  };
}
