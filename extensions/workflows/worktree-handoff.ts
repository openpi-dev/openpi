import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Worktree, WorktreeCleanup } from "../shared/worktree.ts";
import { safeStringify, writeFileAtomic } from "./serialization.ts";

export const WORKTREE_HANDOFF_VERSION = 1;
const PATCH_MAX_BYTES = 512 * 1024;
const GIT_MAX_BUFFER = PATCH_MAX_BYTES + 64 * 1024;

export interface WorktreeHandoffManifest {
  readonly version: typeof WORKTREE_HANDOFF_VERSION;
  readonly runId: string;
  readonly agentIndex: number;
  readonly agentLabel: string;
  readonly repository: string;
  readonly worktree: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly patch: {
    readonly format: "git-diff-binary";
    readonly content: string;
  };
  readonly numstat: string;
  readonly nameStatus: string;
  /** Names only. Their contents are not claimed to be captured by the patch. */
  readonly untracked: readonly string[];
  /** Names only. Their contents are not claimed to be captured by the patch. */
  readonly ignored: readonly string[];
  readonly cleanup?: WorktreeCleanup;
}

export type WorktreeHandoffPreparation =
  | {
      readonly ok: true;
      readonly artifact: string;
      readonly absolutePath: string;
      readonly manifest: WorktreeHandoffManifest;
    }
  | { readonly ok: false; readonly reason: string };

function git(cwd: string, args: readonly string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nulPaths(value: string) {
  return value.split("\0").filter(Boolean).sort();
}

function boundedError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 4096);
}

/**
 * Persist the complete tracked Git handoff before cleanup is allowed. A failure
 * returns `ok:false`; callers must preserve the checkout instead of guessing.
 */
export function prepareWorktreeHandoff(options: {
  runDir: string;
  runId: string;
  agentIndex: number;
  agentLabel: string;
  repoCwd: string;
  worktree: Worktree;
}): WorktreeHandoffPreparation {
  try {
    if (!options.worktree.baseSha) {
      return { ok: false, reason: "worktree creation baseline is unknown" };
    }
    const repository = fs.realpathSync.native(
      git(options.repoCwd, ["rev-parse", "--show-toplevel"]).trim(),
    );
    const worktree = fs.realpathSync.native(options.worktree.path);
    const common = fs.realpathSync.native(
      path.resolve(
        options.repoCwd,
        git(options.repoCwd, ["rev-parse", "--git-common-dir"]).trim(),
      ),
    );
    if (worktree !== common && !worktree.startsWith(`${common}${path.sep}`)) {
      return {
        ok: false,
        reason: "worktree path escaped the repository Git directory",
      };
    }

    const headSha = git(worktree, ["rev-parse", "--verify", "HEAD"]).trim();
    let branch = "";
    try {
      branch = git(worktree, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]).trim();
    } catch {
      // A detached HEAD is valid, but cleanup will preserve productive ones.
    }
    const detached = !branch;
    let patch: string;
    try {
      patch = git(worktree, [
        "diff",
        "--no-ext-diff",
        "--binary",
        options.worktree.baseSha,
        "--",
      ]);
    } catch (error) {
      return {
        ok: false,
        reason: `could not capture bounded binary patch: ${boundedError(error)}`,
      };
    }
    if (Buffer.byteLength(patch, "utf8") > PATCH_MAX_BYTES) {
      return {
        ok: false,
        reason: `binary patch exceeded ${PATCH_MAX_BYTES} bytes`,
      };
    }

    const manifest: WorktreeHandoffManifest = {
      version: WORKTREE_HANDOFF_VERSION,
      runId: options.runId,
      agentIndex: options.agentIndex,
      agentLabel: options.agentLabel,
      repository,
      worktree,
      baseSha: options.worktree.baseSha,
      headSha,
      ...(branch ? { branch } : {}),
      detached,
      patch: { format: "git-diff-binary", content: patch },
      numstat: git(worktree, [
        "diff",
        "--numstat",
        options.worktree.baseSha,
        "--",
      ]),
      nameStatus: git(worktree, [
        "diff",
        "--name-status",
        options.worktree.baseSha,
        "--",
      ]),
      untracked: nulPaths(
        git(worktree, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ),
      ignored: nulPaths(
        git(worktree, [
          "ls-files",
          "--others",
          "--ignored",
          "--exclude-standard",
          "-z",
        ]),
      ),
    };
    // An inventory is not a content backup. Cleanup will preserve these trees,
    // and the manifest says exactly what was not captured.
    const artifact = path.join("worktrees", `agent-${options.agentIndex}.json`);
    const absolutePath = path.join(options.runDir, artifact);
    writeFileAtomic(
      absolutePath,
      safeStringify(manifest, {
        maxBytes: 1024 * 1024,
        maxStringBytes: PATCH_MAX_BYTES,
      }),
    );
    return { ok: true, artifact, absolutePath, manifest };
  } catch (error) {
    return { ok: false, reason: boundedError(error) };
  }
}

export function finalizeWorktreeHandoff(
  prepared: Extract<WorktreeHandoffPreparation, { ok: true }>,
  cleanup: WorktreeCleanup,
) {
  const manifest = { ...prepared.manifest, cleanup };
  writeFileAtomic(
    prepared.absolutePath,
    safeStringify(manifest, {
      maxBytes: 1024 * 1024,
      maxStringBytes: PATCH_MAX_BYTES,
    }),
  );
  return manifest;
}
