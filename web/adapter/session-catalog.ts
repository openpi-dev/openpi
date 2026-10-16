import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { WEB_SESSION_FORK } from "../protocol/session-fork.ts";
import { WEB_TURN_TIMING_ENTRY } from "../protocol/turn-timing.ts";

/** Archive search only inspects this prefix of the first user message. */
const CATALOG_FIRST_MESSAGE_CHARS = 2_000;
const STAT_CONCURRENCY = 64;
const READ_CONCURRENCY = 10;
const READ_CHUNK_BYTES = 64 * 1024;

export type CatalogSession = {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  parentSessionPath?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
};

export type CatalogPartialReason = "byte-limit" | "time-limit";

export type CatalogPage = {
  sessions: CatalogSession[];
  partial: boolean;
  partialReason?: CatalogPartialReason;
  bodyBytes: number;
};

export type CatalogListOptions = {
  signal?: AbortSignal;
  maxBodyBytes?: number;
  deadlineAt?: number;
  now?: () => number;
};

type FileIdentity = {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

type CompactNode = {
  id: string;
  parentId: string | null;
  type: string;
  role?: string;
  stopReason?: string;
  customType?: string;
  data?: unknown;
};

type CachedFile = {
  identity: FileIdentity;
  session: CatalogSession;
  nodes: CompactNode[];
  byId: Map<string, CompactNode>;
  leafId: string | null;
  resolvedCwd: string;
};

type SharedScan = {
  controller: AbortController;
  signals: AbortSignal[];
  detached: boolean;
  promise: Promise<CatalogPage>;
};

type ListedFile = {
  path: string;
  identity: FileIdentity;
  mtimeMs: number;
};

function inodeKey(identity: FileIdentity) {
  return `${identity.dev}:${identity.ino}`;
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function identityOf(stats: FileIdentity): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function follow<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolvePromise(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function withSignal<T>(work: Promise<T>, signal?: AbortSignal) {
  return follow(work, signal);
}

function textOf(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const part = block as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      if (text) text += " ";
      text += part.text;
    }
  }
  return text;
}

function activityTime(entry: Record<string, unknown>, message: Record<string, unknown>) {
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (typeof message.timestamp === "number") return message.timestamp;
  const parsed = new Date(String(entry.timestamp ?? "")).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function materialize(node: CompactNode): SessionEntry {
  if (node.type === "message") {
    return {
      type: "message",
      id: node.id,
      parentId: node.parentId,
      timestamp: "",
      message: {
        role: node.role,
        content: "",
        ...(node.stopReason ? { stopReason: node.stopReason } : {}),
      },
    } as SessionEntry;
  }
  if (node.type === "custom") {
    return {
      type: "custom",
      id: node.id,
      parentId: node.parentId,
      timestamp: "",
      customType: node.customType ?? "",
      data: node.data,
    } as SessionEntry;
  }
  return {
    type: node.type,
    id: node.id,
    parentId: node.parentId,
    timestamp: "",
  } as SessionEntry;
}

function isAbort(error: unknown, signal?: AbortSignal) {
  return Boolean(signal?.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError")));
}

/**
 * File-identity cache for Pi's session directory listing.
 * Unchanged files are not read again. Pi's branch readers still interpret the
 * retained structural entries; message bodies are not kept as a second transcript.
 */
export class SessionCatalog {
  private readonly files = new Map<string, CachedFile>();
  private readonly byInode = new Map<string, string>();
  private readonly shared = new Map<string, SharedScan>();

  async list(directory: string, options: CatalogListOptions = {}): Promise<CatalogPage> {
    const canonical = resolve(directory);
    options.signal?.throwIfAborted();
    const bounded = options.maxBodyBytes !== undefined || options.deadlineAt !== undefined;
    if (bounded) return this.scan(canonical, options);
    const existing = this.shared.get(canonical);
    if (existing) {
      this.watch(existing, options.signal);
      return follow(existing.promise, options.signal);
    }
    const scan: SharedScan = {
      controller: new AbortController(),
      signals: [],
      detached: false,
      promise: undefined as never,
    };
    this.watch(scan, options.signal);
    this.shared.set(canonical, scan);
    scan.promise = this.scan(canonical, { ...options, signal: scan.controller.signal });
    void scan.promise.then(
      () => {
        if (this.shared.get(canonical) === scan) this.shared.delete(canonical);
      },
      () => {
        if (this.shared.get(canonical) === scan) this.shared.delete(canonical);
      },
    );
    return follow(scan.promise, options.signal);
  }

  branch(path: string, sessionId: string, fromId?: string) {
    const cached = this.cached(path, sessionId);
    if (!cached) return undefined;
    const start = fromId ?? cached.leafId;
    const nodes: CompactNode[] = [];
    const seen = new Set<string>();
    let current = start ? cached.byId.get(start) : undefined;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      nodes.push(current);
      current = current.parentId ? cached.byId.get(current.parentId) : undefined;
    }
    nodes.reverse();
    return nodes.map(materialize);
  }

  entries(path: string, sessionId: string) {
    const cached = this.cached(path, sessionId);
    return cached ? cached.nodes.map(materialize) : undefined;
  }

  cwd(path: string, sessionId: string) {
    return this.cached(path, sessionId)?.resolvedCwd;
  }

  private cached(path: string, sessionId: string) {
    const cached = this.files.get(resolve(path));
    return cached?.session.id === sessionId ? cached : undefined;
  }

  private watch(scan: SharedScan, signal?: AbortSignal) {
    if (!signal) {
      scan.detached = true;
      return;
    }
    scan.signals.push(signal);
    const onAbort = () => {
      if (scan.detached || scan.controller.signal.aborted) return;
      if (scan.signals.every((item) => item.aborted)) scan.controller.abort(signal.reason);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  private remember(path: string, cached: CachedFile) {
    const previous = this.files.get(path);
    if (previous) {
      const previousKey = inodeKey(previous.identity);
      if (this.byInode.get(previousKey) === path) this.byInode.delete(previousKey);
    }
    this.files.set(path, cached);
    this.byInode.set(inodeKey(cached.identity), path);
  }

  private forget(path: string) {
    const cached = this.files.get(path);
    if (!cached) return;
    this.files.delete(path);
    const key = inodeKey(cached.identity);
    if (this.byInode.get(key) === path) this.byInode.delete(key);
  }

  private async scan(directory: string, options: CatalogListOptions): Promise<CatalogPage> {
    const signal = options.signal;
    const now = options.now ?? Date.now;
    const empty: CatalogPage = { sessions: [], partial: false, bodyBytes: 0 };
    let names: string[];
    try {
      signal?.throwIfAborted();
      names = await withSignal(readdir(directory), signal);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
      throw error;
    }
    const paths = names
      .filter((name) => name.endsWith(".jsonl"))
      .sort((left, right) => right.localeCompare(left))
      .map((name) => join(directory, name));
    const listed: ListedFile[] = [];
    let statIndex = 0;
    const statWorker = async () => {
      while (statIndex < paths.length) {
        signal?.throwIfAborted();
        const path = paths[statIndex++]!;
        try {
          const stats = await withSignal(stat(path, { bigint: true }), signal);
          if (!stats.isFile()) continue;
          listed.push({
            path,
            identity: identityOf(stats),
            mtimeMs: Number(stats.mtimeMs),
          });
        } catch (error) {
          if (isAbort(error, signal)) throw error;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, () => statWorker()));
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      throw error;
    }
    const seen = new Set(listed.map((file) => file.path));
    const fresh: CachedFile[] = [];
    const stale: ListedFile[] = [];
    for (const file of listed) {
      const cached = this.files.get(file.path);
      if (cached && sameIdentity(cached.identity, file.identity)) {
        fresh.push(cached);
        continue;
      }
      const key = inodeKey(file.identity);
      const previousPath = this.byInode.get(key);
      const previous = previousPath ? this.files.get(previousPath) : undefined;
      if (previous && previousPath && sameIdentity(previous.identity, file.identity) && !seen.has(previousPath)) {
        this.files.delete(previousPath);
        previous.session = { ...previous.session, path: file.path };
        this.remember(file.path, previous);
        fresh.push(previous);
        continue;
      }
      stale.push(file);
    }
    const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
    for (const path of [...this.files.keys()]) {
      if ((path === directory || path.startsWith(prefix)) && !seen.has(path)) this.forget(path);
    }
    stale.sort((left, right) => right.mtimeMs - left.mtimeMs || basename(right.path).localeCompare(basename(left.path)));
    const loaded: CachedFile[] = [];
    let bodyBytes = 0;
    let partial = false;
    let partialReason: CatalogPartialReason | undefined;
    let stop = false;
    let readIndex = 0;
    const readWorker = async () => {
      while (!stop) {
        signal?.throwIfAborted();
        if (options.deadlineAt !== undefined && now() >= options.deadlineAt) {
          stop = true;
          partial = true;
          partialReason ??= "time-limit";
          return;
        }
        const index = readIndex++;
        if (index >= stale.length) return;
        const file = stale[index]!;
        const size = Number(file.identity.size);
        if (options.maxBodyBytes !== undefined && bodyBytes + size > options.maxBodyBytes) {
          stop = true;
          partial = true;
          partialReason ??= "byte-limit";
          return;
        }
        bodyBytes += size;
        const parsed = await this.parseFile(file.path, file.identity, signal);
        if (parsed) loaded.push(parsed);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, stale.length) }, () => readWorker()));
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      throw error;
    }
    const sessions = [...fresh, ...loaded]
      .map((file) => ({ ...file.session }))
      .sort((left, right) => right.modified.getTime() - left.modified.getTime() || basename(right.path).localeCompare(basename(left.path)));
    return {
      sessions,
      partial,
      ...(partialReason ? { partialReason } : {}),
      bodyBytes,
    };
  }

  private async parseFile(path: string, identity: FileIdentity, signal?: AbortSignal) {
    const opening = open(path, "r");
    let handle: FileHandle;
    try {
      handle = await withSignal(opening, signal);
    } catch (error) {
      // Cancellation can win before open settles. Close that handle if it appears later.
      void opening.then((opened) => opened.close()).catch(() => undefined);
      if (isAbort(error, signal)) throw error;
      return null;
    }
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let pending = "";
    let header: Record<string, unknown> | undefined;
    let name: string | undefined;
    let messageCount = 0;
    let firstMessage = "";
    let lastActivity: number | undefined;
    const nodes: CompactNode[] = [];
    const byId = new Map<string, CompactNode>();
    const consume = (line: string) => {
      if (!line.trim()) return;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const entry = value as Record<string, unknown>;
      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") {
          header = { invalid: true };
        } else header = entry;
        return;
      }
      if (header.invalid) return;
      if (entry.type === "session_info") {
        name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
      }
      const id = typeof entry.id === "string" ? entry.id : undefined;
      const parentId = typeof entry.parentId === "string" ? entry.parentId : null;
      if (entry.type === "message") {
        messageCount++;
        const message = entry.message && typeof entry.message === "object" && !Array.isArray(entry.message)
          ? entry.message as Record<string, unknown>
          : undefined;
        if (message) {
          const activity = activityTime(entry, message);
          if (typeof activity === "number") lastActivity = Math.max(lastActivity ?? 0, activity);
          const text = textOf(message);
          if (!firstMessage && message.role === "user" && text) {
            firstMessage = text.slice(0, CATALOG_FIRST_MESSAGE_CHARS);
          }
          if (id) {
            const node: CompactNode = {
              id,
              parentId,
              type: "message",
              ...(typeof message.role === "string" ? { role: message.role } : {}),
              ...(typeof message.stopReason === "string" ? { stopReason: message.stopReason } : {}),
            };
            nodes.push(node);
            byId.set(id, node);
          }
        }
        return;
      }
      if (!id) return;
      const keepData = entry.type === "custom" &&
        (entry.customType === WEB_SESSION_FORK || entry.customType === WEB_TURN_TIMING_ENTRY);
      const node: CompactNode = {
        id,
        parentId,
        type: typeof entry.type === "string" ? entry.type : "custom",
        ...(entry.type === "custom" && typeof entry.customType === "string" ? { customType: entry.customType } : {}),
        ...(keepData ? { data: entry.data } : {}),
      };
      nodes.push(node);
      byId.set(id, node);
    };
    try {
      while (true) {
        signal?.throwIfAborted();
        const { bytesRead } = await withSignal(handle.read(buffer, 0, buffer.length, null), signal);
        if (bytesRead === 0) break;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        let start = 0;
        let newline = pending.indexOf("\n", start);
        while (newline !== -1) {
          consume(pending.slice(start, newline));
          start = newline + 1;
          newline = pending.indexOf("\n", start);
        }
        pending = pending.slice(start);
      }
      pending += decoder.end();
      if (pending) consume(pending);
    } catch (error) {
      if (isAbort(error, signal)) throw error;
      return null;
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (!header || header.invalid === true || typeof header.id !== "string") return null;
    const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : Number.NaN;
    const modified = typeof lastActivity === "number" && lastActivity > 0
      ? new Date(lastActivity)
      : !Number.isNaN(headerTime)
        ? new Date(headerTime)
        : new Date(Number(identity.mtimeNs / 1_000_000n));
    const cwd = typeof header.cwd === "string" ? header.cwd : "";
    const parentSessionPath = typeof header.parentSession === "string" ? header.parentSession : undefined;
    const session: CatalogSession = {
      path,
      id: header.id,
      cwd,
      ...(name ? { name } : {}),
      ...(parentSessionPath ? { parentSessionPath } : {}),
      created: new Date(typeof header.timestamp === "string" ? header.timestamp : Number.NaN),
      modified,
      messageCount,
      firstMessage: firstMessage || "(no messages)",
    };
    const cached: CachedFile = {
      identity,
      session,
      nodes,
      byId,
      leafId: nodes.at(-1)?.id ?? null,
      resolvedCwd: cwd ? resolve(cwd) : resolve(process.cwd()),
    };
    this.remember(path, cached);
    return cached;
  }
}
