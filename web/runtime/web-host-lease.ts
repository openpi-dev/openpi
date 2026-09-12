import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export const WEB_HOST_LEASE_DIRECTORY = ".openpi-web-host.lock";
export const WEB_HOST_LEASE_OWNER_FILE = "owner.json";
export const WEB_HOST_LEASE_ARTIFACT_DIRECTORY =
  ".openpi-web-host.artifacts";
export const WEB_HOST_MAX_STALE_TOMBSTONES = 64;
export const WEB_HOST_MAX_LEASE_ARTIFACTS = 128;

const NONCE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OwnerIdentity = {
  version: 1;
  pid: number;
  nonce: string;
  processStartedAt: string;
  createdAt: number;
};

const execFileAsync = promisify(execFile);
let currentProcessIdentity: Promise<string> | undefined;

function errorCode(error: unknown) {
  return error instanceof Error && "code" in error
    ? String(error.code)
    : undefined;
}

function invalidMetadata(path: string, cause?: unknown): never {
  throw new Error(`Web Host ownership metadata is invalid at ${path}`, {
    cause,
  });
}

function validProcessIdentity(value: string) {
  if (/^linux:[0-9a-f-]{36}:\d+$/i.test(value)) {
    return NONCE_PATTERN.test(value.slice(6, 42));
  }
  if (/^win32:\d+$/.test(value)) return true;
  const prefix = `${process.platform}:boot=`;
  if (!value.startsWith(prefix)) return false;
  const separator = value.indexOf(";start=", prefix.length);
  if (separator < 0) return false;
  const bootedAt = value.slice(prefix.length, separator);
  const startedAt = value.slice(separator + 7);
  return (
    bootedAt.length > 0 &&
    bootedAt.length <= 128 &&
    startedAt.length > 0 &&
    startedAt.length <= 128 &&
    !/[\r\n;]/.test(bootedAt) &&
    !/[\r\n;]/.test(startedAt)
  );
}

function parseOwner(text: string, path: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    invalidMetadata(path, error);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("pid" in value) ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) <= 0 ||
    !("nonce" in value) ||
    typeof value.nonce !== "string" ||
    !NONCE_PATTERN.test(value.nonce) ||
    !("processStartedAt" in value) ||
    typeof value.processStartedAt !== "string" ||
    !validProcessIdentity(value.processStartedAt) ||
    !("createdAt" in value) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) <= 0
  ) {
    invalidMetadata(path);
  }
  return value as OwnerIdentity;
}

function sameOwner(left: OwnerIdentity, right: OwnerIdentity) {
  return (
    left.pid === right.pid &&
    left.nonce === right.nonce &&
    left.processStartedAt === right.processStartedAt
  );
}

async function validateDirectory(path: string, privateDirectory: boolean) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw new Error(`Cannot inspect Web Host lease path at ${path}`, {
      cause: error,
    });
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Web Host lease path is not a private directory: ${path}`);
  }
  if (
    privateDirectory &&
    process.platform !== "win32" &&
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`Web Host lease directory permissions are unsafe: ${path}`);
  }
}

async function readOwner(path: string) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    invalidMetadata(path, error);
  }
  if (before.isSymbolicLink() || !before.isFile()) invalidMetadata(path);
  if (process.platform !== "win32" && (before.mode & 0o077) !== 0) {
    throw new Error(`Web Host ownership metadata permissions are unsafe: ${path}`);
  }
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      invalidMetadata(path);
    }
    return parseOwner(await handle.readFile("utf8"), path);
  } catch (error) {
    invalidMetadata(path, error);
  } finally {
    await handle?.close();
  }
}

async function writeOwner(path: string, owner: OwnerIdentity) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === "ESRCH") return false;
    throw new Error(`Cannot safely determine whether Web Host PID ${pid} is alive`, {
      cause: error,
    });
  }
}

async function readProcessIdentity(pid: number) {
  if (process.platform === "linux") {
    const [stat, bootIdText] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = fields[19];
    const bootId = bootIdText.trim();
    if (!startTicks || !/^\d+$/.test(startTicks)) {
      throw new Error(`Cannot parse Linux start identity for Web Host PID ${pid}`);
    }
    if (!NONCE_PATTERN.test(bootId)) {
      throw new Error("Cannot parse Linux boot identity for Web Host ownership");
    }
    return `linux:${bootId}:${startTicks}`;
  }
  if (process.platform === "win32") {
    const script = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true },
    );
    const ticks = stdout.trim();
    if (!/^\d+$/.test(ticks)) {
      throw new Error(`Cannot parse Windows start identity for Web Host PID ${pid}`);
    }
    return `win32:${ticks}`;
  }
  const environment = { ...process.env, LC_ALL: "C" };
  const [{ stdout: bootOutput }, { stdout: startOutput }] = await Promise.all([
    execFileAsync("/usr/sbin/sysctl", ["-n", "kern.boottime"], {
      env: environment,
    }),
    execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: environment,
    }),
  ]);
  const bootedAt = bootOutput.trim().replace(/\s+/g, " ");
  const startedAt = startOutput.trim().replace(/\s+/g, " ");
  if (!bootedAt || bootedAt.length > 256) {
    throw new Error("Cannot parse POSIX boot identity for Web Host ownership");
  }
  if (!startedAt) {
    throw new Error(`Cannot read process start identity for Web Host PID ${pid}`);
  }
  return `${process.platform}:boot=${bootedAt};start=${startedAt}`;
}

async function ownerIsAlive(owner: OwnerIdentity) {
  if (!processExists(owner.pid)) return false;
  try {
    const identity = owner.pid === process.pid
      ? await getCurrentProcessIdentity()
      : await readProcessIdentity(owner.pid);
    return identity === owner.processStartedAt;
  } catch (error) {
    if (!processExists(owner.pid)) return false;
    throw new Error(
      `Cannot safely verify the start identity of Web Host PID ${owner.pid}`,
      { cause: error },
    );
  }
}

function getCurrentProcessIdentity() {
  currentProcessIdentity ??= readProcessIdentity(process.pid);
  return currentProcessIdentity;
}

async function pathExists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function artifactKind(name: string) {
  for (const kind of ["stale", "candidate", "released"] as const) {
    const prefix = `${kind}-`;
    if (name.startsWith(prefix) && NONCE_PATTERN.test(name.slice(prefix.length))) {
      return kind;
    }
  }
  return undefined;
}

async function inspectLeaseArtifacts(artifactDirectory: string) {
  let stale = 0;
  let total = 0;
  const directory = await opendir(artifactDirectory);
  for await (const entry of directory) {
    const kind = artifactKind(entry.name);
    total += 1;
    if (kind === "stale") stale += 1;
    if (total >= WEB_HOST_MAX_LEASE_ARTIFACTS) break;
  }
  return { stale, total };
}

async function prepareArtifactDirectory(sessionDirectory: string) {
  const artifactDirectory = join(
    sessionDirectory,
    WEB_HOST_LEASE_ARTIFACT_DIRECTORY,
  );
  try {
    await mkdir(artifactDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await validateDirectory(artifactDirectory, true);
  return artifactDirectory;
}

function assertArtifactCapacity(total: number) {
  if (total < WEB_HOST_MAX_LEASE_ARTIFACTS) return;
  throw new Error(
    `Web Host lease acquisition is blocked because ${WEB_HOST_MAX_LEASE_ARTIFACTS} package-owned safety artifacts are retained; verify ownership and remove obsolete candidate-*, released-*, or stale-* entries from ${WEB_HOST_LEASE_ARTIFACT_DIRECTORY} manually`,
  );
}

function assertStaleCapacity(stale: number) {
  if (stale < WEB_HOST_MAX_STALE_TOMBSTONES) return;
  throw new Error(
    `Web Host stale recovery is blocked because ${WEB_HOST_MAX_STALE_TOMBSTONES} safety tombstones are retained; verify no Web Host depends on them and remove obsolete stale-* entries from ${WEB_HOST_LEASE_ARTIFACT_DIRECTORY} manually`,
  );
}

async function unlinkOwned(path: string, expected: OwnerIdentity) {
  const current = await readOwner(path);
  if (!sameOwner(current, expected)) {
    throw new Error(`Web Host ownership changed before release: ${path}`);
  }
  await unlink(path);
}

async function cleanupOwnedDirectory(
  directory: string,
  expected: OwnerIdentity,
) {
  const ownerPath = join(directory, WEB_HOST_LEASE_OWNER_FILE);
  const current = await readOwner(ownerPath);
  if (!sameOwner(current, expected)) {
    throw new Error(`Web Host ownership changed before release: ${ownerPath}`);
  }
  await unlinkOwned(ownerPath, expected);
  await rmdir(directory);
}

async function moveOwnedDirectory(
  source: string,
  destination: string,
  expected: OwnerIdentity,
) {
  const current = await readOwner(join(source, WEB_HOST_LEASE_OWNER_FILE));
  if (!sameOwner(current, expected)) {
    throw new Error(`Web Host ownership changed before release: ${source}`);
  }
  await rename(source, destination);
  const moved = await readOwner(join(destination, WEB_HOST_LEASE_OWNER_FILE));
  if (!sameOwner(moved, expected)) {
    throw new Error(`Web Host ownership changed while moving ${source}`);
  }
}

async function tryPublish(candidate: string, lockDirectory: string) {
  if (await pathExists(lockDirectory)) return false;
  try {
    await rename(candidate, lockDirectory);
    return true;
  } catch (error) {
    if (await pathExists(lockDirectory)) return false;
    throw error;
  }
}

async function cleanupCandidate(candidate: string, owner: OwnerIdentity) {
  if (!(await pathExists(candidate))) return;
  try {
    await cleanupOwnedDirectory(candidate, owner);
  } catch {
    // Candidate directories are never authoritative. A nonce-scoped orphan is
    // inert and cannot block canonical publication.
  }
}

class DirectoryWebHostLease {
  private readonly artifactDirectory: string;
  private cleanupDirectory: string | undefined;
  private released = false;
  private readonly lockDirectory: string;
  private readonly owner: OwnerIdentity;

  constructor(
    lockDirectory: string,
    artifactDirectory: string,
    owner: OwnerIdentity,
  ) {
    this.lockDirectory = lockDirectory;
    this.artifactDirectory = artifactDirectory;
    this.owner = owner;
  }

  async release() {
    if (!this.released) {
      const releaseDirectory = join(
        this.artifactDirectory,
        `released-${this.owner.nonce}`,
      );
      await moveOwnedDirectory(
        this.lockDirectory,
        releaseDirectory,
        this.owner,
      );
      this.released = true;
      this.cleanupDirectory = releaseDirectory;
    }
    if (!this.cleanupDirectory) return;
    await cleanupOwnedDirectory(this.cleanupDirectory, this.owner);
    this.cleanupDirectory = undefined;
  }
}

async function recoverStaleOwner(
  artifactDirectory: string,
  lockDirectory: string,
  candidate: string,
  observed: OwnerIdentity,
  owner: OwnerIdentity,
) {
  const ownerPath = join(lockDirectory, WEB_HOST_LEASE_OWNER_FILE);
  const current = await readOwner(ownerPath);
  if (!sameOwner(current, observed)) {
    throw new Error("Web Host ownership changed during stale recovery");
  }
  if (await ownerIsAlive(current)) {
    throw new Error(`Web Host runtime is already owned by live PID ${current.pid}`);
  }
  const artifacts = await inspectLeaseArtifacts(artifactDirectory);
  assertArtifactCapacity(artifacts.total);
  assertStaleCapacity(artifacts.stale);
  const staleDirectory = join(
    artifactDirectory,
    `stale-${observed.nonce}`,
  );
  if (await pathExists(staleDirectory)) {
    throw new Error("Web Host lease recovery lost a concurrent ownership race");
  }
  await moveOwnedDirectory(lockDirectory, staleDirectory, observed);
  if (!(await tryPublish(candidate, lockDirectory))) {
    throw new Error("Web Host lease recovery lost a concurrent ownership race");
  }
  return new DirectoryWebHostLease(lockDirectory, artifactDirectory, owner);
}

export async function acquireWebHostLease(sessionDirectory: string) {
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  await validateDirectory(sessionDirectory, false);
  const artifactDirectory = await prepareArtifactDirectory(sessionDirectory);
  const artifacts = await inspectLeaseArtifacts(artifactDirectory);
  assertArtifactCapacity(artifacts.total);
  const lockDirectory = join(sessionDirectory, WEB_HOST_LEASE_DIRECTORY);
  const owner: OwnerIdentity = {
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
    processStartedAt: await getCurrentProcessIdentity(),
    createdAt: Date.now(),
  };
  const candidate = join(
    artifactDirectory,
    `candidate-${owner.nonce}`,
  );
  await mkdir(candidate, { mode: 0o700 });
  await writeOwner(join(candidate, WEB_HOST_LEASE_OWNER_FILE), owner);
  try {
    if (!(await pathExists(lockDirectory))) {
      if (await tryPublish(candidate, lockDirectory)) {
        return new DirectoryWebHostLease(
          lockDirectory,
          artifactDirectory,
          owner,
        );
      }
    }
    await validateDirectory(lockDirectory, true);
    const ownerPath = join(lockDirectory, WEB_HOST_LEASE_OWNER_FILE);
    const observed = await readOwner(ownerPath);
    if (await ownerIsAlive(observed)) {
      throw new Error(
        `Web Host runtime is already owned by live PID ${observed.pid}`,
      );
    }
    return await recoverStaleOwner(
      artifactDirectory,
      lockDirectory,
      candidate,
      observed,
      owner,
    );
  } finally {
    await cleanupCandidate(candidate, owner);
  }
}

export type WebHostLease = Awaited<ReturnType<typeof acquireWebHostLease>>;
