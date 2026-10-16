import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { SessionManager, type FileEntry } from "@earendil-works/pi-coding-agent";

const MAX_OPEN_SESSIONS = 4;

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type WorkerResponse = {
  id: number;
  entries?: FileEntry[];
  error?: string;
};

type CachedSession = {
  identity: FileIdentity;
  manager: SessionManager;
};

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (entries: FileEntry[]) => void; reject: (error: Error) => void }>();

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

function releaseWorker(current: Worker) {
  if (pending.size === 0) current.unref();
}

function fileWorker() {
  if (worker) return worker;
  worker = new Worker(new URL("./session-file-worker.ts", import.meta.url), {
    execArgv: ["--experimental-strip-types"],
  });
  // An idle parser must not keep the process, or a finished request never ends.
  worker.unref();
  const current = worker;
  current.on("message", (message: WorkerResponse) => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    releaseWorker(current);
    if (message.error !== undefined) request.reject(new Error(message.error));
    else request.resolve(message.entries ?? []);
  });
  current.on("error", (error) => {
    const requests = [...pending.values()];
    pending.clear();
    if (worker === current) worker = undefined;
    current.unref();
    const failure = error instanceof Error ? error : new Error(String(error));
    for (const request of requests) request.reject(failure);
  });
  return current;
}

function parseEntries(bytes: Buffer) {
  const id = nextId++;
  const current = fileWorker();
  current.ref();
  return new Promise<FileEntry[]>((resolvePromise, reject) => {
    const fail = (error: Error) => {
      if (pending.get(id)) pending.delete(id);
      releaseWorker(current);
      reject(error);
    };
    pending.set(id, {
      resolve: (entries) => {
        resolvePromise(entries);
      },
      reject: fail,
    });
    try {
      current.postMessage({ id, bytes });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
 * Opens a non-current Session off the request thread and reuses it while the
 * file identity is unchanged. Pi remains the parser and the branch authority.
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
    // The bytes are read asynchronously here; Pi parses them off this thread.
    return parseEntries(await readFile(path));
  }
}
