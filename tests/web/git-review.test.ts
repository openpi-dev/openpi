import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
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

test("Git review bounds repeated Session baselines with large dirty files", async () => {
  const root = await repository();
  const baselineDirectory = await mkdtemp(
    join(tmpdir(), "openpi-git-review-capacity-"),
  );
  roots.add(baselineDirectory);
  const firstSession = join(baselineDirectory, "first.jsonl");
  const secondSession = join(baselineDirectory, "second.jsonl");
  await writeFile(firstSession, "{}\n", "utf8");
  await writeFile(secondSession, "{}\n", "utf8");
  const store = new GitReviewBaselineStore(root, baselineDirectory, {
    maxBaselines: 4,
    maxBaselineBytes: 64 * 1024,
    maxTotalBytes: 72 * 1024,
  });

  await writeFile(join(root, "large.bin"), Buffer.alloc(80 * 1024, 7));
  await store.capture(firstSession, root);
  assert.equal(
    (await readdir(baselineDirectory)).some((entry) =>
      entry.endsWith(".objects"),
    ),
    false,
  );

  await unlink(join(root, "large.bin"));
  await writeFile(join(root, "dirty.bin"), randomBytes(48 * 1024));
  await store.capture(firstSession, root);
  const firstEntries = await readdir(baselineDirectory);
  assert.equal(
    firstEntries.filter((entry) => entry.endsWith(".objects")).length,
    1,
  );
  await store.capture(secondSession, root);
  const secondEntries = await readdir(baselineDirectory);
  assert.equal(
    secondEntries.filter((entry) => entry.endsWith(".objects")).length,
    1,
  );
  assert.equal((await store.read(firstSession, root)).ok, true);
  assert.deepEqual(await store.read(secondSession, root), {
    ok: false,
    reason: "baseline_unavailable",
  });
});

test("Git review cleanup preserves resumable Sessions and removes deleted ones", async () => {
  const root = await repository();
  const baselineDirectory = await mkdtemp(
    join(tmpdir(), "openpi-git-review-cleanup-"),
  );
  roots.add(baselineDirectory);
  const sessionPath = join(baselineDirectory, "session.jsonl");
  await writeFile(sessionPath, "{}\n", "utf8");
  const store = new GitReviewBaselineStore(root, baselineDirectory);
  await store.capture(sessionPath, root);
  await store.dispose();
  assert.equal(
    (await readdir(baselineDirectory)).some((entry) =>
      entry.endsWith(".objects"),
    ),
    true,
  );

  await unlink(sessionPath);
  await store.dispose();
  assert.deepEqual(await readdir(baselineDirectory), []);
});

test("Git review reports a non-repository instead of an empty snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "openpi-git-review-none-"));
  roots.add(root);
  assert.deepEqual(await readGitReview(root), {
    ok: false,
    reason: "not_git_repository",
  });
});

test("native Git views remain usable with an oversized untracked file and load diffs on demand", async () => {
  const root = await repository();
  await writeFile(join(root, "large.bin"), Buffer.alloc(8 * 1024 * 1024));
  await writeFile(join(root, "small.txt"), "small change\n");
  const overview = await readGitReview(root, {
    source: "unstaged",
    summary: true,
  });
  assert.equal(overview.ok, true);
  if (!overview.ok) return;
  assert.equal(overview.snapshot.comparison, "unstaged");
  assert.equal(
    overview.snapshot.files.find((file) => file.path === "large.bin")
      ?.diffLoaded,
    false,
  );
  assert.ok(overview.snapshot.files.every((file) => file.diff === ""));
  const detail = await readGitReview(root, {
    source: "unstaged",
    filePath: "small.txt",
  });
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.deepEqual(
    detail.snapshot.files.map((file) => file.path),
    ["small.txt"],
  );
  assert.match(detail.snapshot.files[0]!.diff, /small change/u);
  const large = await readGitReview(root, {
    source: "unstaged",
    filePath: "large.bin",
  });
  assert.equal(large.ok, true);
  if (large.ok) assert.equal(large.snapshot.files[0]?.diffTruncated, true);
  const staged = await readGitReview(root, { source: "staged", summary: true });
  assert.equal(staged.ok, true);
  if (staged.ok) assert.equal(staged.snapshot.files.length, 0);
  await git(root, "add", "small.txt");
  const stagedFile = await readGitReview(root, {
    source: "staged",
    filePath: "small.txt",
  });
  assert.equal(stagedFile.ok, true);
  if (stagedFile.ok)
    assert.match(stagedFile.snapshot.files[0]!.diff, /small change/u);
});

for (const changed of [false, true]) {
  test(`staged rename detail retains both literal paths (edited: ${changed})`, async () => {
    const root = await repository();
    const oldPath = "old [1].txt";
    const newPath = "new [1].txt";
    const original =
      Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") +
      "\n";
    await writeFile(join(root, oldPath), original);
    await git(root, "add", "--", oldPath);
    await git(root, "commit", "-m", "rename source");
    await git(root, "mv", "--", oldPath, newPath);
    if (changed)
      await writeFile(
        join(root, newPath),
        original.replace("line 10\n", "edited line\n"),
      );
    await writeFile(
      join(root, "new 1.txt"),
      "must not enter selected detail\n",
    );
    await git(root, "add", "-A");
    const summary = await readGitReview(root, {
      source: "staged",
      summary: true,
    });
    assert.ok(summary.ok);
    const metadata = summary.snapshot.files.find(
      (file) => file.path === newPath,
    )!;
    assert.equal(metadata.status, "renamed");
    const detail = await readGitReview(root, {
      source: "staged",
      filePath: newPath,
    });
    assert.ok(detail.ok);
    assert.equal(detail.snapshot.files.length, 1);
    const file = detail.snapshot.files[0]!;
    assert.equal(file.status, "renamed");
    assert.equal(file.previousPath, oldPath);
    assert.equal(file.path, newPath);
    assert.equal(file.additions, changed ? 1 : 0);
    assert.equal(file.deletions, changed ? 1 : 0);
    assert.match(file.diff, /rename from/u);
    assert.match(file.diff, /rename to/u);
    assert.doesNotMatch(
      file.diff,
      /\/dev\/null|must not enter selected detail/u,
    );
  });
}

test("branch rename detail retains the source from the merge base", async () => {
  const root = await repository();
  await git(root, "checkout", "-b", "feature/rename");
  await git(root, "mv", "base.txt", "renamed.txt");
  await git(root, "commit", "-m", "rename");
  const detail = await readGitReview(root, {
    source: "branch",
    filePath: "renamed.txt",
  });
  assert.ok(detail.ok);
  assert.equal(detail.snapshot.files[0]?.status, "renamed");
  assert.equal(detail.snapshot.files[0]?.previousPath, "base.txt");
  assert.match(detail.snapshot.files[0]!.diff, /rename from base.txt/u);
});

function indexBlob(root: string, content: string) {
  return execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
    input: content,
    encoding: "utf8",
  }).trim();
}

for (const source of ["staged", "unstaged"] as const) {
  test(`${source} summary revision tracks index-only blob changes with identical statistics`, async () => {
    const root = await repository();
    const path = join(root, "base.txt");
    await writeFile(path, "worktree\n");
    await git(
      root,
      "update-index",
      "--cacheinfo",
      "100644",
      indexBlob(root, "staged-a\n"),
      "base.txt",
    );
    const beforeFile = await lstat(path, { bigint: true });
    const before = await readGitReview(root, { source, summary: true });
    const beforeDetail = await readGitReview(root, {
      source,
      filePath: "base.txt",
    });
    assert.ok(before.ok && beforeDetail.ok);
    await git(
      root,
      "update-index",
      "--cacheinfo",
      "100644",
      indexBlob(root, "staged-b\n"),
      "base.txt",
    );
    const after = await readGitReview(root, { source, summary: true });
    const afterDetail = await readGitReview(root, {
      source,
      filePath: "base.txt",
    });
    assert.ok(after.ok && afterDetail.ok);
    const afterFile = await lstat(path, { bigint: true });
    assert.deepEqual(
      [afterFile.size, afterFile.mtimeNs, afterFile.ctimeNs],
      [beforeFile.size, beforeFile.mtimeNs, beforeFile.ctimeNs],
    );
    assert.equal(await readFile(path, "utf8"), "worktree\n");
    assert.deepEqual(after.snapshot.files, before.snapshot.files);
    assert.match(beforeDetail.snapshot.files[0]!.diff, /staged-a/u);
    assert.match(afterDetail.snapshot.files[0]!.diff, /staged-b/u);
    assert.notEqual(after.snapshot.revision, before.snapshot.revision);
    const unchanged = await readGitReview(root, { source, summary: true });
    assert.ok(unchanged.ok);
    assert.equal(unchanged.snapshot.revision, after.snapshot.revision);
  });
}

test("staged summary revision also tracks a changed HEAD blob without touching the index or worktree", async () => {
  const root = await repository();
  const firstHead = (await git(root, "rev-parse", "HEAD")).trim();
  await writeFile(join(root, "base.txt"), "next-base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "next base");
  const secondHead = (await git(root, "rev-parse", "HEAD")).trim();
  await writeFile(join(root, "base.txt"), "staged\n");
  await git(root, "add", "base.txt");
  await git(root, "update-ref", "HEAD", firstHead);
  const before = await readGitReview(root, { source: "staged", summary: true });
  await git(root, "update-ref", "HEAD", secondHead);
  const after = await readGitReview(root, { source: "staged", summary: true });
  assert.ok(before.ok && after.ok);
  assert.deepEqual(after.snapshot.files, before.snapshot.files);
  assert.notEqual(after.snapshot.revision, before.snapshot.revision);
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
