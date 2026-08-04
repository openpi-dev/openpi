import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createWorktree,
  reclaimWorktree,
  resolveGitCommonDir,
  worktreeCommitCount,
  worktreeSlug,
} from "./worktree.ts";

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

  test("links node_modules in and never deletes the real one", async () => {
    const result = await createWorktree({ cwd: repo, label: "deps", id: "2" });
    assert.ok(result.ok);
    if (!result.ok) return;

    const linked = path.join(result.worktree.path, "node_modules");
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
    // The point of the link: a child can actually resolve dependencies.
    assert.ok(fs.existsSync(path.join(linked, "dep", "index.js")));

    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true);
    assert.ok(
      fs.existsSync(path.join(repo, "node_modules", "dep", "index.js")),
      "teardown must unlink, never follow into the repo's node_modules",
    );
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

  test("reclaims a committed worktree and keeps the commits on its branch", async () => {
    const result = await createWorktree({ cwd: repo, label: "done", id: "4" });
    assert.ok(result.ok);
    if (!result.ok) return;

    fs.writeFileSync(path.join(result.worktree.path, "a.txt"), "committed\n");
    git(result.worktree.path, "commit", "--quiet", "-am", "child work");

    assert.equal(await worktreeCommitCount(repo, result.worktree.branch), 1);
    const cleanup = await reclaimWorktree(repo, result.worktree);
    assert.equal(cleanup.removed, true);
    // Directory gone, work not: the branch is what the parent merges, so a
    // branch holding commits is never deleted by cleanup.
    assert.equal(cleanup.branchDeleted, false);
    assert.equal(await worktreeCommitCount(repo, result.worktree.branch), 1);
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
    assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "hello\n");

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
    assert.equal(
      // realpath because git resolves symlinks and macOS tmpdirs are one.
      fs.realpathSync(path.dirname(path.dirname(inner.worktree.path))),
      fs.realpathSync(path.join(repo, ".git")),
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
