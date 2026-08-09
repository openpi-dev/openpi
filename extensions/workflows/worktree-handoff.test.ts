import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createWorktree, reclaimWorktree } from "../shared/worktree.ts";
import {
  finalizeWorktreeHandoff,
  prepareWorktreeHandoff,
  WORKTREE_HANDOFF_VERSION,
} from "./worktree-handoff.ts";

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

async function fixture(
  run: (input: {
    repo: string;
    runDir: string;
    worktree: Awaited<ReturnType<typeof createWorktree>> & { ok: true };
  }) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-handoff-"));
  const repo = path.join(root, "repo");
  const runDir = path.join(root, "run");
  fs.mkdirSync(repo);
  git(repo, "init", "--quiet", "--initial-branch=main", ".");
  fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
  fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "base");
  const worktree = await createWorktree({
    cwd: repo,
    label: "handoff",
    id: "1",
    linkNodeModules: false,
  });
  assert.ok(worktree.ok);
  try {
    await run({ repo, runDir, worktree });
  } finally {
    if (fs.existsSync(worktree.worktree.path)) {
      git(repo, "worktree", "remove", "--force", worktree.worktree.path);
    }
    try {
      git(repo, "branch", "-D", worktree.worktree.branch);
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("handoff captures tracked binary patch plus untracked and ignored inventories", async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    fs.writeFileSync(path.join(worktree.worktree.path, "a.txt"), "changed\n");
    fs.writeFileSync(
      path.join(worktree.worktree.path, "binary.bin"),
      Buffer.from([0, 255, 1, 2]),
    );
    git(worktree.worktree.path, "add", "binary.bin");
    fs.writeFileSync(path.join(worktree.worktree.path, "loose.txt"), "loose\n");
    fs.mkdirSync(path.join(worktree.worktree.path, "ignored"));
    fs.writeFileSync(
      path.join(worktree.worktree.path, "ignored", "artifact"),
      "keep\n",
    );

    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_test",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: worktree.worktree,
    });
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
    if (!prepared.ok) return;
    assert.equal(prepared.manifest.version, WORKTREE_HANDOFF_VERSION);
    assert.match(prepared.manifest.patch.content, /GIT binary patch/);
    assert.ok(prepared.manifest.untracked.includes("loose.txt"));
    assert.ok(prepared.manifest.ignored.includes("ignored/artifact"));
    assert.ok(fs.existsSync(prepared.absolutePath));

    const cleanup = await reclaimWorktree(repo, worktree.worktree);
    assert.equal(
      cleanup.removed,
      false,
      "uncaptured loose/ignored data must keep the checkout",
    );
    const finalized = finalizeWorktreeHandoff(prepared, cleanup);
    assert.equal(finalized.cleanup?.removed, false);
    const disk = JSON.parse(fs.readFileSync(prepared.absolutePath, "utf8"));
    assert.equal(disk.cleanup.removed, false);
    assert.equal(
      disk.patch.content,
      prepared.manifest.patch.content,
      "a safety artifact must never silently truncate its recovery patch",
    );
  });
});

test("handoff capture failure is explicit and leaves cleanup to the caller", async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_test",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: { ...worktree.worktree, baseSha: "missing-base" },
    });
    assert.equal(prepared.ok, false);
    assert.ok(fs.existsSync(worktree.worktree.path));
  });
});
