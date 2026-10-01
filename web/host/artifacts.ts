import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, readdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { lstat, open, opendir, realpath, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { ARTIFACT_EDIT_BYTES, ARTIFACT_MAX_BYTES, ARTIFACT_PREVIEW_BYTES, ARTIFACT_PREVIEW_LINES, type ArtifactMetadata, type WorkspaceFileEntry, type WorkspaceFileMutation, type WorkspaceFileMutationResult, type WorkspaceTrashEntry } from "../protocol/artifacts.ts";
import { WEB_PROMPT_FILE_MAX_BYTES } from "../protocol/prompt-files.ts";

const MAX_HANDLES = 64;
const MAX_READS = 4;
const TRASH_DIRECTORY = ".openpi-trash";
const TRASH_MARKER = "OpenPI workspace trash v1\n";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;

function protectedPath(path: string) {
  return path.split(/[\\/]/u).some((part) => [".git", ".pi", TRASH_DIRECTORY].includes(part.toLowerCase()));
}

function readPrivateText(path: string) {
  const expected = lstatSync(path, { bigint: true });
  if (!expected.isFile() || expected.isSymbolicLink() || (process.platform !== "win32" && (expected.mode & 0o077n) !== 0n)) throw denied();
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(descriptor, { bigint: true });
    if (!info.isFile() || info.size > 16_384n || info.dev !== expected.dev || info.ino !== expected.ino) throw denied();
    const text = readFileSync(descriptor, "utf8");
    if (metadataIdentity(fstatSync(descriptor, { bigint: true })) !== metadataIdentity(expected)) throw denied();
    return text;
  } finally { closeSync(descriptor); }
}

function readPrivateJson(path: string) { return JSON.parse(readPrivateText(path)) as unknown; }

function writePrivateFile(path: string, content: string) {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { writeFileSync(descriptor, content); fsyncSync(descriptor); }
  finally { closeSync(descriptor); }
}

export class ArtifactError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode: number, message: string) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.name = "ArtifactError";
  }
}

function denied() { return new ArtifactError("ARTIFACT_DENIED", 403, "This file is outside the allowed Session workspace or its identity could not be verified."); }
function inside(root: string, path: string) {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}

interface Scope { sessionId: string; cwd: string; sessionPath?: string }
interface Grant { scope: Scope; path: string; requested: string; readRoot: string; external: boolean; touched: number }

function metadataIdentity(info: import("node:fs").BigIntStats) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function trashIdentity(info: import("node:fs").BigIntStats) {
  // rename changes ctime; preserve inode, size and content modification identity
  // so metadata can be committed before the reversible filesystem operation.
  return [info.dev, info.ino, info.size, info.mtimeNs].join(":");
}

/** Authenticated reads grant one file or one scoped directory cursor.
 * Saving is a separate explicit, revision-checked workspace-only operation.
 * No persistence, background filesystem reads, or model-facing tools. */
export class ArtifactReader {
  private readonly handles = new Map<string, Grant>();
  private readonly listings = new Map<string, { key: string; scan: AsyncGenerator<WorkspaceFileEntry | null>; checks: Map<string, import("node:fs").BigIntStats>; next: IteratorResult<WorkspaceFileEntry | null>; timer: ReturnType<typeof setTimeout> }>();
  private scopeKey = "";
  private revocation = 0;
  private reads = 0;
  private readonly saving = new Set<string>();
  private disposed = false;
  private readonly currentScope: () => Scope | undefined;
  constructor(currentScope: () => Scope | undefined) { this.currentScope = currentScope; }

  private scope() {
    const scope = this.currentScope();
    if (this.disposed || !scope) throw denied();
    const key = `${scope.sessionId}\0${scope.cwd}\0${scope.sessionPath ?? ""}`;
    if (key !== this.scopeKey) { this.revoke(); this.scopeKey = key; }
    for (const [handle, grant] of this.handles) if (Date.now() - grant.touched > 120_000) this.handles.delete(handle);
    return scope;
  }

  private decodeReference(reference: string) {
    if (!reference || reference.length > 4096 || /[\x00-\x1f\x7f]/u.test(reference) || /^(?:\\\\|\/\/)/u.test(reference)) throw denied();
    let decoded: string;
    try { decoded = decodeURIComponent(reference); } catch { throw denied(); }
    if (/[\x00-\x1f\x7f]/u.test(decoded) || /^(?:\\\\|\/\/)/u.test(decoded) || /:/u.test(decoded.replace(/^[a-z]:[\\/]/iu, ""))) throw denied();
    return decoded;
  }

  private async canonical(scope: Scope, requested: string, readRoot = scope.cwd, allowRoot = false) {
    const root = await realpath(readRoot);
    // Find the actual workspace boundary, including Windows short-name aliases
    // in any ancestor. Never follow a link below that boundary.
    const volumeRoot = parse(requested).root;
    let part = volumeRoot;
    let path = await realpath(part);
    let reachedRoot = relative(root, path) === "";
    for (const segment of relative(volumeRoot, requested).split(sep)) {
      part = resolve(part, segment);
      try {
        const info = await lstat(part, { bigint: true });
        if (reachedRoot && info.isSymbolicLink()) throw denied();
        path = await realpath(part);
        if (!reachedRoot && relative(root, path) === "") {
          // An explicitly selected junction root is allowed; another junction
          // pointing at the root is not an additional grant. Compare identity,
          // so alternate 8.3 spellings of the selected junction still work.
          if (info.isSymbolicLink()) {
            const selected = await lstat(readRoot, { bigint: true });
            if (!selected.isSymbolicLink() || selected.dev !== info.dev || selected.ino !== info.ino) throw denied();
          }
          reachedRoot = true;
        } else if (reachedRoot && !inside(root, path)) {
          throw denied();
        }
      } catch (error) {
        // Missing files within the verified workspace retain their exact error.
        // Unverified/outside paths never disclose their filesystem state.
        if (!reachedRoot) throw denied();
        throw error;
      }
    }
    if (!reachedRoot || (!inside(root, path) && !(allowRoot && relative(root, path) === ""))) throw denied();
    return { path, requested };
  }

  private assertScope(scope: Scope) {
    const current = this.scope();
    if (current.sessionId !== scope.sessionId || current.cwd !== scope.cwd || current.sessionPath !== scope.sessionPath) throw denied();
  }

  /** Paged reads retain one bounded cursor, never an unbounded recursive snapshot. */
  async listFiles(sessionId: string, reference = ".", query = "", sessionPath?: string, cursor?: string) {
    const scope = this.scope();
    if (sessionId !== scope.sessionId || (sessionPath !== undefined && sessionPath !== scope.sessionPath)) throw denied();
    if (query.length > 200 || /[\x00-\x1f\x7f]/u.test(query)) throw denied();
    if (this.reads >= MAX_READS) throw new ArtifactError("ARTIFACT_BUSY", 429, "File reads are busy. Try again shortly.");
    this.reads++;
    let scan: AsyncGenerator<WorkspaceFileEntry | null> | undefined;
    try {
      const root = await realpath(scope.cwd);
      const base = await this.canonical(scope, resolve(root, this.decodeReference(reference)), scope.cwd, true);
      const path = relative(root, base.path).split(sep).join("/") || ".";
      const key = JSON.stringify([scope, path, query]);
      const saved = cursor ? this.listings.get(cursor) : undefined;
      if (cursor && (!saved || saved.key !== key)) throw new ArtifactError("ARTIFACT_EXPIRED", 410, "File list expired. Refresh the directory.");
      if (saved && cursor) { clearTimeout(saved.timer); this.listings.delete(cursor); }
      if (!saved && this.listings.size >= 16) throw new ArtifactError("ARTIFACT_LIMIT", 429, "Too many open file lists. Collapse a directory before continuing.");
      const checks = saved?.checks ?? new Map<string, import("node:fs").BigIntStats>();
      scan = saved?.scan ?? this.scanFiles(scope, root, base.path, query.trim().toLocaleLowerCase(), checks);
      const entries: WorkspaceFileEntry[] = [];
      let item = saved?.next ?? await scan.next();
      let visited = 0;
      while (!item.done && entries.length < 250 && visited++ < 2_000) {
        if (item.value) entries.push(item.value);
        item = await scan.next();
      }
      // Verify every directory touched by this page before exposing any names.
      for (const [directory, before] of checks) {
        const after = await this.canonical(scope, directory, scope.cwd, true);
        const info = await lstat(after.path, { bigint: true });
        if (info.dev !== before.dev || info.ino !== before.ino || info.mtimeNs !== before.mtimeNs || after.path !== directory) throw new ArtifactError("ARTIFACT_CHANGED", 409, "Directory changed. Refresh to read its current entries.");
      }
      checks.clear();
      this.assertScope(scope);
      let nextCursor: string | undefined;
      if (!item.done) {
        nextCursor = randomUUID();
        const token = nextCursor;
        const timer = setTimeout(() => this.releaseListing(token), 300_000);
        timer.unref();
        this.listings.set(token, { key, scan, checks, next: item, timer });
      }
      entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      return { path, entries, truncated: false, ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) { await scan?.return(undefined); throw this.classify(error); }
    finally { this.reads--; }
  }

  private async *scanFiles(scope: Scope, root: string, base: string, needle: string, checks: Map<string, import("node:fs").BigIntStats>): AsyncGenerator<WorkspaceFileEntry | null> {
    const queue = [base];
    while (queue.length) {
      const directory = queue.shift()!;
      const current = await this.canonical(scope, directory, scope.cwd, true);
      const before = await lstat(current.path, { bigint: true });
      if (!before.isDirectory()) throw new ArtifactError("ARTIFACT_UNSUPPORTED", 415, "Choose a directory.");
      const stream = await opendir(current.path);
      try {
        // Explicit read/close supports pausing across HTTP pages without the
        // async iterator closing the directory at each page boundary.
        for (;;) {
          checks.set(current.path, before);
          const entry = await stream.read();
          if (!entry) break;
          if (entry.name === TRASH_DIRECTORY) continue;
          const path = relative(root, resolve(current.path, entry.name)).split(sep).join("/");
          const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
          if (needle && kind === "directory" && ![".git", "node_modules"].includes(entry.name)) {
            if (queue.length >= 10_000) throw new ArtifactError("ARTIFACT_LIMIT", 413, "Search is too broad. Search within a smaller directory.");
            queue.push(resolve(current.path, entry.name));
          }
          let identity: string | undefined;
          if (kind === "file" || kind === "directory") {
            const info = await lstat(resolve(current.path, entry.name), { bigint: true });
            if ((kind === "file" && info.isFile()) || (kind === "directory" && info.isDirectory())) identity = metadataIdentity(info);
          }
          this.assertScope(scope);
          yield !needle || entry.name.toLocaleLowerCase().includes(needle) ? { name: entry.name, path, kind, ...(identity ? { identity } : {}) } : null;
        }
      } finally { await stream.close(); }
      if (!needle) break;
    }
  }

  releaseListing(cursor: string) {
    const saved = this.listings.get(cursor);
    if (!saved) return;
    this.listings.delete(cursor);
    clearTimeout(saved.timer);
    void saved.scan.return(undefined).catch(() => undefined);
  }

  async resolveFile(sessionId: string, reference: string, parent?: string) {
    return this.issueGrant(sessionId, reference, parent, false);
  }

  /** Explicit operator consent grants this file only, never its directory. */
  async authorizeFile(sessionId: string, reference: string) {
    return this.issueGrant(sessionId, reference, undefined, true);
  }

  private async issueGrant(sessionId: string, reference: string, parent: string | undefined, external: boolean) {
    const scope = this.scope();
    if (sessionId !== scope.sessionId) throw denied();
    const base = parent ? this.requireGrant(parent, sessionId).path : undefined;
    try {
      const decoded = this.decodeReference(reference);
      if (external && !isAbsolute(decoded)) throw denied();
      const requested = resolve(base ? dirname(base) : await realpath(scope.cwd), decoded);
      const readRoot = external ? dirname(requested) : scope.cwd;
      const { path } = await this.canonical(scope, requested, readRoot);
      const info = await lstat(path);
      if (external && !info.isFile()) throw new ArtifactError("ARTIFACT_UNSUPPORTED", 415, "Only regular files can be opened.");
      this.assertScope(scope);
      if (this.handles.size >= MAX_HANDLES) throw new ArtifactError("ARTIFACT_LIMIT", 429, "Too many open files. Close a preview before opening another.");
      const handle = randomUUID();
      this.handles.set(handle, { scope, path, requested, readRoot, external, touched: Date.now() });
      return handle;
    } catch (error) { throw this.classify(error); }
  }

  private requireGrant(handle: string, sessionId: string) {
    const scope = this.scope();
    const grant = this.handles.get(handle);
    if (!grant || grant.scope.sessionId !== sessionId || sessionId !== scope.sessionId) throw new ArtifactError("ARTIFACT_EXPIRED", 410, "File access expired. Open the file again from its Session.");
    grant.touched = Date.now();
    return grant;
  }

  async metadata(handle: string, sessionId: string) {
    const grant = this.requireGrant(handle, sessionId);
    try {
      const current = await this.canonical(grant.scope, grant.requested, grant.readRoot);
      if (current.path !== grant.path) throw denied();
      const info = await lstat(current.path, { bigint: true });
      if (!info.isFile()) throw denied();
      this.assertScope(grant.scope);
      return { identity: metadataIdentity(info) };
    } catch (error) { throw this.classify(error); }
  }

  async read(handle: string, sessionId: string, expectedRevision?: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > ARTIFACT_MAX_BYTES || (offset > 0 && !expectedRevision)) throw denied();
    const grant = this.requireGrant(handle, sessionId);
    if (this.reads >= MAX_READS) throw new ArtifactError("ARTIFACT_BUSY", 429, "File reads are busy. Try again shortly.");
    this.reads++;
    try {
      const canonical = await this.canonical(grant.scope, grant.requested, grant.readRoot);
      if (canonical.path !== grant.path) throw denied();
      const beforePath = await stat(grant.path, { bigint: true });
      if (!beforePath.isFile()) throw new ArtifactError("ARTIFACT_UNSUPPORTED", 415, "Only regular files can be opened.");
      if (beforePath.size > BigInt(ARTIFACT_MAX_BYTES)) throw new ArtifactError("ARTIFACT_TOO_LARGE", 413, "File exceeds the 20 MiB read/download limit.");
      const file = await open(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino || before.size > BigInt(ARTIFACT_MAX_BYTES)) throw denied();
        const buffer = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const after = await file.stat({ bigint: true });
        const current = await this.canonical(grant.scope, grant.requested, grant.readRoot);
        const afterPath = await stat(current.path, { bigint: true });
        this.assertScope(grant.scope);
        if (before.size !== BigInt(length) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || afterPath.ino !== before.ino || afterPath.dev !== before.dev || current.path !== grant.path) throw new ArtifactError("ARTIFACT_CHANGED", 409, "File changed while being read. Refresh to load a stable version.");
        const bytes = buffer.subarray(0, length);
        const revision = createHash("sha256").update(bytes).digest("hex");
        if (expectedRevision && revision !== expectedRevision) throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file has a newer version. Refresh before downloading.");
        const textual = !/\.(?:pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|zip)$/iu.test(grant.path) && !bytes.includes(0) && isUtf8(bytes);
        const artifact: ArtifactMetadata = { handle, sessionId, path: grant.path, name: basename(grant.path), revision, bytes: length, preview: textual ? "text" : "unsupported", editable: textual && length <= ARTIFACT_EDIT_BYTES && !grant.external };
        const lines = textual ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(offset, offset + ARTIFACT_PREVIEW_BYTES), { stream: length > offset + ARTIFACT_PREVIEW_BYTES }).split("\n") : undefined;
        const text = lines?.slice(0, ARTIFACT_PREVIEW_LINES).join("\n");
        const nextOffset = offset + Buffer.byteLength(text ?? "");
        const truncated = textual && nextOffset < length;
        return { bytes, preview: { artifact, identity: metadataIdentity(after), text, truncated, ...(truncated ? { nextOffset } : {}) } };
      } finally { await file.close(); }
    } catch (error) { throw this.classify(error); }
    finally { this.reads--; }
  }

  async save(handle: string, sessionId: string, revision: string, text: string) {
    const grant = this.requireGrant(handle, sessionId);
    if (grant.external) throw denied();
    if (!/^[a-f0-9]{64}$/u.test(revision)) throw denied();
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > ARTIFACT_EDIT_BYTES) throw new ArtifactError("ARTIFACT_TOO_LARGE", 413, "Editing is limited to 1 MiB of UTF-8 text.");
    if (bytes.includes(0) || bytes.toString("utf8") !== text) throw new ArtifactError("ARTIFACT_UNSUPPORTED", 415, "Only UTF-8 text can be saved.");
    if (this.saving.has(grant.path)) throw new ArtifactError("ARTIFACT_BUSY", 409, "This file is already being saved.");
    this.saving.add(grant.path);
    let temporary: string | undefined;
    try {
      return await withFileMutationQueue(grant.path, async () => {
        this.assertScope(grant.scope);
        if (this.handles.get(handle) !== grant) throw denied();
        const before = await this.read(handle, sessionId, revision);
        if (!before.preview.artifact.editable) throw denied();
        const info = await lstat(grant.path, { bigint: true });
        if (metadataIdentity(info) !== before.preview.identity) throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file changed. Your draft has not been saved.");
        const directory = dirname(grant.path);
        const directoryInfo = await lstat(directory, { bigint: true });
        temporary = resolve(directory, `.openpi-save-${randomUUID()}`);
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), Number(info.mode & 0o777n));
        try { await file.chmod(Number(info.mode & 0o777n)); await file.writeFile(bytes); await file.sync(); }
        finally { await file.close(); }
        const current = await this.canonical(grant.scope, grant.requested);
        // No await between the final identity/content checks and atomic replacement:
        // another HTTP save or Session transition cannot interleave this commit.
        this.assertScope(grant.scope);
        if (this.handles.get(handle) !== grant || current.path !== grant.path) throw denied();
        const parent = lstatSync(directory, { bigint: true });
        const latest = lstatSync(grant.path, { bigint: true });
        if (parent.dev !== directoryInfo.dev || parent.ino !== directoryInfo.ino || !latest.isFile() || metadataIdentity(latest) !== before.preview.identity)
          throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file changed. Your draft has not been saved.");
        const descriptor = openSync(grant.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const snapshot = fstatSync(descriptor, { bigint: true });
          if (!snapshot.isFile() || metadataIdentity(snapshot) !== before.preview.identity) throw denied();
          const content = Buffer.alloc(Number(snapshot.size) + 1);
          let length = 0;
          while (length < content.length) {
            const count = readSync(descriptor, content, length, content.length - length, length);
            if (!count) break;
            length += count;
          }
          if (metadataIdentity(fstatSync(descriptor, { bigint: true })) !== before.preview.identity || createHash("sha256").update(content.subarray(0, length)).digest("hex") !== revision)
            throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file changed. Your draft has not been saved.");
        } finally { closeSync(descriptor); }
        // Windows cannot replace the destination while its read handle is open.
        // Keep closure and replacement synchronous with the final checks above.
        renameSync(temporary, grant.path);
        temporary = undefined;
        return { revision: createHash("sha256").update(bytes).digest("hex") };
      });
    } catch (error) { throw this.classify(error, true); }
    finally { if (temporary) await unlink(temporary).catch(() => undefined); this.saving.delete(grant.path); }
  }

  /** Explicit operator writes share Pi's native mutation lane; they never widen a read grant. */
  async mutateFile(sessionId: string, sessionPath: string, mutation: WorkspaceFileMutation) {
    const scope = this.scope();
    const revocation = this.revocation;
    if (sessionId !== scope.sessionId || sessionPath !== scope.sessionPath) throw denied();
    if (mutation.kind === "move" || mutation.kind === "trash" || mutation.kind === "restore")
      return this.organizeFile(scope, revocation, sessionPath, mutation);
    if (!mutation.name || Buffer.byteLength(mutation.name, "utf8") > 255 || Buffer.from(mutation.name, "utf8").toString("utf8") !== mutation.name || mutation.name === "." || mutation.name === ".." || /[\x00-\x1f\x7f/\\:]/u.test(mutation.name))
      throw new ArtifactError("ARTIFACT_INVALID_NAME", 400, "Choose a single file or directory name without path separators.");
    let bytes = Buffer.alloc(0);
    if (mutation.kind === "import-file") {
      if (mutation.data.length > Math.ceil(WEB_PROMPT_FILE_MAX_BYTES / 3) * 4)
        throw new ArtifactError("ARTIFACT_TOO_LARGE", 413, "Workspace file imports are limited to 50 MiB per file.");
      bytes = Buffer.from(mutation.data, "base64");
      if (bytes.toString("base64") !== mutation.data)
        throw new ArtifactError("ARTIFACT_INVALID_DATA", 400, "File bytes must use canonical base64.");
      if (bytes.length > WEB_PROMPT_FILE_MAX_BYTES)
        throw new ArtifactError("ARTIFACT_TOO_LARGE", 413, "Workspace file imports are limited to 50 MiB per file.");
    }
    let temporary: string | undefined;
    try {
      const root = await realpath(scope.cwd);
      const requested = resolve(root, this.decodeReference(mutation.directory));
      if (mutation.kind === "import-file" && mutation.createParents) {
        const parts = relative(root, requested).split(sep);
        if ((!inside(root, requested) && requested !== root) || protectedPath(parts.join("/"))) throw denied();
        let parent = root;
        for (const part of parts.filter(Boolean)) {
          const verified = await this.canonical(scope, parent, scope.cwd, true);
          this.assertScope(scope);
          if (this.revocation !== revocation) throw denied();
          const path = resolve(verified.path, part);
          try { await this.mutateFile(sessionId, sessionPath, { kind: "create-directory", directory: encodeURI(relative(root, verified.path).split(sep).join("/") || "."), name: part }); }
          catch (error) { if (!(error instanceof ArtifactError) || error.code !== "ARTIFACT_EXISTS") throw error; }
          parent = (await this.canonical(scope, path)).path;
          if (!lstatSync(parent).isDirectory()) throw denied();
        }
      }
      if (protectedPath(relative(root, requested)) || mutation.name === TRASH_DIRECTORY) throw denied();
      const directory = await this.canonical(scope, requested, scope.cwd, true);
      const originalParent = await lstat(directory.path, { bigint: true });
      if (!originalParent.isDirectory()) throw new ArtifactError("ARTIFACT_UNSUPPORTED", 415, "Choose an existing directory.");
      this.assertScope(scope);
      if (this.revocation !== revocation) throw denied();
      const target = resolve(directory.path, mutation.name);
      return await withFileMutationQueue(target, async () => {
        const current = await this.canonical(scope, requested, scope.cwd, true);
        this.assertScope(scope);
        if (this.revocation !== revocation) throw denied();
        const queuedParent = lstatSync(directory.path, { bigint: true });
        if (current.path !== directory.path || queuedParent.dev !== originalParent.dev || queuedParent.ino !== originalParent.ino)
          throw new ArtifactError("ARTIFACT_CHANGED", 409, "The destination directory changed. Nothing was created.");
        if (mutation.kind !== "create-directory") {
          temporary = resolve(directory.path, `.openpi-create-${randomUUID()}`);
          const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
          try { await file.writeFile(bytes); await file.chmod(0o666 & ~process.umask()); await file.sync(); }
          finally { await file.close(); }
        }
        const final = await this.canonical(scope, requested, scope.cwd, true);
        // Session/revocation and parent checks cannot interleave with this no-clobber commit.
        this.assertScope(scope);
        if (this.revocation !== revocation) throw denied();
        const parent = lstatSync(directory.path, { bigint: true });
        if (final.path !== directory.path || parent.dev !== originalParent.dev || parent.ino !== originalParent.ino)
          throw new ArtifactError("ARTIFACT_CHANGED", 409, "The destination directory changed. Nothing was created.");
        if (mutation.kind === "create-directory") mkdirSync(target);
        else linkSync(temporary!, target);
        for (const cursor of this.listings.keys()) this.releaseListing(cursor);
        const result: WorkspaceFileMutationResult = {
          sessionId, sessionPath, path: relative(root, target).split(sep).join("/"),
          kind: mutation.kind === "create-directory" ? "directory" : "file",
          ...(mutation.kind !== "create-directory" ? { bytes: bytes.length } : {}),
        };
        return result;
      });
    } catch (error) { throw this.classify(error, true); }
    finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }

  release(handle: string, sessionId: string) {
    this.requireGrant(handle, sessionId);
    this.handles.delete(handle);
  }

  /** Contents stay on the same filesystem and outside ordinary Git additions.
   * This is a reversible file operation, not another Session store. */
  private trashRoot(scope: Scope, root: string, create: boolean) {
    this.assertScope(scope);
    const path = resolve(root, TRASH_DIRECTORY);
    let info: import("node:fs").Stats;
    try { info = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return undefined;
      mkdirSync(path, { mode: 0o700 });
      // Complete private metadata before touching any operator file. Never
      // rewrite an existing directory or a user-owned ignore file.
      writePrivateFile(resolve(path, ".gitignore"), "*\n");
      writePrivateFile(resolve(path, "owner.json"), JSON.stringify({ marker: TRASH_MARKER, root }));
      info = lstatSync(path);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw denied();
    const owner = readPrivateJson(resolve(path, "owner.json"));
    if (!owner || typeof owner !== "object" || !("marker" in owner) || owner.marker !== TRASH_MARKER || !("root" in owner) || owner.root !== root) throw denied();
    const ignore = resolve(path, ".gitignore");
    if (readPrivateText(ignore) !== "*\n") throw denied();
    return path;
  }

  private trashEntry(directory: string, id: string, root: string) {
    if (!UUID.test(id)) throw denied();
    const folder = resolve(directory, id);
    const folderInfo = lstatSync(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink() || (process.platform !== "win32" && (folderInfo.mode & 0o077) !== 0)) throw denied();
    const record = readPrivateJson(resolve(folder, "entry.json"));
    if (!record || typeof record !== "object" || !("path" in record) || typeof record.path !== "string" || !("kind" in record) || !["file", "directory"].includes(String(record.kind)) || !("identity" in record) || typeof record.identity !== "string" || !("deletedAt" in record) || typeof record.deletedAt !== "number" || !Number.isSafeInteger(record.deletedAt)) throw denied();
    const original = resolve(root, record.path);
    if (!inside(root, original) || protectedPath(record.path) || relative(root, original).split(sep).join("/") !== record.path) throw denied();
    const payload = resolve(folder, "contents");
    const info = lstatSync(payload, { bigint: true });
    if (info.isSymbolicLink() || (record.kind === "file" ? !info.isFile() : !info.isDirectory()) || trashIdentity(info) !== record.identity) throw new ArtifactError("ARTIFACT_CHANGED", 409, "The removed file changed. Its contents were preserved in the workspace trash.");
    const entry: WorkspaceTrashEntry = { id, path: record.path, kind: record.kind === "file" ? "file" : "directory", identity: record.identity, deletedAt: record.deletedAt };
    return { entry, payload, folder, info };
  }

  async listTrash(sessionId: string, sessionPath: string, cursor?: string) {
    const scope = this.scope();
    if (sessionId !== scope.sessionId || sessionPath !== scope.sessionPath) throw denied();
    if (cursor && !UUID.test(cursor)) throw denied();
    try {
      const root = await realpath(scope.cwd);
      this.assertScope(scope);
      const directory = this.trashRoot(scope, root, false);
      const entries: WorkspaceTrashEntry[] = [];
      let unavailable = 0;
      let nextCursor: string | undefined;
      if (directory) {
        const ids = readdirSync(directory).filter((name) => UUID.test(name) && (!cursor || name > cursor)).sort();
        for (const [index, id] of ids.slice(0, 250).entries()) {
          try { entries.push(this.trashEntry(directory, id, root).entry); }
          catch { unavailable++; /* Interrupted or changed entries remain recoverable on disk; do not delete them. */ }
          if (index === 249 && ids.length > 250) nextCursor = id;
        }
      }
      this.assertScope(scope);
      return { sessionId, sessionPath, entries: entries.sort((a, b) => b.deletedAt - a.deletedAt), ...(unavailable ? { unavailable } : {}), ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) { throw this.classify(error); }
  }

  private async organizeFile(scope: Scope, revocation: number, sessionPath: string, mutation: Extract<WorkspaceFileMutation, { kind: "move" | "trash" | "restore" }>) {
    try {
      if (!mutation.identity || mutation.identity.length > 256) throw denied();
      const root = await realpath(scope.cwd);
      this.assertScope(scope);
      if (this.revocation !== revocation) throw denied();
      const trash = mutation.kind === "restore" ? this.trashRoot(scope, root, false) : undefined;
      if (mutation.kind === "restore" && !trash) throw new ArtifactError("ARTIFACT_MISSING", 404, "The removed file is no longer available.");
      const saved = mutation.kind === "restore" ? this.trashEntry(trash!, mutation.id, root) : undefined;
      const source = saved?.payload ?? (await this.canonical(scope, resolve(root, this.decodeReference("path" in mutation ? mutation.path : "")))).path;
      const original = saved?.entry.path ?? relative(root, source).split(sep).join("/");
      if (protectedPath(original)) throw denied();
      const before = await lstat(source, { bigint: true });
      if ((!before.isFile() && !before.isDirectory()) || before.isSymbolicLink()) throw denied();
      if ((saved ? trashIdentity(before) : metadataIdentity(before)) !== mutation.identity) throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file changed. Refresh before organizing it.");
      if (mutation.kind === "move" && (!mutation.name || Buffer.byteLength(mutation.name) > 255 || Buffer.from(mutation.name, "utf8").toString("utf8") !== mutation.name || mutation.name === "." || mutation.name === ".." || /[\x00-\x1f\x7f/\\:]/u.test(mutation.name))) throw new ArtifactError("ARTIFACT_INVALID_NAME", 400, "Choose a single file or directory name without path separators.");
      const destinationReference = mutation.kind === "move" ? resolve(root, this.decodeReference(mutation.directory)) : mutation.kind === "restore" ? dirname(resolve(root, original)) : this.trashRoot(scope, root, true)!;
      const destination = await this.canonical(scope, destinationReference, scope.cwd, true);
      if (!lstatSync(destination.path).isDirectory()) throw denied();
      const target = mutation.kind === "move" ? resolve(destination.path, mutation.name) : mutation.kind === "restore" ? resolve(root, original) : resolve(destination.path, randomUUID(), "contents");
      if (mutation.kind !== "trash" && (protectedPath(relative(root, target)) || (before.isDirectory() && inside(source, target)))) throw denied();
      if (source === target) throw new ArtifactError("ARTIFACT_EXISTS", 409, "Choose a different name or destination.");
      let destinationAlias: string | undefined;
      try { destinationAlias = await realpath(target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const sourceParent = await lstat(dirname(source), { bigint: true });
      const destinationParent = await lstat(destination.path, { bigint: true });
      // The existing object owns this mutation. Locking both names can deadlock
      // when case-insensitive names or another canonical alias share one lane.
      // Destination creation is no-clobber and has no awaited commit gap.
      return await withFileMutationQueue(source, async () => {
        const currentDestination = await this.canonical(scope, destinationReference, scope.cwd, true);
        await this.canonical(scope, source);
        if (saved) {
          const privateRoot = this.trashRoot(scope, root, false);
          if (privateRoot !== dirname(saved.folder)) throw denied();
          this.trashEntry(privateRoot, saved.entry.id, root);
        }
        this.assertScope(scope);
        if (this.revocation !== revocation || currentDestination.path !== destination.path) throw denied();
        const parent = lstatSync(destination.path, { bigint: true });
        const sourceParentNow = lstatSync(dirname(source), { bigint: true });
        const latest = lstatSync(source, { bigint: true });
        if (parent.dev !== destinationParent.dev || parent.ino !== destinationParent.ino || sourceParentNow.dev !== sourceParent.dev || sourceParentNow.ino !== sourceParent.ino || (saved ? trashIdentity(latest) : metadataIdentity(latest)) !== mutation.identity) throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file or directory changed. Nothing was moved.");
        let caseRename = false;
        try {
          const existing = lstatSync(target, { bigint: true });
          caseRename = mutation.kind === "move" && destinationAlias === source && source.toLowerCase() === target.toLowerCase() && existing.dev === latest.dev && existing.ino === latest.ino && !existing.isSymbolicLink();
          if (!caseRename) throw new ArtifactError("ARTIFACT_EXISTS", 409, "The destination already exists. Both files were preserved.");
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        let trashed: WorkspaceTrashEntry | undefined;
        if (mutation.kind === "trash") {
          const folder = dirname(target);
          mkdirSync(folder, { mode: 0o700 });
          // Prepare metadata first. If preparation fails the source is untouched.
          trashed = { id: basename(folder), path: original, kind: before.isDirectory() ? "directory" : "file", identity: trashIdentity(before), deletedAt: Date.now() };
          writePrivateFile(resolve(folder, "entry.json"), JSON.stringify(trashed));
          try { renameSync(source, target); }
          catch (error) {
            // Only our metadata was created; source contents have not moved.
            try { unlinkSync(resolve(folder, "entry.json")); rmdirSync(folder); } catch { /* Preserve unknown evidence. */ }
            throw error;
          }
        } else if (caseRename) renameSync(source, target);
        else if (before.isFile()) {
          // link is a no-clobber commit even if another process creates the name.
          linkSync(source, target);
          unlinkSync(source);
        } else if (process.platform === "win32") {
          // Windows does not replace an existing destination directory.
          renameSync(source, target);
        } else {
          // POSIX rename would replace another process's empty directory.
          // Claim the destination exclusively first; only our empty directory
          // is replaceable. A concurrent creator now gets EEXIST.
          mkdirSync(target, { mode: 0o700 });
          const reservation = lstatSync(target, { bigint: true });
          try { renameSync(source, target); }
          catch (error) {
            try {
              const remaining = lstatSync(target, { bigint: true });
              if (remaining.dev === reservation.dev && remaining.ino === reservation.ino && remaining.isDirectory() && !remaining.isSymbolicLink()) rmdirSync(target);
            } catch { /* Preserve another process's replacement or contents. */ }
            throw error;
          }
        }
        if (saved) {
          try { unlinkSync(resolve(saved.folder, "entry.json")); rmdirSync(saved.folder); }
          catch { /* Restored contents are authoritative; preserve leftover metadata rather than misreporting a failed restore. */ }
        }
        for (const cursor of this.listings.keys()) this.releaseListing(cursor);
        for (const [handle, grant] of this.handles) if (grant.path === source || inside(source, grant.path)) this.handles.delete(handle);
        const result: WorkspaceFileMutationResult = { sessionId: scope.sessionId, sessionPath, path: mutation.kind === "trash" ? original : relative(root, target).split(sep).join("/"), kind: before.isDirectory() ? "directory" : "file", ...(before.isFile() ? { bytes: Number(before.size) } : {}), ...(trashed ? { trashed } : {}), ...(mutation.kind === "move" ? { moved: { from: source, to: target } } : {}) };
        return result;
      });
    } catch (error) { throw this.classify(error, true); }
  }

  private classify(error: unknown, write = false) {
    if (error instanceof ArtifactError) return error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return new ArtifactError("ARTIFACT_MISSING", 404, "File no longer exists.");
    if (["EACCES", "EPERM", "ELOOP"].includes(code ?? "")) return denied();
    if (code === "EEXIST") return new ArtifactError("ARTIFACT_EXISTS", 409, "That name already exists. Choose another name; the original was not changed.");
    return new ArtifactError(write ? "ARTIFACT_WRITE_ERROR" : "ARTIFACT_READ_ERROR", 500, write ? "Unable to write this file or directory." : "Unable to read this file.");
  }

  dispose() { this.disposed = true; this.revoke(); }
  revoke() { this.revocation++; this.handles.clear(); for (const cursor of this.listings.keys()) this.releaseListing(cursor); }
}
