import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Cause, Effect, Exit } from "effect";
import { expandedResultPreview } from "./index.ts";
import { buildDiffArgs, buildLogArgs, buildShowArgs } from "./src/args.ts";
import { runGit } from "./src/process.ts";

function git(repoPath: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function markerCommand(repoPath: string, name: string) {
  const marker = join(repoPath, `${name}-ran`);
  const helper = join(repoPath, `${name}-helper.cjs`);
  writeFileSync(
    helper,
    'require("node:fs").writeFileSync(process.argv[2], "ran");\n',
  );
  const command = [process.execPath, helper, marker]
    .map((value) => JSON.stringify(value.replaceAll("\\", "/")))
    .join(" ");
  return { command, helper, marker };
}

/** Create a small real repository with two commits and a dirty worktree. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-git-read-"));
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "T"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "first"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "b.txt"), "new\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "--quiet", "-m", "second"]);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  return dir;
}

let repo: string;

before(() => {
  repo = makeRepo();
});

after(() => {
  rmSync(repo, { recursive: true, force: true });
});

test("runGit returns stdout for a successful command", async () => {
  const exit = await Effect.runPromiseExit(runGit(buildLogArgs({}), repo));
  assert.ok(Exit.isSuccess(exit));
  if (Exit.isSuccess(exit)) {
    assert.match(exit.value.output.preview, /second/);
    assert.match(exit.value.output.preview, /first/);
    assert.equal(exit.value.exitCode, 0);
  }
});

test("runGit surfaces git failures as GitCommandError with stderr", async () => {
  const exit = await Effect.runPromiseExit(
    runGit(["show", "--no-color", "does-not-exist"], repo),
  );
  assert.ok(Exit.isFailure(exit));
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause) as { message?: string };
    assert.match(
      error.message ?? "",
      /does-not-exist|bad revision|unknown revision|ambiguous argument/i,
    );
  }
});

test("git show output includes commit metadata and patch", async () => {
  const exit = await Effect.runPromiseExit(
    runGit(buildShowArgs({ revision: "HEAD" }), repo),
  );
  assert.ok(Exit.isSuccess(exit));
  if (Exit.isSuccess(exit)) {
    assert.match(exit.value.output.preview, /second/);
    assert.match(exit.value.output.preview, /\+new/);
  }
});

test("git show with path limits the commit patch to that path", async () => {
  const exit = await Effect.runPromiseExit(
    runGit(buildShowArgs({ revision: "HEAD", path: "b.txt" }), repo),
  );
  assert.ok(Exit.isSuccess(exit));
  if (Exit.isSuccess(exit)) {
    assert.match(exit.value.output.preview, /new/);
  }
});

test("structured git diff and show never invoke diff.external", async () => {
  const { command, helper, marker } = markerCommand(repo, "external-diff");
  try {
    git(repo, ["config", "diff.external", command]);
    git(repo, ["diff"]);
    assert.equal(existsSync(marker), true, "the hostile control must execute");
    rmSync(marker, { force: true });

    for (const args of [
      buildDiffArgs({}),
      buildShowArgs({ revision: "HEAD" }),
    ]) {
      const exit = await Effect.runPromiseExit(runGit(args, repo));
      assert.ok(Exit.isSuccess(exit));
      assert.equal(existsSync(marker), false);
    }
  } finally {
    git(repo, ["config", "--unset", "diff.external"]);
    rmSync(helper, { force: true });
    rmSync(marker, { force: true });
  }
});

test("structured git diff and show never invoke textconv commands", async () => {
  const { command, helper, marker } = markerCommand(repo, "textconv");
  const attributes = join(repo, ".gitattributes");
  try {
    writeFileSync(attributes, "a.txt diff=evil\n");
    git(repo, ["config", "diff.evil.textconv", command]);
    git(repo, ["diff"]);
    assert.equal(existsSync(marker), true, "the hostile control must execute");
    rmSync(marker, { force: true });

    for (const args of [
      buildDiffArgs({}),
      buildShowArgs({ revision: "HEAD" }),
    ]) {
      const exit = await Effect.runPromiseExit(runGit(args, repo));
      assert.ok(Exit.isSuccess(exit));
      assert.equal(existsSync(marker), false);
    }
  } finally {
    git(repo, ["config", "--unset", "diff.evil.textconv"]);
    rmSync(attributes, { force: true });
    rmSync(helper, { force: true });
    rmSync(marker, { force: true });
  }
});

test("runGit applies its own bounded timeout", async () => {
  const exit = await Effect.runPromiseExit(
    runGit(["-c", "alias.hang=!sleep 2", "hang"], repo, 20),
  );
  assert.ok(Exit.isFailure(exit));
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause) as { message?: string };
    assert.match(error.message ?? "", /timed out/i);
  }
  // Git for Windows leaves the shell process behind until `sleep` exits; that
  // process holds the fixture as its cwd and would make suite cleanup fail.
  if (process.platform === "win32") {
    await new Promise((resolve) => setTimeout(resolve, 2_100));
  }
});

test("structured git diff preserves worktree, staged, revision, and path forms", async () => {
  const worktree = await Effect.runPromiseExit(runGit(buildDiffArgs({}), repo));
  assert.ok(Exit.isSuccess(worktree));
  if (Exit.isSuccess(worktree)) {
    assert.match(worktree.value.output.preview, /\+three/);
  }

  git(repo, ["add", "a.txt"]);
  const staged = await Effect.runPromiseExit(
    runGit(buildDiffArgs({ staged: true }), repo),
  );
  assert.ok(Exit.isSuccess(staged));
  if (Exit.isSuccess(staged)) {
    assert.match(staged.value.output.preview, /\+three/);
  }

  const revisionPath = await Effect.runPromiseExit(
    runGit(buildDiffArgs({ from: "HEAD~1", to: "HEAD", path: "b.txt" }), repo),
  );
  assert.ok(Exit.isSuccess(revisionPath));
  if (Exit.isSuccess(revisionPath)) {
    assert.match(revisionPath.value.output.preview, /\+new/);
    assert.doesNotMatch(revisionPath.value.output.preview, /a\.txt/);
  }
});

test("outside a repository the command fails with a clear error", async () => {
  const outside = mkdtempSync(join(tmpdir(), "pi-git-none-"));
  try {
    const exit = await Effect.runPromiseExit(runGit(["log"], outside));
    assert.ok(Exit.isFailure(exit));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("expanded git results show a bounded preview and retained output path", () => {
  const rendered = expandedResultPreview(
    {
      content: [
        {
          type: "text",
          text: Array.from(
            { length: 25 },
            (_, index) => `line ${index + 1}`,
          ).join("\n"),
        },
      ],
    },
    "/tmp/pi-git-test/output.txt",
    { fg: (_color, text) => text },
  );
  assert.match(rendered, /line 1/);
  assert.doesNotMatch(rendered, /line 21/);
  assert.match(rendered, /5 more lines/);
  assert.match(rendered, /Full output: \/tmp\/pi-git-test\/output\.txt/);
});
