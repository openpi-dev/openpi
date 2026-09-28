import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { ARTIFACT_MAX_BYTES, ARTIFACT_PREVIEW_BYTES, ARTIFACT_PREVIEW_LINES, type ArtifactMetadata, type WorkspaceFileEntry } from "../protocol/artifacts.ts";

const MAX_HANDLES = 64;
const MAX_READS = 4;

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
interface Grant { scope: Scope; path: string; requested: string; readRoot: string; touched: number }

function metadataIdentity(info: import("node:fs").BigIntStats) {
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

/** Authenticated requests grant one read-only file or one scoped directory cursor.
 * No persistence, background filesystem reads, or model-facing tools. */
export class ArtifactReader {
  private readonly handles = new Map<string, Grant>();
  private readonly listings = new Map<string, { key: string; scan: AsyncGenerator<WorkspaceFileEntry | null>; checks: Map<string, import("node:fs").BigIntStats>; next: IteratorResult<WorkspaceFileEntry | null>; timer: ReturnType<typeof setTimeout> }>();
  private scopeKey = "";
  private reads = 0;
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
          const path = relative(root, resolve(current.path, entry.name)).split(sep).join("/");
          const kind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
          if (needle && kind === "directory" && ![".git", "node_modules"].includes(entry.name)) {
            if (queue.length >= 10_000) throw new ArtifactError("ARTIFACT_LIMIT", 413, "Search is too broad. Search within a smaller directory.");
            queue.push(resolve(current.path, entry.name));
          }
          this.assertScope(scope);
          yield !needle || entry.name.toLocaleLowerCase().includes(needle) ? { name: entry.name, path, kind } : null;
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
      this.handles.set(handle, { scope, path, requested, readRoot, touched: Date.now() });
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
        const artifact: ArtifactMetadata = { handle, sessionId, path: grant.path, name: basename(grant.path), revision, bytes: length, preview: textual ? "text" : "unsupported" };
        const lines = textual ? new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes.subarray(offset, offset + ARTIFACT_PREVIEW_BYTES), { stream: length > offset + ARTIFACT_PREVIEW_BYTES }).split("\n") : undefined;
        const text = lines?.slice(0, ARTIFACT_PREVIEW_LINES).join("\n");
        const nextOffset = offset + Buffer.byteLength(text ?? "");
        const truncated = textual && nextOffset < length;
        return { bytes, preview: { artifact, identity: metadataIdentity(after), text, truncated, ...(truncated ? { nextOffset } : {}) } };
      } finally { await file.close(); }
    } catch (error) { throw this.classify(error); }
    finally { this.reads--; }
  }

  release(handle: string, sessionId: string) {
    this.requireGrant(handle, sessionId);
    this.handles.delete(handle);
  }

  private classify(error: unknown) {
    if (error instanceof ArtifactError) return error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return new ArtifactError("ARTIFACT_MISSING", 404, "File no longer exists.");
    if (["EACCES", "EPERM", "ELOOP"].includes(code ?? "")) return denied();
    return new ArtifactError("ARTIFACT_READ_ERROR", 500, "Unable to read this file.");
  }

  dispose() { this.disposed = true; this.revoke(); }
  revoke() { this.handles.clear(); for (const cursor of this.listings.keys()) this.releaseListing(cursor); }
}
