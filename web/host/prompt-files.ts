import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import {
  WEB_PROMPT_FILE_MAX_BYTES,
  WEB_PROMPT_FILE_MAX_COUNT,
  WEB_PROMPT_FILE_MAX_TEXT_BYTES,
  WEB_PROMPT_FILE_MAX_TOTAL_BYTES,
  type WebPromptFileReceipt,
} from "../protocol/prompt-files.ts";
import type { WebRuntimeController } from "../runtime/types.ts";

// JSON may escape every extracted-text byte as six characters. File bytes are
// base64; the decoded limits below remain authoritative.
export const WEB_PROMPT_FILES_BODY_BYTES =
  Math.ceil(WEB_PROMPT_FILE_MAX_TOTAL_BYTES / 3) * 4 +
  WEB_PROMPT_FILE_MAX_COUNT * WEB_PROMPT_FILE_MAX_TEXT_BYTES * 6 +
  64 * 1024;

export class PromptFileError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(
    code: string,
    statusCode: number,
    message: string,
  ) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "PromptFileError";
  }
}

function invalid(message: string, statusCode = 400) {
  return new PromptFileError("INVALID_PROMPT_FILES", statusCode, message);
}

function denied() {
  return new PromptFileError("PROMPT_FILES_DENIED", 403, "The private Session attachment directory could not be verified.");
}

function conflict() {
  return new PromptFileError("SESSION_CONFLICT", 409, "The active Session changed. Keep the attachments and try again in their original Session.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parsePromptFiles(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > WEB_PROMPT_FILE_MAX_COUNT)
    throw invalid(`Choose between 1 and ${WEB_PROMPT_FILE_MAX_COUNT} files.`);
  let totalBytes = 0;
  return value.map((item) => {
    if (!isRecord(item) || Object.keys(item).some((key) => !["name", "data", "mimeType", "text"].includes(key)) ||
      typeof item.name !== "string" || !item.name || item.name.length > 255 || /[\u0000-\u001f\u007f/\\]/u.test(item.name) ||
      typeof item.data !== "string" ||
      (item.mimeType !== undefined && (typeof item.mimeType !== "string" || item.mimeType.length > 255 || /[\u0000-\u001f\u007f]/u.test(item.mimeType))) ||
      (item.text !== undefined && typeof item.text !== "string"))
      throw invalid("File attachment metadata is invalid.");
    if (item.data.length > Math.ceil(WEB_PROMPT_FILE_MAX_BYTES / 3) * 4)
      throw invalid("A file exceeds the 50 MiB attachment limit.", 413);
    const bytes = Buffer.from(item.data, "base64");
    if (bytes.toString("base64") !== item.data)
      throw invalid("File attachment bytes must use canonical base64.");
    totalBytes += bytes.length;
    if (bytes.length > WEB_PROMPT_FILE_MAX_BYTES || totalBytes > WEB_PROMPT_FILE_MAX_TOTAL_BYTES)
      throw invalid("File attachments exceed the 50 MiB total limit.", 413);
    const text = typeof item.text === "string" ? Buffer.from(item.text, "utf8") : undefined;
    if (text && text.length > WEB_PROMPT_FILE_MAX_TEXT_BYTES)
      throw invalid("Extracted document text exceeds the 1 MiB limit.", 413);
    return { name: item.name, bytes, text };
  });
}

function digest(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileName(name: string, index: number) {
  const safe = name.replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/u, "");
  const extension = extname(safe);
  const suffix = Buffer.byteLength(extension, "utf8") <= 32 ? extension : "";
  const stem = suffix ? safe.slice(0, -suffix.length) : safe;
  let bounded = "";
  for (const character of stem) {
    if (Buffer.byteLength(bounded + character + suffix, "utf8") > 180) break;
    bounded += character;
  }
  return `${index + 1}-original-${bounded || "file"}${suffix}`;
}

function sameFile(before: import("node:fs").BigIntStats, after: import("node:fs").BigIntStats) {
  return before.dev === after.dev && before.ino === after.ino;
}

async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (!isRecord(error) || error.code !== "EEXIST") throw error;
  });
  const info = await lstat(path, { bigint: true });
  // Match the native Web runtime lease: POSIX permission bits are enforced;
  // Windows uses its inherited filesystem ACLs rather than synthetic mode bits.
  if (!info.isDirectory() || info.isSymbolicLink() ||
    (process.platform !== "win32" && (info.mode & 0o077n) !== 0n))
    throw denied();
  return info;
}

async function verifyFile(path: string, expected: Buffer) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw denied();
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || !sameFile(before, info) || info.size !== BigInt(expected.length) ||
      (process.platform !== "win32" && (info.mode & 0o077n) !== 0n) ||
      !(await file.readFile()).equals(expected) ||
      !sameFile(info, await lstat(path, { bigint: true }))) throw denied();
  } finally { await file.close(); }
}

async function writePrivateFile(path: string, bytes: Buffer) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

const PENDING_PREFIX = ".pending-v1-";
const PENDING_MARKER = ".openpi-pending.json";
const PENDING_NAME = /^\.pending-v1-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const SESSION_KEY = /^[0-9a-f]{64}$/u;
const MARKER_BYTES = 16 * 1024;
const RECOVERY_ENTRIES = 2048;
const RECOVERY_CANDIDATES = 64;
const MAX_PENDING_FILES = WEB_PROMPT_FILE_MAX_COUNT * 2;

type DirectoryIdentity = { dev: string; ino: string };
type PendingMarker = {
  version: 1;
  id: string;
  root: DirectoryIdentity;
  attachments: DirectoryIdentity;
  parent: DirectoryIdentity;
  directory: DirectoryIdentity;
  sessionKey: string;
  files: string[];
};
function identity(info: import("node:fs").BigIntStats) {
  return { dev: String(info.dev), ino: String(info.ino) };
}
function matchesIdentity(info: import("node:fs").BigIntStats, expected: DirectoryIdentity) {
  return String(info.dev) === expected.dev && String(info.ino) === expected.ino;
}
function validIdentity(value: unknown): value is DirectoryIdentity {
  return isRecord(value) && Object.keys(value).length === 2 &&
    typeof value.dev === "string" && /^\d{1,40}$/u.test(value.dev) &&
    typeof value.ino === "string" && /^[1-9]\d{0,39}$/u.test(value.ino);
}
function unchangedFile(before: import("node:fs").BigIntStats, after: import("node:fs").BigIntStats) {
  return sameFile(before, after) && before.size === after.size && before.mode === after.mode &&
    before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}
function validPendingFile(name: unknown): name is string {
  return typeof name === "string" && Buffer.byteLength(name, "utf8") <= 220 &&
    /^[1-8]-(?:original-[\p{L}\p{N}._ -]+|extracted\.txt)$/u.test(name);
}
function parsePendingMarker(value: unknown, name: string) {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "attachments,directory,files,id,parent,root,sessionKey,version" ||
    value.version !== 1 || value.id !== PENDING_NAME.exec(name)?.[1] ||
    !validIdentity(value.root) || !validIdentity(value.attachments) ||
    !validIdentity(value.parent) || !validIdentity(value.directory) ||
    typeof value.sessionKey !== "string" || !SESSION_KEY.test(value.sessionKey) ||
    !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_PENDING_FILES ||
    !value.files.every(validPendingFile) || new Set(value.files).size !== value.files.length) throw denied();
  return value as PendingMarker;
}
async function syncDirectory(path: string) {
  // Windows directory fsync is not portable. File sync still precedes payloads;
  // this does not promise power-loss durability on unsupported filesystems.
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}
async function readPendingMarker(path: string, name: string) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MARKER_BYTES) ||
    (process.platform !== "win32" && (before.mode & 0o077n) !== 0n)) throw denied();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!unchangedFile(before, opened) || !opened.isFile() || opened.size !== before.size) throw denied();
    // Never readFile an attacker-grown marker: this allocation/read is bounded.
    const buffer = Buffer.alloc(MARKER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== Number(opened.size) || bytesRead > MARKER_BYTES ||
      !unchangedFile(opened, await lstat(path, { bigint: true }))) throw denied();
    return { marker: parsePendingMarker(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")), name), info: opened };
  } finally { await handle.close(); }
}

/** Caller holds the existing exclusive Host lease, before any upload can start.
 * Private same-user directories are the trust boundary. Identity rechecks are
 * not atomic openat protection against hostile same-UID ancestor replacement. */
export async function recoverPendingPromptFiles(sessionRoot: string) {
  const result = { scannedEntries: 0, candidates: 0, removed: 0, unknown: 0, failed: 0, incomplete: false };
  const rootBefore = await lstat(sessionRoot, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) throw denied();
  const root = await realpath(sessionRoot);
  if (!sameFile(rootBefore, await lstat(root, { bigint: true }))) throw denied();
  const attachments = join(root, ".prompt-files");
  const attachmentInfo = await lstat(attachments, { bigint: true }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!attachmentInfo) return result;
  await privateDirectory(attachments);
  const assertRoot = async () => {
    if (!sameFile(rootBefore, await lstat(sessionRoot, { bigint: true })) ||
      !sameFile(rootBefore, await lstat(root, { bigint: true })) ||
      !sameFile(attachmentInfo, await privateDirectory(attachments))) throw denied();
  };
  const entries = async (path: string, maximum: number) => {
    const before = await privateDirectory(path);
    const directory = await opendir(path);
    const names: string[] = [];
    try {
      if (!sameFile(before, await privateDirectory(path))) throw denied();
      while (true) {
        if (result.scannedEntries >= RECOVERY_ENTRIES) { result.incomplete = true; return undefined; }
        const entry = await directory.read();
        if (!entry) return names;
        result.scannedEntries++;
        if (names.length >= maximum) { result.incomplete = true; return undefined; }
        names.push(entry.name);
      }
    } finally { await directory.close(); }
  };
  // Arrays remain explicitly bounded, including unknown directory entries.
  const sessions = await entries(attachments, RECOVERY_ENTRIES);
  if (!sessions) return result;
  for (const sessionKey of sessions) {
    if (!SESSION_KEY.test(sessionKey)) { result.unknown++; continue; }
    const parent = join(attachments, sessionKey);
    let parentInfo;
    let children;
    try { await assertRoot(); parentInfo = await privateDirectory(parent); children = await entries(parent, RECOVERY_ENTRIES); }
    catch { result.unknown++; continue; }
    if (!children) break;
    for (const name of children) {
      // Published 64hex batches are never inspected, even with a marker inside.
      if (SESSION_KEY.test(name)) continue;
      if (!PENDING_NAME.test(name)) { result.unknown++; continue; }
      if (result.candidates >= RECOVERY_CANDIDATES || result.scannedEntries >= RECOVERY_ENTRIES) { result.incomplete = true; return result; }
      result.candidates++;
      const pending = join(parent, name);
      let marker;
      let markerInfo;
      let pendingInfo: import("node:fs").BigIntStats | undefined;
      let leaves: { name: string; info: import("node:fs").BigIntStats }[];
      const assertParents = async () => {
        await assertRoot();
        if (!sameFile(parentInfo, await privateDirectory(parent)) ||
          !pendingInfo || !sameFile(pendingInfo, await privateDirectory(pending))) throw denied();
      };
      try {
        pendingInfo = await privateDirectory(pending);
        const read = await readPendingMarker(join(pending, PENDING_MARKER), name);
        marker = read.marker; markerInfo = read.info;
        if (marker.sessionKey !== sessionKey || !matchesIdentity(rootBefore, marker.root) ||
          !matchesIdentity(attachmentInfo, marker.attachments) || !matchesIdentity(parentInfo, marker.parent) ||
          !matchesIdentity(pendingInfo, marker.directory)) throw denied();
        const present = await entries(pending, MAX_PENDING_FILES + 1);
        if (!present) { result.unknown++; continue; }
        leaves = [];
        for (const leaf of present) {
          if (leaf === PENDING_MARKER) continue;
          if (!marker.files.includes(leaf)) throw denied();
          const info = await lstat(join(pending, leaf), { bigint: true });
          if (!info.isFile() || info.isSymbolicLink() ||
            (process.platform !== "win32" && (info.mode & 0o077n) !== 0n)) throw denied();
          leaves.push({ name: leaf, info });
        }
        if (!present.includes(PENDING_MARKER)) throw denied();
        await assertParents();
        if (!unchangedFile(markerInfo, await lstat(join(pending, PENDING_MARKER), { bigint: true }))) throw denied();
      } catch { result.unknown++; continue; }
      try {
        for (const leaf of leaves) {
          await assertParents();
          const current = await lstat(join(pending, leaf.name), { bigint: true });
          if (!current.isFile() || current.isSymbolicLink() || !unchangedFile(leaf.info, current)) throw denied();
          await unlink(join(pending, leaf.name));
        }
        await assertParents();
        // No payload/unknown entry may be erased by removing the marker early.
        const remaining = await entries(pending, MAX_PENDING_FILES + 1);
        if (!remaining || remaining.length !== 1 || remaining[0] !== PENDING_MARKER ||
          !unchangedFile(markerInfo, await lstat(join(pending, PENDING_MARKER), { bigint: true }))) throw denied();
        await unlink(join(pending, PENDING_MARKER));
        // A crash/failure here leaves an empty unmarked UNKNOWN directory.
        await assertParents();
        await rmdir(pending);
        result.removed++;
      } catch { result.failed++; }
    }
  }
  return result;
}

/** Explicit browser attachments remain native-tool-readable Session data.
 * One atomic, content-addressed batch is the replay receipt; there is no second
 * conversation store, workspace write, provider upload, or execution grant. */
export async function persistPromptFiles(runtime: WebRuntimeController, body: Record<string, unknown>) {
  if (Object.keys(body).some((key) => !["sessionId", "sessionPath", "files"].includes(key)) ||
    typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 128 || /[\u0000-\u001f\u007f]/u.test(body.sessionId) ||
    typeof body.sessionPath !== "string" || !isAbsolute(body.sessionPath) || body.sessionPath.length > 4096 || /[\u0000-\u001f\u007f]/u.test(body.sessionPath))
    throw invalid("The exact Session id and native Session path are required.");
  const sessionId = body.sessionId;
  const sessionPath = body.sessionPath;
  const manager = runtime.sessionManager;
  const root = resolve(runtime.sessionDirectory);
  const assertSession = () => {
    if (!runtime.workspaceSelected || runtime.sessionManager !== manager || !manager.isPersisted() ||
      manager.getSessionId() !== sessionId || manager.getSessionFile() !== sessionPath ||
      dirname(resolve(sessionPath)) !== root || !sessionPath.endsWith(".jsonl")) throw conflict();
  };
  assertSession();
  const files = parsePromptFiles(body.files);
  let pending: string | undefined;
  let pendingIdentity: import("node:fs").BigIntStats | undefined;
  let cleanupPending: (() => Promise<void>) | undefined;
  try {
    const rootInfo = await lstat(root, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw denied();
    const canonicalRoot = await realpath(root);
    // A newly created persisted Pi Session already owns a future JSONL path.
    // It need not have received its first assistant message yet.
    const nativeFile = await lstat(join(canonicalRoot, basename(sessionPath)), { bigint: true }).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (nativeFile && (!nativeFile.isFile() || nativeFile.isSymbolicLink())) throw denied();
    const attachments = join(canonicalRoot, ".prompt-files");
    const attachmentInfo = await privateDirectory(attachments, true);
    const sessionDirectory = join(attachments, digest(`${sessionId}\0${sessionPath}`));
    const sessionInfo = await privateDirectory(sessionDirectory, true);
    const batchHash = digest(JSON.stringify(files.map((file) => [file.name, digest(file.bytes), file.text === undefined ? null : digest(file.text)])));
    const batchDirectory = join(sessionDirectory, batchHash);
    const receipts: WebPromptFileReceipt[] = files.map((file, index) => ({
      name: file.name,
      size: file.bytes.length,
      path: join(batchDirectory, fileName(file.name, index)),
      ...(file.text === undefined ? {} : { textPath: join(batchDirectory, `${index + 1}-extracted.txt`) }),
    }));
    const assertDirectories = async () => {
      assertSession();
      if (!sameFile(rootInfo, await lstat(root, { bigint: true })) ||
        !sameFile(attachmentInfo, await privateDirectory(attachments)) ||
        !sameFile(sessionInfo, await privateDirectory(sessionDirectory))) throw denied();
    };
    const verifyBatch = async () => {
      const before = await privateDirectory(batchDirectory);
      for (let index = 0; index < files.length; index++) {
        await verifyFile(receipts[index].path, files[index].bytes);
        const textPath = receipts[index].textPath;
        const text = files[index].text;
        if (textPath && text) await verifyFile(textPath, text);
      }
      if (!sameFile(before, await privateDirectory(batchDirectory))) throw denied();
      await assertDirectories();
    };
    const existing = await lstat(batchDirectory).catch((error: unknown) => {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) await verifyBatch();
    else {
      await assertDirectories();
      const id = randomUUID();
      pending = join(sessionDirectory, `${PENDING_PREFIX}${id}`);
      await mkdir(pending, { mode: 0o700 });
      pendingIdentity = await privateDirectory(pending);
      const marker: PendingMarker = { version: 1, id, root: identity(rootInfo), attachments: identity(attachmentInfo),
        parent: identity(sessionInfo), directory: identity(pendingIdentity), sessionKey: basename(sessionDirectory),
        files: receipts.flatMap((receipt) => [basename(receipt.path), ...(receipt.textPath ? [basename(receipt.textPath)] : [])]) };
      const pendingPath = pending;
      const ownedDirectory = pendingIdentity;
      cleanupPending = async () => {
        const assertOwned = async () => {
          if (!sameFile(rootInfo, await lstat(root, { bigint: true })) ||
            !sameFile(attachmentInfo, await privateDirectory(attachments)) ||
            !sameFile(sessionInfo, await privateDirectory(sessionDirectory)) ||
            !sameFile(ownedDirectory, await privateDirectory(pendingPath))) throw denied();
        };
        await assertOwned();
        const directory = await opendir(pendingPath);
        const leaves: { name: string; info: import("node:fs").BigIntStats }[] = [];
        try {
          while (true) {
            const leaf = await directory.read();
            if (!leaf) break;
            if (leaves.length >= MAX_PENDING_FILES + 1 || (leaf.name !== PENDING_MARKER && !marker.files.includes(leaf.name))) return;
            const info = await lstat(join(pendingPath, leaf.name), { bigint: true });
            if (!info.isFile() || info.isSymbolicLink()) return;
            leaves.push({ name: leaf.name, info });
          }
        } finally { await directory.close(); }
        for (const leaf of leaves.sort((a, b) => Number(a.name === PENDING_MARKER) - Number(b.name === PENDING_MARKER))) {
          await assertOwned();
          if (!sameFile(leaf.info, await lstat(join(pendingPath, leaf.name), { bigint: true }))) throw denied();
          await unlink(join(pendingPath, leaf.name));
        }
        await assertOwned();
        await rmdir(pendingPath);
      };
      await writePrivateFile(join(pending, PENDING_MARKER), Buffer.from(JSON.stringify(marker)));
      await syncDirectory(pending);
      await syncDirectory(sessionDirectory);
      for (let index = 0; index < files.length; index++) {
        await writePrivateFile(join(pending, basename(receipts[index].path)), files[index].bytes);
        const text = files[index].text;
        const textPath = receipts[index].textPath;
        if (text !== undefined && textPath) {
          await writePrivateFile(join(pending, basename(textPath)), text);
        }
      }
      await assertDirectories();
      if (!sameFile(pendingIdentity, await privateDirectory(pending))) throw denied();
      try { await rename(pending, batchDirectory); pending = undefined; }
      catch (error) {
        // Windows can report access errors when another identical batch wins
        // publication. Accept only the fully verified batch below, never the
        // error code itself as evidence of a successful upload.
        if (!isRecord(error) || !["EEXIST", "ENOTEMPTY", "EACCES", "EPERM"].includes(String(error.code))) throw error;
      }
      await verifyBatch();
    }
    return { sessionId, sessionPath, files: receipts };
  } catch (error) {
    if (error instanceof PromptFileError) throw error;
    throw denied();
  } finally {
    if (pending && pendingIdentity) {
      const current = await lstat(pending, { bigint: true }).catch(() => undefined);
      if (current && sameFile(pendingIdentity, current)) await cleanupPending?.();
    }
  }
}
