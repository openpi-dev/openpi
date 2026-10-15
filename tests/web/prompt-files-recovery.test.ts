import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(
  new URL("./fixtures/prompt-files-recovery-child.mjs", import.meta.url),
);
const markerName = ".openpi-pending.json";
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "openpi-pending-recovery-"));
  await mkdir(join(root, "sessions"), { mode: 0o700 });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function run(root: string, mode: string, expected = 0) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", child, mode, root],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, expected, result.stderr);
  return JSON.parse(result.stdout.trim());
}
async function exists(path: string) {
  return lstat(path).then(
    () => true,
    () => false,
  );
}
for (const mode of ["crash-payload", "crash-publish"]) {
  test(`fresh process recovers ${mode} without touching published originals or replay identity`, async (t) => {
    const root = await fixture(t);
    const abandoned = run(root, mode, mode === "crash-payload" ? 90 : 88);
    assert.equal(await exists(join(abandoned.pending, markerName)), true);
    const published = run(root, "publish");
    const original = await readFile(published.files[0].path);
    const recovered = run(root, "recover");
    assert.equal(recovered.removed, 1);
    assert.equal(recovered.failed, 0);
    assert.equal(await exists(abandoned.pending), false);
    assert.deepEqual(await readFile(published.files[0].path), original);
    assert.deepEqual(run(root, "publish"), published);
  });
}
for (const mode of ["crash-before-marker", "crash-partial-marker"]) {
  test(`${mode} remains UNKNOWN after restart`, async (t) => {
    const root = await fixture(t);
    const abandoned = run(root, mode, 89);
    const before = await readdir(abandoned.pending);
    const result = run(root, "recover");
    assert.equal(result.removed, 0);
    assert.ok(result.unknown > 0);
    assert.deepEqual(await readdir(abandoned.pending), before);
  });
}
test("flat preflight preserves declared bytes when an unknown nested entry exists", async (t) => {
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  const target = join(abandoned.pending, "1-original-one.bin");
  const original = await readFile(target);
  await mkdir(join(abandoned.pending, "unknown"));
  await writeFile(join(abandoned.pending, "unknown", "keep"), "sentinel");
  const result = run(root, "recover");
  assert.equal(result.removed, 0);
  assert.deepEqual(await readFile(target), original);
  assert.equal(
    await readFile(join(abandoned.pending, "unknown", "keep"), "utf8"),
    "sentinel",
  );
});
test("legacy, unmarked UUID, foreign marker scope, invalid declaration and oversized marker survive", async (t) => {
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  const parent = dirname(abandoned.pending);
  await mkdir(join(parent, ".pending-legacy"));
  await writeFile(join(parent, ".pending-legacy", "keep"), "legacy");
  await mkdir(join(parent, ".pending-v1-00000000-0000-4000-8000-000000000000"));
  const marker = JSON.parse(
    await readFile(join(abandoned.pending, markerName), "utf8"),
  );
  for (const mutation of [
    { ...marker, sessionKey: "f".repeat(64) },
    { ...marker, files: ["../outside"] },
    { ...marker, extra: true },
  ]) {
    await writeFile(
      join(abandoned.pending, markerName),
      JSON.stringify(mutation),
    );
    assert.equal(run(root, "recover").removed, 0);
  }
  await writeFile(join(abandoned.pending, markerName), "x".repeat(17000));
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(
    await readFile(join(parent, ".pending-legacy", "keep"), "utf8"),
    "legacy",
  );
  assert.equal(
    await readFile(join(abandoned.pending, "1-original-one.bin"), "utf8"),
    "original one",
  );
});
test("failed payload unlink keeps marker; later fresh startup retries, final marker gap remains unknown", async (t) => {
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  assert.equal(run(root, "recover-unlink-fail").failed, 1);
  assert.equal(await exists(join(abandoned.pending, markerName)), true);
  assert.equal(run(root, "recover").removed, 1);
  const gap = run(root, "crash-publish", 88);
  assert.equal(run(root, "recover-marker-gap").failed, 1);
  assert.deepEqual(await readdir(gap.pending), []);
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(await exists(gap.pending), true);
});
test("live exclusive Host lease prevents fresh recovery of a paused upload", async (t) => {
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  const holder = spawn(
    process.execPath,
    ["--experimental-strip-types", child, "hold-lease", root],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  t.after(() => holder.kill());
  await once(holder.stdout!, "data");
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", child, "recover", root],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.notEqual(result.status, 0);
  assert.equal(await exists(abandoned.pending), true);
  const exit = once(holder, "exit");
  holder.kill("SIGTERM");
  await exit;
  assert.equal(run(root, "recover").removed, 1);
});
test("symlinked leaf/parent and substituted pending identity stay untouched", {
  skip:
    process.platform === "win32"
      ? "symlink privilege is environment-dependent"
      : false,
}, async (t) => {
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep"), "outside sentinel");
  const original = join(abandoned.pending, "1-original-one.bin");
  await rm(original);
  await symlink(join(outside, "keep"), original);
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(
    await readFile(join(outside, "keep"), "utf8"),
    "outside sentinel",
  );
  await rm(original);
  await writeFile(original, "changed", { mode: 0o600 });
  const saved = abandoned.pending + "-saved";
  await rename(abandoned.pending, saved);
  await mkdir(abandoned.pending, { mode: 0o700 });
  await writeFile(
    join(abandoned.pending, markerName),
    await readFile(join(saved, markerName)),
    { mode: 0o600 },
  );
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(await exists(abandoned.pending), true);
  await rm(abandoned.pending, { recursive: true });
  await symlink(outside, abandoned.pending);
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(
    await readFile(join(outside, "keep"), "utf8"),
    "outside sentinel",
  );
});

test("startup traversal has a global bound and never enters published batches", async (t) => {
  const root = await fixture(t);
  const published = run(root, "publish");
  const attachments = dirname(dirname(dirname(published.files[0].path)));
  await Promise.all(
    Array.from({ length: 2050 }, (_, index) =>
      writeFile(join(attachments, `unknown-${index}`), "untouched"),
    ),
  );
  const result = run(root, "recover");
  assert.equal(result.incomplete, true);
  assert.ok(result.scannedEntries <= 2048);
  assert.equal(result.removed, 0);
  assert.equal(await readFile(published.files[0].path, "utf8"), "original one");
});

test("startup recovers inside the lease before runtime creation; a recovery error releases the lease", async (t) => {
  const { PiWebRuntime } = await import("../../web/runtime/pi-runtime.ts");
  const { acquireWebHostLease } = await import(
    "../../web/runtime/web-host-lease.ts"
  );
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  const agent = join(root, "agent");
  await mkdir(agent, { mode: 0o700 });
  const sessions = join(agent, "web-sessions");
  await rename(join(root, "sessions"), sessions);
  const movedPending = join(
    sessions,
    ".prompt-files",
    basename(dirname(abandoned.pending)),
    basename(abandoned.pending),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  const runtimeConstructor = PiWebRuntime as unknown as {
    createRuntime: () => Promise<never>;
  };
  const original = runtimeConstructor.createRuntime;
  let calls = 0;
  runtimeConstructor.createRuntime = async () => {
    calls++;
    assert.equal(await exists(movedPending), false);
    throw new Error("after recovery, before services");
  };
  process.env.PI_CODING_AGENT_DIR = agent;
  try {
    await assert.rejects(
      PiWebRuntime.create(root),
      /after recovery, before services/,
    );
    assert.equal(calls, 1);
    let lease = await acquireWebHostLease(sessions);
    await lease.release();
    await rm(join(sessions, ".prompt-files"), { recursive: true });
    await writeFile(join(sessions, ".prompt-files"), "not a directory");
    await assert.rejects(PiWebRuntime.create(root), /could not be verified/);
    assert.equal(
      calls,
      1,
      "invalid recovery root must fail before runtime services",
    );
    lease = await acquireWebHostLease(sessions);
    await lease.release();
  } finally {
    runtimeConstructor.createRuntime = original;
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

test("marker and hashed Session-parent symlinks never grant deletion authority", {
  skip:
    process.platform === "win32"
      ? "symlink privilege is environment-dependent"
      : false,
}, async (t) => {
  const root = await fixture(t);
  const abandoned = run(root, "crash-publish", 88);
  const marker = join(abandoned.pending, markerName);
  const savedMarker = join(root, "saved-marker");
  await rename(marker, savedMarker);
  await symlink(savedMarker, marker);
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(
    await readFile(join(abandoned.pending, "1-original-one.bin"), "utf8"),
    "original one",
  );
  await rm(marker);
  await rename(savedMarker, marker);
  const parent = dirname(abandoned.pending);
  const savedParent = join(root, "saved-parent");
  await rename(parent, savedParent);
  await symlink(savedParent, parent);
  assert.equal(run(root, "recover").removed, 0);
  assert.equal(
    await readFile(
      join(savedParent, basename(abandoned.pending), "1-original-one.bin"),
      "utf8",
    ),
    "original one",
  );
});
