import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import {
  countGitDiffLines,
  GitReviewBaselineStore,
  readGitReview,
} from "../../web/host/git-review.ts";
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
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8",
  });
  return stdout;
}

async function looseObjectCount(root: string) {
  const output = await git(root, "count-objects", "-v");
  return Number(/^count: (\d+)$/mu.exec(output)?.[1] ?? -1);
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
  assert.equal(result.snapshot.comparison, "branch");
  assert.deepEqual(result.snapshot.files.map((file) => file.path).sort(), [
    "base.txt",
    "feature.txt",
    "staged.txt",
    "untracked.txt",
  ]);
  assert.ok(result.snapshot.additions >= 4);
  assert.equal(result.snapshot.truncated, false);
});

test("Git review baseline reports only changes made after a Session starts", async () => {
  const root = await repository();
  const baselineDirectory = await mkdtemp(
    join(tmpdir(), "openpi-git-review-baseline-"),
  );
  roots.add(baselineDirectory);
  await writeFile(join(root, "base.txt"), "base\npreexisting\n", "utf8");
  await writeFile(join(root, "preexisting.txt"), "before\n", "utf8");
  const store = new GitReviewBaselineStore(root, baselineDirectory);
  const sessionPath = join(baselineDirectory, "session.jsonl");
  const repositoryObjectsBefore = await looseObjectCount(root);

  await store.capture(sessionPath, root);
  assert.equal(await looseObjectCount(root), repositoryObjectsBefore);
  const initial = await store.read(sessionPath, root);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;
  assert.equal(initial.snapshot.comparison, "session");
  assert.deepEqual(initial.snapshot.files, []);

  await writeFile(join(root, "base.txt"), "base\nsession change\n", "utf8");
  await writeFile(join(root, "preexisting.txt"), "after\n", "utf8");
  await writeFile(join(root, "created.txt"), "created\n", "utf8");
  const changed = await store.read(sessionPath, root);
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.deepEqual(changed.snapshot.files.map((file) => file.path).sort(), [
    "base.txt",
    "created.txt",
    "preexisting.txt",
  ]);
  assert.equal(
    changed.snapshot.files.find((file) => file.path === "preexisting.txt")
      ?.status,
    "modified",
  );
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
