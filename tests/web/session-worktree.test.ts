import { strict as assert } from "node:assert";
import childProcess, {
  execFileSync,
  type ExecFileOptions,
} from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";

// Launch boundary scripts through Node on every platform. Windows execFile
// cannot execute a POSIX shebang, and Git Bash's `which` returns /cmd/git.
const originalExecFile = childProcess.execFile;
const execFileAsync = promisify(originalExecFile);
let gitWrapper: string | undefined;
let afterGitCall: (() => void) | undefined;
childProcess.execFile = Object.assign(originalExecFile.bind(childProcess), {
  [promisify.custom]: async (
    file: string,
    args: string[],
    options: ExecFileOptions,
  ) => {
    const result = await (file === "git" && gitWrapper
      ? execFileAsync(process.execPath, [gitWrapper, ...args], options)
      : execFileAsync(file, args, options));
    if (file === "git") afterGitCall?.();
    return result;
  },
});
syncBuiltinESMExports();
const {
  cleanupSessionWorktree,
  createSessionWorktree,
  inspectSessionWorktree,
  bindSessionWorktree,
  readSessionWorktreeReceipt,
  listSessionWorktrees,
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

function stagedIndex(cwd: string) {
  return git(cwd, "ls-files", "--stage", "-z");
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
  return { root, repo };
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
  const { repo } = fixture(t);
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
  const beforeStage = stagedIndex(repo);
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
  assert.equal(stagedIndex(repo), beforeStage);
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
  const { repo } = fixture(t);
  const previousStage = stagedIndex(repo);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    createSessionWorktree(repo, "cancel-before", controller.signal),
    (error: unknown) =>
      error instanceof SessionWorktreeError && error.code === "cancelled",
  );
  assert.equal(stagedIndex(repo), previousStage);
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
});

test("cancellation during worktree creation waits for identity then removes only its new checkout", async (t) => {
  const { repo, root } = fixture(t);
  const originalStage = stagedIndex(repo);
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
  assert.equal(stagedIndex(repo), originalStage);
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
  const { repo, root } = fixture(t);
  fs.writeFileSync(
    path.join(repo, "packages", "app", "file.txt"),
    "snapshot version\n",
  );
  const originalStage = stagedIndex(repo);
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
  assert.equal(stagedIndex(repo), originalStage);
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
  const scratchWitness = path.join(root, "operation-scratch.json");
  const otherScratch = path.join(
    os.tmpdir(),
    `openpi-session-worktree-${path.basename(root)}-other-owner`,
  );
  t.after(() => fs.rmSync(otherScratch, { recursive: true, force: true }));
  gitBoundary(
    t,
    root,
    `if(isApply){const path=require('node:path');fs.writeFileSync(${JSON.stringify(scratchWitness)},JSON.stringify({patch:args.at(-1)}));fs.mkdirSync(${JSON.stringify(otherScratch)});fs.writeFileSync(path.join(${JSON.stringify(otherScratch)},'other-owner.txt'),'must survive');process.stderr.write('injected apply failure');process.exit(42);} ${runReal}`,
  );
  await assert.rejects(
    createSessionWorktree(repo, "apply-failure"),
    /injected apply failure/,
  );
  assert.equal(
    git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length,
    1,
  );
  const { patch } = JSON.parse(fs.readFileSync(scratchWitness, "utf8")) as {
    patch: string;
  };
  assert.ok(path.isAbsolute(patch));
  assert.equal(path.basename(patch), "working-tree.patch");
  const ownedScratch = path.dirname(patch);
  assert.ok(path.basename(ownedScratch).startsWith("openpi-session-worktree-"));
  assert.equal(fs.existsSync(ownedScratch), false);
  assert.equal(
    fs.readFileSync(path.join(otherScratch, "other-owner.txt"), "utf8"),
    "must survive",
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

test("successful worktree private authority survives restart and never comes from display paths", async (t) => {
  const { repo } = fixture(t);
  const sessions = path.join(repo, "sessions");
  fs.mkdirSync(sessions);
  const child = await createSessionWorktree(repo, "bound-child");
  await assert.rejects(
    readSessionWorktreeReceipt(child.worktree.path, sessions),
  );
  assert.deepEqual(await listSessionWorktrees(repo, sessions), {
    worktrees: [],
    truncated: false,
    unavailable: 1,
  });
  const ownerSession = {
    sessionId: "native-child",
    sessionPath: path.join(sessions, "child.jsonl"),
  };
  await bindSessionWorktree(child.cleanupReceipt, ownerSession);
  const recovered = await readSessionWorktreeReceipt(
    child.worktree.path,
    sessions,
  );
  assert.deepEqual(recovered.ownerSession, ownerSession);
  const listing = await listSessionWorktrees(repo, sessions);
  assert.deepEqual(listing.worktrees, [
    { ...ownerSession, worktreePath: child.worktree.path },
  ]);
  assert.deepEqual(Object.keys(listing.worktrees[0]!).sort(), [
    "sessionId",
    "sessionPath",
    "worktreePath",
  ]);
  assert.equal(JSON.stringify(listing).includes("fingerprint"), false);
  await assert.rejects(
    readSessionWorktreeReceipt(
      child.worktree.path,
      path.join(repo, "other-sessions"),
    ),
  );
  fs.writeFileSync(
    path.join(child.worktree.path, "private.env"),
    "user bytes\n",
  );
  assert.equal((await cleanupSessionWorktree(recovered)).removed, false);
  fs.unlinkSync(path.join(child.worktree.path, "private.env"));
  assert.equal((await cleanupSessionWorktree(recovered)).removed, true);
  assert.deepEqual(await listSessionWorktrees(repo, sessions), {
    worktrees: [],
    truncated: false,
    unavailable: 0,
  });
});

test("managed worktree discovery pages past unavailable markers and rejects stale cursors", async (t) => {
  const { repo } = fixture(t);
  const sessions = path.join(repo, "sessions");
  const child = await createSessionWorktree(repo, "paged-child");
  await bindSessionWorktree(child.cleanupReceipt, {
    sessionId: "native-child",
    sessionPath: path.join(sessions, "child.jsonl"),
  });
  const parent = path.dirname(child.worktree.path);
  for (let index = 0; index < 128; index++) {
    fs.mkdirSync(
      path.join(
        parent,
        `session-000000000000-${String(index).padStart(36, "0")}`,
      ),
    );
  }
  const first = await listSessionWorktrees(repo, sessions);
  assert.equal(first.truncated, true);
  assert.equal(first.unavailable, 128);
  assert.ok(first.nextCursor);
  const next = await listSessionWorktrees(repo, sessions, first.nextCursor);
  assert.equal(next.worktrees[0]?.worktreePath, child.worktree.path);
  assert.equal(next.truncated, false);
  await assert.rejects(
    listSessionWorktrees(repo, sessions, "invalid"),
    /refresh/u,
  );
  const anchor = Buffer.from(first.nextCursor, "base64url").toString("utf8");
  fs.rmdirSync(path.join(parent, anchor));
  await assert.rejects(
    listSessionWorktrees(repo, sessions, first.nextCursor),
    /refresh/u,
  );
});

test("uncertain destructive release is terminal for the exact private resource after recovery", async (t) => {
  const { repo, root } = fixture(t);
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const child = await createSessionWorktree(repo, "uncertain-terminal");
  await bindSessionWorktree(child.cleanupReceipt, {
    sessionId: "child",
    sessionPath: path.join(sessions, "child.jsonl"),
  });
  const stale = { ...child.cleanupReceipt };
  const counter = path.join(root, "remove-count");
  gitBoundary(
    t,
    root,
    `if(args.includes('worktree')&&args.includes('remove')) { const count=${JSON.stringify(counter)}; fs.writeFileSync(count,String((fs.existsSync(count)?Number(fs.readFileSync(count,'utf8')):0)+1)); process.stderr.write('injected unknown removal failure');process.exit(42); } ${runReal}`,
  );
  const first = await cleanupSessionWorktree(child.cleanupReceipt);
  assert.equal(first.removed, false);
  assert.equal("uncertain" in first, true);
  assert.equal(fs.readFileSync(counter, "utf8"), "1");
  assert.equal(fs.existsSync(child.worktree.path), true);
  const marker = JSON.parse(
    fs.readFileSync(
      path.join(child.cleanupReceipt.gitDir, "openpi-session-worktree.json"),
      "utf8",
    ),
  );
  assert.equal(marker.releaseState, "uncertain");
  assert.equal(marker.fingerprint, stale.fingerprint);
  assert.deepEqual(marker.ownerSession, stale.ownerSession);
  const recovered = await readSessionWorktreeReceipt(
    child.worktree.path,
    sessions,
  );
  assert.equal(recovered.releaseState, "uncertain");
  for (const receipt of [stale, recovered]) {
    const repeated = await cleanupSessionWorktree(receipt);
    assert.equal("uncertain" in repeated, true);
    assert.equal(repeated.removed, false);
  }
  assert.equal(fs.readFileSync(counter, "utf8"), "1");
});

test("an external-process release claim blocks removal even if marker update never completed", async (t) => {
  const { repo, root } = fixture(t);
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const child = await createSessionWorktree(repo, "claim-before-marker");
  await bindSessionWorktree(child.cleanupReceipt, {
    sessionId: "child",
    sessionPath: path.join(sessions, "child.jsonl"),
  });
  const claimPath = path.join(
    child.cleanupReceipt.gitDir,
    "openpi-session-worktree.json.release-lock",
  );
  execFileSync(process.execPath, [
    "-e",
    "const fs=require('node:fs');const fd=fs.openSync(process.argv[1],'wx',0o600);fs.writeFileSync(fd,process.argv[2]);fs.fsyncSync(fd);fs.closeSync(fd)",
    claimPath,
    JSON.stringify(child.cleanupReceipt),
  ]);
  const recovered = await readSessionWorktreeReceipt(
    child.worktree.path,
    sessions,
  );
  assert.equal(recovered.releaseState, "uncertain");
  assert.equal(
    "uncertain" in (await cleanupSessionWorktree(child.cleanupReceipt)),
    true,
  );
  assert.equal("uncertain" in (await cleanupSessionWorktree(recovered)), true);
  assert.equal(fs.existsSync(child.worktree.path), true);
  assert.throws(() => fs.openSync(claimPath, "wx"), /EEXIST/u);
});

test("claim acquisition failure is preserved only before creation with unchanged original authority", async (t) => {
  const { repo } = fixture(t);
  const child = await createSessionWorktree(repo, "claim-denied");
  const markerPath = path.join(
    child.cleanupReceipt.gitDir,
    "openpi-session-worktree.json",
  );
  const claimPath = `${markerPath}.release-lock`;
  const originalMarker = fs.readFileSync(markerPath, "utf8");
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    if (String(args[0]) === claimPath)
      throw Object.assign(
        new Error("permission denied before claim creation"),
        { code: "EACCES" },
      );
    return originalOpen(...args);
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await cleanupSessionWorktree(child.cleanupReceipt);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(result.removed, false);
  assert.equal("uncertain" in result, false);
  assert.equal(fs.existsSync(claimPath), false);
  assert.equal(fs.readFileSync(markerPath, "utf8"), originalMarker);
  assert.equal(
    (await cleanupSessionWorktree(child.cleanupReceipt)).removed,
    true,
  );
});

test("failure after exclusive claim creation leaves a durable uncertain barrier and never calls remove", async (t) => {
  const { repo, root } = fixture(t);
  const child = await createSessionWorktree(repo, "claim-write-failed");
  const markerPath = path.join(
    child.cleanupReceipt.gitDir,
    "openpi-session-worktree.json",
  );
  const claimPath = `${markerPath}.release-lock`;
  const originalMarker = fs.readFileSync(markerPath, "utf8");
  const removeLog = path.join(root, "unexpected-remove");
  gitBoundary(
    t,
    root,
    `if(args.includes('worktree')&&args.includes('remove')) { fs.writeFileSync(${JSON.stringify(removeLog)},'remove invoked');process.exit(42); } ${runReal}`,
  );
  const originalOpen = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === claimPath)
      handle.writeFile = async () => {
        throw new Error("injected claim write failure");
      };
    return handle;
  };
  syncBuiltinESMExports();
  let result;
  try {
    result = await cleanupSessionWorktree(child.cleanupReceipt);
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(result.removed, false);
  assert.equal("uncertain" in result, true);
  assert.equal(fs.existsSync(claimPath), true);
  assert.equal(fs.readFileSync(markerPath, "utf8"), originalMarker);
  assert.equal(
    "uncertain" in (await cleanupSessionWorktree(child.cleanupReceipt)),
    true,
  );
  assert.equal(fs.existsSync(removeLog), false);
  assert.equal(fs.existsSync(child.worktree.path), true);
});

test("wall-clock jumps do not change real Git worktree operation budgets", async (t) => {
  const { repo, root } = fixture(t);
  const sessions = path.join(root, "sessions");
  fs.mkdirSync(sessions);
  const originalNow = Date.now;
  for (const shift of [120_000, -120_000]) {
    const withShift = async <T>(operation: () => Promise<T>) => {
      let shifted = false;
      afterGitCall = () => {
        if (!shifted) {
          shifted = true;
          Date.now = () => originalNow() + shift;
        }
      };
      try {
        return await operation();
      } finally {
        Date.now = originalNow;
        afterGitCall = undefined;
        assert.equal(
          shifted,
          true,
          "clock control follows a completed real Git call",
        );
      }
    };
    assert.equal(
      (await withShift(() => inspectSessionWorktree(repo))).available,
      true,
      String(shift),
    );
    const child = await withShift(() =>
      createSessionWorktree(repo, `wall-shift-${shift}`),
    );
    await bindSessionWorktree(child.cleanupReceipt, {
      sessionId: `child-${shift}`,
      sessionPath: path.join(sessions, `child-${shift}.jsonl`),
    });
    const recovered = await withShift(() =>
      readSessionWorktreeReceipt(child.worktree.path, sessions),
    );
    assert.equal(recovered.path, child.worktree.path);
    assert.equal(
      (await withShift(() => listSessionWorktrees(repo, sessions))).worktrees
        .length,
      1,
    );
    assert.equal(
      (await withShift(() => cleanupSessionWorktree(recovered))).removed,
      true,
    );
  }
});

test("real Git inspection honors monotonic remaining budget while wall time moves backward", async (t) => {
  const { repo } = fixture(t);
  const originalDateNow = Date.now;
  const originalPerformanceNow = performance.now.bind(performance);
  const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
  for (const elapsed of [85_000, 120_000]) {
    let calls = 0;
    afterGitCall = () => {
      if (++calls === 1) {
        Date.now = () => originalDateNow() - 120_000;
        Object.defineProperty(performance, "now", {
          configurable: true,
          value: () => originalPerformanceNow() + elapsed,
        });
      }
    };
    try {
      const result = await inspectSessionWorktree(repo);
      if (elapsed < 90_000)
        assert.equal(
          result.available,
          true,
          "remaining fractional milliseconds still produce a bounded valid native timeout",
        );
      else {
        assert.equal(
          result.available,
          false,
          "monotonic budget expires despite backward wall time",
        );
        if (!result.available)
          assert.match(result.reason, /90 second deadline/u);
        assert.equal(calls, 1);
      }
    } finally {
      afterGitCall = undefined;
      Date.now = originalDateNow;
      if (descriptor) Object.defineProperty(performance, "now", descriptor);
      else Reflect.deleteProperty(performance, "now");
    }
  }
});
