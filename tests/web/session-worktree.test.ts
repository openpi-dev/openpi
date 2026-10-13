import { strict as assert } from "node:assert";
import childProcess, {
  execFileSync,
  type ExecFileOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";

// Launch boundary scripts through Node on every platform. Windows execFile
// cannot execute a POSIX shebang, and Git Bash's `which` returns /cmd/git.
const originalExecFile = childProcess.execFile;
const execFileAsync = promisify(originalExecFile);
let gitWrapper: string | undefined;
childProcess.execFile = Object.assign(originalExecFile.bind(childProcess), {
  [promisify.custom]: (
    file: string,
    args: string[],
    options: ExecFileOptions,
  ) =>
    file === "git" && gitWrapper
      ? execFileAsync(process.execPath, [gitWrapper, ...args], options)
      : execFileAsync(file, args, options),
});
syncBuiltinESMExports();
const {
  cleanupSessionWorktree,
  createSessionWorktree,
  inspectSessionWorktree,
  SessionWorktreeError,
} = await import("../../web/runtime/session-worktree.ts");
childProcess.execFile = originalExecFile;
syncBuiltinESMExports();

const realGit = "git";
const identity = {
  GIT_AUTHOR_NAME: "Worktree test",
  GIT_AUTHOR_EMAIL: "worktree@example.test",
  GIT_COMMITTER_NAME: "Worktree test",
  GIT_COMMITTER_EMAIL: "worktree@example.test",
};

function git(cwd: string, ...args: string[]) {
  return execFileSync(realGit, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...identity },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "openpi-session-worktree-test-"),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "core.filemode", String(process.platform !== "win32"));
  git(repo, "config", "core.symlinks", "true");
  fs.mkdirSync(path.join(repo, "packages", "app"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "packages", "app", "file.txt"),
    "committed\n",
  );
  fs.writeFileSync(path.join(repo, "delete.txt"), "delete me\n");
  fs.writeFileSync(path.join(repo, "binary.bin"), Buffer.from([0, 1, 2, 0, 3]));
  fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\necho initial\n");
  fs.writeFileSync(
    path.join(repo, ".gitignore"),
    "*.env\nAGENTS.override.md\nignored/\n",
  );
  fs.symlinkSync("delete.txt", path.join(repo, "link"));
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "initial");
  return { root, repo, index: path.join(repo, ".git", "index") };
}

// The wrapper still executes real Git. It introduces a competing change at a
// precise process boundary, without adding production-only test hooks.
function gitBoundary(
  t: Parameters<typeof fixture>[0],
  root: string,
  code: string,
) {
  const wrapper = path.join(root, "git-boundary.cjs");
  fs.writeFileSync(
    wrapper,
    `const fs=require('node:fs'); const cp=require('node:child_process'); const args=process.argv.slice(2); const isAdd=args.includes('worktree')&&args.includes('add'); const isApply=args.includes('apply'); const realGit=${JSON.stringify(realGit)}; ${code}\n`,
  );
  gitWrapper = wrapper;
  t.after(() => {
    gitWrapper = undefined;
  });
}

const runReal =
  "const result=cp.spawnSync(realGit,args,{stdio:'inherit',env:process.env}); if(result.status!==0) process.exit(result.status??1);";

test("forks source HEAD detached and copies final tracked, untracked, binary, executable and link contents unstaged", async (t) => {
  const { repo, index } = fixture(t);
  const file = path.join(repo, "packages", "app", "file.txt");
  fs.writeFileSync(file, "staged\n");
  git(repo, "add", "--", "packages/app/file.txt");
  fs.writeFileSync(file, "final unstaged\n");
  const binary = Buffer.from([0, 255, 7, 8, 0, 128]);
  fs.writeFileSync(path.join(repo, "binary.bin"), binary);
  fs.chmodSync(path.join(repo, "run.sh"), 0o755);
  fs.rmSync(path.join(repo, "delete.txt"));
  fs.unlinkSync(path.join(repo, "link"));
  fs.symlinkSync("packages/app/file.txt", path.join(repo, "link"));
  fs.symlinkSync("binary.bin", path.join(repo, "new-link"));
  fs.writeFileSync(path.join(repo, "note.txt"), "new content\n");
  fs.writeFileSync(path.join(repo, "staged.env"), "staged despite ignore\n");
  git(repo, "add", "--force", "--", "staged.env");
  fs.writeFileSync(path.join(repo, "private.env"), "do not copy\n");
  const beforeIndex = fs.readFileSync(index);
  const beforeStatus = git(repo, "status", "--porcelain=v1", "-z");
  const head = git(repo, "rev-parse", "HEAD").trim();
  const result = await createSessionWorktree(
    path.join(repo, "packages", "app"),
    "fork-dirty",
  );
  assert.equal(result.cwd, path.join(result.worktree.path, "packages", "app"));
  // Native realpath expands Windows 8.3 aliases such as RUNNER~1.
  assert.equal(result.worktree.sourceRoot, fs.realpathSync.native(repo));
  assert.equal(result.worktree.baseSha, head);
  assert.equal("branch" in result.worktree, false);
  assert.equal(
    git(result.cwd, "rev-parse", "--abbrev-ref", "HEAD").trim(),
    "HEAD",
  );
  assert.equal(git(result.cwd, "rev-parse", "HEAD").trim(), head);
  assert.equal(
    fs.readFileSync(path.join(result.cwd, "file.txt"), "utf8"),
    "final unstaged\n",
  );
  assert.deepEqual(
    fs.readFileSync(path.join(result.worktree.path, "binary.bin")),
    binary,
  );
  if (process.platform !== "win32")
    assert.equal(
      fs.statSync(path.join(result.worktree.path, "run.sh")).mode & 0o111,
      0o111,
    );
  assert.equal(
    fs
      .readlinkSync(path.join(result.worktree.path, "link"))
      .replaceAll("\\", "/"),
    "packages/app/file.txt",
  );
  assert.equal(
    fs.readlinkSync(path.join(result.worktree.path, "new-link")),
    "binary.bin",
  );
  assert.equal(
    fs.readFileSync(path.join(result.worktree.path, "note.txt"), "utf8"),
    "new content\n",
  );
  assert.equal(
    fs.readFileSync(path.join(result.worktree.path, "staged.env"), "utf8"),
    "staged despite ignore\n",
  );
  assert.equal(
    fs.existsSync(path.join(result.worktree.path, "delete.txt")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(result.worktree.path, "private.env")),
    false,
  );
  assert.equal(git(result.cwd, "diff", "--cached", "--name-only"), "");
  assert.deepEqual(fs.readFileSync(index), beforeIndex);
  assert.equal(git(repo, "status", "--porcelain=v1", "-z"), beforeStatus);
  fs.writeFileSync(path.join(result.cwd, "file.txt"), "child edit\n");
  assert.equal(fs.readFileSync(file, "utf8"), "final unstaged\n");
  const cleanup = await cleanupSessionWorktree(result.cleanupReceipt);
  assert.equal(cleanup.removed, false);
  assert.match(cleanup.reason ?? "", /changes made after creation/);
});

test("copies ignored regular AGENTS.override files and Git-parsed .worktreeinclude selections only", async (t) => {
  const { repo } = fixture(t);
  fs.writeFileSync(
    path.join(repo, "AGENTS.override.md"),
    "root instructions\n",
  );
  fs.writeFileSync(
    path.join(repo, "packages", "app", "AGENTS.override.md"),
    "app instructions\n",
  );
  fs.mkdirSync(path.join(repo, "ignored", "nested"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "ignored", "nested", "keep.json"),
    '{"keep":true}\n',
  );
  fs.writeFileSync(
    path.join(repo, "ignored", "nested", "skip.json"),
    '{"skip":true}\n',
  );
  fs.symlinkSync(
    "../../AGENTS.override.md",
    path.join(repo, "ignored", "AGENTS.override.md"),
  );
  fs.writeFileSync(path.join(repo, "selected.env"), "keep this\n");
  fs.writeFileSync(path.join(repo, "private.env"), "private\n");
  fs.writeFileSync(
    path.join(repo, ".worktreeinclude"),
    "# Git ignore-pattern semantics\n*.env\n!private.env\nignored/**/keep.json\n",
  );
  const result = await createSessionWorktree(repo, "include-ignored");
  for (const file of [
    "AGENTS.override.md",
    "packages/app/AGENTS.override.md",
    "selected.env",
    "ignored/nested/keep.json",
  ])
    assert.deepEqual(
      fs.readFileSync(path.join(result.cwd, file)),
      fs.readFileSync(path.join(repo, file)),
    );
  for (const file of [
    "private.env",
    "ignored/nested/skip.json",
    "ignored/AGENTS.override.md",
  ])
    assert.equal(fs.existsSync(path.join(result.cwd, file)), false, file);
  assert.equal(
    (
      await cleanupSessionWorktree(
        JSON.parse(JSON.stringify(result.cleanupReceipt)),
      )
    ).removed,
    true,
  );
  assert.equal(fs.existsSync(result.worktree.path), false);
  assert.equal(
    fs.readFileSync(path.join(repo, "private.env"), "utf8"),
    "private\n",
  );
});

test("rejects a symlink .worktreeinclude instead of reading external inclusion rules", async (t) => {
  const { repo, root } = fixture(t);
  fs.writeFileSync(path.join(root, "rules"), "*.env\n");
  fs.symlinkSync(path.join(root, "rules"), path.join(repo, ".worktreeinclude"));
  await assert.rejects(
    createSessionWorktree(repo, "external-rules"),
    /must be a regular file/,
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("ignores remote default branch and does not run checkout hooks or link dependencies", async (t) => {
  const { repo, root } = fixture(t);
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  fs.writeFileSync(path.join(repo, "local.txt"), "source-only commit\n");
  git(repo, "add", "local.txt");
  git(repo, "commit", "--quiet", "-m", "local head");
  fs.mkdirSync(path.join(repo, "node_modules"));
  fs.appendFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
  const hookFile = path.join(root, "hook-ran");
  fs.writeFileSync(
    path.join(repo, ".git", "hooks", "post-checkout"),
    `#!/bin/sh\ntouch '${hookFile}'\n`,
    { mode: 0o755 },
  );
  const result = await createSessionWorktree(repo, "local-head");
  assert.equal(result.worktree.baseSha, git(repo, "rev-parse", "HEAD").trim());
  assert.notEqual(
    result.worktree.baseSha,
    git(repo, "rev-parse", "origin/HEAD").trim(),
  );
  assert.equal(
    fs.readFileSync(path.join(result.cwd, "local.txt"), "utf8"),
    "source-only commit\n",
  );
  assert.equal(fs.existsSync(hookFile), false);
  assert.equal(fs.existsSync(path.join(result.cwd, "node_modules")), false);
  assert.equal(
    fs.existsSync(path.join(path.dirname(result.cwd), "node_modules")),
    false,
  );
  assert.equal(
    (await cleanupSessionWorktree(result.cleanupReceipt)).removed,
    true,
  );
});

test("forking an existing linked checkout uses the common repository and remaps its source subdirectory", async (t) => {
  const { repo, root } = fixture(t);
  const linked = path.join(root, "linked");
  git(repo, "worktree", "add", "--quiet", "--detach", linked, "HEAD");
  fs.writeFileSync(
    path.join(linked, "packages", "app", "file.txt"),
    "linked checkout change\n",
  );
  const result = await createSessionWorktree(
    path.join(linked, "packages", "app"),
    "linked-source",
  );
  assert.equal(result.worktree.sourceRoot, fs.realpathSync.native(linked));
  assert.equal(
    path.dirname(result.worktree.path),
    path.join(fs.realpathSync.native(repo), ".git", "pi-worktrees"),
  );
  assert.equal(
    fs.readFileSync(path.join(result.cwd, "file.txt"), "utf8"),
    "linked checkout change\n",
  );
  assert.equal(
    fs.readFileSync(path.join(repo, "packages", "app", "file.txt"), "utf8"),
    "committed\n",
  );
  assert.equal(
    (await cleanupSessionWorktree(result.cleanupReceipt)).removed,
    true,
  );
});

test("inspection rejects non-Git, unborn, sparse, unmerged and submodule sources with a reason", async (t) => {
  const { repo, root } = fixture(t);
  const plain = path.join(root, "plain");
  fs.mkdirSync(plain);
  assert.equal((await inspectSessionWorktree(plain)).available, false);
  git(plain, "init", "--quiet");
  assert.equal((await inspectSessionWorktree(plain)).available, false);
  git(repo, "config", "core.sparseCheckout", "true");
  const sparse = await inspectSessionWorktree(repo);
  assert.equal(sparse.available, false);
  if (!sparse.available) assert.match(sparse.reason, /sparse/);
  git(repo, "config", "core.sparseCheckout", "false");
  git(
    repo,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${git(repo, "rev-parse", "HEAD").trim()},nested`,
  );
  const submodule = await inspectSessionWorktree(repo);
  assert.equal(submodule.available, false);
  if (!submodule.available) assert.match(submodule.reason, /submodules/);
  git(repo, "update-index", "--force-remove", "nested");
  const blob = git(repo, "rev-parse", "HEAD:delete.txt").trim();
  execFileSync(realGit, ["update-index", "--index-info"], {
    cwd: repo,
    input: `0 ${"0".repeat(40)}\tdelete.txt\n100644 ${blob} 1\tdelete.txt\n100644 ${blob} 2\tdelete.txt\n`,
    encoding: "utf8",
  });
  const unmerged = await inspectSessionWorktree(repo);
  assert.equal(unmerged.available, false);
  if (!unmerged.available) assert.match(unmerged.reason, /merge conflicts/);
});

test("cancellation before creation never creates or changes a checkout", async (t) => {
  const { repo, index } = fixture(t);
  const previous = fs.readFileSync(index);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createSessionWorktree(repo, "cancel-before", controller.signal),
    (error: unknown) =>
      error instanceof SessionWorktreeError && error.code === "cancelled",
  );
  assert.deepEqual(fs.readFileSync(index), previous);
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("cancellation during worktree creation waits for identity then removes only its new checkout", async (t) => {
  const { repo, root, index } = fixture(t);
  const originalIndex = fs.readFileSync(index);
  const started = path.join(root, "add-finished");
  gitBoundary(
    t,
    root,
    `${runReal} if(isAdd){fs.writeFileSync(${JSON.stringify(started)},'created'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);}`,
  );
  const controller = new AbortController();
  const timer = setInterval(() => {
    if (fs.existsSync(started)) controller.abort();
  }, 5);
  t.after(() => clearInterval(timer));
  await assert.rejects(
    createSessionWorktree(repo, "cancel-during-add", controller.signal),
    (error: unknown) =>
      error instanceof SessionWorktreeError &&
      error.code === "cancelled" &&
      error.preservedPath === undefined,
  );
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("large ignored dependency trees do not consume the snapshot file budget", async (t) => {
  const { repo } = fixture(t);
  const ignored = path.join(repo, "ignored", "cache");
  fs.mkdirSync(ignored, { recursive: true });
  for (let index = 0; index < 20_010; index++)
    fs.writeFileSync(path.join(ignored, `file-${index}`), "");
  fs.writeFileSync(
    path.join(repo, "AGENTS.override.md"),
    "included instructions\n",
  );
  const result = await createSessionWorktree(repo, "large-dependency-tree");
  assert.equal(fs.existsSync(path.join(result.cwd, "ignored")), false);
  assert.equal(
    fs.readFileSync(path.join(result.cwd, "AGENTS.override.md"), "utf8"),
    "included instructions\n",
  );
  assert.equal(
    (await cleanupSessionWorktree(result.cleanupReceipt)).removed,
    true,
  );
});

test("a failed Git worktree add reports a remaining directory without claiming ownership or deleting it", async (t) => {
  const { repo, root } = fixture(t);
  gitBoundary(
    t,
    root,
    `if(isAdd){const destination=args[args.length-2];fs.mkdirSync(destination,{recursive:true});fs.writeFileSync(require('node:path').join(destination,'preserve.txt'),'partial checkout');process.stderr.write('injected add failure');process.exit(42);} ${runReal}`,
  );
  let preservedPath: string | undefined;
  await assert.rejects(
    createSessionWorktree(repo, "add-failure"),
    (error: unknown) => {
      if (!(error instanceof SessionWorktreeError)) return false;
      preservedPath = error.preservedPath;
      return (
        /injected add failure/.test(error.message) && Boolean(preservedPath)
      );
    },
  );
  assert.ok(preservedPath);
  assert.equal(
    fs.readFileSync(path.join(preservedPath, "preserve.txt"), "utf8"),
    "partial checkout",
  );
});

test("a HEAD race fails and removes only the unchanged newly created checkout", async (t) => {
  const { repo, root } = fixture(t);
  const head = git(repo, "rev-parse", "HEAD").trim();
  gitBoundary(
    t,
    root,
    `${runReal} if(isAdd) cp.execFileSync(realGit,['commit','--allow-empty','--quiet','-m','racing commit'],{cwd:${JSON.stringify(repo)},env:{...process.env,...${JSON.stringify(identity)}}});`,
  );
  await assert.rejects(
    createSessionWorktree(repo, "head-race"),
    (error: unknown) =>
      error instanceof SessionWorktreeError &&
      error.code === "changed" &&
      error.preservedPath === undefined,
  );
  assert.notEqual(git(repo, "rev-parse", "HEAD").trim(), head);
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("a source content race is detected without reverting the user's new content", async (t) => {
  const { repo, root, index } = fixture(t);
  fs.writeFileSync(
    path.join(repo, "packages", "app", "file.txt"),
    "snapshot version\n",
  );
  const originalIndex = fs.readFileSync(index);
  gitBoundary(
    t,
    root,
    `${runReal} if(isAdd) fs.writeFileSync(${JSON.stringify(path.join(repo, "packages", "app", "file.txt"))},'new user content\\n');`,
  );
  await assert.rejects(
    createSessionWorktree(repo, "content-race"),
    /source HEAD, index, or working tree changed/,
  );
  assert.equal(
    fs.readFileSync(path.join(repo, "packages", "app", "file.txt"), "utf8"),
    "new user content\n",
  );
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("a staging-only source race is detected even when final file contents stay the same", async (t) => {
  const { repo, root } = fixture(t);
  fs.writeFileSync(
    path.join(repo, "packages", "app", "file.txt"),
    "same final content\n",
  );
  gitBoundary(
    t,
    root,
    `${runReal} if(isAdd) cp.execFileSync(realGit,['add','--','packages/app/file.txt'],{cwd:${JSON.stringify(repo)}});`,
  );
  await assert.rejects(
    createSessionWorktree(repo, "source-index-race"),
    /source HEAD, index, or working tree changed/,
  );
  assert.equal(
    git(repo, "show", ":packages/app/file.txt"),
    "same final content\n",
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("another writer's file after successful Git apply is preserved instead of adopted as owned snapshot data", async (t) => {
  const { repo, root } = fixture(t);
  fs.writeFileSync(path.join(repo, "packages", "app", "file.txt"), "dirty\n");
  gitBoundary(
    t,
    root,
    `${runReal} if(isApply) fs.writeFileSync(require('node:path').join(process.cwd(),'other-user.txt'),'do not delete');`,
  );
  let preservedPath: string | undefined;
  await assert.rejects(
    createSessionWorktree(repo, "external-write-after-apply"),
    (error: unknown) => {
      if (!(error instanceof SessionWorktreeError)) return false;
      preservedPath = error.preservedPath;
      return error.code === "changed" && Boolean(preservedPath);
    },
  );
  assert.ok(preservedPath);
  assert.equal(
    fs.readFileSync(path.join(preservedPath, "other-user.txt"), "utf8"),
    "do not delete",
  );
});

test("an included regular file replaced by a symlink is never followed or copied", async (t) => {
  const { repo, root } = fixture(t);
  const included = path.join(repo, "AGENTS.override.md");
  const external = path.join(root, "external-secret");
  fs.writeFileSync(included, "instructions\n");
  fs.writeFileSync(external, "external data must not be copied\n");
  gitBoundary(
    t,
    root,
    `${runReal} if(isAdd){fs.unlinkSync(${JSON.stringify(included)});fs.symlinkSync(${JSON.stringify(external)},${JSON.stringify(included)});}`,
  );
  await assert.rejects(
    createSessionWorktree(repo, "included-symlink-race"),
    /ELOOP|replaced|symbolic link/i,
  );
  assert.equal(
    fs.readFileSync(external, "utf8"),
    "external data must not be copied\n",
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("failed initialization cleans an unchanged checkout and removes private snapshot files", async (t) => {
  const { repo, root } = fixture(t);
  fs.writeFileSync(path.join(repo, "packages", "app", "file.txt"), "dirty\n");
  const scratchBefore = new Set(
    fs
      .readdirSync(os.tmpdir())
      .filter((name) => name.startsWith("openpi-session-worktree-")),
  );
  gitBoundary(
    t,
    root,
    `if(isApply){process.stderr.write('injected apply failure');process.exit(42);} ${runReal}`,
  );
  await assert.rejects(
    createSessionWorktree(repo, "apply-failure"),
    /injected apply failure/,
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
  assert.deepEqual(
    fs
      .readdirSync(os.tmpdir())
      .filter(
        (name) =>
          name.startsWith("openpi-session-worktree-") &&
          !scratchBefore.has(name),
      ),
    [],
  );
  assert.equal(
    fs.readFileSync(path.join(repo, "packages", "app", "file.txt"), "utf8"),
    "dirty\n",
  );
});

test("failed initialization preserves a checkout containing another writer's file and reports its path", async (t) => {
  const { repo, root } = fixture(t);
  fs.writeFileSync(path.join(repo, "packages", "app", "file.txt"), "dirty\n");
  gitBoundary(
    t,
    root,
    `if(isApply){fs.writeFileSync(require('node:path').join(process.cwd(),'other-user.env'),'valuable ignored file');process.stderr.write('injected failure after external write');process.exit(42);} ${runReal}`,
  );
  let preservedPath: string | undefined;
  await assert.rejects(
    createSessionWorktree(repo, "preserve-user-file"),
    (error: unknown) => {
      if (!(error instanceof SessionWorktreeError)) return false;
      preservedPath = error.preservedPath;
      return Boolean(preservedPath) && /preserved/.test(error.message);
    },
  );
  assert.ok(preservedPath);
  assert.equal(
    fs.readFileSync(path.join(preservedPath, "other-user.env"), "utf8"),
    "valuable ignored file",
  );
});

test("cleanup receipt refuses changed ignored contents, staged state, HEAD and tampered ownership", async (t) => {
  const { repo } = fixture(t);
  for (const mutation of ["ignored", "index", "head", "receipt"]) {
    const result = await createSessionWorktree(repo, `cleanup-${mutation}`);
    if (mutation === "ignored")
      fs.writeFileSync(path.join(result.cwd, "new.env"), "preserve me");
    if (mutation === "index") {
      fs.writeFileSync(path.join(result.cwd, "staged.txt"), "stage me");
      git(result.cwd, "add", "staged.txt");
    }
    if (mutation === "head")
      git(
        result.cwd,
        "commit",
        "--allow-empty",
        "--quiet",
        "-m",
        "new child commit",
      );
    if (mutation === "receipt") result.cleanupReceipt.token = "different-owner";
    const cleanup = await cleanupSessionWorktree(result.cleanupReceipt);
    assert.equal(cleanup.removed, false, mutation);
    assert.equal(fs.existsSync(result.cwd), true, mutation);
  }
});

test("large snapshots fail before creating a worktree instead of silently omitting files", async (t) => {
  const { repo } = fixture(t);
  const fd = fs.openSync(path.join(repo, "oversized.bin"), "w");
  fs.ftruncateSync(fd, 129 * 1024 * 1024);
  fs.closeSync(fd);
  await assert.rejects(
    createSessionWorktree(repo, "oversized"),
    /128 MiB snapshot limit/,
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});
