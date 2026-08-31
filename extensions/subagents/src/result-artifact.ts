import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  formatSize,
  truncateHead,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ResultArtifactRef } from "./domain.ts";

/**
 * The cache is optional recovery data. POSIX hosts pin the cache directory
 * through a descriptor-backed path and use no-follow opens. Windows hosts do
 * not expose the required handle-relative/no-follow primitives through Node,
 * so this module deliberately disables filesystem cache operations there.
 * Any uncertainty fails closed and is caught by the settlement layer.
 */

export type { ResultArtifactRef } from "./domain.ts";

const HEAD_SHARE = 0.75;
const RESULT_ARTIFACT_DIR = ["cache", "openpi", "subagent-results"] as const;
const RESULT_ARTIFACT_NAME = /^[a-f0-9]{64}\.txt$/u;
const RESULT_ARTIFACT_DIGEST = /^[a-f0-9]{64}$/u;
const RESULT_CACHE_LOCK_NAME = ".retention-lock";
const RESULT_CACHE_OWNER_PREFIX = `${RESULT_CACHE_LOCK_NAME}.owner.`;
const RESULT_CACHE_RECOVERY_PREFIX = `${RESULT_CACHE_LOCK_NAME}.recovery.`;
const OUTPUT_MIDDLE_MARKER = "[... middle omitted ...]";
const OUTPUT_TRUNCATED_MARKER = "[Output truncated]";
const OUTPUT_NO_ARTIFACT_MARKER = "[full answer could not be saved]";
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const READ_ONLY_NOFOLLOW = fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK;
const DIRECTORY_NOFOLLOW = fsConstants.O_RDONLY | DIRECTORY | NOFOLLOW;
const MAX_LOCK_DOCUMENT_BYTES = 16 * 1024;
const MIN_USEFUL_BODY_BYTES = 18;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 3;
const CACHE_METADATA_STALE_AFTER_MS = 60 * 60 * 1_000;
const RESULT_CACHE_OWNER_NAME =
  /^\.retention-lock\.owner\.\d+\.[0-9a-f-]{36}$/iu;
const RESULT_CACHE_RECOVERY_NAME =
  /^\.retention-lock\.recovery\.[0-9a-f-]{36}$/iu;
const RESULT_ARTIFACT_TEMP_NAME = /^\.[a-f0-9]{64}\.[0-9a-f-]{36}\.tmp$/u;
const SUPPORTED_DESCRIPTOR_PLATFORMS = new Set([
  "linux",
  "darwin",
  "freebsd",
  "openbsd",
  "netbsd",
]);
const UNSUPPORTED_CACHE_PLATFORM_ERROR =
  "Result artifact cache is unavailable because Node cannot provide safe handle-relative no-follow operations";

/** Bounded retention for exact terminal-result recovery artifacts. */
export const MAX_RESULT_ARTIFACT_FILES = 64;
export const MAX_RESULT_ARTIFACT_BYTES = 64 * 1024 * 1024;
/** Model-facing exact-result paging limits. */
export const MAX_RESULT_PAGE_LINES = 200;
export const MAX_RESULT_PAGE_BYTES = 16 * 1024;

export interface ResultArtifactCacheOptions {
  /** Override used by embedding hosts and focused retention tests. */
  readonly maxFiles?: number;
  /** Aggregate UTF-8 payload bytes retained by this cache. */
  readonly maxBytes?: number;
}

export interface ResultProjectionOptions {
  readonly maxBytes: number;
  readonly maxLines: number;
  /** Optional model-facing recovery capability identity, never a filesystem path. */
  readonly recoveryId?: string;
  /** True when an exact artifact is already available to the protected reader. */
  readonly artifactAvailable?: boolean;
  /** The writer's return value is opaque and is never rendered as a path. */
  readonly writeArtifact: (content: string) => unknown;
}

export interface ResultProjection {
  readonly text: string;
  readonly truncated: boolean;
  /** True when an exact recovery artifact was already present or just persisted. */
  readonly artifactPersisted?: boolean;
  /** True when this projection attempted and failed to persist an artifact. */
  readonly artifactSaveFailed?: boolean;
}

interface ResultArtifactLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface CachedArtifact extends FileIdentity {
  readonly name: string;
  readonly size: number;
  readonly modifiedAt: number;
}

interface CacheDirectory extends FileIdentity {
  /** A descriptor-relative path on POSIX, or the checked path elsewhere. */
  readonly operationPath: string;
  readonly fd: number;
}

interface ReadFileResult {
  readonly bytes: Buffer;
}

interface CacheLock {
  readonly claimPath: string;
  readonly lockPath: string;
  readonly owner: LockOwner;
}

interface LockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: number;
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function identityOf(stat: Stats): FileIdentity {
  return { dev: Number(stat.dev), ino: Number(stat.ino) };
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino;
}

function isErrno(error: unknown, code: string) {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function closeQuietly(fd: number) {
  try {
    closeSync(fd);
  } catch {
    // Best-effort cache cleanup must not mask the primary result path.
  }
}

function unlinkQuietly(filePath: string) {
  try {
    unlinkSync(filePath);
  } catch {
    // A crashed or racing cache writer may already have removed it.
  }
}

function digestForBytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestForContent(content: string) {
  return digestForBytes(Buffer.from(content, "utf8"));
}

/** Validate the compact, path-free durable artifact identity. */
export function isResultArtifactRef(
  value: unknown,
): value is ResultArtifactRef {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === 2 &&
    keys.includes("version") &&
    keys.includes("digest") &&
    candidate.version === 1 &&
    typeof candidate.digest === "string" &&
    RESULT_ARTIFACT_DIGEST.test(candidate.digest)
  );
}

export function resultArtifactRefMatchesContent(
  value: unknown,
  content: string,
): value is ResultArtifactRef {
  return (
    isResultArtifactRef(value) && value.digest === digestForContent(content)
  );
}

function assertResultArtifactRef(value: ResultArtifactRef) {
  if (!isResultArtifactRef(value)) {
    throw new Error("Invalid result artifact reference");
  }
}

/** Pure path construction for display only. It never creates directories. */
export function cacheDirectoryPath(agentDir: string) {
  return path.resolve(agentDir, ...RESULT_ARTIFACT_DIR);
}

/** Derive a display path from the validated digest reference. */
export function resultArtifactPath(agentDir: string, ref: ResultArtifactRef) {
  assertResultArtifactRef(ref);
  return path.join(cacheDirectoryPath(agentDir), `${ref.digest}.txt`);
}

function sliceStartToUtf8Bytes(content: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= maxBytes) return content;
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

function assertCachePlatformSupported() {
  if (
    !SUPPORTED_DESCRIPTOR_PLATFORMS.has(process.platform) ||
    NOFOLLOW === 0 ||
    DIRECTORY === 0 ||
    NONBLOCK === 0
  ) {
    throw new Error(UNSUPPORTED_CACHE_PLATFORM_ERROR);
  }
}

function descriptorRelativePath(fd: number, fallback: string) {
  if (process.platform === "linux") return `/proc/self/fd/${fd}`;
  if (
    process.platform === "darwin" ||
    process.platform === "freebsd" ||
    process.platform === "openbsd" ||
    process.platform === "netbsd"
  ) {
    return `/dev/fd/${fd}`;
  }
  return fallback;
}

function openCheckedDirectory(
  parentPath: string,
  parentFd: number,
  name: string,
  create: boolean,
) {
  const childPath = path.join(
    descriptorRelativePath(parentFd, parentPath),
    name,
  );
  if (create) {
    try {
      mkdirSync(childPath, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
  }
  const checked = lstatSync(childPath);
  if (!checked.isDirectory() || checked.isSymbolicLink()) {
    throw new Error(
      `Unsafe result artifact directory: ${path.join(parentPath, name)}`,
    );
  }
  const fd = openSync(childPath, DIRECTORY_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isDirectory() ||
      !sameIdentity(identityOf(checked), identityOf(opened))
    ) {
      throw new Error(
        `Unsafe result artifact directory: ${path.join(parentPath, name)}`,
      );
    }
    return { fd, path: path.join(parentPath, name) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function openCacheDirectory(agentDir: string, create: boolean): CacheDirectory {
  assertCachePlatformSupported();
  const root = path.resolve(agentDir);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe result artifact directory: ${root}`);
  }
  const rootFd = openSync(root, DIRECTORY_NOFOLLOW);
  let currentFd = rootFd;
  let currentPath = root;
  try {
    const openedRoot = fstatSync(currentFd);
    if (
      !openedRoot.isDirectory() ||
      !sameIdentity(identityOf(rootStat), identityOf(openedRoot))
    ) {
      throw new Error(`Unsafe result artifact directory: ${root}`);
    }

    for (const segment of RESULT_ARTIFACT_DIR) {
      const child = openCheckedDirectory(
        currentPath,
        currentFd,
        segment,
        create,
      );
      closeSync(currentFd);
      currentFd = child.fd;
      currentPath = child.path;
    }

    const identity = identityOf(fstatSync(currentFd));
    return {
      operationPath: descriptorRelativePath(currentFd, currentPath),
      fd: currentFd,
      ...identity,
    };
  } catch (error) {
    closeSync(currentFd);
    throw error;
  }
}

function assertDirectoryStable(directory: CacheDirectory) {
  const current = fstatSync(directory.fd);
  if (!current.isDirectory() || !sameIdentity(directory, identityOf(current))) {
    throw new Error(`Result artifact directory changed during operation`);
  }
}

function cacheLimits(
  options: ResultArtifactCacheOptions | undefined,
): ResultArtifactLimits {
  const maxFiles = options?.maxFiles ?? MAX_RESULT_ARTIFACT_FILES;
  const maxBytes = options?.maxBytes ?? MAX_RESULT_ARTIFACT_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0) {
    throw new Error("maxFiles must be a positive safe integer");
  }
  if (maxFiles > MAX_RESULT_ARTIFACT_FILES) {
    throw new Error(
      `maxFiles must not exceed ${MAX_RESULT_ARTIFACT_FILES} files`,
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("maxBytes must be a positive safe integer");
  }
  if (maxBytes > MAX_RESULT_ARTIFACT_BYTES) {
    throw new Error(
      `maxBytes must not exceed ${MAX_RESULT_ARTIFACT_BYTES} bytes`,
    );
  }
  return { maxFiles, maxBytes };
}

function artifactPathIn(directory: CacheDirectory, name: string) {
  return path.join(directory.operationPath, name);
}

function readFixedBytes(fd: number, size: number) {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(fd, bytes, offset, size - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  return offset === size ? bytes : bytes.subarray(0, offset);
}

function readRegularFile(
  filePath: string,
  maxBytes: number,
): ReadFileResult | undefined {
  let before: Stats;
  try {
    before = lstatSync(filePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Unsafe result artifact file: ${filePath}`);
  }

  let fd: number;
  try {
    fd = openSync(filePath, READ_ONLY_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !sameIdentity(identityOf(before), identityOf(opened))
    ) {
      throw new Error(`Result artifact file changed during open: ${filePath}`);
    }
    if (!Number.isSafeInteger(opened.size) || opened.size > maxBytes) {
      throw new Error(`Result artifact exceeds the read limit: ${filePath}`);
    }
    const bytes = readFixedBytes(fd, opened.size);
    const after = fstatSync(fd);
    if (
      !sameIdentity(identityOf(opened), identityOf(after)) ||
      !after.isFile() ||
      after.size !== opened.size ||
      bytes.byteLength !== opened.size
    ) {
      throw new Error(`Result artifact changed during read: ${filePath}`);
    }
    return { bytes };
  } finally {
    closeQuietly(fd);
  }
}

function inspectCachedArtifact(
  directory: CacheDirectory,
  name: string,
): CachedArtifact | undefined {
  const artifactPath = artifactPathIn(directory, name);
  let before: Stats;
  try {
    before = lstatSync(artifactPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  // Symlinks and unknown file types are ignored during enumeration. They are
  // never opened, followed, or selected for deletion.
  if (before.isSymbolicLink() || !before.isFile()) return undefined;

  let fd: number;
  try {
    fd = openSync(artifactPath, READ_ONLY_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return undefined;
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      !sameIdentity(identityOf(before), identityOf(opened))
    ) {
      throw new Error(
        `Unsafe result artifact changed during scan: ${artifactPath}`,
      );
    }
    const identity = identityOf(opened);
    return {
      name,
      size: opened.size,
      modifiedAt: opened.mtimeMs,
      ...identity,
    };
  } finally {
    closeQuietly(fd);
  }
}

function cacheArtifacts(directory: CacheDirectory): CachedArtifact[] {
  assertDirectoryStable(directory);
  const artifacts: CachedArtifact[] = [];
  for (const entry of readdirSync(directory.operationPath, {
    withFileTypes: true,
  })) {
    const name = entry.name;
    if (!RESULT_ARTIFACT_NAME.test(name)) continue;
    const artifact = inspectCachedArtifact(directory, name);
    if (artifact) artifacts.push(artifact);
  }
  assertDirectoryStable(directory);
  return artifacts;
}

function isCacheMetadataName(name: string) {
  return (
    RESULT_ARTIFACT_TEMP_NAME.test(name) ||
    RESULT_CACHE_OWNER_NAME.test(name) ||
    RESULT_CACHE_RECOVERY_NAME.test(name)
  );
}

function cleanStaleCacheMetadata(directory: CacheDirectory) {
  const cutoff = Date.now() - CACHE_METADATA_STALE_AFTER_MS;
  for (const entry of readdirSync(directory.operationPath, {
    withFileTypes: true,
  })) {
    const name = entry.name;
    if (!isCacheMetadataName(name)) continue;
    const metadataPath = artifactPathIn(directory, name);
    let stat: Stats;
    try {
      stat = lstatSync(metadataPath);
    } catch (error) {
      if (isErrno(error, "ENOENT")) continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.mtimeMs > cutoff) {
      continue;
    }
    if (RESULT_CACHE_OWNER_NAME.test(name)) {
      const owner = readLockOwner(directory, name);
      if (owner && !definitelyDead(owner.pid)) continue;
    }
    removeRenamedEntry(directory, metadataPath, identityOf(stat));
  }
}

function parseLockOwner(bytes: Uint8Array): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.version !== 1 ||
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid as number) <= 0 ||
      typeof candidate.token !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(candidate.token) ||
      !Number.isSafeInteger(candidate.createdAt) ||
      (candidate.createdAt as number) <= 0
    ) {
      return undefined;
    }
    return {
      version: 1,
      pid: candidate.pid as number,
      token: candidate.token as string,
      createdAt: candidate.createdAt as number,
    };
  } catch {
    return undefined;
  }
}

function readLockOwner(
  directory: CacheDirectory,
  name: string,
): LockOwner | undefined {
  const result = readRegularFile(
    artifactPathIn(directory, name),
    MAX_LOCK_DOCUMENT_BYTES,
  );
  return result ? parseLockOwner(result.bytes) : undefined;
}

function lockPath(directory: CacheDirectory) {
  return artifactPathIn(directory, RESULT_CACHE_LOCK_NAME);
}

function ownerPath(directory: CacheDirectory, owner: LockOwner) {
  return artifactPathIn(
    directory,
    `${RESULT_CACHE_OWNER_PREFIX}${owner.pid}.${owner.token}`,
  );
}

function sameOwner(left: LockOwner | undefined, right: LockOwner) {
  return (
    left?.version === right.version &&
    left.pid === right.pid &&
    left.token === right.token &&
    left.createdAt === right.createdAt
  );
}

/**
 * PID liveness is deliberately conservative: a reused PID is treated as
 * alive, so automatic recovery may leave a cache unavailable. There is no
 * portable Node API for a process-start identity on every supported POSIX
 * host; operators can remove the lock/owner metadata after confirming the
 * owning process is gone. Never replace this with an age-only timeout.
 */
function definitelyDead(pid: number) {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return isErrno(error, "ESRCH");
  }
}

function removeRenamedEntry(
  directory: CacheDirectory,
  sourcePath: string,
  expected: FileIdentity,
) {
  const quarantinePath = artifactPathIn(
    directory,
    `${RESULT_CACHE_RECOVERY_PREFIX}${randomUUID()}`,
  );
  assertDirectoryStable(directory);
  try {
    // Rename moves the directory entry itself. If a race replaced the source
    // with a symlink, it is moved to quarantine and never dereferenced.
    renameSync(sourcePath, quarantinePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      throw new Error(`Owned cache entry disappeared: ${sourcePath}`);
    }
    throw error;
  }

  const moved = lstatSync(quarantinePath);
  if (
    moved.isSymbolicLink() ||
    !moved.isFile() ||
    !sameIdentity(identityOf(moved), expected)
  ) {
    // Keep an uncertain entry quarantined instead of deleting it. The name is
    // outside the owned-artifact grammar, so later retention will ignore it.
    throw new Error(`Unsafe result artifact cleanup target: ${sourcePath}`);
  }
  unlinkSync(quarantinePath);
  assertDirectoryStable(directory);
}

function abandonRecoveredLock(
  _directory: CacheDirectory,
  _recoveryPath: string,
) {
  // Never relink an untrusted recovery pathname. Leaving it quarantined keeps
  // an uncertain entry out of the published lock name and lets a later owner
  // make progress instead of poisoning the cache with a symlink lock.
}

function reclaimDeadLock(directory: CacheDirectory) {
  const lock = lockPath(directory);
  const owner = readLockOwner(directory, RESULT_CACHE_LOCK_NAME);
  if (!owner || !definitelyDead(owner.pid)) return false;
  const claim = ownerPath(directory, owner);
  const claimOwner = readLockOwner(directory, path.basename(claim));
  if (!sameOwner(claimOwner, owner)) return false;
  let lockStat: Stats;
  let claimStat: Stats;
  try {
    lockStat = lstatSync(lock);
    claimStat = lstatSync(claim);
  } catch {
    return false;
  }
  if (
    lockStat.isSymbolicLink() ||
    claimStat.isSymbolicLink() ||
    !lockStat.isFile() ||
    !claimStat.isFile() ||
    !sameIdentity(identityOf(lockStat), identityOf(claimStat))
  ) {
    return false;
  }

  const recoveryPath = artifactPathIn(
    directory,
    `${RESULT_CACHE_RECOVERY_PREFIX}${randomUUID()}`,
  );
  try {
    renameSync(lock, recoveryPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return true;
    return false;
  }
  try {
    const recovered = lstatSync(recoveryPath);
    const currentClaim = lstatSync(claim);
    const expectedIdentity = identityOf(lockStat);
    const recoveredIdentity = identityOf(recovered);
    const claimIdentity = identityOf(currentClaim);
    if (
      recovered.isSymbolicLink() ||
      currentClaim.isSymbolicLink() ||
      !recovered.isFile() ||
      !currentClaim.isFile() ||
      !sameIdentity(recoveredIdentity, claimIdentity) ||
      !sameIdentity(recoveredIdentity, expectedIdentity)
    ) {
      abandonRecoveredLock(directory, recoveryPath);
      return false;
    }
    unlinkSync(claim);
    unlinkSync(recoveryPath);
    return true;
  } catch {
    abandonRecoveredLock(directory, recoveryPath);
    return false;
  }
}

function acquireCacheLock(directory: CacheDirectory): CacheLock {
  for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const owner: LockOwner = {
      version: 1,
      pid: process.pid,
      token: randomUUID(),
      createdAt: Date.now(),
    };
    const claimPath = ownerPath(directory, owner);
    const lock = lockPath(directory);
    let fd: number | undefined;
    try {
      fd = openSync(
        claimPath,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          NOFOLLOW,
        0o600,
      );
      writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeQuietly(fd);
      unlinkQuietly(claimPath);
      throw error;
    }

    try {
      linkSync(claimPath, lock);
      return { claimPath, lockPath: lock, owner };
    } catch (error) {
      unlinkQuietly(claimPath);
      if (
        isErrno(error, "EEXIST") &&
        attempt + 1 < MAX_LOCK_ACQUIRE_ATTEMPTS &&
        reclaimDeadLock(directory)
      ) {
        continue;
      }
      if (isErrno(error, "EEXIST")) {
        throw new Error(
          "Result artifact cache is busy or has uncertain ownership",
        );
      }
      throw error;
    }
  }
  throw new Error("Result artifact cache lock acquisition was not stable");
}

function releaseCacheLock(directory: CacheDirectory, lock: CacheLock) {
  assertDirectoryStable(directory);
  const lockStat = lstatSync(lock.lockPath);
  const claimStat = lstatSync(lock.claimPath);
  if (
    lockStat.isSymbolicLink() ||
    claimStat.isSymbolicLink() ||
    !lockStat.isFile() ||
    !claimStat.isFile() ||
    !sameIdentity(identityOf(lockStat), identityOf(claimStat))
  ) {
    throw new Error("Refusing to release an uncertain result artifact lock");
  }
  const publishedOwner = readLockOwner(directory, RESULT_CACHE_LOCK_NAME);
  const claimOwner = readLockOwner(directory, path.basename(lock.claimPath));
  if (
    !sameOwner(publishedOwner, lock.owner) ||
    !sameOwner(claimOwner, lock.owner)
  ) {
    throw new Error("Refusing to release an uncertain result artifact lock");
  }

  const releasePath = artifactPathIn(
    directory,
    `${RESULT_CACHE_RECOVERY_PREFIX}${randomUUID()}`,
  );
  // Move the lock entry itself out of the published name before deleting it.
  // If a race replaced the lock path, the moved inode is detected below and
  // left quarantined rather than relinked into a potentially poisoned name.
  renameSync(lock.lockPath, releasePath);
  try {
    const released = lstatSync(releasePath);
    if (
      released.isSymbolicLink() ||
      !released.isFile() ||
      !sameIdentity(identityOf(released), identityOf(lockStat))
    ) {
      throw new Error("Refusing to release an uncertain result artifact lock");
    }
    try {
      unlinkSync(releasePath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    try {
      unlinkSync(lock.claimPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  } finally {
    assertDirectoryStable(directory);
  }
}

function withCacheLock<T>(directory: CacheDirectory, action: () => T) {
  const lock = acquireCacheLock(directory);
  let value!: T;
  let actionSucceeded = false;
  let actionError: unknown;
  try {
    value = action();
    actionSucceeded = true;
  } catch (error) {
    actionError = error;
  }

  try {
    releaseCacheLock(directory, lock);
  } catch {
    // A completed publication remains authoritative even if optional lock
    // metadata cleanup fails. The next writer will fail closed if ownership is
    // uncertain, but a valid reference must not be discarded.
  }
  if (!actionSucceeded) throw actionError;
  return value;
}

function existingArtifactMatches(
  directory: CacheDirectory,
  name: string,
  content: string,
  expectedDigest: string,
) {
  const result = readRegularFile(
    artifactPathIn(directory, name),
    MAX_RESULT_ARTIFACT_BYTES,
  );
  if (!result) return false;
  const actualDigest = digestForBytes(result.bytes);
  if (
    actualDigest !== expectedDigest ||
    result.bytes.toString("utf8") !== content
  ) {
    throw new Error(
      `Result artifact collision: ${artifactPathIn(directory, name)}`,
    );
  }
  return true;
}

function publishResultArtifact(
  directory: CacheDirectory,
  name: string,
  content: string,
  expectedDigest: string,
) {
  const targetPath = artifactPathIn(directory, name);
  const temporaryName = `.${name}.${randomUUID()}.tmp`;
  const temporaryPath = artifactPathIn(directory, temporaryName);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, Buffer.from(content, "utf8"));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;

    // Hard-link publication is atomic and cannot overwrite a competing target.
    try {
      linkSync(temporaryPath, targetPath);
      return true;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      if (!existingArtifactMatches(directory, name, content, expectedDigest)) {
        throw error;
      }
      return false;
    }
  } finally {
    if (fd !== undefined) closeQuietly(fd);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
  }
}

function trimResultArtifactCache(
  directory: CacheDirectory,
  limits: ResultArtifactLimits,
  incomingBytes: number,
  protectedName?: string,
) {
  const artifacts = cacheArtifacts(directory);
  let totalBytes = artifacts.reduce(
    (total, artifact) => total + artifact.size,
    0,
  );
  let count = artifacts.length;
  const candidates = artifacts
    .filter((artifact) => artifact.name !== protectedName)
    .sort(
      (left, right) =>
        left.modifiedAt - right.modifiedAt ||
        left.name.localeCompare(right.name),
    );

  while (
    count + (protectedName ? 0 : 1) > limits.maxFiles ||
    totalBytes + incomingBytes > limits.maxBytes
  ) {
    const candidate = candidates.shift();
    if (!candidate) {
      throw new Error("Result artifact cache limit cannot be satisfied safely");
    }
    removeRenamedEntry(
      directory,
      artifactPathIn(directory, candidate.name),
      candidate,
    );
    count--;
    totalBytes -= candidate.size;
  }
}

function assertCacheWithinLimits(
  directory: CacheDirectory,
  limits: ResultArtifactLimits,
) {
  const artifacts = cacheArtifacts(directory);
  const totalBytes = artifacts.reduce(
    (total, artifact) => total + artifact.size,
    0,
  );
  if (artifacts.length > limits.maxFiles || totalBytes > limits.maxBytes) {
    throw new Error("Result artifact cache limits were exceeded");
  }
}

/**
 * Persist one immutable, content-addressed final answer below Pi's cache.
 * Model-authored titles and paths never participate in the durable identity.
 * Retention and publication are one cache-wide transaction for cooperating
 * OpenPI processes; cache failures remain safe for the caller to ignore.
 */
export function persistResultArtifact(
  agentDir: string,
  content: string,
  options?: ResultArtifactCacheOptions,
): ResultArtifactRef {
  const limits = cacheLimits(options);
  assertCachePlatformSupported();
  const contentBytes = byteLength(content);
  if (contentBytes > limits.maxBytes) {
    throw new Error(
      `Result artifact exceeds the ${limits.maxBytes}-byte cache capacity`,
    );
  }

  const digest = digestForContent(content);
  const ref: ResultArtifactRef = { version: 1, digest };
  const directory = openCacheDirectory(agentDir, true);
  try {
    return withCacheLock(directory, () => {
      cleanStaleCacheMetadata(directory);
      const name = `${digest}.txt`;
      if (existingArtifactMatches(directory, name, content, digest)) {
        trimResultArtifactCache(directory, limits, 0, name);
        assertCacheWithinLimits(directory, limits);
        return ref;
      }

      trimResultArtifactCache(directory, limits, contentBytes);
      publishResultArtifact(directory, name, content, digest);
      if (!existingArtifactMatches(directory, name, content, digest)) {
        throw new Error("Published result artifact disappeared");
      }
      assertCacheWithinLimits(directory, limits);
      return ref;
    });
  } finally {
    closeQuietly(directory.fd);
  }
}

export interface ResultPage {
  readonly text: string;
  readonly offset: number;
  readonly limit: number;
  readonly totalLines: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
}

/**
 * Page an already-resolved exact result by 0-based line offset. This never
 * accepts a filesystem path; callers must supply canonical or artifact text.
 */
/**
 * Resolve the exact settled text for model-facing paging. Artifact bytes win;
 * retained canonical finalText is next. A truncated projection is never used.
 */
export function resolveExactResultText(options: {
  readonly artifactText: string | undefined;
  readonly retainedFinalText: string | undefined;
  readonly resultIsCanonical: boolean;
  readonly finalTextTruncated?: boolean;
  readonly omittedFinalTextBytes: number;
}): string | undefined {
  if (options.artifactText !== undefined) return options.artifactText;
  if (
    !options.finalTextTruncated &&
    (options.resultIsCanonical || options.omittedFinalTextBytes <= 0)
  ) {
    return options.retainedFinalText ?? "";
  }
  return undefined;
}

export function pageResultText(
  content: string,
  options: {
    readonly offset?: number;
    readonly limit?: number;
    readonly maxBytes?: number;
  } = {},
): ResultPage {
  const offset =
    Number.isSafeInteger(options.offset) && (options.offset as number) >= 0
      ? Math.floor(options.offset as number)
      : 0;
  const requested =
    Number.isSafeInteger(options.limit) && (options.limit as number) >= 1
      ? Math.floor(options.limit as number)
      : MAX_RESULT_PAGE_LINES;
  const limit = Math.min(MAX_RESULT_PAGE_LINES, requested);
  const maxBytes =
    Number.isSafeInteger(options.maxBytes) && (options.maxBytes as number) >= 0
      ? Math.floor(options.maxBytes as number)
      : MAX_RESULT_PAGE_BYTES;
  const lines = content.split("\n");
  const totalLines = lines.length;
  if (offset >= totalLines) {
    return {
      text: `No result lines at offset ${offset}.`,
      offset,
      limit,
      totalLines,
      hasMore: false,
      truncated: false,
    };
  }
  const page = lines.slice(offset, offset + limit).join("\n");
  if (byteLength(page) <= maxBytes) {
    return {
      text: page,
      offset,
      limit,
      totalLines,
      hasMore: offset + limit < totalLines,
      truncated: false,
    };
  }
  const suffix = `\n[page truncated at ${maxBytes} bytes; reduce the requested range]`;
  const prefix = truncateHead(page, {
    maxBytes: Math.max(0, maxBytes - byteLength(suffix)),
    maxLines: limit,
  }).content;
  return {
    text: `${prefix}${suffix}`,
    offset,
    limit,
    totalLines,
    hasMore: true,
    truncated: true,
  };
}

/**
 * Read an exact result by reconstructing its path from the trusted cache root
 * and a validated digest reference. The reference itself can never escape the
 * cache directory or point at an arbitrary absolute path.
 */
export function readResultArtifact(agentDir: string, ref: ResultArtifactRef) {
  if (!isResultArtifactRef(ref)) return undefined;
  let directory: CacheDirectory;
  try {
    directory = openCacheDirectory(agentDir, false);
  } catch {
    return undefined;
  }
  try {
    assertDirectoryStable(directory);
    const result = readRegularFile(
      artifactPathIn(directory, `${ref.digest}.txt`),
      MAX_RESULT_ARTIFACT_BYTES,
    );
    assertDirectoryStable(directory);
    if (!result || digestForBytes(result.bytes) !== ref.digest)
      return undefined;
    const content = result.bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(result.bytes)) return undefined;
    return content;
  } catch {
    return undefined;
  } finally {
    closeQuietly(directory.fd);
  }
}

function recoveryInstruction(recoveryId: string | undefined, offset: number) {
  return recoveryId
    ? `Full final answer available via subagent_result(id=${JSON.stringify(recoveryId)}, offset=${offset}, limit=200).`
    : "Full final answer was saved for protected recovery through the owning subagent result reader.";
}

function compactFooter(
  hasArtifact: boolean,
  recoveryId: string | undefined,
  offset: number,
  totalBytes: number,
  totalLines: number,
  shownBytes: number,
) {
  if (hasArtifact) {
    return recoveryInstruction(recoveryId, offset);
  }
  return `Full final answer could not be saved; head and tail only (${formatSize(shownBytes)} of ${formatSize(totalBytes)}; ${totalLines} total lines).`;
}

function verboseFooter(
  hasArtifact: boolean,
  recoveryId: string | undefined,
  offset: number,
  totalBytes: number,
  totalLines: number,
  shownBytes: number,
) {
  const recovery = hasArtifact
    ? recoveryInstruction(recoveryId, offset)
    : "Full final answer could not be saved; only the head and tail above are available.";
  return (
    `[Output truncated: showing ${formatSize(shownBytes)} of ${formatSize(totalBytes)} ` +
    `across the head and tail (${totalLines} total lines).\n${recovery}]`
  );
}

interface FooterCandidate {
  readonly render: (offset: number, shownBytes: number) => string;
  readonly hasArtifact: boolean;
}

interface ProjectionCandidate {
  readonly text: string;
  readonly bodyBudget: number;
  readonly hasArtifact: boolean;
  readonly readableBody: boolean;
}

function firstAndLastLineBytes(content: string) {
  const firstBreak = content.indexOf("\n");
  const first = firstBreak < 0 ? content : content.slice(0, firstBreak);
  const lastBreak = content.lastIndexOf("\n");
  const last = lastBreak < 0 ? content : content.slice(lastBreak + 1);
  return {
    first: byteLength(first),
    last: byteLength(last),
    sameLine: firstBreak < 0,
  };
}

function bodyByteAllocation(content: string, budget: number) {
  if (budget <= 0) return { head: 0, tail: 0 };
  const lines = firstAndLastLineBytes(content);
  if (!lines.sameLine && lines.first + lines.last <= budget) {
    return { head: lines.first, tail: budget - lines.first };
  }
  if (lines.last < budget) {
    return { head: budget - lines.last, tail: lines.last };
  }
  const tail = Math.max(1, Math.floor(budget / 2));
  return { head: budget - tail, tail };
}

function assembleProjection(
  content: string,
  bodyBudget: number,
  maxLines: number,
  marker: string,
  gap: string,
  footer: (offset: number, shownBytes: number) => string,
  hasArtifact: boolean,
): ProjectionCandidate {
  const safeBudget = Math.max(0, Math.floor(bodyBudget));
  if (safeBudget === 0) {
    return {
      text: footer(0, 0),
      bodyBudget: 0,
      hasArtifact,
      readableBody: false,
    };
  }

  const headLines = Math.max(1, Math.floor(maxLines * HEAD_SHARE));
  const tailLines = Math.max(1, maxLines - headLines);
  const allocation = bodyByteAllocation(content, safeBudget);
  const headResult = truncateHead(content, {
    maxBytes: allocation.head,
    maxLines: headLines,
  });
  const tailResult = truncateTail(content, {
    maxBytes: allocation.tail,
    maxLines: tailLines,
  });
  const head =
    headResult.content || sliceStartToUtf8Bytes(content, allocation.head);
  const tail = tailResult.content;
  const shownBytes = byteLength(head) + byteLength(tail);
  const body = `${head}${gap}${marker}${gap}${tail}`;
  const text = `${body}${gap}${footer(
    // 0-based line offset of the first omitted head line, matching
    // subagent_result(id, offset, limit).
    headResult.outputLines,
    shownBytes,
  )}`;
  const lines = firstAndLastLineBytes(content);
  const readableBody =
    safeBudget >= MIN_USEFUL_BODY_BYTES &&
    (lines.sameLine ||
      (byteLength(head) >= lines.first && byteLength(tail) >= lines.last));
  return { text, bodyBudget: safeBudget, hasArtifact, readableBody };
}

function fitProjection(
  content: string,
  maxBytes: number,
  maxLines: number,
  marker: string,
  gap: string,
  footer: (offset: number, shownBytes: number) => string,
  hasArtifact: boolean,
): ProjectionCandidate | undefined {
  let low = 0;
  let high = Math.max(0, Math.floor(maxBytes));
  let best: ProjectionCandidate | undefined;
  for (let attempt = 0; attempt < 20 && low <= high; attempt++) {
    const bodyBudget = Math.floor((low + high) / 2);
    const candidate = assembleProjection(
      content,
      bodyBudget,
      maxLines,
      marker,
      gap,
      footer,
      hasArtifact,
    );
    if (byteLength(candidate.text) <= maxBytes) {
      best = candidate;
      low = bodyBudget + 1;
    } else {
      high = bodyBudget - 1;
    }
  }
  return best;
}

/**
 * Build the single model-visible projection used by automatic delivery and
 * explicit waits. The complete rendered text, including recovery footer, is
 * always bounded by maxBytes.
 */
export function projectResult(
  content: string,
  options: ResultProjectionOptions,
): ResultProjection {
  const maxBytes = Number.isFinite(options.maxBytes)
    ? Math.max(0, Math.floor(options.maxBytes))
    : 0;
  const maxLines = Number.isFinite(options.maxLines)
    ? Math.max(1, Math.floor(options.maxLines))
    : 1;
  const probe = truncateHead(content, {
    maxBytes,
    maxLines,
  });
  if (!probe.truncated) return { text: content, truncated: false };

  let hasArtifact = options.artifactAvailable === true;
  let artifactSaveFailed = false;
  if (!hasArtifact) {
    try {
      const result = options.writeArtifact(content);
      hasArtifact =
        result !== undefined &&
        result !== null &&
        result !== false &&
        result !== "";
    } catch {
      // Delivery is more important than the optional recovery cache.
      artifactSaveFailed = true;
    }
  }
  const recoveryId =
    typeof options.recoveryId === "string" && options.recoveryId.length > 0
      ? options.recoveryId
      : undefined;
  const persistence = hasArtifact
    ? { artifactPersisted: true as const }
    : artifactSaveFailed
      ? { artifactSaveFailed: true as const }
      : {};

  const footerFactories: FooterCandidate[] = [
    ...(hasArtifact
      ? [
          {
            hasArtifact: true,
            render: (offset: number, shownBytes: number) =>
              verboseFooter(
                true,
                recoveryId,
                offset,
                probe.totalBytes,
                probe.totalLines,
                shownBytes,
              ),
          },
          {
            hasArtifact: true,
            render: (offset: number, shownBytes: number) =>
              compactFooter(
                true,
                recoveryId,
                offset,
                probe.totalBytes,
                probe.totalLines,
                shownBytes,
              ),
          },
        ]
      : []),
    {
      hasArtifact: false,
      render: (offset: number, shownBytes: number) =>
        compactFooter(
          false,
          undefined,
          offset,
          probe.totalBytes,
          probe.totalLines,
          shownBytes,
        ),
    },
    {
      hasArtifact: false,
      render: () => OUTPUT_NO_ARTIFACT_MARKER,
    },
    {
      hasArtifact: false,
      render: () => OUTPUT_TRUNCATED_MARKER,
    },
  ];

  const bodyVariants = [
    { marker: OUTPUT_MIDDLE_MARKER, gap: "\n\n" },
    { marker: OUTPUT_MIDDLE_MARKER, gap: "\n" },
    { marker: "[...]", gap: "\n" },
    { marker: "...", gap: "\n" },
  ];
  const candidates: ProjectionCandidate[] = [];
  for (const footer of footerFactories) {
    for (const variant of bodyVariants) {
      const fitted = fitProjection(
        content,
        maxBytes,
        maxLines,
        variant.marker,
        variant.gap,
        footer.render,
        footer.hasArtifact,
      );
      if (fitted) candidates.push(fitted);
    }
  }

  const artifactCandidates = candidates.filter(
    (candidate) => candidate.hasArtifact && candidate.readableBody,
  );
  const nonArtifactCandidates = candidates.filter(
    (candidate) => !candidate.hasArtifact,
  );
  const preferredArtifactCandidates = artifactCandidates.filter((candidate) =>
    candidate.text.includes(OUTPUT_MIDDLE_MARKER),
  );
  const selected =
    (preferredArtifactCandidates.length > 0
      ? preferredArtifactCandidates
      : artifactCandidates
    ).sort((left, right) => right.bodyBudget - left.bodyBudget)[0] ??
    nonArtifactCandidates.sort(
      (left, right) =>
        Number(right.text.includes(OUTPUT_MIDDLE_MARKER)) -
          Number(left.text.includes(OUTPUT_MIDDLE_MARKER)) ||
        right.bodyBudget - left.bodyBudget,
    )[0];
  if (selected && byteLength(selected.text) <= maxBytes) {
    return {
      text: selected.text,
      truncated: true,
      ...persistence,
    };
  }

  // maxBytes can be smaller than every human-readable marker. Keep the hard
  // contract as the final invariant, even for pathological test/config caps.
  return {
    text: sliceStartToUtf8Bytes(OUTPUT_TRUNCATED_MARKER, maxBytes),
    truncated: true,
    ...persistence,
  };
}
