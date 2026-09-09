import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { ARTIFACT_MAX_BYTES, ARTIFACT_PREVIEW_BYTES, ARTIFACT_PREVIEW_LINES, type ArtifactMetadata } from "../protocol/artifacts.ts";

const MAX_HANDLES = 64;
const MAX_READS = 4;
const TEXT_EXTENSIONS = /\.(?:txt|md|markdown|json|csv|tsv|log|html?|css|[cm]?[jt]sx?|py|rs|go|java|c|h|cpp|yaml|yml|toml|xml|svg|sh|sql|diff|patch)$/iu;

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

interface Scope { sessionId: string; cwd: string }
interface Grant { scope: Scope; path: string; requested: string; touched: number }

/** An explicit authenticated file-open request grants one read-only file.
 * No directory grants, persistence, background reads, or model-facing tools. */
export class ArtifactReader {
  private readonly handles = new Map<string, Grant>();
  private scopeKey = "";
  private reads = 0;
  private disposed = false;
  private readonly currentScope: () => Scope | undefined;
  constructor(currentScope: () => Scope | undefined) { this.currentScope = currentScope; }

  private scope() {
    const scope = this.currentScope();
    if (this.disposed || !scope) throw denied();
    const key = `${scope.sessionId}\0${scope.cwd}`;
    if (key !== this.scopeKey) { this.handles.clear(); this.scopeKey = key; }
    for (const [handle, grant] of this.handles) if (Date.now() - grant.touched > 120_000) this.handles.delete(handle);
    return scope;
  }

  private async canonical(scope: Scope, reference: string, base?: string) {
    if (!reference || reference.length > 4096 || /[\x00-\x1f\x7f]/u.test(reference) || /^(?:\\\\|\/\/)/u.test(reference)) throw denied();
    let decoded: string;
    try { decoded = decodeURIComponent(reference); } catch { throw denied(); }
    if (/[\x00-\x1f\x7f]/u.test(decoded) || /^(?:\\\\|\/\/)/u.test(decoded) || /:/u.test(decoded.replace(/^[a-z]:[\\/]/iu, ""))) throw denied();
    const root = await realpath(scope.cwd);
    const requested = resolve(base ?? root, decoded);
    // The Session cwd may use a Windows 8.3 alias. Accept either spelling of
    // this exact root, then verify descendants and canonical containment.
    const sessionRoot = resolve(scope.cwd);
    const requestedRoot = inside(root, requested) ? root : inside(sessionRoot, requested) ? sessionRoot : undefined;
    if (!requestedRoot) throw denied();
    // Reject links/junctions throughout the descendant path, not just its leaf.
    let part = requestedRoot;
    for (const segment of relative(requestedRoot, requested).split(sep)) {
      part = resolve(part, segment);
      const info = await lstat(part);
      if (info.isSymbolicLink()) throw denied();
    }
    const path = await realpath(requested);
    if (!inside(root, path)) throw denied();
    return { path, requested };
  }

  private assertScope(scope: Scope) {
    const current = this.scope();
    if (current.sessionId !== scope.sessionId || current.cwd !== scope.cwd) throw denied();
  }

  async resolveFile(sessionId: string, reference: string, parent?: string) {
    const scope = this.scope();
    if (sessionId !== scope.sessionId) throw denied();
    const base = parent ? this.requireGrant(parent, sessionId).path : undefined;
    try {
      const { path, requested } = await this.canonical(scope, reference, base ? dirname(base) : undefined);
      this.assertScope(scope);
      if (this.handles.size >= MAX_HANDLES) throw new ArtifactError("ARTIFACT_LIMIT", 429, "Too many open files. Close a preview before opening another.");
      const handle = randomUUID();
      this.handles.set(handle, { scope, path, requested, touched: Date.now() });
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

  async read(handle: string, sessionId: string, expectedRevision?: string) {
    const grant = this.requireGrant(handle, sessionId);
    if (this.reads >= MAX_READS) throw new ArtifactError("ARTIFACT_BUSY", 429, "File reads are busy. Try again shortly.");
    this.reads++;
    try {
      const canonical = await this.canonical(grant.scope, grant.requested);
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
        const current = await this.canonical(grant.scope, grant.requested);
        const afterPath = await stat(current.path, { bigint: true });
        this.assertScope(grant.scope);
        if (before.size !== BigInt(length) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || afterPath.ino !== before.ino || afterPath.dev !== before.dev || current.path !== grant.path) throw new ArtifactError("ARTIFACT_CHANGED", 409, "File changed while being read. Refresh to load a stable version.");
        const bytes = buffer.subarray(0, length);
        const revision = createHash("sha256").update(bytes).digest("hex");
        if (expectedRevision && revision !== expectedRevision) throw new ArtifactError("ARTIFACT_CHANGED", 409, "The file has a newer version. Refresh before downloading.");
        const textual = (TEXT_EXTENSIONS.test(grant.path) || !basename(grant.path).includes(".")) && !bytes.subarray(0, ARTIFACT_PREVIEW_BYTES).includes(0);
        const artifact: ArtifactMetadata = { handle, sessionId, path: grant.path, name: basename(grant.path), revision, bytes: length, preview: textual ? "text" : "unsupported" };
        const text = textual ? bytes.subarray(0, ARTIFACT_PREVIEW_BYTES).toString("utf8").replace(/\ufffd$/u, "").split("\n").slice(0, ARTIFACT_PREVIEW_LINES).join("\n") : undefined;
        return { bytes, preview: { artifact, text, truncated: textual && (length > ARTIFACT_PREVIEW_BYTES || (text?.split("\n").length ?? 0) >= ARTIFACT_PREVIEW_LINES) } };
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

  dispose() { this.disposed = true; this.handles.clear(); }
  revoke() { this.handles.clear(); }
}
