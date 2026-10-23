import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureRuntimeInfo } from "../../web/host/runtime-info.ts";

test("startup identity belongs to the package, stays frozen, and ignores inherited Git routing", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-runtime-info-"));
  const previous = process.env.GIT_DIR;
  try {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    git("init");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "1.2.3" }),
    );
    git("add", "package.json");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const revision = git("rev-parse", "HEAD");
    process.env.GIT_DIR = join(root, "not-a-repo");
    // Windows Git and Node may preserve different drive-letter casing.
    const packageRoot =
      process.platform === "win32"
        ? root[0]!.toLowerCase() + root.slice(1)
        : root;
    const startup = captureRuntimeInfo(packageRoot);
    assert.deepEqual(startup.git, { revision, dirty: false });
    assert.equal(startup.version, "1.2.3");
    assert.equal(startup.packageRoot, packageRoot);
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ version: "2.0.0" }),
    );
    assert.equal(startup.version, "1.2.3");
    assert.equal(startup.git?.dirty, false);
    assert.equal(captureRuntimeInfo(root).git?.dirty, true);
    const installed = join(root, "node_modules", "openpi");
    mkdirSync(installed, { recursive: true });
    writeFileSync(
      join(installed, "package.json"),
      JSON.stringify({ version: "3.0.0" }),
    );
    assert.equal(captureRuntimeInfo(installed).git, null);
  } finally {
    if (previous === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("distribution diagnostics tolerate missing Git and manifests without claiming clean or a build", () => {
  const root = mkdtempSync(join(tmpdir(), "openpi-runtime-dist-"));
  try {
    const missing = captureRuntimeInfo(root);
    assert.equal(missing.version, null);
    assert.equal(missing.git, null);
    assert.equal(missing.frontendAtStartup, null);
    mkdirSync(join(root, "web/dist"), { recursive: true });
    const build = { version: "1.2.3", id: "a".repeat(64), mode: "production" };
    writeFileSync(
      join(root, "web/dist/build-info.json"),
      JSON.stringify(build),
    );
    assert.deepEqual(captureRuntimeInfo(root).frontendAtStartup, build);
    writeFileSync(join(root, "web/dist/build-info.json"), "not JSON");
    assert.equal(captureRuntimeInfo(root).frontendAtStartup, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
