import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from "node:fs/promises";
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
      pending = await mkdtemp(join(sessionDirectory, ".pending-"));
      pendingIdentity = await privateDirectory(pending);
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
        if (!isRecord(error) || !["EEXIST", "ENOTEMPTY"].includes(String(error.code))) throw error;
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
      if (current && sameFile(pendingIdentity, current)) await rm(pending, { recursive: true, force: true });
    }
  }
}
