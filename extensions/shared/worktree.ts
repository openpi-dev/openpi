/**
 * Git worktree isolation for child agents.
 *
 * Parallel children that share one working copy share a git index and a file
 * tree: two agents editing the same file, or staging at the same time, silently
 * clobber each other. A worktree gives each child its own checkout on its own
 * branch, so their edits are separable and the parent decides what to merge.
 *
 * Design decisions, each forced by measured git behavior:
 *
 * - **Worktrees live under `.git/pi-worktrees/`,** not in the project tree.
 *   Anything inside the working copy shows up as an untracked entry in the
 *   parent's `git status` (verified: `?? .pi/`), which would corrupt the very
 *   signal a coding agent reads to see what it changed. `.git/` is already
 *   outside every status walk, and `git worktree` is perfectly happy there.
 *
 * - **Trust is inherited by path.** Pi resolves project trust by walking
 *   parents (`findNearestTrustEntry`), so a worktree under the repo inherits
 *   the repo's trust decision and the child keeps its project skills and
 *   AGENTS.md. A worktree in `/tmp` would resolve to "untrusted" and silently
 *   strip those, which is why an out-of-repo location is not an option.
 *
 * - **`node_modules` is symlinked in.** A fresh checkout has no dependencies,
 *   so an isolated child cannot build or test its own work (verified:
 *   `ERR_MODULE_NOT_FOUND: Cannot find package 'effect'`). The symlink is
 *   absolute so it resolves regardless of how deep the worktree sits, and it
 *   is removed before teardown so `git worktree remove` sees a clean tree.
 *
 * - **Teardown never uses `--force`.** Git refuses to remove a worktree with
 *   modified or untracked files, and that refusal is exactly the policy we
 *   want: an isolated child that produced nothing is reclaimed automatically,
 *   and one that produced work keeps its directory and branch for the parent
 *   to inspect. Committed work is safe either way — the branch outlives the
 *   worktree — but uncommitted work would not be, so we let git veto.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** A hung git call must not stall a spawn or a session teardown. */
export const WORKTREE_GIT_TIMEOUT_MS = 10_000;

/** Kept inside `.git/` so the parent's `git status` never sees these. */
export const WORKTREE_DIR_SEGMENTS = ["pi-worktrees"] as const;

/** Branch/directory prefix, so these are recognizable in `git worktree list`. */
export const WORKTREE_NAME_PREFIX = "pi/";

export interface Worktree {
  /** Absolute path to the isolated checkout; use as the child's cwd. */
  readonly path: string;
  /** Branch created for this worktree. Survives teardown. */
  readonly branch: string;
}

export interface WorktreeFailure {
  readonly reason: string;
}

export type WorktreeResult =
  | { readonly ok: true; readonly worktree: Worktree }
  | { readonly ok: false; readonly reason: string };

interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runGit(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", timeout: WORKTREE_GIT_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as unknown as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({
          code,
          stdout: stdout ?? "",
          stderr: (stderr ?? "") || (error ? error.message : ""),
        });
      },
    );
  });
}

function firstLine(text: string) {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * Sanitize a caller-supplied label into one path/ref segment.
 *
 * The label reaches us from a model-authored tool argument, so it is untrusted
 * input on a path and a ref: `..`, a slash, or a leading dash would let it
 * escape `.git/pi-worktrees/` or be read by git as an option. Only a
 * conservative character set survives, and the result is never empty.
 */
export function worktreeSlug(label: string, fallback: string) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 40);
  return slug || fallback;
}

/**
 * Common git dir for `cwd`, or undefined when it is not a repository.
 *
 * `--git-common-dir` rather than `--git-dir`: inside an existing worktree the
 * latter points at `.git/worktrees/<name>`, and nesting new worktrees there
 * would bury them. The common dir is the same `.git` for the main checkout and
 * every worktree of it, so isolation composes.
 */
export async function resolveGitCommonDir(cwd: string) {
  const result = await runGit(["rev-parse", "--git-common-dir"], cwd);
  if (result.code !== 0) return undefined;
  const value = firstLine(result.stdout);
  if (!value) return undefined;
  return path.resolve(cwd, value);
}

/**
 * Create an isolated worktree for `cwd`'s repository, branched from HEAD.
 *
 * Never throws and never falls back silently: a non-repository, a git failure,
 * or a name collision comes back as `{ ok: false, reason }` so the caller can
 * decide between reporting it and continuing in the shared directory.
 */
export async function createWorktree(options: {
  cwd: string;
  /** Human-ish label (agent title); sanitized into the branch/dir name. */
  label: string;
  /** Disambiguator appended to the slug; must be unique per live worktree. */
  id: string;
  /** Link the repo's node_modules in, so the child can build and test. */
  linkNodeModules?: boolean;
}): Promise<WorktreeResult> {
  const gitDir = await resolveGitCommonDir(options.cwd);
  if (!gitDir) {
    return { ok: false, reason: `not a git repository: ${options.cwd}` };
  }

  const name = `${worktreeSlug(options.label, "agent")}-${worktreeSlug(options.id, "0")}`;
  const worktreePath = path.join(gitDir, ...WORKTREE_DIR_SEGMENTS, name);
  const branch = `${WORKTREE_NAME_PREFIX}${name}`;

  const added = await runGit(
    ["worktree", "add", "--quiet", "-b", branch, worktreePath, "HEAD"],
    options.cwd,
  );
  if (added.code !== 0) {
    return {
      ok: false,
      reason: firstLine(added.stderr) || "git worktree add failed",
    };
  }

  if (options.linkNodeModules !== false)
    linkNodeModules(options.cwd, worktreePath);

  return { ok: true, worktree: { path: worktreePath, branch } };
}

/**
 * Symlink the repository's node_modules into the worktree, best effort.
 *
 * Absolute target: the worktree sits several levels inside `.git`, and a
 * relative link would break if either path shape changed. A failure here is
 * not fatal — the child just cannot run builds — so it is swallowed rather
 * than turned into a spawn failure.
 */
function linkNodeModules(repoCwd: string, worktreePath: string) {
  const source = path.join(repoCwd, "node_modules");
  const target = path.join(worktreePath, "node_modules");
  try {
    if (!fs.existsSync(source)) return;
    if (
      fs.existsSync(target) ||
      fs.lstatSync(target, { throwIfNoEntry: false })
    )
      return;
    fs.symlinkSync(source, target, "junction");
  } catch {
    // The worktree is still usable for reading and editing without deps.
  }
}

/** Remove the node_modules symlink (never its target) before teardown. */
function unlinkNodeModules(worktreePath: string) {
  const target = path.join(worktreePath, "node_modules");
  try {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    // Only ever unlink a symlink: a real directory here would mean the child
    // installed its own dependencies, and deleting that is not our call.
    if (stat?.isSymbolicLink()) fs.unlinkSync(target);
  } catch {
    // Leaving it behind only means `git worktree remove` declines below.
  }
}

export interface WorktreeCleanup {
  /** True when the worktree directory is gone. */
  readonly removed: boolean;
  /** True when the branch was deleted too, because it held no commits. */
  readonly branchDeleted: boolean;
  /** Why it was kept, for the parent-facing message. */
  readonly reason?: string;
  /** Branch; present unless it was deleted as empty. */
  readonly branch: string;
}

/**
 * Reclaim a worktree, keeping anything the child actually produced.
 *
 * Deliberately no `--force`: git's own refusal on a dirty tree is the policy
 * we want. A child that changed nothing costs nothing to discard; a child with
 * uncommitted work keeps its directory so the parent can look at it. The
 * branch is deleted only when it holds no commits, so a child that committed
 * always leaves something to merge, and a child that did nothing leaves no
 * litter behind.
 */
export async function reclaimWorktree(
  repoCwd: string,
  worktree: Worktree,
): Promise<WorktreeCleanup> {
  const commits = await worktreeCommitCount(repoCwd, worktree.branch);
  unlinkNodeModules(worktree.path);
  const removed = await runGit(["worktree", "remove", worktree.path], repoCwd);
  if (removed.code !== 0) {
    return {
      removed: false,
      branchDeleted: false,
      reason: firstLine(removed.stderr) || "worktree has uncommitted changes",
      branch: worktree.branch,
    };
  }
  if (commits > 0) {
    return { removed: true, branchDeleted: false, branch: worktree.branch };
  }
  const deleted = await runGit(["branch", "-D", worktree.branch], repoCwd);
  return {
    removed: true,
    branchDeleted: deleted.code === 0,
    branch: worktree.branch,
  };
}

/** Commits the child made on its branch that the base does not have. */
export async function worktreeCommitCount(repoCwd: string, branch: string) {
  const result = await runGit(
    ["rev-list", "--count", `HEAD..${branch}`],
    repoCwd,
  );
  if (result.code !== 0) return 0;
  const count = Number.parseInt(firstLine(result.stdout), 10);
  return Number.isFinite(count) ? count : 0;
}
