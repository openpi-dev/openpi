/**
 * Read-only git commands: pure argv construction.
 *
 * Everything here is synchronous and side-effect free so the exact argv
 * passed to the child process can be asserted in tests. Revision and path
 * inputs are validated against strict shapes before they are ever placed
 * in an argument list. Validated revisions go before an explicit `--`
 * separator and paths go after it, so Git never guesses a revision is a
 * path. Only argv subcommands that cannot write are reachable at all.
 */

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_LOG_DEFAULT_LIMIT = 100;
export const GIT_LOG_MAX_LIMIT = 1000;

/** Revisions may be a sha-ish hex string, HEAD~n, HEAD^n, or a plain name; a
 * leading `-` is rejected so a revision can never smuggle a git flag. */
const REVISION_PATTERN =
  /^(?:[0-9a-fA-F]{4,40}|HEAD(?:[~^]\d*)*|[A-Za-z_][\w./@-]{0,199})$/;
/** Diffs compare two revisions; worktree comparison uses one revision. */
const MAX_REVISION_LENGTH = 200;

export function isSafeRevision(revision: string): boolean {
  const trimmed = revision.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_REVISION_LENGTH)
    return false;
  return REVISION_PATTERN.test(trimmed);
}

/** A relative repo path; `..` escapes and absolute paths are rejected. */
const REPO_PATH_PATTERN = /^[^:/\\?#*[\]'"\s][^:/\\?#*[\]'"\s]*$/;

export function isSafeRepoPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (!REPO_PATH_PATTERN.test(segment)) return false;
  }
  return true;
}

function revision(value: string): string | undefined {
  return isSafeRevision(value) ? value.trim() : undefined;
}

export class InvalidRevisionError extends Error {
  constructor(value: string) {
    super(
      `Invalid git revision: ${JSON.stringify(value.slice(0, 80))}. Allowed: a commit sha, branch or tag name, or HEAD with ~ / ^ modifiers.`,
    );
    this.name = "InvalidRevisionError";
  }
}

export class InvalidPathError extends Error {
  constructor(value: string) {
    super(
      `Invalid repository path: ${JSON.stringify(value.slice(0, 80))}. Use a relative path inside the repository.`,
    );
    this.name = "InvalidPathError";
  }
}

export class InvalidDiffCombinationError extends Error {
  constructor(message: string) {
    super(`Invalid git diff options: ${message}`);
    this.name = "InvalidDiffCombinationError";
  }
}

export interface GitShowParams {
  revision: string;
  path?: string;
}

export function buildShowArgs(params: GitShowParams): string[] {
  if (!isSafeRevision(params.revision))
    throw new InvalidRevisionError(params.revision);
  const args = [
    "show",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--format=fuller",
    params.revision.trim(),
    "--",
  ];
  if (params.path !== undefined) {
    if (!isSafeRepoPath(params.path)) throw new InvalidPathError(params.path);
    args.push(params.path);
  }
  return args;
}

export interface GitDiffParams {
  /** Base revision, e.g. HEAD, HEAD~1, a branch name, or a sha. */
  from?: string;
  /** Compared revision; omit to compare `from` against the worktree. */
  to?: string;
  /** Compare against the index (staged changes) instead of the worktree. */
  staged?: boolean;
  stat?: boolean;
  path?: string;
}

export function buildDiffArgs(params: GitDiffParams): string[] {
  const from = params.from !== undefined ? revision(params.from) : undefined;
  if (params.from !== undefined && from === undefined) {
    throw new InvalidRevisionError(params.from);
  }
  const to = params.to !== undefined ? revision(params.to) : undefined;
  if (params.to !== undefined && to === undefined) {
    throw new InvalidRevisionError(params.to);
  }
  if (params.to !== undefined && params.from === undefined) {
    throw new InvalidDiffCombinationError("to requires from");
  }
  if (params.staged && (params.from !== undefined || params.to !== undefined)) {
    throw new InvalidDiffCombinationError(
      "staged cannot be combined with from or to",
    );
  }

  const args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
  if (params.staged) args.push("--cached");
  if (params.stat) args.push("--stat");

  if (from !== undefined && to !== undefined) {
    args.push(`${from}...${to}`);
  } else if (from !== undefined) {
    args.push(from);
  }
  // No revisions: worktree vs index (or HEAD with --cached).

  args.push("--");
  if (params.path !== undefined) {
    if (!isSafeRepoPath(params.path)) throw new InvalidPathError(params.path);
    args.push(params.path);
  }
  return args;
}

export interface GitLogParams {
  revision?: string;
  file?: string;
  limit?: number;
  oneline?: boolean;
}

export function buildLogArgs(params: GitLogParams): string[] {
  const args = ["log", "--no-color", "--no-ext-diff"];
  if (params.oneline !== false) args.push("--oneline");
  const limit = Math.min(
    GIT_LOG_MAX_LIMIT,
    Math.max(1, Math.floor(params.limit ?? GIT_LOG_DEFAULT_LIMIT)),
  );
  args.push(`-n`, String(limit));

  if (params.revision !== undefined) {
    if (!isSafeRevision(params.revision)) {
      throw new InvalidRevisionError(params.revision);
    }
    args.push(params.revision.trim());
  }
  args.push("--");
  if (params.file !== undefined) {
    if (!isSafeRepoPath(params.file)) throw new InvalidPathError(params.file);
    args.push(params.file);
  }
  return args;
}
