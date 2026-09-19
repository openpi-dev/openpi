import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import { countGitDiffLines, readGitReview } from "../../web/host/git-review.ts";
import {
  jsonByteLength,
  WEB_MAX_SNAPSHOT_BYTES,
} from "../../web/protocol/types.ts";

const execFileAsync = promisify(execFile);
const roots = new Set<string>();

after(async () => {
  await Promise.all(
    [...roots].map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function git(root: string, ...args: string[]) {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "openpi-git-review-"));
  roots.add(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "OpenPI Test");
  await git(root, "config", "user.email", "openpi@example.invalid");
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "base");
  return root;
}

test("Git review combines branch, staged, unstaged, and untracked changes", async () => {
  const root = await repository();
  await git(root, "checkout", "-b", "feature/review");
  await writeFile(join(root, "feature.txt"), "feature\n", "utf8");
  await git(root, "add", "feature.txt");
  await git(root, "commit", "-m", "feature");
  await writeFile(join(root, "base.txt"), "base\nchanged\n", "utf8");
  await writeFile(join(root, "staged.txt"), "staged\n", "utf8");
  await git(root, "add", "staged.txt");
  await writeFile(join(root, "untracked.txt"), "untracked\n", "utf8");

  const result = await readGitReview(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.snapshot.currentBranch, "feature/review");
  assert.equal(result.snapshot.baseBranch, "main");
  assert.deepEqual(result.snapshot.files.map((file) => file.path).sort(), [
    "base.txt",
    "feature.txt",
    "staged.txt",
    "untracked.txt",
  ]);
  assert.ok(result.snapshot.additions >= 4);
  assert.equal(result.snapshot.truncated, false);
});

test("Git review reports a non-repository instead of an empty snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-git-review-none-"));
  roots.add(root);
  assert.deepEqual(await readGitReview(root), {
    ok: false,
    reason: "not_git_repository",
  });
});

test("Git diff counts ignore metadata outside hunks", () => {
  assert.deepEqual(
    countGitDiffLines(
      "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new",
    ),
    { additions: 1, deletions: 1 },
  );
});

test("Git review treats an empty untracked file as a zero-line change", async () => {
  const root = await repository();
  await writeFile(join(root, "empty.txt"), "", "utf8");
  const result = await readGitReview(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const empty = result.snapshot.files.find((file) => file.path === "empty.txt");
  assert.equal(empty?.additions, 0);
  assert.equal(empty?.deletions, 0);
  assert.equal(empty?.diffTruncated, false);
  assert.doesNotMatch(empty?.diff ?? "", /^@@/mu);
  await unlink(join(root, "empty.txt"));
});

test("Git review keeps file metadata when an encoded diff exceeds the response budget", async () => {
  const root = await repository();
  await writeFile(join(root, "large.txt"), '"\n'.repeat(1_600_000), "utf8");
  const result = await readGitReview(root);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const large = result.snapshot.files.find((file) => file.path === "large.txt");
  assert.ok(large);
  assert.equal(large.diff, "");
  assert.equal(large.diffTruncated, true);
  assert.equal(result.snapshot.truncated, true);
  assert.ok(jsonByteLength(result) <= WEB_MAX_SNAPSHOT_BYTES);
});
