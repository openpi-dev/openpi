import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionInfoLike } from "./sessions.ts";

export interface SessionStats {
  add: number;
  mod: number;
  del: number;
}

export type SessionStatsState =
  | { status: "pending" }
  | { status: "ready"; stats: SessionStats }
  | { status: "unavailable" };

type CachedSessionStats = Exclude<SessionStatsState, { status: "pending" }>;

interface StatsLoaderOptions {
  cache?: Map<string, CachedSessionStats>;
  maxCache?: number;
  maxConcurrency?: number;
  runGit?: (
    args: string[],
    cwd: string,
    signal: AbortSignal,
  ) => Promise<string>;
  canonicalizeCwd?: (cwd: string) => Promise<string>;
  canonicalizeConcurrency?: number;
}

interface QueueEntry {
  signal: AbortSignal;
  start: (done: () => void) => void;
  cancel: () => void;
}

const GIT_STATS_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CACHE = 256;
const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_CANONICALIZE_CONCURRENCY = 8;

const abortError = () => {
  const error = new Error("Session stats load was cancelled.");
  error.name = "AbortError";
  return error;
};

function createQueue(maxConcurrency: number) {
  const queue: QueueEntry[] = [];
  let active = 0;

  const pump = () => {
    while (active < maxConcurrency && queue.length > 0) {
      const entry = queue.shift()!;
      if (entry.signal.aborted) {
        entry.cancel();
        continue;
      }
      active++;
      entry.start(() => {
        active--;
        pump();
      });
    }
  };

  const run = <A>(task: () => Promise<A>, signal: AbortSignal) =>
    new Promise<A>((resolve, reject) => {
      let started = false;
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancelQueued);
        complete();
      };
      const cancelQueued = () => {
        if (started || settled) return;
        // Leave the cancelled entry in place for the next linear pump. Removing
        // every entry from a large shared-signal queue would make abort O(n²).
        finish(() => reject(abortError()));
      };
      const entry: QueueEntry = {
        signal,
        cancel: cancelQueued,
        start: (done) => {
          if (settled) {
            done();
            return;
          }
          started = true;
          signal.removeEventListener("abort", cancelQueued);
          void task()
            .then(
              (value) => finish(() => resolve(value)),
              (error) => finish(() => reject(error)),
            )
            .finally(done);
        },
      };

      signal.addEventListener("abort", cancelQueued, { once: true });
      queue.push(entry);
      pump();
    });

  return { run };
}

const runGit = (args: string[], cwd: string, signal: AbortSignal) =>
  new Promise<string>((resolveOutput, reject) => {
    try {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          timeout: GIT_STATS_TIMEOUT_MS,
          signal,
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolveOutput(stdout);
        },
      );
    } catch (error) {
      reject(error);
    }
  });

const calculateStats = (outputs: readonly string[]) => {
  let added = 0;
  let deleted = 0;
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const [rawAdded, rawDeleted] = line.trim().split(/\s+/);
      const nextAdded = Number.parseInt(rawAdded ?? "", 10);
      const nextDeleted = Number.parseInt(rawDeleted ?? "", 10);
      if (!Number.isNaN(nextAdded)) added += nextAdded;
      if (!Number.isNaN(nextDeleted)) deleted += nextDeleted;
    }
  }

  const mod = Math.min(added, deleted);
  return { add: added - mod, mod, del: deleted - mod };
};

export function createSessionStatsLoader(options: StatsLoaderOptions = {}) {
  const cache = options.cache ?? new Map<string, CachedSessionStats>();
  const maxCache = options.maxCache ?? DEFAULT_MAX_CACHE;
  const execute = options.runGit ?? runGit;
  const canonicalize = options.canonicalizeCwd ?? realpath;
  const canonicalizeConcurrency = Math.max(
    1,
    options.canonicalizeConcurrency ?? DEFAULT_CANONICALIZE_CONCURRENCY,
  );
  const queue = createQueue(
    Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
  );
  interface Request {
    key: string;
    cwd: string;
    after: string;
    before: string;
    includeWorktreeDiff: boolean;
  }
  interface ActiveRequest {
    controller: AbortController;
    promise: Promise<void>;
  }

  const active = new Map<string, ActiveRequest>();
  const pathKeys = new Map<string, string>();
  const canonicalCwds = new Map<string, Promise<string>>();
  let canonicalUniverse:
    | {
        universe: readonly SessionInfoLike[];
        controller: AbortController;
        promise: Promise<Map<string, string>>;
      }
    | undefined;
  let requestedPaths = new Set<string>();
  let reconcileGeneration = 0;
  let notify = () => {};

  const canonicalCwd = (cwd: string) => {
    const absolute = resolve(cwd);
    let pending = canonicalCwds.get(absolute);
    if (!pending) {
      pending = canonicalize(absolute).catch(() => absolute);
      canonicalCwds.set(absolute, pending);
    }
    return pending;
  };

  const buildCanonicalWorkspaceMap = async (
    sessions: readonly SessionInfoLike[],
    signal: AbortSignal,
  ) => {
    const workspaces = [
      ...new Set(sessions.map((session) => resolve(session.cwd))),
    ];
    const result = new Map<string, string>();
    let index = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const cwd = workspaces[index++];
        if (!cwd) return;
        result.set(cwd, await canonicalCwd(cwd));
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(canonicalizeConcurrency, workspaces.length) },
        worker,
      ),
    );
    if (signal.aborted) throw abortError();
    return result;
  };

  const canonicalWorkspaceMap = (sessions: readonly SessionInfoLike[]) => {
    if (
      canonicalUniverse?.universe === sessions &&
      !canonicalUniverse.controller.signal.aborted
    ) {
      return canonicalUniverse.promise;
    }
    canonicalUniverse?.controller.abort();
    const controller = new AbortController();
    const promise = buildCanonicalWorkspaceMap(sessions, controller.signal);
    canonicalUniverse = { universe: sessions, controller, promise };
    return promise;
  };

  const latestPathsByCwd = (
    sessions: readonly SessionInfoLike[],
    canonical: ReadonlyMap<string, string>,
  ) => {
    const latest = new Map<string, SessionInfoLike>();
    for (const session of sessions) {
      const cwd = canonical.get(resolve(session.cwd)) ?? resolve(session.cwd);
      const current = latest.get(cwd);
      if (!current || session.modified.getTime() > current.modified.getTime()) {
        latest.set(cwd, session);
      }
    }
    return new Map(
      [...latest].map(([cwd, session]) => [cwd, session.path] as const),
    );
  };

  const requestFor = (
    session: SessionInfoLike,
    latest: ReadonlyMap<string, string>,
    canonical: ReadonlyMap<string, string>,
  ): Request => {
    const cwd = canonical.get(resolve(session.cwd)) ?? resolve(session.cwd);
    const after = session.created
      ? session.created.toISOString()
      : new Date(session.modified.getTime() - 24 * 3600 * 1000).toISOString();
    const before = session.modified.toISOString();
    const includeWorktreeDiff = latest.get(cwd) === session.path;
    return {
      key: JSON.stringify([cwd, after, before, includeWorktreeDiff]),
      cwd,
      after,
      before,
      includeWorktreeDiff,
    };
  };

  const putCache = (key: string, value: CachedSessionStats) => {
    if (cache.has(key)) cache.delete(key);
    while (cache.size >= Math.max(1, maxCache)) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(key, value);
  };

  const start = (request: Request) => {
    const controller = new AbortController();
    const promise = Promise.all([
      queue.run(
        () =>
          execute(
            [
              "log",
              `--after=${request.after}`,
              `--before=${request.before}`,
              "--numstat",
              "--pretty=format:",
            ],
            request.cwd,
            controller.signal,
          ),
        controller.signal,
      ),
      request.includeWorktreeDiff
        ? queue.run(
            () =>
              execute(["diff", "--numstat"], request.cwd, controller.signal),
            controller.signal,
          )
        : Promise.resolve(""),
    ])
      .then((outputs) => {
        if (!controller.signal.aborted) {
          putCache(request.key, {
            status: "ready",
            stats: calculateStats(outputs),
          });
          notify();
        }
      })
      .catch(() => {
        const cancelled = controller.signal.aborted;
        if (!cancelled) {
          putCache(request.key, { status: "unavailable" });
          notify();
          controller.abort();
        }
      })
      .finally(() => {
        if (active.get(request.key)?.controller === controller) {
          active.delete(request.key);
        }
      });
    const entry = { controller, promise };
    active.set(request.key, entry);
    return entry;
  };

  const cancelKey = (key: string) => {
    const entry = active.get(key);
    if (!entry) return;
    active.delete(key);
    entry.controller.abort();
  };

  const reconcile = async (
    targets: readonly SessionInfoLike[],
    universe: readonly SessionInfoLike[],
    onUpdate: () => void,
  ) => {
    notify = onUpdate;
    const generation = ++reconcileGeneration;
    requestedPaths = new Set(targets.map((session) => session.path));
    if (targets.length === 0) {
      for (const key of [...active.keys()]) cancelKey(key);
      pathKeys.clear();
      return;
    }

    let canonical: ReadonlyMap<string, string>;
    try {
      canonical = await canonicalWorkspaceMap(universe);
    } catch {
      return;
    }
    if (generation !== reconcileGeneration) return;
    const latest = latestPathsByCwd(universe, canonical);
    const requests = targets.map((session) => ({
      session,
      request: requestFor(session, latest, canonical),
    }));
    const wanted = new Set(requests.map(({ request }) => request.key));

    for (const key of active.keys()) {
      if (!wanted.has(key)) cancelKey(key);
    }

    pathKeys.clear();
    const pending: Promise<void>[] = [];
    for (const { session, request } of requests) {
      pathKeys.set(session.path, request.key);
      if (cache.has(request.key)) continue;
      const current = active.get(request.key) ?? start(request);
      pending.push(current.promise);
    }
    await Promise.all(pending);
  };

  const get = (session: SessionInfoLike): SessionStatsState | undefined => {
    if (!requestedPaths.has(session.path)) return undefined;
    const key = pathKeys.get(session.path);
    if (!key) return { status: "pending" };
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return cached;
    }
    if (active.has(key)) return { status: "pending" };
    return undefined;
  };

  const cancel = () => {
    reconcileGeneration++;
    canonicalUniverse?.controller.abort();
    canonicalUniverse = undefined;
    for (const key of [...active.keys()]) cancelKey(key);
    pathKeys.clear();
    requestedPaths.clear();
  };

  return { cache, get, reconcile, cancel };
}
