import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseSessionEntries, SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";

const MAX_OPEN_SESSIONS = 4;
/** Enough lines that a yield can run, without a timer per message. */
const PARSE_TURN_LINES = 4_000;

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type CachedSession = {
  identity: FileIdentity;
  manager: SessionManager;
};

function identityOf(stats: FileIdentity): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function yieldTurn() {
  // setTimeout, not setImmediate: a chain of check-phase callbacks starves caller timers.
  return new Promise((resolveTurn) => setTimeout(resolveTurn, 0));
}

async function parseInTurns(content: string) {
  const entries: FileEntry[] = [];
  let start = 0;
  let cursor = 0;
  let linesInChunk = 0;
  let chunks = 0;
  const flush = async (end: number) => {
    const slice = chunks === 0 && end >= content.length ? content : content.slice(start, end);
    // A single short file stays one Pi parse. A longer file yields before every chunk.
    if (chunks > 0 || end < content.length) await yieldTurn();
    if (slice.length > 0) entries.push(...parseSessionEntries(slice) as FileEntry[]);
    chunks++;
    start = end;
    linesInChunk = 0;
  };
  while (cursor < content.length) {
    const newline = content.indexOf("\n", cursor);
    if (newline === -1) {
      cursor = content.length;
      linesInChunk++;
      break;
    }
    cursor = newline + 1;
    linesInChunk++;
    if (linesInChunk === PARSE_TURN_LINES) await flush(cursor);
  }
  if (start < cursor) await flush(cursor);
  return entries;
}

function readableSession(path: string, sessionDir: string, entries: FileEntry[]) {
  const header = entries.find((entry) => entry.type === "session");
  const headerCwd = header && typeof header.cwd === "string" ? header.cwd : "";
  const manager = SessionManager.inMemory(headerCwd || process.cwd(), undefined, entries);
  const file = resolve(path);
  const directory = resolve(sessionDir);
  manager.getSessionFile = () => file;
  manager.getSessionDir = () => directory;
  return manager;
}

/**
 * Opens a non-current Session without a synchronous full-file read. Long files
 * yield before each Pi parse turn, including the first. The result is reused
 * while the file identity is unchanged. Pi remains the parser and the branch authority.
 */
export class SessionLoader {
  private readonly cache = new Map<string, CachedSession>();
  private readonly recent: string[] = [];

  async open(path: string, sessionDir: string) {
    const resolved = resolve(path);
    const stats = await stat(resolved, { bigint: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stats || !stats.isFile()) return SessionManager.open(path, sessionDir);
    const identity = identityOf(stats);
    const cached = this.cache.get(resolved);
    if (cached && sameIdentity(cached.identity, identity)) {
      this.touch(resolved);
      return cached.manager;
    }
    const entries = await this.readStable(resolved, identity);
    if (entries.length === 0 || entries[0]?.type !== "session" || typeof entries[0].id !== "string") {
      throw new Error(`Session file is not a valid pi session: ${resolved}`);
    }
    const manager = readableSession(resolved, sessionDir, entries);
    const after = await stat(resolved, { bigint: true }).catch(() => undefined);
    if (after && after.isFile() && sameIdentity(identity, identityOf(after))) {
      this.cache.set(resolved, { identity, manager });
      this.touch(resolved);
    }
    return manager;
  }

  private touch(path: string) {
    const index = this.recent.indexOf(path);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.push(path);
    while (this.recent.length > MAX_OPEN_SESSIONS) {
      const evicted = this.recent.shift();
      if (evicted) this.cache.delete(evicted);
    }
  }

  private async readStable(path: string, identity: FileIdentity) {
    const first = await this.readEntries(path);
    const after = await stat(path, { bigint: true }).catch(() => undefined);
    if (!after || !after.isFile() || sameIdentity(identity, identityOf(after))) return first;
    return this.readEntries(path);
  }

  private async readEntries(path: string) {
    return parseInTurns(await readFile(path, "utf8"));
  }
}
