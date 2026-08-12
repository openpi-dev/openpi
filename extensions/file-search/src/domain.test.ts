import assert from "node:assert/strict";
import test from "node:test";
import { buildFdArgs, buildRgArgs, normalizeSearchPath } from "./args.ts";
import { formatCapturedOutput } from "./output.ts";
import { releaseAsset, type PlatformTarget } from "./binaries.ts";

test("normalizeSearchPath strips @ and expands ~", () => {
  assert.equal(normalizeSearchPath("@src"), "src");
  assert.equal(normalizeSearchPath("  src  "), "src");
  assert.equal(normalizeSearchPath("~"), process.env.HOME);
  assert.ok(normalizeSearchPath("~/x").startsWith(process.env.HOME ?? ""));
  assert.equal(normalizeSearchPath("plain"), "plain");
});

test("buildFdArgs clamps limits and puts patterns after --", () => {
  const args = buildFdArgs({
    pattern: "*.ts",
    path: "src",
    hidden: true,
    max_depth: 999,
    limit: 99_999,
  });
  assert.deepEqual(args, [
    "--color=never",
    "--hidden",
    "--max-depth",
    "64",
    "--max-results",
    "10000",
    "--",
    "*.ts",
    "src",
  ]);
  // Defaults when nothing is provided.
  const minimal = buildFdArgs({ pattern: "" });
  assert.deepEqual(minimal, [
    "--color=never",
    "--max-results",
    "1000",
    "--",
    "",
  ]);
});

test("buildRgArgs maps case sensitivity and context clamps", () => {
  const smart = buildRgArgs({ pattern: "foo" });
  assert.ok(smart.includes("--smart-case"));
  const explicit = buildRgArgs({ pattern: "foo", case_sensitive: true });
  assert.ok(explicit.includes("--case-sensitive"));
  const insensitive = buildRgArgs({ pattern: "foo", case_sensitive: false });
  assert.ok(insensitive.includes("--ignore-case"));
  const context = buildRgArgs({ pattern: "foo", context: 999 });
  assert.ok(context.includes("--context"));
  assert.ok(context.includes("20"));
  const legacy = buildRgArgs({ pattern: "x", limit: 5 });
  assert.ok(legacy.includes("--max-count"));
  assert.ok(legacy.includes("5"));
});

test("formatCapturedOutput reports capture-limit and truncation branches", async () => {
  // captureLimitExceeded branch: search was stopped, no saved artifact.
  const limited = formatCapturedOutput({
    preview: "line1\nline2",
    lineCount: 100,
    totalBytes: 2048,
    truncated: true,
    captureLimitExceeded: true,
    captureLimitBytes: 1024,
  });
  assert.equal(limited.truncated, true);
  assert.match(limited.text, /complete-output capture limit/);
  assert.equal(limited.lineCount, 100);

  // truncation branch with a persisted full output path.
  const saved = formatCapturedOutput({
    preview: "line1\nline2",
    lineCount: 100,
    totalBytes: 2048,
    truncated: true,
    captureLimitExceeded: false,
    captureLimitBytes: 1024,
    fullOutputPath: "/tmp/pi-fd-xxx/output.txt",
  });
  assert.match(saved.text, /Output truncated: 2 of 100 lines/);
  assert.match(saved.text, /pi-fd-xxx\/output\.txt/);
  assert.equal(saved.fullOutputPath, "/tmp/pi-fd-xxx/output.txt");

  // Untruncated output passes through unchanged.
  const plain = formatCapturedOutput({
    preview: "a\nb",
    lineCount: 2,
    totalBytes: 4,
    truncated: false,
    captureLimitExceeded: false,
    captureLimitBytes: 1024,
  });
  assert.equal(plain.truncated, false);
  assert.equal(plain.text, "a\nb");
});

test("releaseAsset resolves official GitHub assets per platform", () => {
  const linux: PlatformTarget = { os: "linux", arch: "x64" };
  const fd = releaseAsset("fd", linux);
  assert.ok(fd);
  assert.match(fd!.url, /sharkdp\/fd\/releases\/download/);
  assert.match(fd!.fileName, /tar\.gz$/);
  assert.ok(fd!.sha256.length === 64);

  const rg = releaseAsset("rg", linux);
  assert.ok(rg);
  assert.match(rg!.url, /BurntSushi\/ripgrep\/releases/);

  // Unsupported platform resolves to no asset.
  assert.equal(releaseAsset("fd", { os: "windows", arch: "x64" }), undefined);
});
