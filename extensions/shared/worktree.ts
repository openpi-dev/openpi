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
 * - **`node_modules` is linked from the PARENT of the checkout, not into it.**
 *   A fresh checkout has no dependencies, so an isolated child cannot build or
 *   test its own work (verified: `ERR_MODULE_NOT_FOUND: Cannot find package
 *   'effect'`). Node resolves `node_modules` by walking ancestor directories,
 *   so a link at `.git/pi-worktrees/node_modules` serves every worktree under
 *   it while git never sees the entry at all.
 *
 *   Putting it INSIDE the checkout was the original design and was wrong in a
 *   way worth recording. A `.gitignore` line of `node_modules/` — with the
 *   trailing slash almost every project uses — matches a directory only, not a
 *   symlink. So the link showed as `?? node_modules` for the child's whole
 *   life, `git add -A` committed it as a `120000` blob, teardown was then
 *   permanently blocked ("contains modified or untracked files"), and merging
 *   the child's branch REPLACED the parent's real `node_modules` directory
 *   with a self-referential symlink — destroying the dependencies of the very
 *   repo the session was working in.
 *
 * - **Teardown never uses `--force`.** Git refuses to remove a worktree with
 *   modified or untracked files, and that refusal is exactly the policy we
 *   want: an isolated child that produced nothing is reclaimed automatically,
 *   and one that produced work keeps its directory and branch for the parent
 *   to inspect. Committed work is safe either way — the branch outlives the
 *   worktree — but uncommitted work would not be, so we let git veto.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  /**
   * Commit the worktree was created at. "Did the child produce anything" is
   * measured against THIS, never against the parent's HEAD: the parent moves
   * (it can commit, or merge the child's own branch) while the child works, and
   * a moving baseline makes a productive child look empty and get its branch
   * deleted.
   */
  readonly baseSha?: string;
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
  /** Spawn/timeout failure rather than a normal numeric Git exit status. */
  readonly exception: boolean;
}

function runGit(
  args: readonly string[],
  cwd: string,
  timeoutMs = WORKTREE_GIT_TIMEOUT_MS,
): Promise<GitResult> {
  if (timeoutMs <= 0) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "git operation deadline exceeded",
      exception: true,
    });
  }
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: Math.min(timeoutMs, WORKTREE_GIT_TIMEOUT_MS),
      },
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
          exception:
            !!error && typeof (error as { code?: unknown }).code !== "number",
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
 *
 * The result is NOT unique and must never be the only thing distinguishing two
 * worktrees. It cannot be: a non-Latin label ("中文标签", "🚀") has no surviving
 * characters and collapses to the fallback, and two labels sharing a long
 * prefix collide once `maxLength` cuts them. Uniqueness comes from the random
 * suffix in `createWorktree`.
 */
export function worktreeSlug(label: string, fallback: string, maxLength = 32) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // `a..b` sanitizes fine as a path but is not a legal ref: git rejects any
    // name containing `..`, which would fail the spawn rather than escape it.
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, maxLength)
    .replace(/[-.]+$/g, "");
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

  /*
   * The random suffix is what makes the name unique, and it is not optional.
   * A committed branch deliberately OUTLIVES its worktree, so any name derived
   * only from label+id is already taken the next time the same agent title
   * runs — `git worktree add` then fails with "a branch named … already
   * exists" and isolation, which is requested rather than best-effort, turns
   * into a hard spawn failure that tells the model to go run unisolated.
   * Deriving it from a label cannot work: every non-Latin title slugs to the
   * same fallback.
   */
  const name = [
    worktreeSlug(options.label, "agent"),
    worktreeSlug(options.id, "0", 24),
    randomBytes(3).toString("hex"),
  ].join("-");
  const worktreePath = path.join(gitDir, ...WORKTREE_DIR_SEGMENTS, name);
  const branch = `${WORKTREE_NAME_PREFIX}${name}`;

  // Read before creating: this is the baseline teardown measures against.
  const base = await runGit(["rev-parse", "HEAD"], options.cwd);
  const baseSha = base.code === 0 ? firstLine(base.stdout) : undefined;

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

  return {
    ok: true,
    worktree: { path: worktreePath, branch, ...(baseSha ? { baseSha } : {}) },
  };
}

/**
 * Link the repository's node_modules NEXT TO the worktrees, best effort.
 *
 * The link lives at `.git/pi-worktrees/node_modules`, one level above every
 * checkout, because Node resolves bare imports by walking ancestor
 * directories: a child at `.git/pi-worktrees/impl-1` finds it, and git never
 * sees an entry inside the tree it reports on. See the header for what putting
 * it inside the checkout actually did.
 *
 * The target is absolute so it resolves regardless of depth, and one link
 * serves every worktree, so this is idempotent across concurrent creates. A
 * failure here is not fatal — the child just cannot run builds — so it is
 * swallowed rather than turned into a spawn failure.
 */
function linkNodeModules(repoCwd: string, worktreePath: string) {
  const source = path.join(repoCwd, "node_modules");
  const target = path.join(path.dirname(worktreePath), "node_modules");
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

export interface WorktreeCleanup {
  /** True when the worktree directory is gone. */
  readonly removed: boolean;
  /** True when the branch was deleted too, because it held no commits. */
  readonly branchDeleted: boolean;
  /** Why it was kept, or why a final cleanup step failed. */
  readonly reason?: string;
  /** Branch observed in the checkout, or the branch created for it. */
  readonly branch: string;
  /** Creation-time baseline used to judge whether the child committed work. */
  readonly baseSha?: string;
  /** HEAD observed before cleanup. */
  readonly headSha?: string;
  /** Commits reachable from HEAD but not from baseSha. */
  readonly commits?: number;
  readonly detached: boolean;
  readonly dirty?: boolean;
  readonly untracked?: boolean;
  readonly ignored?: boolean;
}

export interface WorktreeCommitCount {
  readonly ok: boolean;
  readonly count?: number;
  readonly reason?: string;
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
 *
 * "Produced nothing" is measured against the worktree's OWN head and its
 * creation-time base, never against the parent's current HEAD. Both matter:
 * a child is free to `checkout -b` and commit somewhere else, and the parent
 * is free to move on (or merge the child's branch) before teardown runs.
 * Getting either wrong deletes a branch that holds real work.
 */
export async function reclaimWorktree(
  repoCwd: string,
  worktree: Worktree,
  options: { timeoutMs?: number } = {},
): Promise<WorktreeCleanup> {
  const deadline = Date.now() + (options.timeoutMs ?? WORKTREE_GIT_TIMEOUT_MS);
  const run = (args: readonly string[]) =>
    runGit(args, repoCwd, deadline - Date.now());
  const base = {
    removed: false,
    branchDeleted: false,
    branch: worktree.branch,
    ...(worktree.baseSha ? { baseSha: worktree.baseSha } : {}),
    detached: false,
  };
  const preserve = (
    reason: string,
    observed: Partial<WorktreeCleanup> = {},
  ): WorktreeCleanup => ({ ...base, ...observed, reason });

  // Inspect everything that automatic removal could destroy before asking Git
  // to remove anything. An unknown state is productive until proven otherwise.
  const head = await run([
    "-C",
    worktree.path,
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const headSha = head.code === 0 ? firstLine(head.stdout) : "";
  if (!headSha) {
    return preserve(
      firstLine(head.stderr) || "could not inspect worktree HEAD",
    );
  }

  const symbolic = await run([
    "-C",
    worktree.path,
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (symbolic.code !== 0 && (symbolic.code !== 1 || symbolic.exception)) {
    return preserve(
      firstLine(symbolic.stderr) || "could not inspect worktree branch",
      { headSha },
    );
  }
  const headBranch = symbolic.code === 0 ? firstLine(symbolic.stdout) : "";
  const detached = !headBranch;
  const branch = headBranch || worktree.branch;
  const observed = { branch, headSha, detached };

  const status = await run([
    "-C",
    worktree.path,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.code !== 0) {
    return preserve(
      firstLine(status.stderr) || "could not inspect worktree status",
      observed,
    );
  }
  const statusLines = status.stdout.split("\n").filter(Boolean);
  const untracked = statusLines.some((line) => line.startsWith("??"));
  const dirty = statusLines.length > 0;

  const ignoredFiles = await run([
    "-C",
    worktree.path,
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  if (ignoredFiles.code !== 0) {
    return preserve(
      firstLine(ignoredFiles.stderr) || "could not inspect ignored files",
      { ...observed, dirty, untracked },
    );
  }
  const ignored = ignoredFiles.stdout.length > 0;

  if (!worktree.baseSha) {
    return preserve("worktree creation baseline is unknown", {
      ...observed,
      dirty,
      untracked,
      ignored,
    });
  }
  const mergeBase = await run(["merge-base", worktree.baseSha, headSha]);
  if (mergeBase.code !== 0) {
    return preserve(
      firstLine(mergeBase.stderr) || "could not compare HEAD with its baseline",
      { ...observed, dirty, untracked, ignored },
    );
  }
  if (firstLine(mergeBase.stdout) !== worktree.baseSha) {
    return preserve("worktree HEAD no longer descends from its baseline", {
      ...observed,
      dirty,
      untracked,
      ignored,
    });
  }
  const commitCount = await worktreeCommitCount(
    repoCwd,
    headSha,
    worktree.baseSha,
    deadline - Date.now(),
  );
  if (!commitCount.ok || commitCount.count === undefined) {
    return preserve(
      commitCount.reason ?? "could not inspect worktree commits",
      {
        ...observed,
        dirty,
        untracked,
        ignored,
      },
    );
  }
  const inspected = {
    ...observed,
    commits: commitCount.count,
    dirty,
    untracked,
    ignored,
  };

  if (dirty || ignored) {
    const contents = [
      dirty ? "modified or untracked files" : undefined,
      ignored ? "ignored files" : undefined,
    ].filter(Boolean);
    return preserve(`worktree contains ${contents.join(" and ")}`, inspected);
  }
  // Detachment is itself an intentional checkout-state change, and productive
  // detached commits have no surviving ref. Preserve all detached checkouts
  // rather than guessing that a clean one is disposable.
  if (detached) {
    return preserve(
      commitCount.count > 0
        ? "detached HEAD contains commits not reachable from its base"
        : "worktree HEAD is detached",
      {
        ...inspected,
        branch: worktree.branch,
      },
    );
  }

  const removed = await run(["worktree", "remove", worktree.path]);
  if (removed.code !== 0) {
    return preserve(
      firstLine(removed.stderr) || "git declined to remove the worktree",
      inspected,
    );
  }
  if (commitCount.count > 0 || branch !== worktree.branch) {
    return { ...base, ...inspected, removed: true };
  }

  // Only delete the branch this module created, after proving it is clean and
  // has no commits beyond its immutable creation baseline.
  const deleted = await run(["branch", "-D", worktree.branch]);
  return {
    ...base,
    ...inspected,
    removed: true,
    branchDeleted: deleted.code === 0,
    ...(deleted.code === 0
      ? {}
      : {
          reason: firstLine(deleted.stderr) || "could not delete empty branch",
        }),
  };
}

/** Commits on `head` that the immutable creation `base` does not have. */
export async function worktreeCommitCount(
  repoCwd: string,
  head: string,
  base: string,
  timeoutMs = WORKTREE_GIT_TIMEOUT_MS,
): Promise<WorktreeCommitCount> {
  const result = await runGit(
    ["rev-list", "--count", `${base}..${head}`],
    repoCwd,
    timeoutMs,
  );
  if (result.code !== 0) {
    return {
      ok: false,
      reason: firstLine(result.stderr) || "git rev-list failed",
    };
  }
  const count = Number.parseInt(firstLine(result.stdout), 10);
  if (!Number.isFinite(count) || count < 0) {
    return { ok: false, reason: "git rev-list returned an invalid count" };
  }
  return { ok: true, count };
}
