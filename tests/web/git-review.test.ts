import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
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
  assert.equal(result.snapshot.baseBranch, "refs/heads/main");
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

test("branch review requires a concrete base and selects qualified local/remote refs", async () => {
  const root = await repository();
  const initial = (await git(root, "rev-parse", "HEAD")).trim();
  await git(root, "branch", "-m", "release");
  await writeFile(join(root, "release-only.txt"), "release-only\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "release");
  await git(root, "checkout", "-b", "feature/review");
  await writeFile(join(root, "feature.txt"), "feature\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "feature");
  const missing = await readGitReview(root, {
    source: "branch",
    summary: true,
    offset: 0,
  });
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.reason, "base_branch_unavailable");
  assert.deepEqual(
    missing.branches?.options.map((option) => option.ref),
    ["refs/heads/feature/review", "refs/heads/release"],
  );
  await git(root, "branch", "main", initial);
  // Same-name tags must never alter an explicitly chosen branch identity.
  await git(root, "tag", "release", initial);
  await git(root, "update-ref", "refs/remotes/origin/release", initial);
  const chosen = await readGitReview(root, {
    source: "branch",
    baseRef: "refs/heads/release",
    summary: true,
    offset: 0,
  });
  assert.equal(chosen.ok, true);
  if (!chosen.ok) return;
  assert.equal(chosen.snapshot.baseBranch, "refs/heads/release");
  assert.deepEqual(
    chosen.snapshot.files.map((file) => file.path),
    ["feature.txt"],
  );
  const remote = await readGitReview(root, {
    source: "branch",
    baseRef: "refs/remotes/origin/release",
    summary: true,
    offset: 0,
  });
  assert.equal(remote.ok, true);
  if (!remote.ok) return;
  assert.deepEqual(
    remote.snapshot.files.map((file) => file.path),
    ["feature.txt", "release-only.txt"],
  );
  assert.notEqual(remote.snapshot.revision, chosen.snapshot.revision);
  for (const baseRef of [
    "release",
    "refs/tags/release",
    "refs/heads/release^{commit}",
    "refs/heads/missing",
    "refs/heads/release\0",
  ]) {
    const invalid = await readGitReview(root, { source: "branch", baseRef });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.reason, "invalid_base_branch");
  }
  await git(root, "branch", "-D", "release");
  const deleted = await readGitReview(root, {
    source: "branch",
    baseRef: "refs/heads/release",
  });
  assert.equal(deleted.ok, false);
  if (!deleted.ok) {
    assert.equal(deleted.reason, "invalid_base_branch");
    assert.ok(
      deleted.branches?.options.some(
        (option) => option.ref === "refs/heads/main",
      ),
    );
  }
});

test("lazy detail refuses a changed pinned summary and confirms the unchanged summary identity", async () => {
  const root = await repository();
  await writeFile(join(root, "base.txt"), "one\n");
  const summary = await readGitReview(root, {
    source: "unstaged",
    summary: true,
    offset: 0,
  });
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  const detail = await readGitReview(root, {
    source: "unstaged",
    filePath: "base.txt",
    expectedRevision: summary.snapshot.revision,
  });
  assert.equal(detail.ok, true);
  if (!detail.ok) return;
  assert.equal(detail.summaryRevision, summary.snapshot.revision);
  assert.match(detail.snapshot.files[0]!.diff, /\+one/u);
  await writeFile(join(root, "base.txt"), "new after summary\nsecond\nthird\n");
  const changed = await readGitReview(root, {
    source: "unstaged",
    filePath: "base.txt",
    expectedRevision: summary.snapshot.revision,
  });
  assert.deepEqual(changed, { ok: false, reason: "revision_changed" });
  const staged = await readGitReview(root, {
    source: "staged",
    summary: true,
    offset: 0,
  });
  assert.equal(staged.ok, true);
  if (!staged.ok) return;
  await git(root, "add", "base.txt");
  const changedIndex = await readGitReview(root, {
    source: "staged",
    filePath: "base.txt",
    expectedRevision: staged.snapshot.revision,
  });
  assert.deepEqual(changedIndex, { ok: false, reason: "revision_changed" });
});

test("lazy detail rejects an external write during the actual Git patch invocation", async () => {
  const root = await repository();
  await writeFile(join(root, "base.txt"), "old pinned content\n");
  const summary = await readGitReview(root, {
    source: "unstaged",
    summary: true,
    offset: 0,
  });
  assert.equal(summary.ok, true);
  if (!summary.ok) return;
  const bin = join(root, ".git", "probe-bin");
  await mkdir(bin);
  const ready = join(bin, "ready");
  const resume = join(bin, "resume");
  await writeFile(
    join(bin, "git"),
    '#!/bin/sh\ncase " $* " in\n  *" --patch "*)\n    : > "$OPENPI_REVIEW_DETAIL_READY"\n    while [ ! -f "$OPENPI_REVIEW_DETAIL_RESUME" ]; do /bin/sleep 0.02; done\n    ;;\nesac\nexec /usr/bin/git "$@"\n',
    { mode: 0o700 },
  );
  const reader = new URL("../../web/host/git-review.ts", import.meta.url).href;
  const probe = join(bin, "detail.mjs");
  await writeFile(
    probe,
    `import { readGitReview } from ${JSON.stringify(reader)};\nprocess.stdout.write(JSON.stringify(await readGitReview(process.argv[2], { source: "unstaged", filePath: "base.txt", expectedRevision: process.argv[3] })));\n`,
  );
  const child = execFileAsync(
    process.execPath,
    ["--experimental-strip-types", probe, root, summary.snapshot.revision],
    {
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        OPENPI_REVIEW_DETAIL_READY: ready,
        OPENPI_REVIEW_DETAIL_RESUME: resume,
      },
    },
  ).then(
    (result) => ({ ok: true as const, result }),
    (error) => ({ ok: false as const, error }),
  );
  try {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (
        await lstat(ready).then(
          () => true,
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(
      await lstat(ready).then(
        () => true,
        () => false,
      ),
      "actual Git patch invocation reached the bounded barrier",
    );
    await writeFile(
      join(root, "base.txt"),
      "new content during detail\nsecond line\n",
    );
  } finally {
    await writeFile(resume, "resume\n");
  }
  const outcome = await child;
  if (!outcome.ok) throw outcome.error;
  assert.deepEqual(JSON.parse(outcome.result.stdout), {
    ok: false,
    reason: "revision_changed",
  });
});

test("branch choices stay bounded and a chosen base outside the first page remains visible", async () => {
  const root = await repository();
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  const refs =
    Array.from(
      { length: 205 },
      (_, index) =>
        `update refs/heads/base-${String(index).padStart(3, "0")} ${head}`,
    ).join("\n") + "\n";
  execFileSync("git", ["-C", root, "update-ref", "--stdin"], { input: refs });
  const result = await readGitReview(root, {
    source: "branch",
    baseRef: "refs/heads/base-204",
    summary: true,
    offset: 0,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.branches?.options.length, 200);
  assert.equal(result.branches?.truncated, true);
  assert.ok(
    result.branches?.options.some(
      (option) => option.ref === "refs/heads/base-204",
    ),
  );
  assert.ok(jsonByteLength(result) <= WEB_MAX_SNAPSHOT_BYTES);
});

test("summary pages include files past 200, have exact totals and refuse a changed listing", async () => {
  const root = await repository();
  await Promise.all(
    Array.from({ length: 205 }, (_, i) =>
      writeFile(join(root, `${i + 1}.stp`), `ISO-10303-21;\n${i}\n`),
    ),
  );
  const first = await readGitReview(root, {
    source: "unstaged",
    summary: true,
    offset: 0,
  });
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.snapshot.totalFiles, 205);
  assert.deepEqual(first.snapshot.totals, {
    additions: 410,
    deletions: 0,
    complete: true,
  });
  assert.equal(first.snapshot.files.length, 200);
  assert.equal(first.snapshot.listComplete, true);
  assert.equal(first.snapshot.truncated, false);
  assert.deepEqual(
    first.snapshot.files.slice(0, 3).map((f) => f.path),
    ["1.stp", "2.stp", "3.stp"],
  );
  const second = await readGitReview(root, {
    source: "unstaged",
    summary: true,
    offset: first.snapshot.nextOffset!,
    expectedRevision: first.snapshot.revision,
  });
  assert.ok(second.ok);
  if (!second.ok) return;
  assert.equal(second.snapshot.files.length, 5);
  assert.deepEqual(second.snapshot.totals, first.snapshot.totals);
  assert.equal(second.snapshot.nextOffset, undefined);
  assert.equal(second.snapshot.revision, first.snapshot.revision);
  assert.equal(
    new Set(
      [...first.snapshot.files, ...second.snapshot.files].map((f) => f.path),
    ).size,
    205,
  );
  await writeFile(join(root, "205.stp"), "changed text\n");
  assert.deepEqual(
    await readGitReview(root, {
      source: "unstaged",
      summary: true,
      offset: 200,
      expectedRevision: first.snapshot.revision,
    }),
    { ok: false, reason: "revision_changed" },
  );
});

test("binary detection uses contents rather than the STEP extension", async () => {
  const root = await repository();
  await writeFile(join(root, "text.stp"), "ISO-10303-21;\nDATA;\n");
  await writeFile(join(root, "image.dat"), Buffer.from([1, 0, 2, 3]));
  const result = await readGitReview(root, { source: "unstaged" });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(
    result.snapshot.files.find((f) => f.path === "text.stp")?.binary,
    false,
  );
  assert.equal(
    result.snapshot.files.find((f) => f.path === "image.dat")?.binary,
    true,
  );
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

test("summary counts stay partial for symlinks and do not read their targets", async () => {
  const root = await repository();
  await writeFile(join(root, "small.txt"), "one\ntwo");
  await symlink("base.txt", join(root, "linked.txt"));
  const result = await readGitReview(root, {
    source: "unstaged",
    summary: true,
    offset: 0,
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.deepEqual(result.snapshot.totals, {
    additions: 2,
    deletions: 0,
    complete: false,
  });
  assert.equal(
    result.snapshot.files.find((file) => file.path === "linked.txt")
      ?.statsUnavailable,
    "content_limit",
  );
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
  assert.deepEqual(overview.snapshot.totals, {
    additions: 1,
    deletions: 0,
    complete: false,
  });
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

test("file details retain the selected summary identity and reject worktree or index changes", async () => {
  const root = await repository();
  await writeFile(join(root, "base.txt"), "worktree-a\n");
  const summary = await readGitReview(root, {
    source: "unstaged",
    summary: true,
    offset: 0,
  });
  assert.ok(summary.ok);
  const detail = await readGitReview(root, {
    source: "unstaged",
    filePath: "base.txt",
    expectedRevision: summary.snapshot.revision,
  });
  assert.ok(detail.ok);
  assert.equal(detail.summaryRevision, summary.snapshot.revision);
  assert.match(detail.snapshot.files[0]!.diff, /worktree-a/);
  await writeFile(join(root, "base.txt"), "worktree-b\n");
  assert.deepEqual(
    await readGitReview(root, {
      source: "unstaged",
      filePath: "base.txt",
      expectedRevision: summary.snapshot.revision,
    }),
    { ok: false, reason: "revision_changed" },
  );
  await git(root, "add", "base.txt");
  const staged = await readGitReview(root, {
    source: "staged",
    summary: true,
    offset: 0,
  });
  assert.ok(staged.ok);
  await writeFile(join(root, "base.txt"), "worktree-c\n");
  await git(root, "add", "base.txt");
  assert.deepEqual(
    await readGitReview(root, {
      source: "staged",
      filePath: "base.txt",
      expectedRevision: staged.snapshot.revision,
    }),
    { ok: false, reason: "revision_changed" },
  );
});
