import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkspaceChanges } from "../../web/host/workspace-changes.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]) {
  await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}

async function commit(cwd: string, message: string) {
  await git(cwd, [
    "-c",
    "user.name=OpenPI test",
    "-c",
    "user.email=openpi-test@example.invalid",
    "commit",
    "-m",
    message,
  ]);
}

test("reports current Git changes against an explicit baseline", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "openpi-workspace-changes-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  await git(cwd, ["init"]);
  await writeFile(join(cwd, "modified.txt"), "before\n");
  await writeFile(join(cwd, "deleted.txt"), "remove me\n");
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2]));
  await writeFile(join(cwd, "large.txt"), "small\n");
  await git(cwd, ["add", "."]);
  await commit(cwd, "initial");

  await writeFile(join(cwd, "modified.txt"), "before\nafter\n");
  await unlink(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, "new.txt"), "new file\n");
  await writeFile(join(cwd, "empty.txt"), "");
  await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 3, 2]));
  await writeFile(join(cwd, "large.txt"), "x\n".repeat(300_000));

  const result = await loadWorkspaceChanges(cwd, "session-1");
  assert.equal(result.sessionId, "session-1");
  assert.equal(result.cwd, cwd);
  assert.equal(result.status, "changed");
  assert.equal(result.baseline?.kind, "head");
  assert.equal(result.files.length, 6);

  const files = new Map(result.files.map((file) => [file.path, file]));
  assert.equal(files.get("modified.txt")?.status, "modified");
  assert.match(files.get("modified.txt")?.diff ?? "", /\+after/u);
  assert.equal(files.get("deleted.txt")?.status, "deleted");
  assert.equal(files.get("new.txt")?.status, "untracked");
  assert.match(files.get("new.txt")?.diff ?? "", /\+new file/u);
  assert.equal(files.get("empty.txt")?.binary, false);
  assert.equal(files.get("empty.txt")?.diffStatus, "text");
  assert.equal(files.get("binary.bin")?.binary, true);
  assert.equal(files.get("binary.bin")?.diffStatus, "binary");
  assert.equal(files.get("large.txt")?.truncated, true);
  assert.equal(files.get("large.txt")?.diffStatus, "text");

  await writeFile(join(cwd, "modified.txt"), "before\nafter again\n");
  const refreshed = await loadWorkspaceChanges(cwd, "session-1");
  assert.match(
    refreshed.files.find((file) => file.path === "modified.txt")?.diff ?? "",
    /\+after again/u,
  );
});

test("distinguishes a clean repository with no HEAD from a non-repository", async (t) => {
  const emptyRepository = await mkdtemp(
    join(tmpdir(), "openpi-empty-repository-"),
  );
  const nonRepository = await mkdtemp(join(tmpdir(), "openpi-non-repository-"));
  t.after(async () => {
    await Promise.all([
      rm(emptyRepository, { recursive: true, force: true }),
      rm(nonRepository, { recursive: true, force: true }),
    ]);
  });

  await git(emptyRepository, ["init"]);
  const empty = await loadWorkspaceChanges(emptyRepository, "session-empty");
  assert.equal(empty.status, "clean");
  assert.equal(empty.baseline?.kind, "empty-tree");

  const outside = await loadWorkspaceChanges(nonRepository, "session-none");
  assert.equal(outside.status, "not-repository");
  assert.equal(outside.baseline, undefined);
});
