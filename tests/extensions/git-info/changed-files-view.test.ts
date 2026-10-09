import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadChangedFiles } from "../../../extensions/git-info/src/changed-files-view.ts";
import {
  createRuntime,
  runEffect,
} from "../../../extensions/git-info/src/runtime.ts";

test("changed-file names, paths and diffs from the repository reach the view terminal-safe", async () => {
  const repo = mkdtempSync(join(tmpdir(), "openpi-changed-files-"));
  const runtime = createRuntime();
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: repo, stdio: "ignore" },
    );
  try {
    git("init", "-q");
    writeFileSync(join(repo, "tracked.txt"), "before\n");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "fixture");
    writeFileSync(
      join(repo, "tracked.txt"),
      "after\u001b]52;c;Y2xpcGJvYXJk\u0007\u001b[31mred\u001b[0m\u0001\n",
    );
    // Bidi controls are legal file-name characters on every platform.
    writeFileSync(join(repo, "spoof\u202etxt.md"), "untracked\u001b_apc\n");

    const files = await runEffect(runtime, loadChangedFiles(repo));
    assert.ok(files);
    const byName = new Map(files.map((file) => [file.name, file]));
    const tracked = byName.get("tracked.txt");
    const untracked = byName.get("spooftxt.md");
    assert.ok(tracked, "tracked change is listed");
    assert.ok(untracked, "spoofing control is removed from the name");
    assert.equal(untracked.path, "spooftxt.md");
    assert.ok(tracked.diff.includes("+afterred"));
    assert.ok(untracked.diff.includes("+untracked"));
    for (const line of files.flatMap((file) => [
      file.name,
      file.path,
      ...file.diff,
    ])) {
      assert.doesNotMatch(line, /[\u0000-\u0008\u000b-\u001f\u007f\u202e]/u);
    }
  } finally {
    await runtime.dispose();
    rmSync(repo, { recursive: true, force: true });
  }
});
