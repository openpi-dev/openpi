import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  createWorktree,
  reclaimWorktree,
} from "../../../extensions/shared/worktree.ts";
import {
  finalizeWorktreeHandoff,
  prepareWorktreeHandoff,
  WORKTREE_HANDOFF_VERSION,
} from "../../../extensions/workflows/worktree-handoff.ts";

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
  // These test-owned inventories deliberately cross MAX_PATH on Windows.
  // Configure only the disposable repository, never the user's Git settings.
  git(repo, "config", "core.longpaths", "true");
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
    assert.deepEqual(prepared.manifest.ignored, ["ignored/artifact"]);
    assert.equal(prepared.manifest.inventoryCoverage, undefined);
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

test("large ignored dependency inventory retains the patch and preserves the checkout", async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    const cwd = worktree.worktree.path;
    fs.writeFileSync(path.join(cwd, "a.txt"), "deliverable\n");
    const ignored = path.join(cwd, "ignored", "dependencies");
    fs.mkdirSync(ignored, { recursive: true });
    for (let i = 0; i < 6000; i++) {
      fs.writeFileSync(
        path.join(ignored, `${"x".repeat(200)}-${i}`),
        "private\n",
      );
    }
    // Prove this fixture exceeds both old handoff and cleanup buffers.
    const expanded = execFileSync(
      "git",
      ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { cwd, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.ok(expanded.length > 1024 * 1024);
    const looseName =
      process.platform === "win32" ? "loose-�.txt" : "loose-�\n.txt";
    fs.writeFileSync(path.join(cwd, looseName), "keep\n");
    fs.symlinkSync(
      ignored,
      path.join(cwd, "dependency-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_large",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: worktree.worktree,
    });
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
    if (!prepared.ok) return;
    assert.match(prepared.manifest.patch.content, /\+deliverable/);
    assert.deepEqual(prepared.manifest.ignored, ["ignored/"]);
    assert.deepEqual(prepared.manifest.inventoryCoverage, {
      // Git enumerates a Windows junction as a directory, unlike a Unix
      // symlink. The inventory must disclose that extra summary honestly.
      untracked:
        process.platform === "win32" ? "directory-summary" : "complete-files",
      ignored: "directory-summary",
    });
    assert.deepEqual(prepared.manifest.untracked, [
      process.platform === "win32" ? "dependency-link/" : "dependency-link",
      looseName,
    ]);
    assert.ok(fs.statSync(prepared.absolutePath).size < 1024 * 1024);
    const cleanup = await reclaimWorktree(repo, worktree.worktree);
    assert.equal(cleanup.removed, false);
    assert.equal(cleanup.ignored, true);
    assert.equal(
      fs.readFileSync(path.join(ignored, `${"x".repeat(200)}-0`), "utf8"),
      "private\n",
    );
    const disk = JSON.parse(fs.readFileSync(prepared.absolutePath, "utf8"));
    assert.deepEqual(
      disk.inventoryCoverage,
      prepared.manifest.inventoryCoverage,
    );
    assert.equal(
      finalizeWorktreeHandoff(prepared, cleanup).patch.content,
      prepared.manifest.patch.content,
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

for (const kind of ["untracked", "ignored"] as const) {
  test(`oversized loose ${kind} inventory fails explicitly without partial facts`, async () => {
    await fixture(async ({ repo, runDir, worktree }) => {
      const cwd = worktree.worktree.path;
      if (kind === "ignored")
        fs.appendFileSync(path.join(cwd, ".gitignore"), "*.private\n");
      for (let i = 0; i < 3100; i++) {
        fs.writeFileSync(
          path.join(cwd, `${"x".repeat(200)}-${i}.private`),
          "keep\n",
        );
      }
      const prepared = prepareWorktreeHandoff({
        runDir,
        runId: "wf_loose",
        agentIndex: 1,
        agentLabel: "impl",
        repoCwd: repo,
        worktree: worktree.worktree,
      });
      assert.equal(prepared.ok, false);
      if (!prepared.ok)
        assert.match(
          prepared.reason,
          new RegExp(
            `${kind} inventory exceeded .*even with directory summaries`,
          ),
        );
      assert.equal(
        fs.existsSync(path.join(runDir, "worktrees", "agent-1.json")),
        false,
      );
      const cleanup = await reclaimWorktree(repo, worktree.worktree);
      assert.equal(cleanup.removed, false);
      assert.ok(fs.existsSync(path.join(cwd, `${"x".repeat(200)}-0.private`)));
    });
  });
}

test("large untracked directory uses explicit directory coverage", async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    const looseName = process.platform === "win32" ? "loose-�" : "loose-�\n";
    const loose = path.join(worktree.worktree.path, looseName);
    fs.mkdirSync(loose);
    for (let i = 0; i < 6000; i++)
      fs.writeFileSync(path.join(loose, `${"x".repeat(200)}-${i}`), "keep\n");
    // Exceed the cleanup status buffer too, without creating a second tree.
    const expandedStatus = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: worktree.worktree.path, maxBuffer: 4 * 1024 * 1024 },
    );
    assert.ok(expandedStatus.length > 1024 * 1024);
    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_directory",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: worktree.worktree,
    });
    assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
    if (!prepared.ok) return;
    assert.deepEqual(prepared.manifest.untracked, [`${looseName}/`]);
    assert.deepEqual(prepared.manifest.inventoryCoverage, {
      untracked: "directory-summary",
      ignored: "complete-files",
    });
    const cleanup = await reclaimWorktree(repo, worktree.worktree);
    assert.equal(cleanup.removed, false);
    assert.equal(cleanup.dirty, true);
    assert.equal(cleanup.untracked, true);
    assert.equal(cleanup.ignored, false);
  });
});

test("handoff path ownership rejects a symlink escaping the Git directory", async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    const link = path.join(path.dirname(worktree.worktree.path), "escape");
    fs.symlinkSync(
      repo,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_escape",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: { ...worktree.worktree, path: link },
    });
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.match(prepared.reason, /escaped/);
    assert.ok(fs.existsSync(worktree.worktree.path));
  });
});

test("invalid UTF-8 inventory paths are rejected rather than replaced", {
  skip: process.platform !== "linux",
}, async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    fs.writeFileSync(
      Buffer.concat([
        Buffer.from(`${worktree.worktree.path}/invalid-`),
        Buffer.from([0xff]),
      ]),
      "keep\n",
    );
    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_invalid_path",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: worktree.worktree,
    });
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.match(prepared.reason, /UTF-8/);
    assert.equal(
      fs.existsSync(path.join(runDir, "worktrees", "agent-1.json")),
      false,
    );
  });
});

for (const location of ["patch", "inventory"] as const) {
  test(`handoff preserves a literal replacement character in ${location}`, async () => {
    await fixture(async ({ repo, runDir, worktree }) => {
      if (location === "patch") {
        fs.writeFileSync(
          path.join(worktree.worktree.path, "a.txt"),
          "literal � marker\n",
        );
      } else {
        fs.writeFileSync(
          path.join(worktree.worktree.path, "literal-�.txt"),
          "keep\n",
        );
        fs.mkdirSync(path.join(worktree.worktree.path, "ignored"));
        fs.writeFileSync(
          path.join(worktree.worktree.path, "ignored", "�.txt"),
          "keep\n",
        );
      }
      const prepared = prepareWorktreeHandoff({
        runDir,
        runId: "wf_unicode",
        agentIndex: 1,
        agentLabel: "impl",
        repoCwd: repo,
        worktree: worktree.worktree,
      });
      assert.ok(prepared.ok, prepared.ok ? "" : prepared.reason);
      if (!prepared.ok) return;
      const disk = JSON.parse(fs.readFileSync(prepared.absolutePath, "utf8"));
      if (location === "patch") {
        assert.match(disk.patch.content, /\+literal � marker/);
      } else {
        assert.deepEqual(disk.untracked, ["literal-�.txt"]);
        assert.deepEqual(disk.ignored, ["ignored/�.txt"]);
      }
    });
  });
}

test("handoff still rejects invalid UTF-8 patch bytes before writing an artifact", async () => {
  await fixture(async ({ repo, runDir, worktree }) => {
    fs.writeFileSync(
      path.join(worktree.worktree.path, "a.txt"),
      Buffer.from([0xff, 0x0a]),
    );
    const prepared = prepareWorktreeHandoff({
      runDir,
      runId: "wf_invalid",
      agentIndex: 1,
      agentLabel: "impl",
      repoCwd: repo,
      worktree: worktree.worktree,
    });
    assert.equal(prepared.ok, false);
    if (!prepared.ok) assert.match(prepared.reason, /UTF-8/);
    assert.equal(
      fs.existsSync(path.join(runDir, "worktrees", "agent-1.json")),
      false,
    );
    assert.ok(fs.existsSync(worktree.worktree.path));
  });
});
