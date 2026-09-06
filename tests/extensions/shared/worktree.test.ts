import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createWorktree,
  formatWorktreeCleanupWarning,
  reclaimWorktree,
  resolveGitCommonDir,
  worktreeCommitCount,
  worktreeSlug,
} from "../../../extensions/shared/worktree.ts";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
}

describe("worktreeSlug", () => {
  test("keeps a readable name and drops everything unsafe", () => {
    assert.equal(worktreeSlug("Fix Auth Bug", "x"), "fix-auth-bug");
    assert.equal(worktreeSlug("a/b", "x"), "a-b");
  });

  test("cannot escape its directory or be read as a git option", () => {
    // Untrusted input on a path and a ref: these are the shapes that would
    // otherwise write outside .git/pi-worktrees or flip git into option
    // parsing.
    for (const hostile of ["../../etc", "..", "--force", "-b", "/abs/path"]) {
      const slug = worktreeSlug(hostile, "fallback");
      assert.ok(!slug.includes("/"), `${hostile} kept a slash`);
      assert.ok(!slug.includes(".."), `${hostile} kept ..`);
      assert.ok(!slug.startsWith("-"), `${hostile} kept a leading dash`);
      assert.ok(!slug.startsWith("."), `${hostile} kept a leading dot`);
    }
  });

  test("falls back rather than producing an empty segment", () => {
    assert.equal(worktreeSlug("...", "fallback"), "fallback");
    assert.equal(worktreeSlug("", "fallback"), "fallback");
  });

  test("a slug is never unique enough to identify a worktree by itself", () => {
    // Recorded because it is easy to assume otherwise. Every non-Latin label
    // collapses to the fallback, and two labels sharing a long prefix collide
    // once the length cap bites. createWorktree adds randomness for this
    // reason; nothing else may depend on slug uniqueness.
    assert.equal(worktreeSlug("中文标签", "agent"), "agent");
    assert.equal(worktreeSlug("🚀🚀", "agent"), "agent");
    assert.equal(
      worktreeSlug("refactor the authentication subsystem part one", "x"),
      worktreeSlug("refactor the authentication subsystem part two", "x"),
    );
  });

  test("mid-string dots collapse, since git rejects a ref containing ..", () => {
    // "bump v1.2..3" sanitizes fine as a path but `pi/bump-v1.2..3` is not a
    // legal branch name, which would fail the spawn outright.
    assert.equal(worktreeSlug("a..b", "x"), "a.b");
    assert.ok(!worktreeSlug("bump v1.2..3", "x").includes(".."));
  });
});

describe("formatWorktreeCleanupWarning", () => {
  test("identifies a preserved checkout", () => {
    assert.equal(
      formatWorktreeCleanupWarning(
        {
          removed: false,
          branchDeleted: false,
          branch: "pi/example",
          detached: false,
          reason: "git declined to remove the worktree",
        },
        "C:/repo/.git/pi-worktrees/example",
      ),
      "git declined to remove the worktree; checkout was not confirmed removed; inspect C:/repo/.git/pi-worktrees/example",
    );
  });

  test("does not claim an uninspectable checkout still exists", () => {
    assert.equal(
      formatWorktreeCleanupWarning(
        {
          removed: false,
          branchDeleted: false,
          branch: "pi/example",
          detached: false,
          reason: "could not inspect worktree HEAD",
        },
        "C:/repo/.git/pi-worktrees/example",
      ),
      "could not inspect worktree HEAD; checkout was not confirmed removed; inspect C:/repo/.git/pi-worktrees/example",
    );
  });

  test("identifies a leftover branch after directory removal", () => {
    assert.equal(
      formatWorktreeCleanupWarning(
        {
          removed: true,
          branchDeleted: false,
          branch: "pi/example",
          detached: false,
          reason: "could not delete empty branch",
        },
        "C:/repo/.git/pi-worktrees/example",
      ),
      "could not delete empty branch; branch pi/example remains",
    );
  });

  test("identifies a leftover branch even without a cleanup reason", () => {
    assert.equal(
      formatWorktreeCleanupWarning(
        {
          removed: true,
          branchDeleted: false,
          branch: "pi/example",
          detached: false,
        },
        "C:/repo/.git/pi-worktrees/example",
      ),
      "branch pi/example remains",
    );
  });

  test("does not report a warning after complete cleanup", () => {
    assert.equal(
      formatWorktreeCleanupWarning(
        {
          removed: true,
          branchDeleted: true,
          branch: "pi/example",
          detached: false,
        },
        "C:/repo/.git/pi-worktrees/example",
      ),
      undefined,
    );
  });
});

describe("worktree lifecycle", () => {
  let repo: string;

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-worktree-test-"));
    git(repo, "init", "--quiet", "--initial-branch=main", ".");
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    fs.mkdirSync(path.join(repo, "node_modules", "dep"), { recursive: true });
    fs.writeFileSync(
      path.join(repo, "node_modules", "dep", "index.js"),
      "module.exports = 1;\n",
    );
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "init");
  });

  after(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  test("creates an isolated checkout that the parent status ignores", async () => {
    const result = await createWorktree({ cwd: repo, label: "impl", id: "1" });
    assert.ok(result.ok, `create failed: ${result.ok ? "" : result.reason}`);
    if (!result.ok) return;

    assert.ok(fs.existsSync(path.join(result.worktree.path, "a.txt")));
    // Living under .git is the whole reason the parent's status stays usable
    // for the agent working there.
    assert.ok(result.worktree.path.includes(`${path.sep}.git${path.sep}`));
    assert.equal(git(repo, "status", "--porcelain").trim(), "");

    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true);
    assert.equal(fs.existsSync(result.worktree.path), false);
    // Nothing was committed, so the branch is litter and goes too.
    assert.equal(cleanup.branchDeleted, true);
  });

  test("the child's own status is clean, so node_modules is never committed", async () => {
    // The original design linked node_modules INSIDE the checkout, and a
    // `.gitignore` of `node_modules/` (trailing slash = directory only) does
    // not match a symlink. The child then saw `?? node_modules` from the
    // start, `git add -A` committed it as a 120000 blob, teardown was blocked
    // forever, and merging that branch replaced the PARENT's real
    // node_modules with a self-referential symlink.
    const result = await createWorktree({ cwd: repo, label: "deps", id: "2" });
    assert.ok(result.ok);
    if (!result.ok) return;

    assert.equal(
      git(result.worktree.path, "status", "--porcelain").trim(),
      "",
      "a freshly created worktree must start clean for the child too",
    );

    // The link lives beside the worktrees, and Node finds it by walking up.
    const beside = path.join(
      path.dirname(result.worktree.path),
      "node_modules",
    );
    assert.equal(fs.lstatSync(beside).isSymbolicLink(), true);
    assert.ok(fs.existsSync(path.join(beside, "dep", "index.js")));
    assert.equal(
      fs.existsSync(path.join(result.worktree.path, "node_modules")),
      false,
      "nothing may be placed inside the tree git reports on",
    );

    // `git add -A` is what a child is told to do before committing.
    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "child\n");
    git(result.worktree.path, "add", "-A");
    assert.ok(
      !git(result.worktree.path, "diff", "--cached", "--name-only").includes(
        "node_modules",
      ),
      "node_modules must never reach the index",
    );

    git(result.worktree.path, "commit", "--quiet", "-m", "child work");
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true, cleanup.reason ?? "");
    assert.equal(cleanup.branchDeleted, false, "committed work must survive");
    assert.ok(
      fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")),
      "teardown must never follow the link into the repo's node_modules",
    );

    git(repo, "merge", "--quiet", "--no-ff", "-m", "merge", cleanup.branch);
    assert.equal(
      fs.lstatSync(path.join(repo, "node_modules")).isDirectory(),
      true,
      "merging the child's branch must not turn node_modules into a symlink",
    );
    git(repo, "reset", "--quiet", "--hard", "HEAD~1");
  });

  test("keeps a worktree that still holds uncommitted work", async () => {
    const result = await createWorktree({ cwd: repo, label: "dirty", id: "3" });
    assert.ok(result.ok);
    if (!result.ok) return;

    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "changed\n");
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, false);
    assert.ok(cleanup.reason);
    assert.ok(
      fs.existsSync(result.worktree.path),
      "uncommitted work must survive automatic cleanup",
    );

    // Clean it up by hand so the suite leaves nothing behind.
    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("preserves ignored-only output instead of silently deleting it", async () => {
    const result = await createWorktree({
      cwd: repo,
      label: "ignored",
      id: "ignored",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    fs.mkdirSync(path.join(result.worktree.path, "node_modules"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(result.worktree.path, "node_modules", "artifact.txt"),
      "generated\n",
    );
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, false);
    assert.equal(cleanup.ignored, true);
    assert.match(cleanup.reason ?? "", /ignored files/);
    assert.ok(fs.existsSync(result.worktree.path));

    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("preserves a clean detached checkout instead of guessing it is empty", async () => {
    const result = await createWorktree({
      cwd: repo,
      label: "detached-clean",
      id: "1",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    git(result.worktree.path, "checkout", "--quiet", "--detach");
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, false);
    assert.equal(cleanup.detached, true);
    assert.equal(cleanup.commits, 0);
    assert.match(cleanup.reason ?? "", /HEAD is detached/);

    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("preserves a detached HEAD that contains child commits", async () => {
    const result = await createWorktree({
      cwd: repo,
      label: "detached",
      id: "detached",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    git(result.worktree.path, "checkout", "--quiet", "--detach");
    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "detached\n");
    git(result.worktree.path, "commit", "--quiet", "-am", "detached work");
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, false);
    assert.equal(cleanup.detached, true);
    assert.equal(cleanup.commits, 1);
    assert.match(cleanup.reason ?? "", /detached HEAD/);

    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("preserves a clean branch whose history moved behind its baseline", async () => {
    fs.writeFileSync(path.join(repo, "a.txt"), "second\n");
    git(repo, "commit", "--quiet", "-am", "second");
    const result = await createWorktree({
      cwd: repo,
      label: "rewritten",
      id: "1",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    git(result.worktree.path, "reset", "--quiet", "--hard", "HEAD^");
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, false);
    assert.match(cleanup.reason ?? "", /no longer descends/);
    assert.ok(fs.existsSync(result.worktree.path));

    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
    git(repo, "reset", "--quiet", "--hard", "HEAD^");
  });

  test("a cleanup deadline preserves the checkout before any mutation", async () => {
    const result = await createWorktree({
      cwd: repo,
      label: "deadline",
      id: "deadline",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    const cleanup = await reclaimWorktree(repo, result.worktree, {
      timeoutMs: 0,
    });
    assert.equal(cleanup.removed, false);
    assert.match(cleanup.reason ?? "", /deadline exceeded/);
    assert.ok(fs.existsSync(result.worktree.path));

    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("preserves when the immutable base cannot be inspected", async () => {
    const result = await createWorktree({
      cwd: repo,
      label: "unknown-base",
      id: "unknown-base",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    const cleanup = await reclaimWorktree(repo, {
      ...result.worktree,
      baseSha: "does-not-exist",
    });
    assert.equal(cleanup.removed, false);
    assert.match(
      cleanup.reason ?? "",
      /ambiguous argument|rev-list|not a valid object name/i,
    );
    assert.ok(fs.existsSync(result.worktree.path));

    git(repo, "worktree", "remove", "--force", result.worktree.path);
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("reclaims a committed worktree and keeps the commits on its branch", async () => {
    const result = await createWorktree({ cwd: repo, label: "done", id: "4" });
    assert.ok(result.ok);
    if (!result.ok) return;

    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "committed\n");
    git(result.worktree.path, "commit", "--quiet", "-am", "child work");

    assert.deepEqual(
      await worktreeCommitCount(
        repo,
        result.worktree.branch,
        result.worktree.baseSha!,
      ),
      { ok: true, count: 1 },
    );
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true);
    // Directory gone, work not: the branch is what the parent merges, so a
    // branch holding commits is never deleted by cleanup.
    assert.equal(cleanup.branchDeleted, false);
    assert.deepEqual(
      await worktreeCommitCount(
        repo,
        result.worktree.branch,
        result.worktree.baseSha!,
      ),
      { ok: true, count: 1 },
    );
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("the same agent title can be isolated again after one commits", async () => {
    // A committed branch outlives its worktree by design, so a name derived
    // only from label+id is already taken the next time that title runs —
    // `git worktree add` fails and isolation, which is requested rather than
    // best-effort, degrades into a hard spawn failure.
    const first = await createWorktree({
      cwd: repo,
      label: "reviewer",
      id: "1",
    });
    assert.ok(first.ok);
    if (!first.ok) return;
    fs.writeFileSync(path.join(first.worktree.path, "a.txt"), "one\n");
    git(first.worktree.path, "commit", "--quiet", "-am", "first");
    const firstCleanup = await reclaimWorktree(repo, first.worktree);
    assert.equal(firstCleanup.branchDeleted, false, "branch must survive");

    const second = await createWorktree({
      cwd: repo,
      label: "reviewer",
      id: "1",
    });
    assert.ok(
      second.ok,
      `second spawn of the same title failed: ${second.ok ? "" : second.reason}`,
    );
    if (!second.ok) return;
    assert.notEqual(second.worktree.branch, first.worktree.branch);
    await reclaimWorktree(repo, second.worktree);
    git(repo, "branch", "-D", first.worktree.branch);
  });

  test("a productive child is not judged empty because the parent moved", async () => {
    // "Produced nothing" was measured against the parent's HEAD, which the
    // parent is free to move — including by merging the child's own branch.
    // The count then reads zero and the branch is deleted.
    const result = await createWorktree({ cwd: repo, label: "base", id: "9" });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.worktree.baseSha, "creation must record its baseline");

    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "child\n");
    git(result.worktree.path, "commit", "--quiet", "-am", "child work");

    // The parent merges before teardown runs.
    git(
      repo,
      "merge",
      "--quiet",
      "--no-ff",
      "-m",
      "merge",
      result.worktree.branch,
    );
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true, cleanup.reason ?? "");
    assert.equal(
      cleanup.branchDeleted,
      false,
      "a branch holding real commits must not be deleted as empty",
    );
    git(repo, "reset", "--quiet", "--hard", "HEAD~1");
    git(repo, "branch", "-D", cleanup.branch);
  });

  test("a child that commits on its own branch keeps it and is reported", async () => {
    // The spawn result names the branch we created; if the child moved, that
    // name is a dead end and its real work would go unreported.
    const result = await createWorktree({
      cwd: repo,
      label: "moved",
      id: "10",
    });
    assert.ok(result.ok);
    if (!result.ok) return;

    git(result.worktree.path, "checkout", "--quiet", "-b", "child-own-branch");
    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "elsewhere\n");
    git(result.worktree.path, "commit", "--quiet", "-am", "on my own branch");

    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true, cleanup.reason ?? "");
    assert.equal(
      cleanup.branch,
      "child-own-branch",
      "report where the work actually landed",
    );
    assert.equal(
      cleanup.branchDeleted,
      false,
      "a branch this module did not create is not ours to delete",
    );
    git(repo, "branch", "-D", "child-own-branch");
    git(repo, "branch", "-D", result.worktree.branch);
  });

  test("isolates concurrent children from each other", async () => {
    const created = await Promise.all(
      ["a", "b", "c"].map((id) =>
        createWorktree({ cwd: repo, label: "par", id }),
      ),
    );
    const worktrees = created.map((r) => {
      assert.ok(r.ok);
      return r.ok ? r.worktree : undefined;
    });

    for (const [index, worktree] of worktrees.entries()) {
      if (!worktree) continue;
      fs.writeFileSync(path.join(worktree.path, "a.txt"), `child ${index}\n`);
    }
    // The property the shared-cwd status quo cannot provide: each child sees
    // only its own edit.
    for (const [index, worktree] of worktrees.entries()) {
      if (!worktree) continue;
      assert.equal(
        fs.readFileSync(path.join(worktree.path, "a.txt"), "utf8"),
        `child ${index}\n`,
      );
    }
    assert.equal(
      fs
        .readFileSync(path.join(repo, "a.txt"), "utf8")
        .replaceAll("\r\n", "\n"),
      "hello\n",
    );

    for (const worktree of worktrees) {
      if (!worktree) continue;
      git(repo, "worktree", "remove", "--force", worktree.path);
      git(repo, "branch", "-D", worktree.branch);
    }
  });

  test("nests from inside a worktree instead of burying itself", async () => {
    const outer = await createWorktree({ cwd: repo, label: "outer", id: "5" });
    assert.ok(outer.ok);
    if (!outer.ok) return;

    // --git-common-dir, not --git-dir: the latter would resolve to
    // .git/worktrees/<outer> and nest the inner worktree inside it.
    const inner = await createWorktree({
      cwd: outer.worktree.path,
      label: "inner",
      id: "6",
    });
    assert.ok(inner.ok);
    if (!inner.ok) return;
    const worktreeContainer = fs.statSync(
      path.dirname(path.dirname(inner.worktree.path)),
    );
    const commonGitDirectory = fs.statSync(path.join(repo, ".git"));
    assert.deepEqual(
      {
        dev: worktreeContainer.dev,
        ino: worktreeContainer.ino,
      },
      {
        dev: commonGitDirectory.dev,
        ino: commonGitDirectory.ino,
      },
    );

    git(repo, "worktree", "remove", "--force", inner.worktree.path);
    git(repo, "branch", "-D", inner.worktree.branch);
    git(repo, "worktree", "remove", "--force", outer.worktree.path);
    git(repo, "branch", "-D", outer.worktree.branch);
  });
});

describe("worktree outside a repository", () => {
  test("reports the reason instead of throwing", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pi-not-a-repo-"));
    try {
      assert.equal(await resolveGitCommonDir(plain), undefined);
      const result = await createWorktree({
        cwd: plain,
        label: "x",
        id: "1",
      });
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.reason, /not a git repository/);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});
