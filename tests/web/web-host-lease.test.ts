import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireWebHostLease,
  WEB_HOST_LEASE_ARTIFACT_DIRECTORY,
  WEB_HOST_LEASE_DIRECTORY,
  WEB_HOST_MAX_LEASE_ARTIFACTS,
  WEB_HOST_MAX_STALE_TOMBSTONES,
  WEB_HOST_LEASE_OWNER_FILE,
} from "../../web/runtime/web-host-lease.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "openpi-web-host-lease-"));
  const sessionDirectory = join(root, "web-sessions");
  return {
    root,
    sessionDirectory,
    artifactDirectory: join(
      sessionDirectory,
      WEB_HOST_LEASE_ARTIFACT_DIRECTORY,
    ),
    lockDirectory: join(sessionDirectory, WEB_HOST_LEASE_DIRECTORY),
    ownerFile: join(
      sessionDirectory,
      WEB_HOST_LEASE_DIRECTORY,
      WEB_HOST_LEASE_OWNER_FILE,
    ),
  };
}

async function exitedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  assert.ok(child.pid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  return child.pid;
}

function staleProcessIdentity() {
  if (process.platform === "linux") {
    return "linux:11111111-1111-4111-8111-111111111111:0";
  }
  if (process.platform === "win32") return "win32:0";
  return `${process.platform}:boot=fixture-boot;start=fixture-start`;
}

function owner(
  pid: number,
  nonce = "00000000-0000-4000-8000-000000000000",
  processStartedAt = staleProcessIdentity(),
) {
  return JSON.stringify({
    version: 1,
    pid,
    nonce,
    processStartedAt,
    createdAt: Date.now(),
  });
}

function nonce(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function createArtifacts(
  artifactDirectory: string,
  kind: "candidate" | "released" | "stale",
  count: number,
) {
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  await Promise.all(
    Array.from({ length: count }, (_, index) =>
      mkdir(join(artifactDirectory, `${kind}-${nonce(index)}`), {
        mode: 0o700,
      }),
    ),
  );
}

test("a live Web Host owner excludes a second process", async () => {
  const paths = await fixture();
  try {
    const lease = await acquireWebHostLease(paths.sessionDirectory);
    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /already owned by live PID/,
    );
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("release is idempotent and permits reacquisition", async () => {
  const paths = await fixture();
  try {
    const first = await acquireWebHostLease(paths.sessionDirectory);
    await first.release();
    await first.release();
    const second = await acquireWebHostLease(paths.sessionDirectory);
    await second.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an interrupted candidate publication cannot block acquisition", async () => {
  const paths = await fixture();
  try {
    const candidate = join(paths.artifactDirectory, `candidate-${nonce(700)}`);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    await writeFile(join(candidate, WEB_HOST_LEASE_OWNER_FILE), "partial", {
      mode: 0o600,
    });

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const published = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    assert.equal(published.pid, process.pid);
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an interrupted recovery candidate cannot block stale recovery", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.ownerFile, owner(await exitedPid()), { mode: 0o600 });
    const candidate = join(paths.artifactDirectory, `candidate-${nonce(701)}`);
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    await writeFile(join(candidate, WEB_HOST_LEASE_OWNER_FILE), "partial", {
      mode: 0o600,
    });

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const recovered = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    assert.equal(recovered.pid, process.pid);
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an empty canonical directory fails closed", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });

    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /ownership metadata is invalid/,
    );
    await assert.rejects(readFile(paths.ownerFile, "utf8"), /ENOENT/);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("concurrent acquisition publishes exactly one owner", async () => {
  const paths = await fixture();
  try {
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        acquireWebHostLease(paths.sessionDirectory),
      ),
    );
    const acquired = results.filter((result) => result.status === "fulfilled");
    assert.equal(acquired.length, 1);
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      7,
    );
    if (acquired[0].status === "fulfilled") await acquired[0].value.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an interrupted release cleanup cannot block acquisition", async () => {
  const paths = await fixture();
  try {
    const staleRelease = join(
      paths.artifactDirectory,
      `released-${nonce(702)}`,
    );
    await mkdir(staleRelease, { recursive: true, mode: 0o700 });
    await writeFile(
      join(staleRelease, WEB_HOST_LEASE_OWNER_FILE),
      `${owner(await exitedPid())}\n`,
      {
        mode: 0o600,
      },
    );

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const published = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    assert.equal(published.pid, process.pid);
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a lease from a dead owner PID is recovered", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.ownerFile, owner(await exitedPid()), { mode: 0o600 });

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const recovered = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    assert.equal(recovered.pid, process.pid);
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("16 rounds of concurrent stale recovery elect exactly one owner", async () => {
  const paths = await fixture();
  try {
    const deadPid = await exitedPid();
    await mkdir(paths.sessionDirectory, { mode: 0o700 });
    for (let round = 0; round < 16; round += 1) {
      const observedNonce = nonce(round);
      await mkdir(paths.lockDirectory, { mode: 0o700 });
      await writeFile(paths.ownerFile, owner(deadPid, observedNonce), {
        mode: 0o600,
      });

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          acquireWebHostLease(paths.sessionDirectory),
        ),
      );
      const acquired = results.filter(
        (result) => result.status === "fulfilled",
      );
      assert.equal(acquired.length, 1, `round ${round}`);
      assert.equal(
        results.filter((result) => result.status === "rejected").length,
        7,
        `round ${round}`,
      );
      const canonical = JSON.parse(await readFile(paths.ownerFile, "utf8"));
      assert.equal(canonical.pid, process.pid, `round ${round}`);
      const tombstoneOwner = JSON.parse(
        await readFile(
          join(
            paths.artifactDirectory,
            `stale-${observedNonce}`,
            WEB_HOST_LEASE_OWNER_FILE,
          ),
          "utf8",
        ),
      );
      assert.equal(tombstoneOwner.nonce, observedNonce, `round ${round}`);
      if (acquired[0].status === "fulfilled") await acquired[0].value.release();
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("stale recovery reaches but never exceeds its tombstone limit", async () => {
  const paths = await fixture();
  try {
    await createArtifacts(
      paths.artifactDirectory,
      "stale",
      WEB_HOST_MAX_STALE_TOMBSTONES - 1,
    );
    const deadPid = await exitedPid();
    await mkdir(paths.lockDirectory, { mode: 0o700 });
    await writeFile(
      paths.ownerFile,
      owner(deadPid, nonce(WEB_HOST_MAX_STALE_TOMBSTONES)),
      { mode: 0o600 },
    );

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    await lease.release();
    assert.equal(
      (await readdir(paths.artifactDirectory)).filter((name) =>
        name.startsWith("stale-"),
      ).length,
      WEB_HOST_MAX_STALE_TOMBSTONES,
    );

    await mkdir(paths.lockDirectory, { mode: 0o700 });
    await writeFile(
      paths.ownerFile,
      owner(deadPid, nonce(WEB_HOST_MAX_STALE_TOMBSTONES + 1)),
      { mode: 0o600 },
    );
    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /stale recovery is blocked.*remove obsolete.*manually/,
    );
    assert.equal(
      (await readdir(paths.artifactDirectory)).filter((name) =>
        name.startsWith("stale-"),
      ).length,
      WEB_HOST_MAX_STALE_TOMBSTONES,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("orphaned lease artifacts stop acquisition at a hard limit", async () => {
  const paths = await fixture();
  try {
    await createArtifacts(
      paths.artifactDirectory,
      "candidate",
      WEB_HOST_MAX_LEASE_ARTIFACTS,
    );

    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /acquisition is blocked.*remove obsolete.*manually/,
    );
    await assert.rejects(readFile(paths.ownerFile, "utf8"), /ENOENT/);
    assert.equal(
      (await readdir(paths.artifactDirectory)).length,
      WEB_HOST_MAX_LEASE_ARTIFACTS,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("normal Session files do not consume the lease artifact scan budget", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.sessionDirectory, { mode: 0o700 });
    for (let offset = 0; offset < 4_100; offset += 128) {
      await Promise.all(
        Array.from({ length: Math.min(128, 4_100 - offset) }, (_, index) =>
          writeFile(
            join(paths.sessionDirectory, `session-${offset + index}.json`),
            "{}",
          ),
        ),
      );
    }
    await createArtifacts(paths.artifactDirectory, "candidate", 1);

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    assert.equal(
      JSON.parse(await readFile(paths.ownerFile, "utf8")).pid,
      process.pid,
    );
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("published process identity includes the current OS boot identity", async () => {
  const paths = await fixture();
  try {
    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const published = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    if (process.platform === "linux") {
      assert.match(published.processStartedAt, /^linux:[0-9a-f-]{36}:\d+$/i);
    } else if (process.platform === "win32") {
      assert.match(published.processStartedAt, /^win32:\d+$/);
    } else {
      assert.match(
        published.processStartedAt,
        new RegExp(`^${process.platform}:boot=.+;start=.+$`),
      );
    }
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a reused live PID does not preserve a stale owner identity", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.ownerFile, owner(process.pid), { mode: 0o600 });

    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const recovered = JSON.parse(await readFile(paths.ownerFile, "utf8"));
    assert.equal(recovered.pid, process.pid);
    assert.notEqual(recovered.processStartedAt, staleProcessIdentity());
    await lease.release();
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("an unparseable process identity fails closed", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });
    const malformed = owner(
      process.pid,
      "11111111-1111-4111-8111-111111111111",
      `${process.platform}:missing-boot-identity`,
    );
    await writeFile(paths.ownerFile, malformed, { mode: 0o600 });

    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /ownership metadata is invalid/,
    );
    assert.equal(await readFile(paths.ownerFile, "utf8"), malformed);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("malformed ownership fails closed", async () => {
  const paths = await fixture();
  try {
    await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.ownerFile, "not-json", { mode: 0o600 });

    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /ownership metadata is invalid/,
    );
    assert.equal(await readFile(paths.ownerFile, "utf8"), "not-json");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("release never removes another owner identity", async () => {
  const paths = await fixture();
  try {
    const lease = await acquireWebHostLease(paths.sessionDirectory);
    const replacement = owner(
      process.pid,
      "11111111-1111-4111-8111-111111111111",
    );
    await writeFile(paths.ownerFile, replacement, { mode: 0o600 });

    await assert.rejects(lease.release(), /ownership changed before release/);
    assert.equal(await readFile(paths.ownerFile, "utf8"), replacement);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("a symlinked lease directory fails closed", async (context) => {
  if (process.platform === "win32") {
    context.skip("creating directory symlinks may require Windows privileges");
    return;
  }
  const paths = await fixture();
  try {
    const target = join(paths.root, "foreign");
    await mkdir(paths.sessionDirectory, { recursive: true });
    await mkdir(target);
    await symlink(target, paths.lockDirectory, "dir");

    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /lease path is not a private directory/,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("unsafe ownership permissions fail closed", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows does not expose POSIX ownership mode bits");
    return;
  }
  const paths = await fixture();
  try {
    await acquireWebHostLease(paths.sessionDirectory);
    await chmod(paths.ownerFile, 0o644);

    await assert.rejects(
      acquireWebHostLease(paths.sessionDirectory),
      /ownership metadata permissions are unsafe/,
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});
